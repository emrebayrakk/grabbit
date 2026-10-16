'use strict';

const {
  DEFAULT_UA,
  AppError,
  HttpError,
  MIME_EXT,
  extOf,
  filenameFromDisposition,
  filenameFromUrl,
  parseContentRange,
  sanitizeFilename
} = require('./utils');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Yönlendirmeleri elle takip eden fetch. Çerez yalnızca, çerezin alındığı
 * adresle aynı kökene (origin) giden isteklere eklenir; böylece bir sitenin
 * çerezleri başka bir alan adına sızmaz.
 */
async function request(url, { headers = {}, auth = {}, signal, range } = {}) {
  let current = url;
  for (let hop = 0; hop <= 10; hop++) {
    const h = {
      'User-Agent': headers.userAgent || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity'
    };
    if (headers.referer) h.Referer = headers.referer;
    // Çerçeve içindeki oynatıcılar akışı CORS ile çeker; bazı sunucular Origin olmadan 403/404 döner
    if (headers.origin) h.Origin = headers.origin;
    if (auth.cookie && auth.origin && originOf(current) === auth.origin) h.Cookie = auth.cookie;
    if (range) h.Range = range;

    const res = await fetch(current, { headers: h, signal, redirect: 'manual' });
    if (REDIRECTS.has(res.status)) {
      const loc = res.headers.get('location');
      await discard(res);
      if (!loc) throw new AppError('err.noLocation');
      current = new URL(loc, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new AppError('err.tooManyRedirects');
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch { /* yoksay */ }
}

/** Dosyanın adını, boyutunu ve parça parça indirilebilir olup olmadığını öğrenir. */
async function probe(url, { headers = {}, auth = {}, signal, timeout = 20000 } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const sig = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let { res, finalUrl } = await request(url, { headers, auth, signal: sig, range: 'bytes=0-0' });
  if (res.status === 416 || res.status === 405 || res.status === 501) {
    // Bazı sunucular Range'i hiç anlamaz ya da boş dosyada 416 döner
    await discard(res);
    ({ res, finalUrl } = await request(url, { headers, auth, signal: sig }));
  }
  try {
    if (!res.ok) throw new HttpError(res.status);
    let size = -1;
    let resumable = false;
    if (res.status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'));
      if (cr && cr.total >= 0) {
        size = cr.total;
        resumable = true;
      }
    } else {
      const cl = parseInt(res.headers.get('content-length'), 10);
      if (Number.isFinite(cl)) size = cl;
    }
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    let name =
      filenameFromDisposition(res.headers.get('content-disposition')) ||
      filenameFromUrl(finalUrl) ||
      filenameFromUrl(url);
    if (name && !extOf(name) && MIME_EXT[contentType]) name += '.' + MIME_EXT[contentType];
    // Tumblr'ın .pnj / .gifv adresleri gerçekte jpg/png/gif döndürür: dosya gerçek uzantıyla açılabilsin
    if (name && /\.(pnj|gifv)$/i.test(name) && /^image\//i.test(contentType) && MIME_EXT[contentType]) {
      name = name.replace(/\.(pnj|gifv)$/i, '.' + MIME_EXT[contentType]);
    }
    if (!name) name = 'download' + (MIME_EXT[contentType] ? '.' + MIME_EXT[contentType] : '');
    return { finalUrl, size, resumable, contentType, filename: sanitizeFilename(name) };
  } finally {
    // Tek baytlık yanıtı okuyup bitirmek bağlantıyı açık tutar: indirmenin ilk bağlantısı
    // TCP/TLS el sıkışmasını yeniden yapmaz. Büyük gövde gelirse kesilir.
    const small = res.status === 206 && Number(res.headers.get('content-length')) <= 64 * 1024;
    if (small) await res.arrayBuffer().catch(() => {});
    else await discard(res);
  }
}

module.exports = { request, probe, discard, originOf };
