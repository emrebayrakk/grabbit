'use strict';

// Videoyu tek dosya olarak vermeyen siteler: bunlarda video, uygulamadaki video motoruna (yt-dlp)
// sayfa adresiyle gönderilir. Uygulamadaki liste: src/engine/media.js → MEDIA_HOSTS (ikisi aynı tutulmalı).
const TI_MEDIA_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com',
  'facebook.com', 'fb.watch', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'reddit.com', 'redd.it',
  'soundcloud.com', 'bilibili.com', 'pinterest.com', 'linkedin.com', 'threads.net', 'threads.com', 'kick.com',
  'rumble.com', 'bandcamp.com', 'snapchat.com', 'tumblr.com', 'vk.com', 'ok.ru', 'streamable.com', 'imgur.com', '9gag.com'
];

function tiIsMediaSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TI_MEDIA_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Doğrudan dosya adresleri (ör. 64.media.tumblr.com/…/foto.pnj, i.redd.it/x.jpg) sayfa değil, dosyadır:
// video sitesinin alan adında olsalar bile normal dosya gibi indirilir. Uygulamadaki karşılığı: isMediaSiteUrl.
const TI_DIRECT_FILE = /\.(jpe?g|png|gif|webp|avif|bmp|pnj|svg|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$/i;

function tiIsMediaPage(url) {
  try {
    return tiIsMediaSite(url) && !TI_DIRECT_FILE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Bir <img>'in srcset/<picture> adaylarından en büyüğünü seçer. Siteler (Tumblr, Instagram, haber
 * siteleri…) aynı görselin büyük sürümlerini imzalı adreslerle srcset'te verir; adresten tahmin
 * etmekten daha güvenilirdir. img: { src, width, base, sets: [srcset dizgeleri] }.
 */
function tiBestImage(img) {
  let best = { url: img.src, size: img.width || 1 };
  const abs = (u) => {
    try {
      return new URL(u, img.base || img.src).href;
    } catch {
      return null;
    }
  };
  for (const set of img.sets || []) {
    for (const m of String(set).matchAll(/\s*(\S+?)(?:\s+(\d+(?:\.\d+)?)([wx]))?\s*(?:,(?=\s*\S)|$)/g)) {
      const url = m[1] && abs(m[1]);
      if (!url || !/^https?:/i.test(url)) continue;
      const n = Number(m[2]) || 1;
      const size = m[3] === 'w' ? n : n * (img.width || 1);
      if (size > best.size) best = { url, size };
    }
  }
  return best.url;
}

// ------------------------------------------------------------ video menüsü: seçim ve etiketler

function tiFmtSize(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function tiFmtDur(s) {
  if (!(s > 0) || !isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function tiFileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

/** "bdde2fe31b3cc57f7d5e.mp4", "1699999.mp4" gibi kullanıcıya bir şey söylemeyen adlar. */
function tiMeaninglessName(name) {
  const stem = String(name).replace(/\.[^.]+$/, '');
  return !stem || /^[0-9a-f_-]{10,}$/i.test(stem) || !/[a-z]{3}/i.test(stem) || /^(index|master|playlist|video|media|chunklist|manifest)$/i.test(stem);
}

const TI_MIN_FILE = 2 * 1024 * 1024; // daha küçük yakalanan dosyalar reklam/önizleme parçacığıdır

/**
 * İmlecin altındaki video için anlamlı seçenekler (en fazla 3, en olası önce).
 * ctx: { direct: [videonun kendi adresleri], duration: videonun süresi, frameOrigin, mediaPage, pageUrl }
 * - Video sitelerinde (YouTube vb.): "bu videoyu indir" + "yalnızca ses (MP3)".
 * - Videonun kendi dosyası her zaman ilk sırada.
 * - Akışlardan (HLS) yalnızca bu videoya uyan en iyisi: aynı çerçeveden, süresi tutan, en yüksek kalite.
 * - Diğer dosyalardan 2 MB altı (reklam, önizleme) ve aynı adın tekrarları elenir.
 */
function tiPickMedia(list, ctx = {}) {
  if (ctx.mediaPage) {
    const page = { type: 'page', url: ctx.pageUrl, size: -1 };
    return [page, { ...page, quality: 'audio' }];
  }
  const direct = new Set(ctx.direct || []);
  const items = (list || []).filter((m) => m && !m.hidden && m.type !== 'page');
  const near = (d) => !(ctx.duration > 0 && isFinite(ctx.duration)) || !(d > 0) || Math.abs(d - ctx.duration) <= Math.max(5, ctx.duration * 0.03);
  const ownFrame = (m) => (ctx.frameOrigin && m.referer && m.referer.startsWith(ctx.frameOrigin) ? 1 : 0);
  const height = (m) => parseInt(m.quality, 10) || 0;

  const hls = items
    .filter((m) => m.type === 'hls' && near(m.duration))
    .sort((a, b) => ownFrame(b) - ownFrame(a) || !!b.variants - !!a.variants || height(b) - height(a) || (b.time || 0) - (a.time || 0));

  const files = [];
  for (const m of items.filter((x) => x.type !== 'hls')) {
    const own = direct.has(m.url);
    if (!own && !(m.size >= TI_MIN_FILE)) continue;
    const name = tiFileName(m.url).toLowerCase();
    const dup = files.find((f) => f.url === m.url || (name && tiFileName(f.url).toLowerCase() === name));
    if (dup) {
      if (own) dup.direct = true;
      if ((m.size || 0) > (dup.size || 0)) dup.size = m.size;
      continue;
    }
    files.push({ ...m, direct: own || m.direct });
  }
  // Videosu olan sayfada ayrı ses dosyaları gereksiz kalabalık
  const videos = files.filter((f) => f.type !== 'audio');
  const shown = videos.length || hls.length ? videos : files;
  shown.sort((a, b) => !!b.direct - !!a.direct || (b.size || 0) - (a.size || 0));

  const own = shown.filter((f) => f.direct);
  const rest = shown.filter((f) => !f.direct);
  // Video düğmesinde tek akış (bu video); eklenti penceresinde sayfadaki her akış
  return [...own, ...(ctx.allStreams ? hls : hls.slice(0, 1)), ...rest].slice(0, ctx.limit || 3);
}

/** Menü satırı: { tag, title, sub }. t: çeviri işlevi; ctx: { pageTitle } */
function tiDescribe(m, t, ctx = {}) {
  const host = (() => {
    try {
      return new URL(m.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const title = String(ctx.pageTitle || '').trim().slice(0, 70);
  if (m.fallback) return { tag: '?', title: t('tryEngine'), sub: t('tryEngineSub') };
  if (m.type === 'page' && m.quality === 'audio') return { tag: 'MP3', title: t('mp3Title'), sub: t('mp3Sub') };
  if (m.type === 'page') return { tag: t('siteTag'), title: t('siteTitle'), sub: t('siteSub', { host }) };
  if (m.type === 'hls') {
    const n = m.variants?.length || 0;
    return {
      tag: m.quality || 'HD',
      title: title || t('hlsTitle'),
      sub: [tiFmtDur(m.duration), n > 1 ? t('qualities', { n }) : '', t('streamWord')].filter(Boolean).join(' · ')
    };
  }
  const name = tiFileName(m.url);
  const ext = (name.split('.').pop() || '').toUpperCase().slice(0, 4);
  const fallbackTitle = m.type === 'audio' ? t('audioFile') : t('videoFile');
  return {
    tag: m.type === 'audio' ? t('audioTag') : ext || 'VIDEO',
    title: !tiMeaninglessName(name) ? name.slice(0, 70) : title || fallbackTitle,
    sub: [m.direct ? t('thisVideo') : '', tiFmtSize(m.size), host].filter(Boolean).join(' · ')
  };
}
