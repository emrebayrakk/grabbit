'use strict';

// Videoların sağ üst köşesinde IDM tarzı "Bu videoyu indir" düğmesi gösterir.
(() => {
  if (window.__turboIndir) return;
  window.__turboIndir = true;

  let enabled = true;
  let intercept = true;
  chrome.storage.local.get({ videoButton: true, intercept: true }, (s) => {
    enabled = s.videoButton;
    intercept = s.intercept;
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.intercept) intercept = c.intercept.newValue;
    if (c.videoButton) {
      enabled = c.videoButton.newValue;
      if (!enabled) hide(true);
    }
  });

  // Dosya bağlantılarına tıklamayı IDM gibi doğrudan yakala. (PDF ve resimler tarayıcıda açılsın.)
  const CAPTURE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|zst|exe|msi|msix|apk|dmg|pkg|deb|rpm|iso|img|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|mp3|wav|flac|aac|m4a|ogg|wma|opus|docx?|xlsx?|pptx?|odt|ods|epub)$/i;
  document.addEventListener(
    'click',
    (e) => {
      if (!intercept || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.composedPath().find((n) => n.tagName === 'A' && n.href);
      if (!a || !/^https?:/i.test(a.href)) return;
      let pathname = '';
      try {
        pathname = decodeURIComponent(new URL(a.href).pathname);
      } catch {
        return;
      }
      if (!CAPTURE_EXT.test(pathname) && !a.hasAttribute('download')) return;
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'captureLink', url: a.href, filename: a.getAttribute('download') || undefined }).catch(() => {
        location.href = a.href; // eklenti yeniden yüklendiyse normal davran
      });
    },
    true
  );

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; display: none; font: 13px/1.3 "Segoe UI", system-ui, sans-serif; }
      .wrap.show { display: block; }
      .btn {
        display: flex; align-items: center; gap: 7px; cursor: pointer; border: 0; color: #fff;
        padding: 7px 12px 7px 9px; border-radius: 9px; font: 600 13px "Segoe UI", system-ui, sans-serif;
        background: linear-gradient(135deg, #3b63f0, #6d4ae8); box-shadow: 0 4px 14px rgba(0,0,0,.35);
        opacity: .94; transition: opacity .15s, transform .15s; white-space: nowrap;
      }
      .btn:hover { opacity: 1; transform: translateY(-1px); }
      .btn svg { width: 17px; height: 17px; flex: none; }
      .x { margin-left: 4px; width: 18px; height: 18px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; opacity: .7; }
      .x:hover { background: rgba(255,255,255,.2); opacity: 1; }
      .menu {
        position: absolute; right: 0; top: calc(100% + 6px); min-width: 280px; max-width: 420px; background: #fff; color: #171a21;
        border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.35); padding: 6px; display: none;
      }
      .menu.show { display: block; }
      .menu .t { font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; padding: 6px 8px 4px; }
      .item { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 7px; cursor: pointer; }
      .item:hover { background: #eef2ff; }
      .item b { display: block; font-weight: 600; }
      .item small { display: block; color: #6b7280; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 330px; }
      .tag { flex: none; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 5px; background: #e8edfe; color: #2a4fd6; }
      .msg { padding: 10px; color: #374151; max-width: 320px; }
      @media (prefers-color-scheme: dark) {
        .menu { background: #1f232b; color: #eceef2; }
        .item:hover { background: #2a3350; }
        .item small, .menu .t { color: #9aa3b2; }
        .tag { background: #2a3350; color: #9cb1ff; }
        .msg { color: #cfd5df; }
      }
    </style>
    <div class="wrap">
      <button class="btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
        <span class="label"></span>
        <span class="x">✕</span>
      </button>
      <div class="menu"></div>
    </div>`;
  const wrap = root.querySelector('.wrap');
  const btn = root.querySelector('.btn');
  const label = root.querySelector('.label');
  const menu = root.querySelector('.menu');
  const closeX = root.querySelector('.x');
  const applyTexts = () => {
    btn.title = tiT('btnTitle');
    closeX.title = tiT('hide');
    if (!menu.classList.contains('show')) label.textContent = tiT('btnLabel');
  };
  applyTexts();
  tiLoadLang(applyTexts);

  let current = null; // şu an düğmenin bağlı olduğu video
  let hideTimer = null;
  const dismissed = new WeakSet();
  let menuOpen = false;

  function attach() {
    if (!host.isConnected) (document.fullscreenElement || document.documentElement).appendChild(host);
  }

  function place(video) {
    const r = video.getBoundingClientRect();
    if (r.width < 160 || r.height < 90 || r.bottom < 0 || r.top > innerHeight) return hide(true);
    attach();
    const w = wrap.offsetWidth || 170;
    wrap.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.right - w - 10)) + 'px';
    wrap.style.top = Math.max(4, r.top + 10) + 'px';
  }

  function show(video) {
    if (!enabled || dismissed.has(video)) return;
    clearTimeout(hideTimer);
    if (current !== video) {
      current = video;
      closeMenu();
      label.textContent = tiT('btnLabel');
    }
    wrap.classList.add('show');
    place(video);
  }

  function hide(now) {
    clearTimeout(hideTimer);
    const go = () => {
      if (menuOpen) return;
      wrap.classList.remove('show');
      current = null;
    };
    if (now) go();
    else hideTimer = setTimeout(go, 2500);
  }

  // Canlı koleksiyon: sayfadaki video sayısını sorgu yapmadan bilir
  const videos = document.getElementsByTagName('video');

  function videoAt(x, y) {
    // elementsFromPoint üst üste binen tüm öğeleri döner; oynatıcı katmanının altındaki video da gelir
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === 'VIDEO') return el;
      if (el === host) return current;
    }
    return null;
  }

  let last = 0;
  document.addEventListener(
    'mousemove',
    (e) => {
      // Videosuz sayfalarda (ve çerçevelerde) hiçbir yerleşim hesabı yapma
      if (!enabled || (!videos.length && !current)) return;
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      const v = videoAt(e.clientX, e.clientY);
      if (v) show(v);
      else if (current) hide(false);
    },
    { passive: true, capture: true }
  );
  addEventListener('scroll', () => current && place(current), { passive: true, capture: true });
  addEventListener('resize', () => current && place(current));
  document.addEventListener('fullscreenchange', () => {
    host.remove();
    if (current) place(current);
  });

  closeX.addEventListener('click', (e) => {
    e.stopPropagation();
    if (current) dismissed.add(current);
    closeMenu();
    hide(true);
  });

  function closeMenu() {
    menuOpen = false;
    menu.classList.remove('show');
  }

  function directSources(video) {
    const urls = [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map((s) => s.src)];
    return [...new Set(urls.filter((u) => /^https?:/i.test(u || '')))];
  }

  function fmtSize(n) {
    if (!(n > 0)) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < 3) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDur(s) {
    if (!(s > 0)) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function describe(m) {
    if (m.type === 'page' && m.quality === 'audio') {
      return { tag: 'MP3', title: tiT('mp3Title'), sub: tiT('mp3Sub') };
    }
    if (m.type === 'page') {
      return { tag: tiT('siteTag'), title: tiT('siteTitle'), sub: tiT('siteSub', { host: location.hostname.replace(/^www\./, '') }) };
    }
    const host = (() => {
      try {
        return new URL(m.url).host;
      } catch {
        return '';
      }
    })();
    const name = decodeURIComponent((m.url.split('?')[0].split('/').pop() || '').slice(0, 80));
    if (m.type === 'hls') {
      return {
        tag: m.quality || 'HLS',
        title: m.variants?.length ? tiT('hlsTitleQ', { n: m.variants.length }) : tiT('hlsTitle'),
        sub: [fmtDur(m.duration), host].filter(Boolean).join(' · ')
      };
    }
    return {
      tag: m.type === 'audio' ? tiT('audioTag') : (name.split('.').pop() || 'VIDEO').toUpperCase().slice(0, 5),
      title: name || (m.type === 'audio' ? tiT('audioFile') : tiT('videoFile')),
      sub: [fmtSize(m.size), host].filter(Boolean).join(' · ')
    };
  }

  // Akış sayfalarında (X, Instagram, TikTok, Facebook…) imlecin altındaki gönderinin kalıcı adresi
  const POST_LINK = /\/(status|statuses|p|reel|reels|tv|video|videos|watch|shorts|clip|clips)\/[^/?#]+|[?&]v=/i;

  function siteRoot(host) {
    return host.split('.').slice(-2).join('.');
  }

  function pageVideoUrl(video) {
    const host = location.hostname;
    // YouTube ve gömülü oynatıcılarda sayfanın kendisi videonun adresidir
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return location.href;
    const root = siteRoot(host);
    let el = video;
    for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
      for (const a of el.querySelectorAll ? el.querySelectorAll('a[href]') : []) {
        try {
          const u = new URL(a.href);
          if (siteRoot(u.hostname) === root && POST_LINK.test(u.pathname + u.search)) return u.href;
        } catch { /* geçersiz bağlantı */ }
      }
    }
    return location.href;
  }

  async function candidates(video) {
    const direct = directSources(video).map((url) => ({ url, type: 'video', size: -1, direct: true }));
    let sniffed = [];
    try {
      sniffed = (await chrome.runtime.sendMessage({ type: 'getMedia' })) || [];
    } catch { /* eklenti yeniden yüklendiyse */ }
    const all = [...direct];
    for (const m of sniffed.sort((a, b) => (b.type === 'hls') - (a.type === 'hls') || (b.size || 0) - (a.size || 0))) {
      if (!all.some((x) => x.url === m.url)) all.push(m);
    }
    // Video sitelerinde (YouTube vb.) asıl yol sayfa adresiyle video motoru; başka sitelerde
    // hiçbir şey yakalanmadıysa son çare olarak yine onu dene.
    const page = { url: pageVideoUrl(video), type: 'page', size: -1 };
    if (tiIsMediaPage(location.href)) {
      return [page, { ...page, quality: 'audio' }, ...all.filter((m) => m.type === 'hls' || m.direct)];
    }
    return all.length ? all : [page];
  }

  async function download(item) {
    label.textContent = tiT('sending');
    closeMenu();
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'download', item });
    } catch {
      r = { ok: false, error: tiT('reloaded') };
    }
    label.textContent = r?.ok ? tiT('sent') : r?.error || tiT('sendFailed');
    setTimeout(() => {
      if (current) label.textContent = tiT('btnLabel');
    }, 2500);
  }

  function message(text) {
    menu.innerHTML = `<div class="msg"></div>`;
    menu.firstChild.textContent = text;
    menu.classList.add('show');
    menuOpen = true;
  }

  // Düğmeye gelince video sitesindeki sayfa uygulamada önceden yoklanır: tıklayınca bilgiler hazır olur
  const prefetched = new Set();
  btn.addEventListener('pointerenter', () => {
    if (!current || !tiIsMediaPage(location.href)) return;
    const url = pageVideoUrl(current);
    if (prefetched.has(url)) return;
    prefetched.add(url);
    chrome.runtime.sendMessage({ type: 'prefetch', url }).catch(() => {});
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menuOpen) return closeMenu();
    const video = current;
    if (!video) return;
    const list = await candidates(video);
    if (!list.length) return message(tiT('noAddress'));
    if (list.length === 1) return download(list[0]);
    menu.innerHTML = '<div class="t"></div>';
    menu.firstChild.textContent = tiT('pickVideo');
    for (const m of list) {
      const d = describe(m);
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = '<span class="tag"></span><div><b></b><small></small></div>';
      el.querySelector('.tag').textContent = d.tag;
      el.querySelector('b').textContent = d.title;
      el.querySelector('small').textContent = d.sub || m.url;
      el.title = m.url;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        download(m);
      });
      menu.appendChild(el);
    }
    menu.classList.add('show');
    menuOpen = true;
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (menuOpen && !e.composedPath().includes(host)) {
        closeMenu();
        hide(false);
      }
    },
    true
  );
})();
