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
