'use strict';

// Birçok site görselleri küçük önizleme olarak sunar ve boyutu adreste taşır (ör. YouTube "=s64",
// Tumblr "s64x64", X "name=small"). Bu kurallar aynı görselin büyük/orijinal sürümünün adresini üretir.
// Adaylar en büyükten başlayarak denenir; hiçbiri yoksa asıl adres kullanılır, yani kural yanlış
// tahmin etse bile indirme bozulmaz.

const IMG_EXT = '(?:jpe?g|png|gif|webp|avif|bmp|pnj|gifv)';

function tryUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Görselin büyük sürümleri için aday adresler (en iyiden kötüye). Kural uymazsa boş dizi. */
function fullSizeCandidates(url) {
  const u = tryUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return [];
  const host = u.hostname.toLowerCase();
  const out = [];
  const add = (x) => {
    if (x && x !== url && !out.includes(x)) out.push(x);
  };

  // YouTube/Google avatarları ve görselleri: ...=s64-c-k-c0x00ffffff-no-rj, =w120-h90, /s64-c/
  if (/(^|\.)(ggpht\.com|googleusercontent\.com)$/.test(host)) {
    if (/=[swh]\d+[^/]*$/.test(u.pathname + u.search)) add(url.replace(/=[swh]\d+[^/?#]*$/, '=s0'));
    if (/\/[swh]\d+(-[\w-]+)?\/[^/]+$/.test(u.pathname)) add(url.replace(/\/[swh]\d+(-[\w-]+)?\/([^/]+)$/, '/s0/$2'));
  }

  // YouTube küçük resimleri: default / mqdefault / hqdefault / sddefault → maxresdefault
  if (/(^|\.)ytimg\.com$/.test(host) && /\/vi(_webp)?\/[^/]+\/[\w]+\.(jpg|webp)$/.test(u.pathname)) {
    const base = `${u.origin}${u.pathname.replace(/\/vi_webp\//, '/vi/').replace(/\/[\w]+\.(jpg|webp)$/, '')}`;
    for (const n of ['maxresdefault', 'sddefault', 'hqdefault']) add(`${base}/${n}.jpg`);
  }

  // Tumblr: .../s64x64u_c1/foto.jpg, /s640x960/ → s2048x3072; eski tumblr_xxx_500.jpg → _1280;
  // avatarlar avatar_xxx_64.pnj → _512
  if (/(^|\.)tumblr\.com$/.test(host)) {
    // .pnj / .gifv tarayıcı dışı isteklere HTML sayfası dönebilir: doğrudan .png / .gif sürümünü de dene
    const plain = (x) => x.replace(/\.pnj(?=$|[?#])/i, '.png').replace(/\.gifv(?=$|[?#])/i, '.gif');
    const sized = [];
    if (/\/s\d+x\d+[\w]*\//.test(u.pathname)) sized.push(url.replace(/\/s\d+x\d+[\w]*\//, '/s2048x3072/'));
    if (new RegExp(`_\\d{2,4}\\.${IMG_EXT}$`, 'i').test(u.pathname)) {
      const big = /\/avatar_/.test(u.pathname) ? '512' : '1280';
      sized.push(url.replace(new RegExp(`_\\d{2,4}(\\.${IMG_EXT})(?=$|[?#])`, 'i'), `_${big}$1`));
    }
    for (const s of sized) {
      add(plain(s));
      add(s);
    }
    add(plain(url));
  }

  // X / Twitter: ?format=jpg&name=small → name=orig; foto.jpg:small → ?format=jpg&name=orig;
  // profil fotoğrafları _normal / _bigger / _mini / _200x200 → orijinal
  if (host === 'pbs.twimg.com') {
    if (u.pathname.startsWith('/media/')) {
      const m = /^(\/media\/[^.:]+)(?:\.(\w+))?(?::\w+)?$/.exec(u.pathname);
      if (m) {
        const fmt = u.searchParams.get('format') || m[2] || 'jpg';
        add(`${u.origin}${m[1]}?format=${fmt}&name=orig`);
        add(`${u.origin}${m[1]}?format=${fmt}&name=4096x4096`);
        add(`${u.origin}${m[1]}?format=${fmt}&name=large`);
      }
    }
    if (/_(normal|bigger|mini|\d+x\d+)\.\w+$/.test(u.pathname)) add(url.replace(/_(normal|bigger|mini|\d+x\d+)(\.\w+)(?=$|[?#])/, '$2'));
  }

  // Pinterest: /236x/…, /474x/, /736x/ → /originals/
  if (host === 'i.pinimg.com' && /^\/\d+x\d*\//.test(u.pathname)) {
    add(url.replace(/^(https?:\/\/[^/]+)\/\d+x\d*\//, '$1/originals/'));
    add(url.replace(/^(https?:\/\/[^/]+)\/\d+x\d*\//, '$1/736x/'));
  }

  // Reddit önizlemesi: preview.redd.it/ID.jpg?width=… → i.redd.it/ID.jpg
  if (host === 'preview.redd.it' || host === 'external-preview.redd.it') {
    const name = u.pathname.split('/').pop();
    if (host === 'preview.redd.it' && /^[\w-]+\.\w+$/.test(name)) add(`https://i.redd.it/${name.replace(/^.*-([a-z0-9]{13}\.\w+)$/, '$1')}`);
  }

  // Imgur: i.imgur.com/AbCdEfGs.jpg (s/b/t/m/l/h son eki küçük boyuttur) → AbCdEfG.jpg
  if (host === 'i.imgur.com') {
    const m = /^\/([A-Za-z0-9]{5,7})[sbtmlh]\.(\w+)$/.exec(u.pathname);
    if (m) add(`${u.origin}/${m[1]}.${m[2]}`);
  }

  // Wikipedia / Wikimedia küçük resmi: /thumb/a/ab/Dosya.jpg/220px-Dosya.jpg → /a/ab/Dosya.jpg
  if (host === 'upload.wikimedia.org' && u.pathname.includes('/thumb/')) {
    add(url.replace(/\/thumb(\/[^/]+\/[^/]+\/[^/]+)\/[^/]+$/, '$1'));
  }

  // Gravatar ?s=64 → s=2048; Discord ?size=64 → size=4096
  if (/(^|\.)gravatar\.com$/.test(host) && /[?&](s|size)=\d+/.test(u.search)) {
    add(url.replace(/([?&])(s|size)=\d+/, '$1$2=2048'));
  }
  if (/(^|\.)(discordapp\.(com|net)|discord\.com)$/.test(host) && u.searchParams.has('size')) {
    const x = new URL(url);
    x.searchParams.set('size', '4096');
    add(x.toString());
  }

  // WordPress ve benzerleri: foto-150x150.jpg → foto.jpg (orijinal yükleme)
  if (new RegExp(`-\\d{2,4}x\\d{2,4}\\.${IMG_EXT}$`, 'i').test(u.pathname)) {
    add(url.replace(new RegExp(`-\\d{2,4}x\\d{2,4}(\\.${IMG_EXT})(?=$|[?#])`, 'i'), '$1'));
  }
  // WordPress Jetpack görsel hızlandırıcı: i0.wp.com/…?resize=150,150 / ?w=300 → parametresiz
  if (/^i\d\.wp\.com$/.test(host) && /[?&](resize|w|h|fit)=/.test(u.search)) add(`${u.origin}${u.pathname}`);

  return out;
}

module.exports = { fullSizeCandidates };
