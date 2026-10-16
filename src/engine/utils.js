'use strict';

const fsp = require('fs').promises;
const I18N = require('../../i18n/i18n');
const path = require('path');

const PART_EXT = '.tipart';

const CATEGORIES = {
  video: { label: 'Video', ext: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts'] },
  music: { label: 'Müzik', ext: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff'] },
  document: { label: 'Belgeler', ext: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'epub', 'md'] },
  archive: { label: 'Arşivler', ext: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'zst', 'cab'] },
  program: { label: 'Programlar', ext: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'iso', 'img'] },
  image: { label: 'Resimler', ext: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff', 'tif', 'ico', 'heic', 'avif', 'psd'] },
  other: { label: 'Diğer', ext: [] }
};

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/vnd.android.package-archive': 'apk',
  'application/json': 'json',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac'
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Kullanıcıya gösterilen hata: mesaj seçili dilde üretilir, ayrıca dil anahtarı ve parametreleri
 * saklanır; böylece kaydedilen hata, dil sonradan değişse de yeni dilde gösterilebilir.
 */
class AppError extends Error {
  constructor(key, params, { fatal: isFatal = false } = {}) {
    super(I18N.t(key, params));
    this.key = key;
    this.params = params;
    if (isFatal) this.fatal = true;
  }
}

const HTTP_KEYS = { 401: 'err.http401', 403: 'err.http403', 404: 'err.http404', 410: 'err.http410', 416: 'err.http416', 429: 'err.http429' };

class HttpError extends AppError {
  constructor(status, key) {
    super(key || HTTP_KEYS[status] || 'err.httpGeneric', { status });
    this.status = status;
    // 5xx, 429 ve 408 geçici kabul edilir; diğerleri tekrar denemekle düzelmez
    this.fatal = !(status >= 500 || status === 429 || status === 408);
  }
}

function fatal(key, params) {
  return new AppError(key, params, { fatal: true });
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function categoryOf(name) {
  const e = extOf(name);
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.ext.includes(e)) return key;
  }
  return 'other';
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n) n = 'download';
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > 180) {
    const e = extOf(n);
    n = e && e.length < 12 ? n.slice(0, 180 - e.length - 1) + '.' + e : n.slice(0, 180);
  }
  return n;
}

function filenameFromDisposition(header) {
  if (!header) return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (m) {
    try {
      return decodeURIComponent(m[2].trim().replace(/^"|"$/g, ''));
    } catch { /* düz filename'e düş */ }
  }
  m = /filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
  if (!m) return null;
  let v = m[1].trim().replace(/\\(.)/g, '$1');
  // Birçok sunucu UTF-8 baytlarını ham gönderir; başlık latin1 olarak çözülmüş gelir
  if (/^[\u0000-ÿ]*$/.test(v)) {
    const u = Buffer.from(v, 'latin1').toString('utf8');
    if (!u.includes('�')) v = u;
  }
  return v;
}

function filenameFromUrl(url) {
  let last = '';
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function parseContentRange(header) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(header || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? -1 : Number(m[3]) };
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** dir içinde, ne diskte ne de `reserved` içinde olan bir dosya yolu bulur: "ad (1).ext" gibi. */
async function uniquePath(dir, name, reserved = new Set()) {
  const e = extOf(name);
  const base = e ? name.slice(0, -(e.length + 1)) : name;
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${e ? '.' + e : ''}`;
    const full = path.join(dir, candidate);
    if (reserved.has(full.toLowerCase())) continue;
    if ((await exists(full)) || (await exists(full + PART_EXT))) continue;
    return full;
  }
  throw new AppError('err.noFilename');
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const CODE_KEYS = {
  ENOTFOUND: 'err.dns',
  EAI_AGAIN: 'err.dns',
  ECONNREFUSED: 'err.refused',
  ECONNRESET: 'err.reset',
  ETIMEDOUT: 'err.timeout',
  UND_ERR_CONNECT_TIMEOUT: 'err.timeout',
  ENOSPC: 'err.diskFull',
  EACCES: 'err.noWrite',
  EPERM: 'err.noWrite',
  CERT_HAS_EXPIRED: 'err.cert',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'err.cert',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'err.cert'
};

/** Hatanın dil anahtarı ve parametreleri (bilinmeyen hatalarda null). */
function errorInfo(err) {
  if (!err) return { key: 'err.unknown' };
  if (err.key) return { key: err.key, params: err.params };
  const code = err.cause?.code || err.code;
  if (CODE_KEYS[code]) return { key: CODE_KEYS[code] };
  if (err.name === 'TimeoutError') return { key: 'err.slowServer' };
  if (err.message === 'fetch failed') return { key: 'err.network' };
  return null;
}

/** Hatanın seçili dildeki metni. */
function humanizeError(err) {
  const info = errorInfo(err);
  return info ? I18N.t(info.key, info.params) : err.message || String(err);
}

module.exports = {
  PART_EXT,
  CATEGORIES,
  MIME_EXT,
  DEFAULT_UA,
  AppError,
  HttpError,
  fatal,
  errorInfo,
  extOf,
  categoryOf,
  sanitizeFilename,
  filenameFromDisposition,
  filenameFromUrl,
  parseContentRange,
  exists,
  uniquePath,
  sleep,
  humanizeError
};
