'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Download } = require('./download');
const { spawn } = require('child_process');
const { request, discard } = require('./http');
const { AppError, HttpError, fatal, sleep, humanizeError, errorInfo } = require('./utils');

const STALL_MS = 30000;

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/** M3U8 çalma listesini çözer: ana liste (kaliteler) ya da medya listesi (parçalar). */
function parsePlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw fatal('err.notPlaylist');
  const abs = (u) => new URL(u, baseUrl).toString();

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    // Ayrı ses akışları (çoğu film sitesi sesi görüntüden ayrı bir listede verir)
    const audio = [];
    for (const l of lines) {
      if (!l.startsWith('#EXT-X-MEDIA:')) continue;
      const a = parseAttrs(l.slice(13));
      if (a.TYPE !== 'AUDIO' || !a.URI) continue;
      audio.push({ group: a['GROUP-ID'] || '', url: abs(a.URI), name: a.NAME || '', language: a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES' });
    }
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const a = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) continue;
      variants.push({
        url: abs(uri),
        bandwidth: Number(a.BANDWIDTH) || 0,
        resolution: a.RESOLUTION || '',
        height: Number((a.RESOLUTION || '').split('x')[1]) || 0,
        codecs: a.CODECS || '',
        audio: a.AUDIO || ''
      });
    }
    variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, audio };
  }

  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  let duration = 0;
  let pendingDuration = 0;
  let endList = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : null, iv: a.IV || null };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      if (a.URI) map = abs(a.URI);
    } else if (l.startsWith('#EXTINF:')) pendingDuration = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (!l.startsWith('#')) {
      segments.push({ url: abs(l), seq: seq + segments.length, key });
      duration += pendingDuration;
      pendingDuration = 0;
    }
  }
  return { type: 'media', segments, map, endList, duration };
}

/** Görüntü kalitesinin ses grubundan çalınacak sesi seçer: oynatıcının varsayılanı, yoksa ilki. */
function pickAudio(master, variant) {
  if (!variant?.audio) return null;
  const group = master.audio.filter((r) => r.group === variant.audio);
  return (group.find((r) => r.isDefault) || group[0])?.url || null;
}

const MUX_FORMAT = { mp4: 'mp4', m4v: 'mp4', mkv: 'matroska', ts: 'mpegts', mov: 'mov' };

/** Ayrı inen görüntü ve sesi yeniden kodlamadan tek dosyada birleştirir (FFmpeg). */
function muxAv(cmd, video, audio, out, ext) {
  const args = [
    ...cmd.args,
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', video, '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c', 'copy',
    '-f', MUX_FORMAT[ext] || 'mp4', out
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd.cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (b) => (err = (err + b).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new AppError('err.muxFailed', { detail: err.trim().split(/\r?\n/).pop() || String(code) }))
    );
  });
}

async function fetchText(url, d, signal) {
  const { res, finalUrl } = await request(url, { headers: d.headers, auth: d.auth, signal });
  try {
    if (!res.ok) throw new HttpError(res.status);
    return { text: await res.text(), finalUrl };
  } finally {
    await discard(res);
  }
}

/** Bir HLS adresinin ana mı medya listesi mi olduğunu, kalitelerini ve süresini döner. */
async function probeHls(url, { headers = {}, auth = {}, signal } = {}) {
  const sig = signal || AbortSignal.timeout(20000);
  const fake = { headers, auth };
  const { text, finalUrl } = await fetchText(url, fake, sig);
  const pl = parsePlaylist(text, finalUrl);
  if (pl.type === 'master') return { kind: 'hls', type: 'master', variants: pl.variants, finalUrl };
  return {
    kind: 'hls',
    type: 'media',
    variants: [],
    finalUrl,
    duration: pl.duration,
    segments: pl.segments.length,
    live: !pl.endList,
    encrypted: pl.segments.some((s) => s.key)
  };
}

/**
 * HLS video akışı indirmesi. Parçalar eşzamanlı indirilip `<dosya>.tipart.d` klasörüne yazılır,
 * bitince sırayla tek dosyada birleştirilir. Klasörde biten parçalar kaldığı için devam desteklidir.
 */
class HlsDownload extends Download {
  constructor(data, ctx) {
    super({ kind: 'hls', variantUrl: null, audioUrl: null, resumable: true, ...data }, ctx);
    this.kind = 'hls';
    this.totalSegments = data.totalSegments || 0;
    this.doneSegments = data.doneSegments || 0;
    this.downloaded = data.downloaded || 0;
  }

  get partDir() {
    return this.tempPath + '.d';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      kind: 'hls',
      variantUrl: this.variantUrl,
      audioUrl: this.audioUrl,
      totalSegments: this.totalSegments,
      doneSegments: this.doneSegments,
      downloaded: this.downloaded
    };
  }

  snapshot() {
    const s = super.snapshot();
    s.kind = 'hls';
    s.estimated = this.status !== 'completed';
    s.resumable = true;
    s.segmentsDone = this.doneSegments;
    s.segmentsTotal = this.totalSegments;
    s.progress = this.status === 'completed' ? 1 : this.totalSegments ? this.doneSegments / this.totalSegments : 0;
    s.segments = this.totalSegments && this.size > 0 ? [[0, this.size - 1, Math.round(s.progress * this.size), 0]] : [];
    s.activeConnections = this._active || 0;
    return s;
  }

  resetProgress() {
    super.resetProgress();
    this.doneSegments = 0;
    this.totalSegments = 0;
    this.size = -1;
  }

  async cleanupTemp() {
    await fsp.rm(this.partDir, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(this.tempPath).catch(() => {});
  }

  async _run() {
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this.status = 'downloading';
    this.error = null;
    this.errorKey = null;
    this.errorParams = null;
    this.history = [];
    this._active = 0;
    this.emit('change');
    try {
      let { text, finalUrl } = await fetchText(this.url, this, signal).catch((err) => {
        // Ana liste artık açılmıyorsa (süresi dolmuş imza) önceden seçilen kaliteyle sürdür
        if (this.variantUrl && !signal.aborted) return fetchText(this.variantUrl, this, signal);
        throw err;
      });
      let pl = parsePlaylist(text, finalUrl);
      if (pl.type === 'master') {
        if (!pl.variants.length) throw fatal('err.noVariants');
        // Seçilen kalite (yoksa en yüksek) ve onun ses grubundaki ses
        const variant = pl.variants.find((v) => v.url === this.variantUrl) || pl.variants[0];
        this.variantUrl = variant.url;
        this.audioUrl = pickAudio(pl, variant);
        ({ text, finalUrl } = await fetchText(this.variantUrl, this, signal));
        pl = parsePlaylist(text, finalUrl);
      }
      let audioPl = null;
      if (this.audioUrl) {
        const a = await fetchText(this.audioUrl, this, signal);
        audioPl = parsePlaylist(a.text, a.finalUrl);
        if (audioPl.type !== 'media' || !audioPl.segments.length) audioPl = null;
      }
      const mux = audioPl ? this.ctx.tools?.ffmpegCommand?.() : null;
      if (audioPl && !mux) throw fatal('err.audioNeedsEngine');
      if (!pl.endList) throw fatal('err.live');
      if ([...pl.segments, ...(audioPl?.segments || [])].some((s) => s.key && s.key.method !== 'AES-128')) {
        throw fatal('Bu video DRM ile korunuyor; indirilemez');
      }
      if (!pl.segments.length) throw fatal('err.noSegments');
      this.probed = true;
      // fMP4 parçalar ya da görüntüyle birleştirilen ses: çıktı MP4'tür (.ts uzantısını adı verilse de biz ekledik)
      if ((pl.map || audioPl) && /\.ts$/i.test(this.filename)) {
        await this.ctx.assignPath(this, this.filename.replace(/\.ts$/i, '.mp4'));
      }

      // Görüntü parçaları "N.seg", ses parçaları "aN.seg" olarak yazılır
      const track = (list, prefix) =>
        [...(list.map ? [{ url: list.map, seq: -1, key: null, init: true }] : []), ...list.segments].map((p, i) => ({
          ...p,
          file: `${prefix}${i}.seg`
        }));
      const videoParts = track(pl, '');
      const audioParts = audioPl ? track(audioPl, 'a') : [];
      const parts = [...videoParts, ...audioParts];
      this.totalSegments = parts.length;
      await fsp.mkdir(this.partDir, { recursive: true });

      // Daha önce bitmiş parçaları say
      const done = new Set();
      let bytes = 0;
      for (const f of await fsp.readdir(this.partDir)) {
        if (!/^a?\d+\.seg$/.test(f)) continue;
        done.add(f);
        bytes += (await fsp.stat(path.join(this.partDir, f))).size;
      }
      this.downloaded = bytes;
      this.doneSegments = done.size;
      this._estimate();
      this.emit('change');

      const keyCache = new Map();
      const queue = parts.map((p, i) => i).filter((i) => !done.has(parts[i].file));
      let failure = null;
      const worker = async () => {
        while (queue.length && !signal.aborted && !failure) {
          const i = queue.shift();
          this._active++;
          try {
            await this._fetchPart(parts[i], keyCache, signal);
            this.doneSegments++;
            this._estimate();
          } catch (err) {
            if (!signal.aborted) failure = err;
          } finally {
            this._active--;
          }
        }
      };
      const n = Math.max(1, Math.min(this.connections, 16));
      await Promise.all(Array.from({ length: n }, worker));
      if (failure) throw failure;
      if (signal.aborted) return;

      // Birleştir; ses ayrıysa görüntüyle tek dosyaya kat
      const join = async (list, file) => {
        const out = await fsp.open(file, 'w');
        try {
          for (const p of list) {
            if (signal.aborted) return false;
            await out.write(await fsp.readFile(path.join(this.partDir, p.file)));
          }
        } finally {
          await out.close();
        }
        return true;
      };
      if (audioParts.length) {
        const v = path.join(this.partDir, 'video.av');
        const a = path.join(this.partDir, 'audio.av');
        if (!(await join(videoParts, v)) || !(await join(audioParts, a))) return;
        await muxAv(mux, v, a, this.tempPath, path.extname(this.filename).slice(1).toLowerCase());
      } else if (!(await join(videoParts, this.tempPath))) return;
      const st = await fsp.stat(this.tempPath);
      this.size = st.size;
      this.downloaded = st.size;
      const finalPath = await this.ctx.finalPath(this);
      await fsp.rename(this.tempPath, finalPath);
      await fsp.rm(this.partDir, { recursive: true, force: true }).catch(() => {});
      this.filename = path.basename(finalPath);
      this.status = 'completed';
      this.completedAt = Date.now();
      this.emit('completed');
    } catch (err) {
      if (signal.aborted && !err?.fatal) return;
      this.status = 'error';
      const info = errorInfo(err);
      this.error = humanizeError(err);
      this.errorKey = info?.key || null;
      this.errorParams = info?.params || null;
      this.emit('failed');
    } finally {
      this._active = 0;
      this.speed = 0;
      this.eta = null;
      this.emit('change');
    }
  }

  _estimate() {
    if (this.doneSegments > 0 && this.totalSegments) {
      this.size = Math.max(this.downloaded, Math.round((this.downloaded / this.doneSegments) * this.totalSegments));
    }
  }

  async _fetchPart(part, keyCache, signal) {
    let attempt = 0;
    for (;;) {
      let got = 0;
      try {
        const buf = await this._download(part.url, signal, (n) => {
          got += n;
          this.downloaded += n;
        });
        let data = buf;
        if (part.key) data = await this._decrypt(buf, part, keyCache, signal);
        const file = path.join(this.partDir, part.file);
        await fsp.writeFile(file + '.tmp', data);
        await fsp.rename(file + '.tmp', file);
        this.downloaded += data.length - got; // şifre çözme boyutu değiştirebilir
        return;
      } catch (err) {
        this.downloaded -= got;
        if (signal.aborted || err.fatal) throw err;
        if (++attempt > this.ctx.settings.retries) throw err;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000), signal);
      }
    }
  }

  async _download(url, signal, onBytes) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Takılma denetimi tek aralıkla (her parçada zamanlayıcı kurmadan)
    let stalled = false;
    let lastData = Date.now();
    let throttled = false;
    const watchdog = setInterval(() => {
      if (!throttled && Date.now() - lastData > STALL_MS) {
        stalled = true;
        ctrl.abort();
      }
    }, 2000);
    let res = null;
    try {
      ({ res } = await request(url, { headers: this.headers, auth: this.auth, signal: ctrl.signal }));
      if (!res.ok) throw new HttpError(res.status);
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastData = Date.now();
        const wait = this.ctx.limiter.consume(value.length, ctrl.signal);
        const waitItem = this.speedLimit ? this._limiter.consume(value.length, ctrl.signal) : null;
        if (wait || waitItem) {
          throttled = true;
          if (wait) await wait;
          if (waitItem) await waitItem;
          throttled = false;
          lastData = Date.now();
        }
        chunks.push(value);
        onBytes(value.length);
      }
      if (ctrl.signal.aborted) throw new AppError(stalled ? 'err.stalled' : 'err.cancelled');
      return Buffer.concat(chunks);
    } catch (err) {
      if (stalled && !signal.aborted) throw new AppError('err.stalled');
      throw err;
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener('abort', onAbort);
      if (res) await discard(res);
    }
  }

  async _decrypt(buf, part, keyCache, signal) {
    const { uri, iv } = part.key;
    if (!uri) throw fatal('err.noKeyUri');
    if (!keyCache.has(uri)) {
      keyCache.set(
        uri,
        (async () => {
          const { res } = await request(uri, { headers: this.headers, auth: this.auth, signal });
          try {
            if (!res.ok) throw new HttpError(res.status, 'err.keyFetch');
            return Buffer.from(await res.arrayBuffer());
          } finally {
            await discard(res);
          }
        })()
      );
    }
    let key;
    try {
      key = await keyCache.get(uri);
    } catch (err) {
      keyCache.delete(uri);
      throw err;
    }
    let ivBuf;
    if (iv) {
      ivBuf = Buffer.from(iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
    } else {
      ivBuf = Buffer.alloc(16);
      ivBuf.writeUInt32BE(part.seq >>> 0, 12);
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, ivBuf);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  }
}

module.exports = { HlsDownload, parsePlaylist, probeHls, pickAudio };
