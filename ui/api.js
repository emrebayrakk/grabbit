'use strict';

// Arayüz ile Rust arka planı arasındaki köprü: Tauri komutlarını `window.api` olarak sunar.
// Ayrıca pencere çerçevesini (sürükleme alanları, küçült/büyüt/kapat düğmeleri) HTML ile çizer.
(function () {
  const T = window.__TAURI__;
  const win = T.window.getCurrentWindow();
  const webview = T.webviewWindow.getCurrentWebviewWindow();
  const isMain = win.label === 'main';

  const invoke = (cmd, args) =>
    T.core.invoke(cmd, args).catch((e) => {
      throw new Error(typeof e === 'string' ? e : e?.message || String(e));
    });

  window.api = {
    getState: () => invoke('state_get'),
    toolsStatus: () => invoke('tools_status'),
    installTools: () => invoke('tools_install'),
    singleState: () => invoke('single_state'),
    openSingle: (id) => invoke('single_open', { id }),
    openInfo: (payload) => invoke('single_open_info', { payload }),
    showMain: () => invoke('app_show_main'),
    listBrowsers: () => invoke('browsers_list'),
    setupBrowser: (id) => invoke('browsers_setup', { id }),
    probe: (url, headers, cookie, kind, jar) =>
      invoke('dl_probe', { url, headers: headers || null, cookie: cookie || null, kind: kind || null, jar: jar || null }),
    add: (entries) => invoke('dl_add', { entries }),
    start: (ids) => invoke('dl_start', { ids }),
    pause: (ids) => invoke('dl_pause', { ids }),
    startAll: () => invoke('dl_start_all'),
    pauseAll: () => invoke('dl_pause_all'),
    remove: (ids, deleteFiles) => invoke('dl_remove', { ids, deleteFiles: !!deleteFiles }),
    redownload: (id) => invoke('dl_redownload', { id }),
    updateUrl: (id, url) => invoke('dl_update_url', { id, url }),
    setItemLimit: (id, kbps) => invoke('dl_set_limit', { id, kbps }),
    computeHash: (id, algo) => invoke('dl_hash', { id, algo }),
    setExpectedHash: (id, algo, expected) => invoke('dl_expected_hash', { id, algo, expected: expected ?? null }),
    open: (id) => invoke('dl_open', { id }),
    showInFolder: (id) => invoke('dl_show', { id }),
    setSettings: (patch) => invoke('settings_set', { patch }),
    pickFolder: (current) => invoke('dialog_folder', { current: current || null }),
    readClipboard: () => invoke('clipboard_read'),
    writeClipboard: (text) => invoke('clipboard_write', { text: String(text) }),
    openExtensionFolder: () => invoke('app_open_extension'),
    openFolder: (dir) => invoke('app_open_folder', { dir: dir || null }),
    openUrl: (url) => invoke('app_open_url', { url }),
    quit: () => invoke('app_quit'),
    on: (channel, cb) => {
      const off = webview.listen(channel, (e) => cb(e.payload));
      return () => off.then((un) => un());
    }
  };

  // Tekli pencerelerdeki "Kapat" düğmeleri window.close() kullanır
  window.close = () => win.close();

  // Dış bağlantılar pencere içinde değil varsayılan tarayıcıda açılır
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (a && /^https?:/i.test(a.getAttribute('href'))) {
      e.preventDefault();
      window.api.openUrl(a.href);
    }
  });
  window.open = (url) => {
    if (/^https?:/i.test(String(url))) window.api.openUrl(String(url));
    return null;
  };

  // ------------------------------------------------------------ pencere çerçevesi

  // CSS'teki `-webkit-app-region: drag` alanları sürüklenir (Electron'daki gibi); düğme ve alanlar hariç
  function dragRegion(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.matches('button, input, select, textarea, a, label, [contenteditable], .win-controls')) return false;
      const cs = getComputedStyle(n);
      const r = cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region');
      if (r === 'no-drag') return false;
      if (r === 'drag') return true;
    }
    return false;
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !dragRegion(e.target)) return;
    if (e.detail === 2 && isMain) win.toggleMaximize();
    else win.startDragging();
  });

  const ICONS = {
    min: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    max: '<svg viewBox="0 0 10 10" width="10" height="10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg>',
    restore:
      '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M2.5 .5h7v7M.5 2.5h7v7h-7z" fill="none" stroke="currentColor"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.1"/></svg>'
  };

  function buildControls() {
    const box = document.createElement('div');
    box.className = 'win-controls' + (isMain ? '' : ' compact');
    box.innerHTML =
      `<button type="button" class="wc-min" tabindex="-1">${ICONS.min}</button>` +
      (isMain ? `<button type="button" class="wc-max" tabindex="-1">${ICONS.max}</button>` : '') +
      `<button type="button" class="wc-close" tabindex="-1">${ICONS.close}</button>`;
    box.querySelector('.wc-min').onclick = () => win.minimize();
    box.querySelector('.wc-close').onclick = () => win.close();
    const max = box.querySelector('.wc-max');
    if (max) {
      max.onclick = () => win.toggleMaximize();
      const sync = () => win.isMaximized().then((m) => (max.innerHTML = m ? ICONS.restore : ICONS.max));
      win.onResized(sync);
      sync();
    }
    document.body.appendChild(box);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildControls);
  else buildControls();
})();
