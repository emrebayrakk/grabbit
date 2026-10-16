'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Download } = require('./download');
const { AppError, fatal } = require('./utils');

// Videoyu tek dosya olarak vermeyen (parçalı/imzalı yayın yapan) siteler: yt-dlp ile çözülür
const MEDIA_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com',
  'facebook.com', 'fb.watch', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'reddit.com', 'redd.it',
  'soundcloud.com', 'bilibili.com', 'pinterest.com', 'linkedin.com', 'threads.net', 'threads.com', 'kick.com',
  'rumble.com', 'bandcamp.com', 'snapchat.com', 'tumblr.com', 'vk.com', 'ok.ru', 'streamable.com', 'imgur.com', '9gag.com'
];

const DIRECT_FILE = /\.(jpe?g|png|gif|webp|avif|bmp|pnj|svg|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$/i;

function isMediaSiteUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!MEDIA_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return false;
  // Sitenin kendi dosya sunucusundaki doğrudan dosya (ör. 64.media.tumblr.com/…/foto.pnj) sayfa değildir
  return !DIRECT_FILE.test(new URL(url).pathname);
}

const QUALITIES = ['2160', '1440', '1080', '720', '480', '360'];

/** yt-dlp hatalarını anlaşılır Türkçeye çevirir. */
/** yt-dlp hatasını anlaşılır bir AppError'a çevirir (dil anahtarıyla). */
function mediaError(raw, { fatal: isFatal = false } = {}) {
  const s = String(raw || '').replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '').trim();
  const key =
    /needs to be reloaded/i.test(s) ? 'media.errSession'
    : /drm/i.test(s) ? 'media.errDrm'
    : /sign in to confirm|not a bot/i.test(s) ? 'media.errBot'
    : /private video|this video is private/i.test(s) ? 'media.errPrivate'
    : /login|log in|cookies|authentication|rate-limit reached/i.test(s) ? 'media.errLogin'
    : /members[- ]only|join this channel/i.test(s) ? 'media.errMembers'
    : /age[- ]restrict|confirm your age|inappropriate/i.test(s) ? 'media.errAge'
    : /unavailable|not available|removed|deleted|does not exist|404/i.test(s) ? 'media.errGone'
    : /live event will begin|is live|live stream/i.test(s) ? 'err.live'
    : /unsupported url/i.test(s) ? 'media.errUnsupported'
    : /requested format is not available/i.test(s) ? 'media.errFormat'
    : /unable to download|timed out|connection|network|getaddrinfo/i.test(s) ? 'err.network'
    : null;
  // Tekrar denemekle düzelmeyecek durumlar
  const permanent = ['media.errDrm', 'media.errPrivate', 'media.errGone', 'media.errUnsupported', 'media.errMembers'].includes(key);
  if (key) return new AppError(key, null, { fatal: isFatal || permanent });
  return new AppError('media.errGeneric', { detail: s.split('\n')[0].slice(0, 300) || 'yt-dlp' }, { fatal: isFatal });
}

/**
 * Tarayıcıdan gelen çerezleri yt-dlp'nin okuduğu Netscape biçiminde geçici dosyaya yazar.
 * `jar` (eklentinin gönderdiği tam çerez listesi) varsa alan adı, yol, Secure ve süre bilgisi
 * aynen korunur; yoksa yalnızca "ad=değer" dizesinden makul bir dosya üretilir.
 */
async function writeCookieFile(cookie, url, jar) {
  let lines;
  if (Array.isArray(jar) && jar.length) {
    lines = jar
      .filter((c) => c && c.name && c.domain)
      .map((c) => {
        const host = String(c.domain);
        // Yalnızca o alan adına ait çerez: başında nokta yok, alt alan adları FALSE
        const domain = c.hostOnly ? host.replace(/^\./, '') : host.startsWith('.') ? host : '.' + host;
        const expiry = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
        return [domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', expiry, c.name, c.value ?? ''].join('\t');
      });
  } else if (cookie) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    // Ayrıntı bilinmiyor: çerezler sitenin tamamı için geçerli sayılır (ör. www.instagram.com → .instagram.com)
    const domain = '.' + host.split('.').slice(-2).join('.');
    lines = [];
    for (const part of String(cookie).split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      lines.push([domain, 'TRUE', '/', 'TRUE', '2147483647', part.slice(0, i).trim(), part.slice(i + 1).trim()].join('\t'));
    }
  }
  if (!lines?.length) return null;
  const file = path.join(os.tmpdir(), `grabbit-cookies-${crypto.randomUUID()}.txt`);
  await fsp.writeFile(file, ['# Netscape HTTP Cookie File', ...lines].join('\n') + '\n', { mode: 0o600 });
  return file;
}

function commonArgs({ cookieFile, referer, userAgent }) {
  const a = ['--no-playlist', '--no-colors', '--no-warnings', '--encoding', 'utf-8'];
  if (cookieFile) a.push('--cookies', cookieFile);
  if (referer) a.push('--referer', referer);
  if (userAgent) a.push('--user-agent', userAgent);
  return a;
}

function run(tools, args, { timeout = 90000 } = {}) {
  const { cmd, args: pre, env } = tools.command();
  return new Promise((resolve, reject) => {
    execFile(cmd, [...pre, ...args], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env }, (err, stdout, stderr) => {
      if (err) return reject(mediaError(stderr || err.message));
      resolve(stdout);
    });
  });
}

const isYouTube = (url) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(hostOf(url));
const AUTH_ERRORS = new Set(['media.errLogin', 'media.errBot', 'media.errAge', 'media.errMembers', 'media.errPrivate']);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Çerezlerin hangi sırayla deneneceği. YouTube herkese açık videolarda çerez istemez ve tarayıcıdan
 * alınan oturum çerezlerini sık sık reddeder ("sayfayı yenileyin"): orada önce çerezsiz denenir.
 * Diğer sitelerde (Instagram vb.) giriş çoğu zaman gerekli: önce çerezle.
 */
function cookieAttempts(url, hasCookies) {
  if (!hasCookies) return [false];
  return isYouTube(url) ? [false, true] : [true, false];
}

// Yoklamada yt-dlp'nin verdiği tam bilgi (biçimler ve adresleriyle). İndirme başlarken --load-info-json ile
// geri verilir: sayfa ikinci kez çözülmez (YouTube'da ~2-3 sn kazanç). Adresler zamanla geçersizleşir.
const INFO_TTL = 20 * 60 * 1000;
const INFO_MAX = 8;
const infoCache = new Map(); // adres → { json, at, usedCookies }

function rememberInfo(url, json, usedCookies) {
  infoCache.delete(url);
  infoCache.set(url, { json, at: Date.now(), usedCookies });
  while (infoCache.size > INFO_MAX) infoCache.delete(infoCache.keys().next().value);
}

function cachedInfo(url) {
  const e = infoCache.get(url);
  if (e && Date.now() - e.at < INFO_TTL) return e;
  infoCache.delete(url);
  return null;
}

/** Sayfadaki videonun başlığını, süresini ve indirilebilir kalitelerini öğrenir. */
async function probeMedia(tools, url, { cookie, jar, referer, userAgent } = {}) {
  if (!tools.ready) {
    const err = new AppError('err.engineMissing');
    err.code = 'TOOLS_MISSING';
    throw err;
  }
  let firstError = null;
  const attempts = cookieAttempts(url, !!(cookie || jar?.length));
  for (let i = 0; i < attempts.length; i++) {
    const withCookies = attempts[i];
    const cookieFile = withCookies ? await writeCookieFile(cookie, url, jar) : null;
    try {
      const out = await run(tools, ['-J', ...commonArgs({ cookieFile, referer, userAgent }), url]);
      const info = JSON.parse(out);
      let result;
      if (info._type === 'playlist' && !info.formats) {
        const first = (info.entries || []).find(Boolean);
        if (!first) throw new AppError('media.errNoVideo');
        result = summarize(first, url);
        if (first.formats) rememberInfo(url, JSON.stringify(first), withCookies);
      } else {
        result = summarize(info, url);
        rememberInfo(url, out, withCookies);
      }
      return { ...result, usedCookies: withCookies };
    } catch (err) {
      firstError = firstError || err;
      const last = i === attempts.length - 1;
      // Çerezli deneme başarısızsa çerezsiz dene; çerezsiz deneme yalnızca giriş gerekiyorsa çerezle tekrarlanır
      const retry = !last && (withCookies || AUTH_ERRORS.has(err.key));
      if (!retry) throw last && err.key === 'media.errGeneric' ? firstError : err;
    } finally {
      // Oturum çerezleri diskte beklemesin
      if (cookieFile) await fsp.rm(cookieFile, { force: true }).catch(() => {});
    }
  }
  throw firstError;

}

function summarize(info, url) {
  const formats = info.formats || [];
  const audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudioSize = Math.max(0, ...audio.map((f) => f.filesize || f.filesize_approx || 0));
  // Her görüntü biçimini bir kalite kovasına yerleştir. yt-dlp'nin "res" ölçüsü gibi kısa kenarı
  // kullanırız: dikey 1080x1920 bir video da "1080p" olur.
  const video = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && (f.height || f.width));
  const bucketOf = (f) => {
    const p = f.width && f.height ? Math.min(f.width, f.height) : f.height || f.width;
    return QUALITIES.find((q) => p >= Number(q) * 0.95) || null;
  };
  const qualities = [];
  for (const q of QUALITIES) {
    const inBucket = video.filter((f) => bucketOf(f) === q);
    if (!inBucket.length) continue;
    const best = inBucket.sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0))[0];
    const v = best.filesize || best.filesize_approx || 0;
    const merged = !best.acodec || best.acodec === 'none' ? v + bestAudioSize : v;
    qualities.push({ id: q, label: `${q}p`, size: merged || null });
  }
  const hasVideo = video.length > 0 || formats.some((f) => f.vcodec && f.vcodec !== 'none');
  if (!qualities.length && hasVideo) qualities.push({ id: 'best', label: 'best', size: info.filesize_approx || null });
  if (audio.length || !hasVideo) qualities.push({ id: 'audio', label: 'audio', size: bestAudioSize || null });
  return {
    kind: 'media',
    url: info.webpage_url || url,
    title: info.title || info.id || 'video',
    site: info.extractor_key || info.extractor || '',
    uploader: info.uploader || info.channel || '',
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    qualities,
    isLive: !!info.is_live
  };
}

/** Kalite seçimine göre yt-dlp biçim argümanları. */
function formatArgs(quality) {
  if (quality === 'audio') return { ext: 'mp3', args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'] };
  const sort = quality === 'best' ? 'res,vcodec:h264,ext:mp4:m4a' : `res:${quality},vcodec:h264,ext:mp4:m4a`;
  // Çözünürlük önce gelir (en yüksek ≤ seçilen); eşitlikte uyumlu H.264/MP4 tercih edilir
  return { ext: 'mp4', args: ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4'] };
}

/** Windows'ta yt-dlp ve başlattığı ffmpeg'i birlikte sonlandırır. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * YouTube, Instagram, TikTok vb. sitelerden video indirmesi (yt-dlp ile).
 * Duraklatınca süreç kapatılır; devam edince yt-dlp yarım `.part` dosyalarından sürdürür.
 */
class MediaDownload extends Download {
  constructor(data, ctx) {
    super({ kind: 'media', quality: '1080', title: '', resumable: true, ...data }, ctx);
    this.kind = 'media';
    this.phase = null;
    this._phases = new Map();
  }

  get ext() {
    return formatArgs(this.quality).ext;
  }

  /** yt-dlp çıktısı için uzantısız taban yol. */
  get basePath() {
    return path.join(this.dir, this.filename.replace(/\.[^.]+$/, ''));
  }

  toJSON() {
    return { ...super.toJSON(), kind: 'media', quality: this.quality, title: this.title, downloaded: this.downloaded, useCookies: this.useCookies };
  }

  snapshot() {
    const s = super.snapshot();
    s.kind = 'media';
    s.quality = this.quality;
    s.title = this.title;
    s.phase = this.phase;
    s.resumable = true;
    s.estimated = this.status !== 'completed';
    s.segments = this.size > 0 ? [[0, this.size - 1, Math.min(this.downloaded, this.size), this.status === 'downloading' ? 1 : 0]] : [];
    s.progress = this.status === 'completed' ? 1 : this.size > 0 ? Math.min(1, this.downloaded / this.size) : null;
    s.activeConnections = this._child ? 1 : 0;
    return s;
  }

  resetProgress() {
    super.resetProgress();
    this.size = -1;
    this._phases = new Map();
  }

  async cleanupTemp() {
    if (!this.dir) return;
    const base = path.basename(this.basePath);
    const files = await fsp.readdir(this.dir).catch(() => []);
    await Promise.all(
      files
        .filter((f) => f.startsWith(base + '.') && /\.(part|ytdl|temp\.\w+|f\d+[\w-]*\.\w+)$|\.part-Frag\d+/.test(f))
        .map((f) => fsp.rm(path.join(this.dir, f), { force: true }).catch(() => {}))
    );
  }

  async _run() {
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this.status = 'downloading';
    this.error = null;
    this.errorKey = null;
    this.errorParams = null;
    this.phase = 'phase.preparing';
    this.history = [];
    this.emit('change');
    let cookieFile = null;
    let printFile = null;
    let infoFile = null;
    try {
      const tools = this.ctx.tools;
      if (!tools?.ready) throw fatal('err.engineMissingSettings');
      if (!this.probed) {
        const info = await probeMedia(tools, this.url, { cookie: this.auth?.cookie, jar: this.auth?.jar, referer: this.headers?.referer, userAgent: this.headers?.userAgent });
        this.useCookies = info.usedCookies;
        if (info.isLive) throw fatal('err.live');
        this.title = info.title;
        this.probed = true;
        const est = info.qualities.find((q) => q.id === this.quality)?.size;
        if (est) this.size = est;
        if (this.autoName) await this.ctx.assignPath(this, `${info.title}.${this.ext}`);
        this.emit('change');
      }
      if (signal.aborted) return;
      this._estimate = this.size > 0 ? this.size : 0;
      await fsp.mkdir(this.dir, { recursive: true });
      // Yoklamada çerezsiz çalıştıysa indirmede de çerez gönderme (YouTube oturum hatasını önler)
      cookieFile = this.useCookies === false ? null : await writeCookieFile(this.auth?.cookie, this.url, this.auth?.jar);
      printFile = path.join(os.tmpdir(), `grabbit-path-${this.id}.txt`);
      await fsp.rm(printFile, { force: true });

      const fmt = formatArgs(this.quality);
      // Çıktı şablonunda % özel karakterdir
      const out = this.basePath.replace(/%/g, '%%') + '.%(ext)s';
      const limit = minPositive(this.speedLimit, this.ctx.settings.speedLimit);
      const args = [
        ...commonArgs({ cookieFile, referer: this.headers?.referer, userAgent: this.headers?.userAgent }),
        ...fmt.args,
        '-o', out,
        '--newline',
        '--continue',
        '--no-mtime',
        '--ffmpeg-location', this.ctx.tools.ffmpegDir,
        '-N', String(Math.max(1, Math.min(this.connections, 16))),
        '--progress-template', 'download:TIPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s',
        '--print-to-file', 'after_move:%(filepath)s', printFile
      ];
      if (limit) args.push('-r', `${limit}K`);

      // Yeni yoklandıysa sayfayı yeniden çözme; kayıtlı bilgi işe yaramazsa (süresi dolmuş adres) adresle dene
      const cached = cachedInfo(this.url);
      if (cached && cached.usedCookies === !!cookieFile) {
        infoFile = path.join(os.tmpdir(), `grabbit-info-${this.id}.json`);
        await fsp.writeFile(infoFile, cached.json);
        try {
          await this._spawn([...args, '--load-info-json', infoFile], signal);
        } catch (err) {
          if (signal.aborted) throw err;
          infoCache.delete(this.url);
          await this._spawn([...args, this.url], signal);
        }
      } else {
        await this._spawn([...args, this.url], signal);
      }
      if (signal.aborted) return;

      const finalPath = (await fsp.readFile(printFile, 'utf8').catch(() => '')).trim().split(/\r?\n/).pop();
      if (!finalPath || !fs.existsSync(finalPath)) throw new AppError('media.errNoOutput');
      const st = await fsp.stat(finalPath);
      this.dir = path.dirname(finalPath);
      this.filename = path.basename(finalPath);
      this.size = st.size;
      this.downloaded = st.size;
      this.phase = null;
      this.status = 'completed';
      this.completedAt = Date.now();
      this.emit('completed');
    } catch (err) {
      if (signal.aborted && !err?.fatal) return;
      this.status = 'error';
      this.error = err.message;
      this.errorKey = err.key || null;
      this.errorParams = err.params || null;
      this.phase = null;
      this.emit('failed');
    } finally {
      if (cookieFile) await fsp.rm(cookieFile, { force: true }).catch(() => {});
      if (printFile) await fsp.rm(printFile, { force: true }).catch(() => {});
      if (infoFile) await fsp.rm(infoFile, { force: true }).catch(() => {});
      this._child = null;
      if (this.status !== 'downloading') this.phase = null;
      this.speed = 0;
      this.eta = null;
      this.emit('change');
    }
  }

  _spawn(args, signal) {
    const { cmd, args: pre, env } = this.ctx.tools.command();
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, [...pre, ...args], { windowsHide: true, env: { ...env, PYTHONIOENCODING: 'utf-8' } });
      this._child = child;
      const onAbort = () => killTree(child);
      signal.addEventListener('abort', onAbort, { once: true });
      let lastError = '';
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          this._line(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) if (/^ERROR:/i.test(line)) lastError = line;
      });
      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(new AppError('media.errSpawn', { detail: err.message }));
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return resolve();
        if (code === 0) return resolve();
        reject(mediaError(lastError || `yt-dlp exited with code ${code}`));
      });
    });
  }

  _line(line) {
    if (line.startsWith('TIPROG ')) {
      const [, done, total, estimate, formatId] = line.split(' ');
      const n = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : 0);
      // Görüntü ve ses ayrı akışlar: her birinin ilerlemesini ayrı tut, toplamı göster
      this._phases.set(formatId || '?', { done: n(done), total: n(total) || n(estimate) });
      let d = 0;
      let t = 0;
      for (const p of this._phases.values()) {
        d += p.done;
        t += Math.max(p.total, p.done);
      }
      this.downloaded = d;
      // Ses akışı başlamadan toplam bilinmez: yoklamadaki tahminin altına düşme
      if (t > 0) this.size = Math.max(t, this._estimate || 0);
      if (this.phase !== 'phase.downloading') {
        this.phase = 'phase.downloading';
        this.emit('change');
      }
      return;
    }
    let phase = null;
    if (line.startsWith('[Merger]')) phase = 'phase.merging';
    else if (line.startsWith('[ExtractAudio]')) phase = 'phase.extracting';
    else if (line.startsWith('[FixupM3u8]') || line.startsWith('[VideoConvertor]') || line.startsWith('[FixupM4a]')) phase = 'phase.fixing';
    if (phase && phase !== this.phase) {
      this.phase = phase;
      this.emit('change');
    }
  }
}

function minPositive(...vals) {
  const v = vals.map(Number).filter((x) => x > 0);
  return v.length ? Math.min(...v) : 0;
}

module.exports = { MediaDownload, probeMedia, isMediaSiteUrl, formatArgs, mediaError, writeCookieFile, MEDIA_HOSTS };
