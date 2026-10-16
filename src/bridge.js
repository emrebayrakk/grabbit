'use strict';

const http = require('http');
const { identifyClient } = require('./client-process');

/**
 * Tarayıcı eklentisinin bağlantı gönderdiği yerel sunucu (yalnızca 127.0.0.1).
 * Web sayfaları buraya istek atamasın diye: Origin varsa yalnızca eklenti kökenleri kabul edilir
 * ve JSON içerik türü zorunludur (sayfalardan gelen JSON istekleri CORS ön kontrolüne takılır).
 */
function startBridge({ port, version, onAdd, onPrefetch, onPing, onError, getLang }) {
  // Tarayıcının gerçek adı (netstat + tasklist ile, ~100 ms) arka planda bulunur ve tanıtılan ada göre
  // saklanır: istekler bunu beklemez, son bilinen adı kullanır.
  const known = new Map(); // tanıtılan ad → gerçek ad
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !/^(chrome|moz|edge|safari-web)-extension:\/\//i.test(origin)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    const claimed = String(req.headers['x-ti-browser'] || '').slice(0, 40);
    const extVersion = String(req.headers['x-ti-version'] || '').slice(0, 20);
    // Bağlantı açıkken sahibi olan programı sor; tanınırsa eklentinin beyanından önceliklidir.
    // Arka planda tamamlanır ve eşleşmeyi kaydeder; yanıtlar ise en fazla kısa bir süre bekler,
    // böylece yavaş bir netstat eklentinin ping zaman aşımına takılıp indirmeleri kaçırmasına yol açmaz.
    const who = claimed
      ? identifyClient(req.socket)
          .catch(() => null)
          .then((c) => {
            const w = c?.browser ? { name: c.browser, verified: true } : { name: claimed, verified: false };
            if (w.verified) known.set(claimed, w);
            return w;
          })
      : Promise.resolve(null);
    who.then((w) => w && onPing?.(w.name, extVersion, w.verified));
    // Daha önce tanındıysa beklemeden; ilk kez görülüyorsa kısa bir süre tanınmayı bekle
    const identity = (budget) => (known.has(claimed) ? Promise.resolve(known.get(claimed)) : within(who, budget));
    if (req.method === 'GET' && req.url === '/ping') {
      identity(PING_BUDGET_MS).then((w) =>
        send(res, 200, { ok: true, app: 'Grabbit', version, browser: w?.verified ? w.name : undefined, lang: getLang?.() })
      );
      return;
    }
    if (req.method === 'POST' && (req.url === '/add' || req.url === '/prefetch')) {
      const prefetch = req.url === '/prefetch';
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
        return send(res, 415, { ok: false, error: 'json bekleniyor' });
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => {
        body += d;
        if (body.length > 2 * 1024 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          const p = JSON.parse(body);
          const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
          const urls = (Array.isArray(p.urls) ? p.urls : [p.url]).filter(isHttp).slice(0, 500);
          if (!urls.length) return send(res, 400, { ok: false, error: 'adres yok' });
          const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
          if (prefetch) {
            // Video düğmesine gelindi: tıklanmadan önce sayfayı yokla (yalnızca tek adres)
            onPrefetch?.({
              url: urls[0],
              cookie: str(p.cookie, 16000),
              jar: cleanJar(p.cookies),
              headers: { referer: str(p.referer), userAgent: str(p.userAgent, 500) }
            });
            return send(res, 202, { ok: true });
          }
          const w = (await identity(ADD_BUDGET_MS)) || (claimed ? { name: claimed } : null);
          // Yanıt beklenmez: yoklama uzun sürebilir ve eklenti 5 sn sonra vazgeçip tarayıcıya indirtir
          // (çift indirme). Kabul edildiği hemen bildirilir, ekleme arka planda sürer.
          Promise.resolve(
            onAdd({
              urls,
              kind: p.kind === 'hls' || p.kind === 'media' ? p.kind : undefined,
              variantUrl: isHttp(p.variantUrl) ? p.variantUrl : undefined,
              quality: QUALITIES.includes(p.quality) ? p.quality : undefined,
              filename: str(p.filename, 200),
              cookie: urls.length === 1 ? str(p.cookie, 16000) : undefined,
              jar: urls.length === 1 ? cleanJar(p.cookies) : undefined,
              headers: { referer: str(p.referer), userAgent: str(p.userAgent, 500) },
              source: w?.name
            })
          ).catch(() => { /* tek tek eklemelerin hataları listede gösterilir */ });
          send(res, 200, { ok: true });
        } catch (err) {
          send(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }
    send(res, 404, { ok: false });
  });
  // Eklenti aynı bağlantıyı yeniden kullansın: tarayıcı tespiti önbellekten anında gelir
  server.keepAliveTimeout = 60000;
  server.on('error', (err) => onError?.(err));
  server.listen(port, '127.0.0.1');
  return server;
}

/** Eklentinin gönderdiği çerez listesini doğrular (yalnızca beklenen alanlar, makul boyut). */
function cleanJar(list) {
  if (!Array.isArray(list)) return undefined;
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const jar = list.slice(0, 300).filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string').map((c) => ({
    name: s(c.name, 256),
    value: s(c.value, 8192),
    domain: s(c.domain, 255),
    path: s(c.path, 1024) || '/',
    secure: !!c.secure,
    hostOnly: !!c.hostOnly,
    session: !!c.session,
    expirationDate: Number(c.expirationDate) || 0
  }));
  return jar.length ? jar : undefined;
}

const QUALITIES = ['audio', 'best', '2160', '1440', '1080', '720', '480', '360'];
const PING_BUDGET_MS = 400;
const ADD_BUDGET_MS = 800;

/** Söz en fazla `ms` içinde biterse sonucunu, bitmezse null döner (iş arka planda sürer). */
function within(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((r) => (t = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(t));
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

module.exports = { startBridge };
