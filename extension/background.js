'use strict';

importScripts('sites.js', 'i18n.js');
// Uygulamanın dili değişince sağ tık menüleri yeni dilde yeniden kurulur
tiLoadLang(() => createMenus());

const VERSION = chrome.runtime.getManifest().version;
const DEFAULTS = { port: 17890, intercept: true, minSizeMb: 0, videoButton: true };
const FILE_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|3gp|mp3|wav|flac|aac|ogg|m4a|wma|opus|pdf|docx?|xlsx?|pptx?|epub|zip|rar|7z|tar|gz|bz2|xz|tgz|exe|msi|apk|dmg|iso|img|deb|rpm)(\?|#|$)/i;

// Kendi geri düşüş indirmelerimizi tekrar yakalamamak için
const passThrough = new Set();

// ------------------------------------------------------------ ayarlar & bağlantı

async function cfg() {
  return chrome.storage.local.get(DEFAULTS);
}

async function base() {
  const { port } = await cfg();
  return `http://127.0.0.1:${port}`;
}

let browserNameCache = null;
async function browserName() {
  if (browserNameCache) return browserNameCache;
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(' ');
  let name = 'Chromium';
  try {
    if (navigator.brave && (await navigator.brave.isBrave())) name = 'Brave';
  } catch { /* yoksay */ }
  if (name === 'Chromium') {
    if (/Edge/i.test(brands) || /Edg\//.test(ua)) name = 'Microsoft Edge';
    else if (/Opera/i.test(brands) || /OPR\//.test(ua)) name = 'Opera';
    else if (/Vivaldi/i.test(ua)) name = 'Vivaldi';
    else if (/Google Chrome/i.test(brands)) name = 'Google Chrome';
  }
  return (browserNameCache = name);
}

async function appHeaders(extra = {}) {
  return { 'X-TI-Browser': await browserName(), 'X-TI-Version': VERSION, ...extra };
}

// Uygulama, bağlantının hangi programdan geldiğine bakarak tarayıcıyı kesin tanır
// (Vivaldi gibi tarayıcılar kendini Chrome diye tanıtır); bulduğu adı burada saklarız.
let appSeenAs = null;

// Son ping sonucu: indirme yakalanırken her seferinde uygulamaya sorulmaz (dakikalık ping tazeler)
let appAlive = { ok: false, at: 0 };
const ALIVE_MS = 90 * 1000;

async function appIsUp() {
  return appAlive.ok && Date.now() - appAlive.at < ALIVE_MS ? true : ping();
}

async function ping() {
  const ok = await pingNow();
  appAlive = { ok, at: Date.now() };
  return ok;
}

async function pingNow() {
  try {
    const res = await fetch(`${await base()}/ping`, { headers: await appHeaders(), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const info = await res.json().catch(() => ({}));
    if (info.browser) appSeenAs = info.browser;
    if (info.lang) {
      const { appLang } = await chrome.storage.local.get({ appLang: '' });
      if (appLang !== info.lang) await chrome.storage.local.set({ appLang: info.lang });
    }
    return true;
  } catch {
    return false;
  }
}

async function send(payload, endpoint = '/add') {
  const res = await fetch(`${await base()}${endpoint}`, {
    method: 'POST',
    headers: await appHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ userAgent: navigator.userAgent, ...payload }),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

/** Yalnızca bu adres için geçerli çerezler (tarayıcının alan/yol kurallarıyla). */
async function cookiesFor(url) {
  return (await cookieData(url)).cookie;
}

/**
 * Bu adres için çerezler tek okumayla iki biçimde: "ad=değer" dizesi (normal indirme) ve tam liste
 * (alan adı, yol, Secure, süre). Video motoru listeyi dosyaya aynen yazar; yalnızca dize gönderilince
 * oturum bozuk görünür (YouTube: "sayfayı yenileyin").
 */
async function cookieData(url) {
  let list = [];
  try {
    list = await chrome.cookies.getAll({ url });
  } catch { /* çerez izni yok */ }
  return { cookie: list.map((c) => `${c.name}=${c.value}`).join('; '), cookies: cookieJar(list) };
}

function cookieJar(list) {
  return list.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    hostOnly: c.hostOnly,
    session: c.session,
    expirationDate: c.expirationDate
  }));
}

async function sendOne(url, extra = {}) {
  await send({ url, ...(await cookieData(url)), ...extra });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message });
}

function appMissing() {
  notify(tiT('appMissingTitle'), tiT('appMissingBody'));
}

// ------------------------------------------------------------ video / ses yakalama

const mediaKey = (tabId) => `m:${tabId}`;

async function getMedia(tabId) {
  const r = await chrome.storage.session.get(mediaKey(tabId));
  return r[mediaKey(tabId)] || [];
}

async function setMedia(tabId, list) {
  await chrome.storage.session.set({ [mediaKey(tabId)]: list });
  updateBadge(tabId, list);
}

function updateBadge(tabId, list) {
  const n = list.filter((m) => !m.hidden).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b63f0' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: n ? tiT('badgeTitle', { n }) : 'Grabbit' }).catch(() => {});
}

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name)?.value || '';

function classify(details) {
  const url = details.url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const ct = header(details.responseHeaders, 'content-type').toLowerCase();
  const path = u.pathname.toLowerCase();
  // Parçalı (DASH) yayın parçaları ve YouTube tek başına oynatılabilir dosya değil
  if (/googlevideo\.com$|\.youtube\.com$/.test(u.hostname)) return null;
  if (/[?&](range|bytestart)=/i.test(u.search) || /\.(m4s|m4f|ts|aac\.\d+)$/.test(path)) return null;
  if (/mpegurl/.test(ct) || path.endsWith('.m3u8')) return { type: 'hls', mime: ct };
  if (/mp2t|iso\.segment|dash\+xml/.test(ct)) return null;
  if (/^video\//.test(ct) || (/octet-stream/.test(ct) && /\.(mp4|m4v|webm|mkv|mov|flv)$/.test(path))) return { type: 'video', mime: ct };
  if (/^audio\//.test(ct) || (/octet-stream/.test(ct) && /\.(mp3|m4a|ogg|opus|flac|wav)$/.test(path))) return { type: 'audio', mime: ct };
  return null;
}

function totalSize(details) {
  const cr = header(details.responseHeaders, 'content-range');
  const m = /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(header(details.responseHeaders, 'content-length'));
  return Number.isFinite(cl) && cl > 0 ? cl : -1;
}

// Aynı sekmede eşzamanlı güncellemeler birbirini ezmesin
const tabLocks = new Map();
function withTab(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  tabLocks.set(tabId, tail);
  // Kuyrukta başka iş yoksa kilidi bırak (kapanan sekmeler birikmesin)
  tail.then(() => tabLocks.get(tabId) === tail && tabLocks.delete(tabId));
  return next;
}

/** Adres, yakalanmış bir ana listenin kalitesi ya da ayrı ses/altyazı listesi mi? */
function partOfMaster(master, url) {
  return !!(master.variants?.some((v) => v.url === url) || master.related?.includes(url));
}

async function inspectHls(url) {
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    if (!text.startsWith('#EXTM3U')) return null;
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variants = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const res2 = /RESOLUTION=\d+x(\d+)/.exec(lines[i]);
        const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
        if (uri) variants.push({ url: new URL(uri.trim(), url).toString(), height: res2 ? Number(res2[1]) : 0 });
      }
      // Ayrı ses/altyazı listeleri tek başına video değildir: listede gösterilmesin (uygulama ana listeden alır)
      const related = [...text.matchAll(/^#EXT-X-MEDIA:.*?URI="([^"]+)"/gm)].map((m) => new URL(m[1], url).toString());
      return { master: true, variants, related, best: Math.max(0, ...variants.map((v) => v.height)) };
    }
    let duration = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) duration += parseFloat(m[1]);
    return { master: false, live: !text.includes('#EXT-X-ENDLIST'), duration };
  } catch {
    return null;
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || (details.statusCode !== 200 && details.statusCode !== 206)) return;
    const c = classify(details);
    if (!c) return;
    const size = totalSize(details);
    if (c.type !== 'hls' && size >= 0 && size < 300 * 1024) return; // reklam/önizleme parçacıkları
    const url = details.url.replace(/#.*$/, '');
    withTab(details.tabId, async () => {
      const known = await getMedia(details.tabId);
      if (known.some((m) => m.url === url)) return;
      // Akışı isteyen çerçevenin kökeni: oynatıcı başka alan adındaki bir iframe'deyse sunucu Referer olarak bunu bekler
      const referer = details.initiator && details.initiator !== 'null' ? details.initiator + '/' : undefined;
      const item = { url, type: c.type, mime: c.mime, size, time: Date.now(), referer };
      // Zaten yakalanmış bir ana listenin kalitesiyse listeyi tekrar indirmeye gerek yok
      const isKnownVariant = c.type === 'hls' && known.some((m) => partOfMaster(m, url));
      let info = null;
      if (c.type === 'hls' && !isKnownVariant) {
        info = await inspectHls(url);
        if (info && !info.master && info.live) return; // canlı yayın indirilemez
        if (info?.master) {
          item.variants = info.variants;
          item.related = info.related;
          item.quality = info.best ? `${info.best}p` : '';
        } else if (info) {
          item.duration = info.duration;
        }
      }
      // inspectHls beklerken sayfa yenilenmiş olabilir: listeyi yeniden oku
      const list = await getMedia(details.tabId);
      if (info?.master) {
        // Bu ana listeye ait tek tek kalite listelerini gizle
        for (const m of list) if (partOfMaster(item, m.url)) m.hidden = true;
      } else if (list.some((m) => partOfMaster(m, url))) {
        item.hidden = true;
      }
      list.push(item);
      await setMedia(details.tabId, list.slice(-40));
    });
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Sayfa tamamen yeniden yüklendiğinde eski kayıtları temizle
  if (info.status === 'loading' && info.url) setMedia(tabId, []);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLocks.delete(tabId);
  chrome.storage.session.remove(mediaKey(tabId));
});

/** Bir medya öğesini uygulamaya gönderir. */
async function sendMedia(item, { pageUrl, title } = {}) {
  if (item.type === 'page') {
    // Video sitesi: sayfa adresi uygulamadaki video motoruna gider (kalite orada seçilir)
    return send({
      url: item.url,
      kind: 'media',
      quality: item.quality,
      referer: pageUrl,
      ...(await cookieData(item.url))
    });
  }
  const name = (title || '').replace(/\s*[-|–]\s*[^-|–]*$/, '').trim().slice(0, 120) || undefined;
  if (item.type === 'hls') {
    await send({
      url: item.url,
      kind: 'hls',
      variantUrl: item.variantUrl,
      filename: name,
      referer: item.referer || pageUrl,
      ...(await cookieData(item.url))
    });
  } else {
    await sendOne(item.url, { referer: item.referer || pageUrl });
  }
}

/** Sekmedeki en iyi video adayı: önce HLS ana liste, sonra en büyük dosya. */
function bestMedia(list, preferType) {
  const visible = list.filter((m) => !m.hidden && (!preferType || m.type === preferType || (preferType === 'video' && m.type === 'hls')));
  return visible.sort((a, b) => (b.type === 'hls') - (a.type === 'hls') || (b.size || 0) - (a.size || 0))[0];
}

// ------------------------------------------------------------ sağ tık menüleri

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
    add('ti-link', tiT('menuLink'), ['link']);
    add('ti-video', tiT('menuVideo'), ['video']);
    // YouTube vb.: sayfadaki ya da bağlantıdaki videonun yalnızca sesini MP3 olarak indir
    const mediaPatterns = TI_MEDIA_HOSTS.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);
    chrome.contextMenus.create({ id: 'ti-mp3', title: tiT('menuMp3'), contexts: ['page', 'video', 'audio'], documentUrlPatterns: mediaPatterns });
    chrome.contextMenus.create({ id: 'ti-mp3-link', title: tiT('menuMp3Link'), contexts: ['link'], targetUrlPatterns: mediaPatterns });
    add('ti-audio', tiT('menuAudio'), ['audio']);
    add('ti-image', tiT('menuImage'), ['image']);
    add('ti-sel', tiT('menuSelection'), ['selection']);
    add('ti-page-video', tiT('menuPageVideo'), ['page']);
    add('ti-page-links', tiT('menuPageLinks'), ['page']);
    add('ti-page-images', tiT('menuPageImages'), ['page']);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  chrome.alarms.create('ti-ping', { periodInMinutes: 1 });
  ping();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('ti-ping', { periodInMinutes: 1 });
  ping();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'ti-ping') ping();
});

async function collect(tabId, what, { frameId, src } = {}) {
  const results = await chrome.scripting.executeScript({
    target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
    args: [what, src || null],
    func: (kind, src) => {
      // Görselin srcset / <picture> adaylarıyla birlikte tarifi: en büyüğü arka planda seçilir
      const describe = (i) => {
        const sets = [i.getAttribute('srcset')];
        if (i.parentElement?.tagName === 'PICTURE') {
          i.parentElement.querySelectorAll('source[srcset]').forEach((s) => {
            if (!s.type || /^image\//i.test(s.type)) sets.push(s.getAttribute('srcset'));
          });
        }
        return { src: i.currentSrc || i.src, width: i.naturalWidth, base: document.baseURI, sets: sets.filter(Boolean) };
      };
      if (kind === 'images') {
        return [...document.images].filter((i) => i.naturalWidth >= 100 && i.naturalHeight >= 100).map(describe);
      }
      if (kind === 'image') {
        const img = [...document.images].find((i) => i.currentSrc === src || i.src === src);
        return img ? [describe(img)] : [];
      }
      if (kind === 'selection') {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return [];
        const out = [];
        for (let r = 0; r < sel.rangeCount; r++) {
          const frag = sel.getRangeAt(r).cloneContents();
          frag.querySelectorAll('a[href]').forEach((a) => out.push(new URL(a.getAttribute('href'), location.href).href));
        }
        return out.concat(sel.toString().match(/https?:\/\/[^\s"'<>]+/g) || []);
      }
      return [...document.querySelectorAll('a[href], video[src], audio[src], source[src]')].map((e) => e.href || e.src);
    }
  });
  const found = results.flatMap((r) => r.result || []).map((x) => (typeof x === 'string' ? x : tiBestImage(x)));
  return [...new Set(found.filter((u) => /^https?:/i.test(u || '')))];
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = info.pageUrl || tab?.url;
  try {
    switch (info.menuItemId) {
      case 'ti-link':
        return await sendOne(info.linkUrl, { referer: pageUrl });
      case 'ti-mp3':
        return await sendMedia({ type: 'page', url: info.frameUrl || pageUrl, quality: 'audio' }, { pageUrl });
      case 'ti-mp3-link':
        return await sendMedia({ type: 'page', url: info.linkUrl, quality: 'audio' }, { pageUrl });
      case 'ti-image':
        if (!/^https?:/i.test(info.srcUrl || '')) return notify('Grabbit', tiT('imageEmbedded'));
        // Görselin sayfada daha büyük bir sürümü (srcset) varsa onu indir
        const [big] = await collect(tab.id, 'image', { frameId: info.frameId, src: info.srcUrl }).catch(() => []);
        return await sendOne(big || info.srcUrl, { referer: pageUrl });
      case 'ti-video':
      case 'ti-audio':
      case 'ti-page-video': {
        const type = info.menuItemId === 'ti-audio' ? 'audio' : 'video';
        if (tiIsMediaPage(pageUrl || '')) return await sendMedia({ type: 'page', url: info.frameUrl || pageUrl }, { pageUrl });
        if (/^https?:/i.test(info.srcUrl || '')) return await sendOne(info.srcUrl, { referer: pageUrl });
        const best = bestMedia(await getMedia(tab.id), type);
        // Yakalanan dosya yoksa video motoru sayfayı çözmeyi denesin
        if (!best) return await sendMedia({ type: 'page', url: pageUrl }, { pageUrl });
        return await sendMedia(best, { pageUrl, title: tab.title });
      }
      case 'ti-sel': {
        const urls = await collect(tab.id, 'selection');
        if (!urls.length) return notify('Grabbit', tiT('noSelectionLinks'));
        return await send(urls.length === 1 ? { url: urls[0], referer: pageUrl, cookie: await cookiesFor(urls[0]) } : { urls, referer: pageUrl });
      }
      case 'ti-page-links':
      case 'ti-page-images': {
        const images = info.menuItemId === 'ti-page-images';
        const urls = (await collect(tab.id, images ? 'images' : 'links')).filter((u) => (images ? true : FILE_EXT.test(u)));
        if (!urls.length) return notify('Grabbit', images ? tiT('noImages') : tiT('noFileLinks'));
        // Çoklu gönderimde çerez yok: farklı sitelere sızmasın
        return await send({ urls, referer: pageUrl });
      }
    }
  } catch {
    appMissing();
  }
});

// ------------------------------------------------------------ indirme yakalama

chrome.downloads.onCreated.addListener(async (item) => {
  const { intercept, minSizeMb } = await cfg();
  const url = item.finalUrl || item.url;
  if (!intercept || !/^https?:/i.test(url || '')) return;
  if (passThrough.has(url)) {
    passThrough.delete(url);
    return;
  }
  if (minSizeMb > 0 && item.totalBytes > 0 && item.totalBytes < minSizeMb * 1024 * 1024) return;
  // Tarayıcı indirmeye başlamasın: önce hemen duraklat, uygulama yoksa devam ettir
  chrome.downloads.pause(item.id).catch(() => {});
  if (!(await appIsUp())) {
    chrome.downloads.resume(item.id).catch(() => {});
    return; // uygulama kapalıysa tarayıcı indirsin
  }
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch { /* zaten bitmiş olabilir */ }
  try {
    const filename = (item.filename || '').split(/[\\/]/).pop() || undefined;
    await sendOne(url, { referer: item.referrer || undefined, filename });
  } catch {
    passThrough.add(url);
    chrome.downloads.download({ url });
  }
});

// ------------------------------------------------------------ içerik betiği & açılır pencere

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'ping':
        return { ok: await ping(), browser: appSeenAs || (await browserName()) };
      case 'prefetch': {
        // Video düğmesine gelindi: uygulama sayfayı tıklanmadan önce yoklasın (tıklanınca hazır olur)
        if (!/^https?:/i.test(msg.url || '') || !(await appIsUp())) return undefined;
        await send({ url: msg.url, referer: sender.tab?.url, ...(await cookieData(msg.url)) }, '/prefetch').catch(() => {});
        return undefined;
      }
      case 'getMedia': {
        const tabId = msg.tabId ?? sender.tab?.id;
        return tabId == null ? [] : (await getMedia(tabId)).filter((m) => !m.hidden);
      }
      case 'captureLink': {
        // Uygulama açıksa ona gönder, değilse tarayıcı normal indirsin
        const fallback = () => {
          passThrough.add(msg.url);
          chrome.downloads.download({ url: msg.url, filename: msg.filename || undefined }).catch(() => chrome.downloads.download({ url: msg.url }));
        };
        if (!(await appIsUp())) return fallback();
        try {
          await sendOne(msg.url, { referer: sender.tab?.url, filename: msg.filename });
        } catch {
          fallback();
        }
        return undefined;
      }
      case 'download': {
        const tab = sender.tab || (msg.tabId != null ? await chrome.tabs.get(msg.tabId) : null);
        try {
          // İstek bir iframe'deki oynatıcıdan geldiyse Referer o çerçevenin adresidir, sekmenin değil
          await sendMedia(msg.item, { pageUrl: sender.url || tab?.url, title: tab?.title });
          return { ok: true };
        } catch {
          return { ok: false, error: tiT('appNotOpen') };
        }
      }
      default:
        return undefined;
    }
  })().then(reply);
  return true;
});
