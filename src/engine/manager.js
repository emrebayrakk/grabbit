'use strict';

const EventEmitter = require('events');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Download } = require('./download');
const { HlsDownload, probeHls } = require('./hls');
const { MediaDownload, probeMedia, isMediaSiteUrl } = require('./media');
const { Tools } = require('./tools');
const { fullSizeCandidates } = require('./fullsize');
const I18N = require('../../i18n/i18n');
const { RateLimiter } = require('./limiter');
const { probe, originOf } = require('./http');
const {
  CATEGORIES,
  PART_EXT,
  categoryOf,
  sanitizeFilename,
  filenameFromUrl,
  uniquePath,
  exists,
  humanizeError,
  AppError
} = require('./utils');

const DEFAULT_SETTINGS = {
  downloadDir: '',
  categorize: true,
  maxConcurrent: 3,
  connections: 8,
  speedLimit: 0, // KB/s, 0 = sınırsız
  retries: 5,
  resumeOnStart: true,
  minimizeToTray: true,
  notifications: true,
  clipboardWatch: true,
  theme: 'system',
  language: 'system', // 'system' ya da dil kodu (en, tr, de, es, fr, ru)
  bridgeEnabled: true,
  bridgePort: 17890,
  askOnBridge: true,
  showProgressWindow: true,
  fullSizeImages: true, // küçük önizleme görsellerin (=s64, s64x64, name=small…) orijinal boyutunu indir
  mediaQuality: '1080', // video sitelerinde varsayılan kalite: 2160/1440/1080/720/480/360/best/audio
  schedule: { enabled: false, start: '02:00', stop: '' }
};

class DownloadManager extends EventEmitter {
  constructor({ dataDir, defaultDownloadDir, trashItem }) {
    super();
    this.dataDir = dataDir;
    this.defaultDownloadDir = defaultDownloadDir;
    this.trashItem = trashItem || ((p) => fsp.unlink(p));
    this.downloads = new Map();
    this.settings = { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir };
    this.limiter = new RateLimiter(0);
    this.tools = new Tools(dataDir);
    this._saveTimer = null;
    this._lastProgressSave = 0;
    this.progressSaveMs = PROGRESS_SAVE_MS;
    this._scheduleFired = '';
    // Ad seçimi sırayla yapılır; henüz listeye girmemiş eklemeler de ayrılmış sayılır
    this._pathLock = Promise.resolve();
    this._adding = new Set();
    this._probes = new Map(); // yoklama önbelleği: anahtar → { at, ttl, promise }
    this._ctx = {
      settings: this.settings,
      limiter: this.limiter,
      tools: this.tools,
      assignPath: (d, name) => this._assignPath(d, name),
      finalPath: (d) => this._finalPath(d)
    };
  }

  get _downloadsFile() {
    return path.join(this.dataDir, 'downloads.json');
  }

  get _settingsFile() {
    return path.join(this.dataDir, 'settings.json');
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const saved = await readJson(this._settingsFile, {});
    Object.assign(this.settings, saved, { schedule: { ...DEFAULT_SETTINGS.schedule, ...(saved.schedule || {}) } });
    if (!this.settings.downloadDir) this.settings.downloadDir = this.defaultDownloadDir;
    this.limiter.setRate(this.settings.speedLimit * 1024);

    const list = await readJson(this._downloadsFile, []);
    for (const data of list) {
      if (['downloading', 'queued', 'verifying'].includes(data.status)) {
        data.status = data.status === 'verifying' ? 'completed' : this.settings.resumeOnStart ? 'queued' : 'paused';
      }
      this._register(this._create(data));
    }
    this._tick = setInterval(() => this._onTick(), 1000);
    this._schedule();
  }

  _create(data) {
    if (data.kind === 'hls') return new HlsDownload(data, this._ctx);
    if (data.kind === 'media') return new MediaDownload(data, this._ctx);
    return new Download(data, this._ctx);
  }

  _register(d) {
    this.downloads.set(d.id, d);
    d.on('change', () => this._changed());
    d.on('settled', () => {
      this._changed();
      this._schedule();
    });
    d.on('completed', () => this.emit('completed', d.snapshot()));
    d.on('failed', () => this.emit('failed', d.snapshot()));
  }

  _changed() {
    this.emit('change');
    this._saveSoon();
  }

  list() {
    return [...this.downloads.values()].map((d) => d.snapshot());
  }

  stats() {
    let speed = 0;
    let active = 0;
    let total = 0;
    let done = 0;
    for (const d of this.downloads.values()) {
      if (d.status !== 'downloading') continue;
      active++;
      speed += d.speed;
      if (d.size > 0) {
        total += d.size;
        done += d.downloaded;
      }
    }
    return { speed, active, progress: total > 0 ? done / total : active ? -1 : null };
  }

  // ---- ekleme ----

  /**
   * Yoklama sonuçları kısa süre saklanır: tarayıcıdan gelen istekte yoklama pencere açılırken başlar,
   * video düğmesine gelince önceden yapılır; pencere ya da indirme aynı işi tekrar beklemez.
   */
  probe(url, headers = {}, cookie = '', kind, jar) {
    const u = normalizeUrl(url);
    const media = kind === 'media' || (!kind && isMediaSiteUrl(u));
    const key = [kind || '', u, !!(cookie || jar?.length), this.settings.fullSizeImages].join('\n');
    const hit = this._probes.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
    const promise = this._probe(u, headers, cookie, kind, jar);
    const entry = { at: Date.now(), ttl: media ? PROBE_TTL_MEDIA : PROBE_TTL_FILE, promise };
    this._probes.set(key, entry);
    // Hatalar saklanmaz: bir sonraki deneme yeniden yoklar
    promise.catch(() => this._probes.get(key) === entry && this._probes.delete(key));
    while (this._probes.size > 50) this._probes.delete(this._probes.keys().next().value);
    return promise;
  }

  async _probe(u, headers, cookie, kind, jar) {
    const auth = { cookie, origin: originOf(u) };
    if (kind === 'media' || (!kind && isMediaSiteUrl(u))) {
      const info = await probeMedia(this.tools, u, { cookie, jar, referer: headers.referer, userAgent: headers.userAgent });
      if (info.isLive) throw new AppError('err.live');
      const pick = info.qualities.find((q) => q.id === this.settings.mediaQuality) || info.qualities[0];
      const ext = pick?.id === 'audio' ? 'mp3' : 'mp4';
      return { ...info, filename: sanitizeFilename(`${info.title}.${ext}`), defaultQuality: pick?.id, size: pick?.size || -1, category: ext === 'mp3' ? 'music' : 'video' };
    }
    if (kind === 'hls' || isHlsUrl(u)) return this._probeHls(u, withOrigin(headers), auth);
    // Asıl adres, büyük sürüm adaylarıyla aynı anda yoklanır (büyüğü yoksa beklemeden hazır olsun)
    const plain = probe(u, { headers, auth });
    plain.catch(() => {});
    const up = await this._upgradeImage(u, headers, auth);
    if (up) return { ...up.info, kind: 'file', category: categoryOf(up.info.filename), upgradedUrl: up.url, upgradedFrom: u };
    const info = await plain;
    if (/mpegurl/i.test(info.contentType)) return this._probeHls(u, withOrigin(headers), auth);
    return { ...info, kind: 'file', category: categoryOf(info.filename) };
  }

  /**
   * Bilinen sitelerin küçük önizleme görselleri için büyük sürümü dener (ör. YouTube =s64 → =s0).
   * Yalnızca sunucu gerçekten bir görsel döndürürse kabul edilir; yoksa null (asıl adres kullanılır).
   */
  async _upgradeImage(url, headers, auth) {
    if (!this.settings.fullSizeImages) return null;
    // Adaylar aynı anda denenir; sonuç yine öncelik sırasıyla (en büyük önce) seçilir
    const tries = fullSizeCandidates(url)
      .slice(0, 4)
      .map((candidate) =>
        probe(candidate, { headers, auth, timeout: 8000 }).then(
          (info) => (/^image\//i.test(info.contentType) ? { url: candidate, info } : null),
          () => null // bu boyut yok
        )
      );
    for (const t of tries) {
      const found = await t;
      if (found) return found;
    }
    return null;
  }

  async _probeHls(u, headers, auth) {
    const info = await probeHls(u, { headers, auth });
    if (info.live) throw new AppError('err.live');
    return { ...info, filename: hlsFilename(null, u), size: -1, resumable: true, category: 'video' };
  }

  /**
   * entries: [{ url, filename?, dir?, connections?, startNow?, checksum?, headers?, cookie?, speedLimit?, probeInfo? }]
   */
  async add(entries) {
    // Toplu eklemede sunucuyu yüzlerce eşzamanlı yoklamayla boğmamak için en fazla 6 paralel
    const results = await mapLimit(entries, PROBE_CONCURRENCY, (e) =>
      this._addOne(e).catch((err) => ({ error: humanizeError(err), url: e.url }))
    );
    this._schedule();
    this._saveSoon();
    return results;
  }

  async _addOne(e) {
    const d = this._newDownload(e);
    this._adding.add(d);
    try {
      return await this._prepareAndRegister(d, e);
    } finally {
      this._adding.delete(d);
    }
  }

  _newDownload(e) {
    // Yoklamada görselin büyük sürümü bulunduysa onu indir
    const url = normalizeUrl(e.probeInfo?.upgradedUrl || e.url);
    const headers = {};
    if (e.headers?.referer) headers.referer = String(e.headers.referer);
    if (e.headers?.userAgent) headers.userAgent = String(e.headers.userAgent);
    const kind =
      e.kind === 'media' || e.probeInfo?.kind === 'media' || (!e.kind && isMediaSiteUrl(url))
        ? 'media'
        : e.kind === 'hls' || e.probeInfo?.kind === 'hls' || isHlsUrl(url)
          ? 'hls'
          : 'file';
    // HLS akışları oynatıcıda CORS ile çekilir: tarayıcı gibi Origin de gönder
    if (kind === 'hls') Object.assign(headers, withOrigin(headers));
    return this._create(
      {
        id: crypto.randomUUID(),
        kind,
        variantUrl: kind === 'hls' && e.variantUrl ? normalizeUrl(e.variantUrl) : null,
        quality: kind === 'media' ? String(e.quality || e.probeInfo?.defaultQuality || this.settings.mediaQuality) : undefined,
        url,
        connections: clamp(e.connections || this.settings.connections, 1, 32),
        speedLimit: Math.max(0, Number(e.speedLimit) || 0),
        headers,
        auth:
          e.cookie || e.jar?.length
            ? { cookie: e.cookie ? String(e.cookie) : undefined, jar: Array.isArray(e.jar) ? e.jar : undefined, origin: originOf(url) }
            : {},
        checksum: e.checksum?.expected
          ? { algo: e.checksum.algo || 'sha256', expected: String(e.checksum.expected).trim().toLowerCase() }
          : null,
        customDir: e.dir || null,
        autoName: !e.filename,
        createdAt: Date.now(),
        status: 'queued'
      },
      this._ctx
    );
  }

  async _prepareAndRegister(d, e) {
    const { url, kind } = d;
    if (kind === 'media') {
      // Yoklama yapılmışsa ad başlıktan; yapılmamışsa indirme başlarken öğrenilir
      const info = e.probeInfo;
      if (info) {
        d.title = info.title;
        d.probed = true;
        d.useCookies = info.usedCookies;
        d.size = info.qualities?.find((q) => q.id === d.quality)?.size || -1;
      }
      const base = (e.filename || info?.title || 'video').replace(/\.(mp4|mp3|m4a|webm|mkv)$/i, '');
      await this._assignPath(d, `${base}.${d.ext}`);
      d.status = e.startNow === false ? 'paused' : 'queued';
      this._register(d);
      this._changed();
      return d.snapshot();
    }
    if (kind === 'hls') {
      await this._assignPath(d, hlsFilename(e.filename, url));
      d.status = e.startNow === false ? 'paused' : 'queued';
      this._register(d);
      this._changed();
      return d.snapshot();
    }

    let info = e.probeInfo;
    if (!info) {
      // Hata olursa başlatılırken tekrar denenir; orada gösterilir
      const plain = probe(url, { headers: d.headers, auth: d.auth, timeout: 15000 }).catch(() => null);
      const up = await this._upgradeImage(url, d.headers, d.auth);
      if (up) {
        d.url = up.url;
        info = up.info;
      } else {
        info = await plain;
      }
    }
    if (info) {
      d.finalUrl = info.finalUrl;
      d.size = info.size;
      d.resumable = info.resumable;
      d.probed = true;
    }
    await this._assignPath(d, e.filename || info?.filename);
    d.status = e.startNow === false ? 'paused' : 'queued';
    this._register(d);
    this._changed();
    return d.snapshot();
  }

  _dirFor(category, customDir) {
    if (customDir) return customDir;
    const base = this.settings.downloadDir;
    // Klasör adları seçili dilde (ör. Music / Müzik / Musik)
    return this.settings.categorize ? path.join(base, sanitizeFilename(I18N.t('cat.' + category))) : base;
  }

  _reserved(except) {
    const set = new Set();
    for (const d of [...this.downloads.values(), ...this._adding]) {
      if (d !== except && d.status !== 'completed' && d.dir) set.add(d.savePath.toLowerCase());
    }
    return set;
  }

  /** Ad seçimi kilitle sıralanır: eşzamanlı iki ekleme aynı boş adı alamaz. */
  _assignPath(d, name) {
    const run = this._pathLock.then(() => this._assignPathNow(d, name));
    this._pathLock = run.catch(() => {});
    return run;
  }

  async _assignPathNow(d, name) {
    const filename = sanitizeFilename(name || filenameFromUrl(d.finalUrl || d.url) || 'indirme');
    d.category = categoryOf(filename);
    const dir = this._dirFor(d.category, d.customDir);
    const full = await uniquePath(dir, filename, this._reserved(d));
    d.dir = dir;
    d.filename = path.basename(full);
  }

  _finalPath(d) {
    const run = this._pathLock.then(async () => {
      if (!(await exists(d.savePath))) return d.savePath;
      return uniquePath(d.dir, d.filename, this._reserved(d));
    });
    this._pathLock = run.catch(() => {});
    return run;
  }

  // ---- kuyruk ----

  _schedule() {
    let running = 0;
    for (const d of this.downloads.values()) if (d.isRunning) running++;
    let slots = this.settings.maxConcurrent - running;
    for (const d of this.downloads.values()) {
      if (slots <= 0) break;
      if (d.status === 'queued' && !d.isRunning) {
        slots--;
        d.start();
      }
    }
  }

  _get(id) {
    const d = this.downloads.get(id);
    if (!d) throw new AppError('err.downloadNotFound');
    return d;
  }

  /** Kullanıcı açıkça "Başlat" dediğinde kuyruk sınırını beklemeden başlatır. */
  start(ids) {
    for (const id of ids) {
      const d = this.downloads.get(id);
      if (d && !d.isRunning && d.status !== 'completed' && d.status !== 'verifying') d.start();
    }
  }

  async pause(ids) {
    await Promise.all(
      ids.map((id) => this.downloads.get(id)).filter((d) => d && ['downloading', 'queued', 'error'].includes(d.status)).map((d) => d.stop('paused'))
    );
    this._schedule();
  }

  startAll() {
    for (const d of this.downloads.values()) {
      if (['paused', 'error'].includes(d.status)) d.status = 'queued';
    }
    this._changed();
    this._schedule();
  }

  async pauseAll() {
    await Promise.all(
      [...this.downloads.values()].filter((d) => ['downloading', 'queued'].includes(d.status)).map((d) => d.stop('paused'))
    );
  }

  async remove(ids, deleteFiles = false) {
    for (const id of ids) {
      const d = this.downloads.get(id);
      if (!d) continue;
      if (d.isRunning) await d.stop('paused');
      this.downloads.delete(id);
      d.removeAllListeners();
      if (d.status !== 'completed') {
        await d.cleanupTemp();
      } else if (deleteFiles && (await exists(d.savePath))) {
        await this.trashItem(d.savePath).catch(() => {});
      }
    }
    this._changed();
    this._schedule();
  }

  async redownload(id) {
    const d = this._get(id);
    if (d.isRunning) await d.stop('paused');
    await d.cleanupTemp();
    const wasCompleted = d.status === 'completed';
    d.resetProgress();
    if (wasCompleted && (await exists(d.savePath))) {
      // Eski dosyanın üzerine yazma; yeni bir ad seç
      await this._assignPath(d, d.filename);
    }
    d.status = 'queued';
    this._changed();
    this._schedule();
  }

  async updateUrl(id, url) {
    const d = this._get(id);
    if (d.isRunning) await d.stop('paused');
    d.url = normalizeUrl(url);
    d.finalUrl = null;
    if (d.auth?.cookie) d.auth.origin = originOf(d.url);
    d.error = null;
    d.errorKey = null;
    d.errorParams = null;
    this._changed();
  }

  setItemSpeedLimit(id, kbps) {
    this._get(id).setSpeedLimit(kbps);
  }

  async computeHash(id, algo) {
    if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw new Error('Desteklenmeyen algoritma');
    return this._get(id).computeHash(algo);
  }

  setExpectedHash(id, algo, expected) {
    const d = this._get(id);
    d.checksum = { ...(d.checksum || {}), algo, expected: String(expected || '').trim().toLowerCase() || null };
    if (d.checksum.actual && d.checksum.algo === algo && d.checksum.expected) d.checksum.ok = d.checksum.actual === d.checksum.expected;
    this._changed();
  }

  get(id) {
    return this.downloads.get(id);
  }

  updateSettings(patch) {
    const s = this.settings;
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      s[k] = k === 'schedule' ? { ...s.schedule, ...v } : v;
    }
    s.maxConcurrent = clamp(s.maxConcurrent, 1, 20);
    s.connections = clamp(s.connections, 1, 32);
    s.retries = clamp(s.retries, 0, 50);
    s.speedLimit = Math.max(0, Number(s.speedLimit) || 0);
    this.limiter.setRate(s.speedLimit * 1024);
    this._saveSettings();
    this._schedule();
    this.emit('settings', { ...s });
    return { ...s };
  }

  // ---- zamanlayıcı & örnekleme ----

  _onTick() {
    let anyActive = false;
    for (const d of this.downloads.values()) {
      d.sample();
      if (d.status === 'downloading') anyActive = true;
    }
    if (anyActive) {
      this.emit('change');
      // Elektrik kesilmesi / çökmede inen kısım kaybolmasın: ilerlemeyi düzenli kaydet
      const now = Date.now();
      if (now - this._lastProgressSave >= this.progressSaveMs) {
        this._lastProgressSave = now;
        this._saveSoon();
      }
    }

    const sch = this.settings.schedule;
    if (sch?.enabled) {
      const now = new Date();
      const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const key = `${now.toDateString()} ${hm}`;
      if (this._scheduleFired !== key) {
        if (hm === sch.start) {
          this._scheduleFired = key;
          this.startAll();
          this.emit('schedule', 'start');
        } else if (sch.stop && hm === sch.stop) {
          this._scheduleFired = key;
          this.pauseAll();
          this.emit('schedule', 'stop');
        }
      }
    }
  }

  // ---- kalıcılık ----

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch((err) => this.emit('log', 'Save failed: ' + err.message));
    }, 1500);
  }

  async save() {
    const list = [...this.downloads.values()].map((d) => d.toJSON());
    await writeJsonAtomic(this._downloadsFile, list);
  }

  _saveSettings() {
    writeJsonAtomic(this._settingsFile, this.settings).catch((err) => this.emit('log', 'Settings save failed: ' + err.message));
  }

  /** Uygulama kapanırken: çalışanları durdur, açılışta devam edilsin diye "sırada" bırak. */
  async shutdown() {
    clearInterval(this._tick);
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    await Promise.all([...this.downloads.values()].filter((d) => d.isRunning).map((d) => d.stop('queued')));
    await this.save();
  }
}

const PROBE_CONCURRENCY = 6;
const PROBE_TTL_MEDIA = 10 * 60 * 1000; // video sitesi bilgisi (başlık, kaliteler) birkaç dakika geçerli
const PROBE_TTL_FILE = 30 * 1000;
const PROGRESS_SAVE_MS = 10000;

/** Sırayı koruyarak en fazla `limit` işi aynı anda çalıştırır. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Referer varsa aynı kökeni Origin olarak da ekler. */
function withOrigin(headers = {}) {
  if (!headers.referer || headers.origin) return headers;
  try {
    return { ...headers, origin: new URL(headers.referer).origin };
  } catch {
    return headers;
  }
}

function isHlsUrl(url) {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** HLS için dosya adı: verilen ad (ör. sayfa başlığı) ya da adresten; video uzantısı yoksa .ts eklenir. */
function hlsFilename(name, url) {
  let n = String(name || '').trim();
  if (!n) n = filenameFromUrl(url).replace(/\.m3u8$/i, '') || 'video';
  if (/^(index|master|playlist|chunklist|manifest|video)(_\w+)?$/i.test(n)) {
    try {
      n = new URL(url).hostname.replace(/^www\./, '') + ' video';
    } catch { /* yoksay */ }
  }
  n = n.replace(/\.m3u8$/i, '');
  if (!/\.(ts|mp4|mkv|webm)$/i.test(n)) n += '.ts';
  return sanitizeFilename(n);
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
  } catch {
    throw new AppError('err.badUrl', { url: s.slice(0, 80) });
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('err.httpOnly');
  return u.toString();
}

function clamp(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1));
  await fsp.rename(tmp, file);
}

module.exports = { DownloadManager, DEFAULT_SETTINGS, CATEGORIES, PART_EXT, normalizeUrl, isMediaSiteUrl };
