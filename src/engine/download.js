'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { RateLimiter } = require('./limiter');
const { request, probe, discard } = require('./http');
const { PART_EXT, AppError, HttpError, fatal, exists, sleep, humanizeError, errorInfo, parseContentRange } = require('./utils');

const MIN_SEGMENT = 1024 * 1024; // ilk bölmede bağlantı başına en az 1 MB
const MIN_SPLIT = 1024 * 1024; // dinamik bölmede her iki yarı en az 1 MB kalmalı
const STALL_MS = 30000; // bu süre veri gelmezse bağlantı yenilenir
const STALL_CHECK_MS = 2000;
const WRITE_BUFFER = 512 * 1024; // diske en az bu büyüklükte bloklar halinde yaz
const FLUSH_MS = 250; // yavaş bağlantıda ilerleme görünsün diye en geç bu sürede yaz
const HISTORY = 60;

const PERSISTED = [
  'id', 'url', 'finalUrl', 'filename', 'dir', 'customDir', 'autoName', 'category', 'size', 'resumable',
  'probed', 'status', 'error', 'errorKey', 'errorParams', 'segments', 'connections', 'speedLimit', 'headers', 'auth', 'checksum',
  'createdAt', 'completedAt'
];

class Download extends EventEmitter {
  constructor(data, ctx) {
    super();
    this.ctx = ctx;
    Object.assign(this, {
      finalUrl: null,
      filename: 'indirme',
      dir: '',
      customDir: null,
      autoName: true,
      category: 'other',
      size: -1,
      resumable: false,
      probed: false,
      status: 'queued',
      error: null,
      segments: [],
      connections: 8,
      speedLimit: 0,
      headers: {},
      auth: {},
      checksum: null,
      createdAt: Date.now(),
      completedAt: null
    }, data);
    for (const s of this.segments) delete s.active;
    this.downloaded = this.segments.reduce((a, s) => a + s.downloaded, 0);
    this.speed = 0;
    this.eta = null;
    this.history = [];
    this.hashProgress = null;
    this._limiter = new RateLimiter(this.speedLimit * 1024);
    this._running = null;
    this._abort = null;
  }

  get savePath() {
    return path.join(this.dir, this.filename);
  }

  get tempPath() {
    return this.savePath + PART_EXT;
  }

  get isRunning() {
    return !!this._running;
  }

  toJSON() {
    const o = {};
    for (const k of PERSISTED) o[k] = this[k];
    o.segments = this.segments.map(({ start, end, downloaded, finished }) => ({ start, end, downloaded, finished }));
    return o;
  }

  snapshot() {
    return {
      id: this.id,
      kind: 'file',
      progress: this.status === 'completed' ? 1 : this.size > 0 ? this.downloaded / this.size : null,
      url: this.url,
      finalUrl: this.finalUrl,
      filename: this.filename,
      dir: this.dir,
      savePath: this.savePath,
      category: this.category,
      size: this.size,
      downloaded: this.downloaded,
      status: this.status,
      error: this.error,
      errorKey: this.errorKey,
      errorParams: this.errorParams,
      resumable: this.resumable,
      probed: this.probed,
      connections: this.connections,
      activeConnections: this.segments.filter((s) => s.active).length,
      speed: this.speed,
      eta: this.eta,
      speedLimit: this.speedLimit,
      checksum: this.checksum,
      hashProgress: this.hashProgress,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      hasCookies: !!this.auth?.cookie,
      segments: this._compactSegments(),
      history: this.status === 'downloading' ? this.history.slice() : []
    };
  }

  /** Arayüz için: bitişik tamamlanmış parçaları birleştirir, [başlangıç, bitiş, inen, aktif] döner. */
  _compactSegments() {
    const out = [];
    const sorted = [...this.segments].sort((a, b) => a.start - b.start);
    for (const s of sorted) {
      const done = this._segDone(s);
      const prev = out[out.length - 1];
      if (done && prev && prev[4] && prev[1] + 1 === s.start) {
        prev[1] = s.end;
        prev[2] += s.downloaded;
        continue;
      }
      out.push([s.start, s.end, s.downloaded, !!s.active, done]);
    }
    return out.slice(0, 256).map(([a, b, c, d]) => [a, b, c, d ? 1 : 0]);
  }

  setSpeedLimit(kbps) {
    this.speedLimit = Math.max(0, Number(kbps) || 0);
    this._limiter.setRate(this.speedLimit * 1024);
    this.emit('change');
  }

  start() {
    if (!this._running) {
      this._running = this._run().finally(() => {
        this._running = null;
        this.emit('settled');
      });
    }
    return this._running;
  }

  /** Çalışan indirmeyi durdurur; durum `nextStatus` olarak kalır. */
  async stop(nextStatus = 'paused') {
    if (this._running) {
      this.status = nextStatus;
      this._abort.abort();
      await this._running;
    } else if (this.status !== 'completed') {
      this.status = nextStatus;
    }
    this.speed = 0;
    this.eta = null;
    this.emit('change');
  }

  async cleanupTemp() {
    await fsp.unlink(this.tempPath).catch(() => {});
  }

  resetProgress() {
    this.segments = [];
    this.downloaded = 0;
    this.probed = false;
    this.finalUrl = null;
    this.error = null;
    this.errorKey = null;
    this.errorParams = null;
    this.completedAt = null;
    this.checksum = this.checksum?.expected ? { algo: this.checksum.algo, expected: this.checksum.expected } : null;
  }

  async _run() {
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this.status = 'downloading';
    this.error = null;
    this.errorKey = null;
    this.errorParams = null;
    this._fatal = null;
    this._connLimit = this.connections;
    this._reresolved = false;
    this.history = [];
    this.emit('change');

    let fh = null;
    try {
      if (!this.probed) {
        const info = await probe(this.url, { headers: this.headers, auth: this.auth, signal });
        this.finalUrl = info.finalUrl;
        this.size = info.size;
        this.resumable = info.resumable;
        this.probed = true;
        this.segments = [];
        if (this.autoName) await this.ctx.assignPath(this, info.filename);
        this.emit('change');
      }
      await fsp.mkdir(this.dir, { recursive: true });
      const hasPart = await exists(this.tempPath);
      if (!hasPart || !this.resumable) {
        // Devam edilemiyorsa ya da geçici dosya silinmişse baştan başla
        this.segments = [];
        this.downloaded = 0;
      }
      if (!this.segments.length) this._initSegments();
      fh = await fsp.open(this.tempPath, hasPart && this.resumable ? 'r+' : 'w+');
      this._fh = fh;

      await this._runSegments(signal);
      if (this._fatal) throw this._fatal;
      if (signal.aborted) return;

      await fh.close();
      fh = null;
      await this._finalize();
    } catch (err) {
      if (signal.aborted && !this._fatal) return;
      this.status = 'error';
      const failure = this._fatal || err;
      const info = errorInfo(failure);
      this.error = humanizeError(failure);
      this.errorKey = info?.key || null;
      this.errorParams = info?.params || null;
      this.emit('failed');
    } finally {
      if (fh) await fh.close().catch(() => {});
      this._fh = null;
      for (const s of this.segments) s.active = false;
      this.speed = 0;
      this.eta = null;
      this.emit('change');
    }
  }

  _initSegments() {
    this.segments = [];
    if (this.resumable && this.size > 0) {
      const n = Math.max(1, Math.min(this.connections, Math.ceil(this.size / MIN_SEGMENT)));
      const step = Math.floor(this.size / n);
      for (let i = 0; i < n; i++) {
        this.segments.push({
          start: i * step,
          end: i === n - 1 ? this.size - 1 : (i + 1) * step - 1,
          downloaded: 0
        });
      }
    } else {
      this.segments.push({ start: 0, end: this.size > 0 ? this.size - 1 : -1, downloaded: 0 });
    }
  }

  _segDone(s) {
    return !!s.finished || (s.end >= 0 && s.downloaded >= s.end - s.start + 1);
  }

  _activeCount() {
    return this.segments.filter((s) => s.active).length;
  }

  async _runSegments(signal) {
    const workers = new Set();
    const launch = (seg) => {
      seg.active = true;
      const p = this._segmentWorker(seg, signal)
        .catch((err) => this._fail(err))
        .finally(() => {
          seg.active = false;
          workers.delete(p);
        });
      workers.add(p);
    };
    const fill = () => {
      for (const s of this.segments) {
        if (workers.size >= this._connLimit) return;
        if (!s.active && !this._segDone(s)) launch(s);
      }
      // IDM tarzı dinamik bölümleme: boşalan bağlantı, en çok işi kalan parçanın yarısını devralır
      while (workers.size < this._connLimit) {
        const seg = this._split();
        if (!seg) break;
        launch(seg);
      }
    };

    fill();
    while (workers.size && !signal.aborted) {
      await Promise.race(workers);
      if (!signal.aborted) fill();
    }
    if (workers.size) await Promise.allSettled([...workers]);
  }

  _split() {
    if (!this.resumable || this.size <= 0) return null;
    let best = null;
    let bestRem = 0;
    for (const s of this.segments) {
      if (!s.active || s.end < 0) continue;
      const rem = s.end - (s.start + s.downloaded) + 1;
      if (rem > bestRem) {
        best = s;
        bestRem = rem;
      }
    }
    if (!best || bestRem < 2 * MIN_SPLIT) return null;
    const mid = best.start + best.downloaded + Math.floor(bestRem / 2);
    const seg = { start: mid, end: best.end, downloaded: 0 };
    best.end = mid - 1;
    this.segments.splice(this.segments.indexOf(best) + 1, 0, seg);
    return seg;
  }

  _fail(err) {
    if (!this._fatal) {
      this._fatal = err;
      this._abort.abort();
    }
  }

  async _segmentWorker(seg, signal) {
    let attempt = 0;
    while (!signal.aborted && !this._segDone(seg)) {
      try {
        await this._fetchSegment(seg, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (
          err instanceof HttpError &&
          [401, 403, 404, 410].includes(err.status) &&
          this.finalUrl &&
          this.finalUrl !== this.url &&
          !this._reresolved
        ) {
          // Yönlendirilen adresin süresi dolmuş olabilir: asıl adresten yeniden çözümle
          this._reresolved = true;
          this.finalUrl = null;
          continue;
        }
        if (err.fatal) return this._fail(err);
        if (err.bytes > 0) attempt = 0;
        attempt++;
        if (attempt > this.ctx.settings.retries) {
          // Sunucu fazla bağlantıyı reddediyor olabilir: diğerleri çalışıyorsa bu bağlantıyı bırak
          if (this._activeCount() > 1) {
            this._connLimit = Math.max(1, this._activeCount() - 1);
            return;
          }
          return this._fail(err);
        }
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000), signal);
      }
    }
  }

  async _fetchSegment(seg, signal) {
    if (!this.resumable && seg.downloaded > 0) {
      // Devam desteklenmiyor: bu bağlantı koptuysa baştan başlamak zorundayız
      this.downloaded -= seg.downloaded;
      seg.downloaded = 0;
      await this._fh.truncate(0);
    }
    const pos0 = seg.start + seg.downloaded;
    const range = this.resumable ? `bytes=${pos0}-${seg.end >= 0 ? seg.end : ''}` : undefined;

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Takılma denetimi: her parçada zamanlayıcı kurup bozmak yerine tek bir aralıkla son veri zamanına bak
    let stalled = false;
    let lastData = Date.now();
    let throttled = false; // hız sınırı beklemesi takılma sayılmaz
    const watchdog = setInterval(() => {
      if (!throttled && Date.now() - lastData > STALL_MS) {
        stalled = true;
        ctrl.abort();
      }
    }, STALL_CHECK_MS);
    let bytes = 0;
    let res = null;

    // Küçük ağ parçalarını biriktirip daha büyük bloklar halinde diske yaz
    let pos = pos0; // diske yazılmış son konumun bir sonrası
    const pending = [];
    let pendingLen = 0;
    let lastFlush = Date.now();
    const flush = async () => {
      if (!pendingLen) return;
      let buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
      pending.length = 0;
      pendingLen = 0;
      lastFlush = Date.now();
      if (seg.end >= 0) {
        // Parça biriktirme sırasında bölünmüş olabilir: güncel sona göre kırp
        const allowed = seg.end - pos + 1;
        if (allowed <= 0) return;
        if (buf.length > allowed) buf = buf.subarray(0, allowed);
      }
      await this._fh.write(buf, 0, buf.length, pos);
      pos += buf.length;
      bytes += buf.length;
      seg.downloaded += buf.length;
      this.downloaded += buf.length;
    };

    try {
      const r = await request(this.finalUrl || this.url, {
        headers: this.headers,
        auth: this.auth,
        signal: ctrl.signal,
        range
      });
      res = r.res;
      if (!this.finalUrl) this.finalUrl = r.finalUrl;

      if (this.resumable) {
        if (res.status === 206) {
          const cr = parseContentRange(res.headers.get('content-range'));
          if (cr && cr.start !== pos0) throw fatal('err.wrongRange');
          if (cr && cr.total >= 0 && this.size > 0 && cr.total !== this.size) {
            throw fatal('err.fileChanged');
          }
        } else if (res.ok && !(pos0 === 0 && this.segments.length === 1)) {
          throw fatal('err.noLongerResumable');
        } else if (!res.ok) {
          throw new HttpError(res.status);
        }
      } else if (!res.ok) {
        throw new HttpError(res.status);
      }

      const reader = res.body.getReader();
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
        if (ctrl.signal.aborted) break;
        let chunk = value;
        const next = pos + pendingLen;
        if (seg.end >= 0) {
          const allowed = seg.end - next + 1;
          if (allowed <= 0) break;
          if (chunk.length > allowed) chunk = chunk.subarray(0, allowed);
        }
        pending.push(chunk);
        pendingLen += chunk.length;
        if (pendingLen >= WRITE_BUFFER || lastData - lastFlush >= FLUSH_MS) await flush();
        if (seg.end >= 0 && pos + pendingLen > seg.end) break;
      }
      // Duraklatmada da gelen veriyi diske yaz: tekrar indirilmesin
      await flush();

      if (signal.aborted || ctrl.signal.aborted) {
        if (stalled && !signal.aborted) throw new AppError('err.stalled');
        return;
      }
      if (seg.end < 0) {
        // Boyutu bilinmeyen dosya: akış bittiyse dosya bitmiştir
        seg.finished = true;
        seg.end = pos - 1;
        this.size = pos;
      } else if (!this._segDone(seg)) {
        throw new AppError('err.closedEarly');
      }
    } catch (err) {
      // Bağlantı koptuysa o ana kadar gelen geçerli veriyi kaybetme
      await flush().catch(() => {});
      const e = stalled && !signal.aborted ? new AppError('err.stalled') : err;
      if (e && typeof e === 'object') {
        try {
          e.bytes = bytes;
        } catch { /* salt okunur hata nesnesi */ }
      }
      throw e;
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener('abort', onAbort);
      if (res) await discard(res);
      ctrl.abort();
    }
  }

  async _finalize() {
    const st = await fsp.stat(this.tempPath);
    if (this.size > 0) {
      if (st.size < this.size) throw new Error('Dosya eksik indi — tekrar deneyin');
      if (st.size > this.size) await fsp.truncate(this.tempPath, this.size);
    } else {
      this.size = st.size;
    }
    const finalPath = await this.ctx.finalPath(this);
    // Antivirüs dosyayı kısa süre kilitleyebilir: birkaç kez dene
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(this.tempPath, finalPath);
        break;
      } catch (err) {
        if (i >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
        await sleep(400 * (i + 1));
      }
    }
    this.filename = path.basename(finalPath);
    this.segments = [{ start: 0, end: this.size - 1, downloaded: this.size, finished: true }];
    this.downloaded = this.size;
    this.status = 'completed';
    this.completedAt = Date.now();
    this.emit('completed');
    if (this.checksum?.expected) await this.computeHash(this.checksum.algo);
  }

  async computeHash(algo = 'sha256') {
    if (this.status !== 'completed') throw new AppError('err.notCompleted');
    this.status = 'verifying';
    this.hashProgress = 0;
    this.emit('change');
    try {
      const hash = crypto.createHash(algo);
      const total = (await fsp.stat(this.savePath)).size || 1;
      let read = 0;
      let lastEmit = 0;
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(this.savePath, { highWaterMark: 1024 * 1024 });
        stream.on('data', (buf) => {
          hash.update(buf);
          read += buf.length;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            this.hashProgress = read / total;
            this.emit('change');
          }
        });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      const actual = hash.digest('hex');
      const expected = this.checksum?.algo === algo ? this.checksum.expected : null;
      this.checksum = {
        algo,
        expected: expected || null,
        actual,
        ok: expected ? expected.toLowerCase() === actual : null
      };
      return this.checksum;
    } finally {
      this.status = 'completed';
      this.hashProgress = null;
      this.emit('change');
    }
  }

  /** Saniyede bir yöneticiden çağrılır: hız, kalan süre ve hız geçmişini günceller. */
  sample() {
    if (this.status !== 'downloading') {
      this._last = this.downloaded;
      this._samples = [];
      this.speed = 0;
      this.eta = null;
      return;
    }
    const delta = Math.max(0, this.downloaded - (this._last ?? this.downloaded));
    this._last = this.downloaded;
    this._samples = [...(this._samples || []), delta].slice(-5);
    this.speed = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    this.history.push(delta);
    if (this.history.length > HISTORY) this.history.shift();
    this.eta = this.speed > 0 && this.size > 0 ? Math.max(0, (this.size - this.downloaded) / this.speed) : null;
  }
}

module.exports = { Download };
