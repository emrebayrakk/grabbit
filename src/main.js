'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeImage,
  nativeTheme,
  Notification
} = require('electron');
const { DownloadManager, CATEGORIES } = require('./engine/manager');
const { MEDIA_HOSTS } = require('./engine/media');
const { extOf } = require('./engine/utils');
const { startBridge } = require('./bridge');
const { detectBrowsers, setupBrowser } = require('./browsers');
const fs = require('fs');
const os = require('os');
const I18N = require('../i18n/i18n');

const t = I18N.t;

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const TRAY_ICON = path.join(ROOT, 'assets', 'tray.png');
const EXTENSION_DIR = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(ROOT, 'extension');
const DOWNLOADABLE_EXT = new Set(Object.values(CATEGORIES).flatMap((c) => c.ext));

let win = null;
let tray = null;
let manager = null;
let bridge = null;
let bridgeStatus = { running: false, port: 0, error: null };
let quitting = false;
let shutdownDone = false;
let trayHintShown = false;
// Tekli indirme pencereleri: webContents.id → { win, downloadId, payload }
const singles = new Map();
// Eklentisi bağlanan tarayıcılar: ad → { lastSeen, version }
let paired = {};

// Taşınabilir kullanım / test için veri klasörü dışarıdan verilebilir
const DATA_OVERRIDE = process.env.GRABBIT_DATA || process.env.TURBO_INDIR_DATA;
if (DATA_OVERRIDE) app.setPath('userData', path.resolve(DATA_OVERRIDE));
else migrateFromTurboIndir();

/**
 * Uygulamanın eski adı "Turbo İndir" idi: ilk açılışta indirme listesi, ayarlar, eşleşen tarayıcılar
 * ve kurulu video motoru yeni veri klasörüne taşınır.
 */
function migrateFromTurboIndir() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Turbo İndir');
    const newDir = app.getPath('userData');
    if (!fs.existsSync(oldDir)) return;
    if (fs.existsSync(path.join(newDir, 'settings.json')) || fs.existsSync(path.join(newDir, 'downloads.json'))) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['settings.json', 'downloads.json', 'browsers.json']) {
      if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
    }
    if (fs.existsSync(path.join(oldDir, 'tools')) && !fs.existsSync(path.join(newDir, 'tools'))) {
      fs.renameSync(path.join(oldDir, 'tools'), path.join(newDir, 'tools'));
    }
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
}

app.setAppUserModelId('com.turboindir.app');

async function boot() {
  manager = new DownloadManager({
    dataDir: app.getPath('userData'),
    defaultDownloadDir: app.getPath('downloads'),
    trashItem: (p) => shell.trashItem(p)
  });
  await manager.init();
  applyLanguage();
  manager.tools.on('status', (s) => broadcast('tools', s));
  // yt-dlp'yi arka planda güncel tut (siteler sık değişir)
  manager.tools.maybeUpdate().catch(() => {});
  // Uygulama günlerce tepside açık kalabilir: arada bir yine bak (asıl sıklığı maybeUpdate belirler)
  setInterval(() => manager.tools.maybeUpdate().catch(() => {}), 6 * 3600 * 1000).unref();
  nativeTheme.themeSource = manager.settings.theme;
  try {
    paired = JSON.parse(fs.readFileSync(pairedFile(), 'utf8'));
  } catch {
    paired = {};
  }
  if (process.platform === 'win32') {
    // Eski sürümler tarayıcıyı eklentinin beyanından tahmin ediyordu (Vivaldi → "Chrome").
    // Doğrulanmamış kayıtları at; gerçekten bağlı tarayıcılar 1 dakika içinde yeniden bildirir.
    for (const [name, rec] of Object.entries(paired)) if (!rec?.verified) delete paired[name];
  }

  wireManager();
  registerIpc();
  createWindow();
  createTray();
  applyBridge();
  startClipboardWatch();
}

// ---------- pencere & tepsi ----------

// Windows 11 22H2+ yarı saydam "Mica" zemini destekler; eski sürümlerde düz renk kullanılır
const SUPPORTS_MICA = process.platform === 'win32' && Number(String(os.release()).split('.')[2] || 0) >= 22621;

/** Başlık çubuğuna gömülü pencere düğmelerinin (küçült/kapat) renkleri temaya uysun. */
function titleBarOverlay(height) {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#e6ebf3' : '#1e293b', height };
}

/** Modern pencere: gizli başlık çubuğu + gömülü pencere düğmeleri + (varsa) Mica zemin. */
function modernFrame(height) {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(height),
    backgroundMaterial: SUPPORTS_MICA ? 'mica' : undefined,
    backgroundColor: SUPPORTS_MICA ? '#00000000' : dark ? '#0b0f17' : '#f1f3f7'
  };
}

nativeTheme.on('updated', () => {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setTitleBarOverlay(titleBarOverlay(w === win ? MAIN_BAR : SINGLE_BAR));
    } catch { /* başlıksız pencere */ }
  }
});
const MAIN_BAR = 48;
const SINGLE_BAR = 40;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 880,
    minHeight: 540,
    title: 'Grabbit',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    ...modernFrame(MAIN_BAR),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  // Gizliyken gönderilmeyen güncellemeleri pencere görününce eşitle
  win.on('show', pushState);
  win.on('restore', pushState);
  win.on('close', (e) => {
    if (!quitting && manager.settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown && manager.settings.notifications) {
        trayHintShown = true;
        notify(t('main.trayHintTitle'), t('main.trayHintBody'));
      }
    }
  });
  // Pencere içinde gezinmeyi ve yeni pencereleri engelle; dış bağlantıları tarayıcıda aç
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---------- tekli indirme pencereleri (IDM tarzı) ----------

function openSingle({ downloadId = null, payload = null }) {
  if (downloadId) {
    for (const s of singles.values()) {
      if (s.downloadId === downloadId && !s.win.isDestroyed()) {
        if (s.win.isMinimized()) s.win.restore();
        s.win.show();
        s.win.focus();
        return;
      }
    }
  }
  const w = new BrowserWindow({
    width: 560,
    height: payload ? (payload.kind === 'media' ? 540 : 470) : 448,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Grabbit',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    alwaysOnTop: !!payload, // tarayıcıdan gelen sorunun tarayıcının arkasında kalmasın
    ...modernFrame(SINGLE_BAR),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  w.setMenu(null);
  const id = w.webContents.id;
  singles.set(id, { win: w, downloadId, payload });
  w.on('closed', () => singles.delete(id));
  w.on('restore', pushState);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.loadFile(path.join(ROOT, 'renderer', 'single.html'));
  w.once('ready-to-show', () => {
    w.show();
    w.focus();
    if (payload) setTimeout(() => !w.isDestroyed() && w.setAlwaysOnTop(false), 1500);
  });
}

function singleFor(sender) {
  return singles.get(sender.id);
}

function pairedFile() {
  return path.join(app.getPath('userData'), 'browsers.json');
}

let pairedSaveTimer = null;
function markPaired(name, version, verified) {
  // Windows'ta yalnızca bağlantının sahibi olan programdan doğrulanan tarayıcıyı kaydet:
  // eklentinin kendi beyanı yanıltıcı olabilir (Vivaldi kendini Chrome diye tanıtır)
  if (process.platform === 'win32' && !verified) return;
  const prev = paired[name];
  paired[name] = { lastSeen: Date.now(), version: version || prev?.version || '', verified: !!verified };
  if (!prev) send('bridge', { ...bridgeStatus, paired });
  clearTimeout(pairedSaveTimer);
  pairedSaveTimer = setTimeout(() => fs.promises.writeFile(pairedFile(), JSON.stringify(paired)).catch(() => {}), 2000);
}

/** Ayardaki dil tercihini (ya da sistem dilini) uygular. */
function applyLanguage() {
  I18N.setLanguage(I18N.resolve(manager.settings.language, app.getLocale()));
  buildTrayMenu();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('Grabbit');
  tray.on('click', showWindow);
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('main.trayShow'), click: showWindow },
      {
        label: t('nav.new') + '…',
        click: () => {
          showWindow();
          send('open-add', {});
        }
      },
      { type: 'separator' },
      { label: t('tb.startAll'), click: () => manager.startAll() },
      { label: t('tb.pauseAll'), click: () => manager.pauseAll() },
      { type: 'separator' },
      { label: t('main.quit'), click: () => app.quit() }
    ])
  );
}

/** Ana pencere ve tüm tekli pencerelere gönderir. */
function broadcast(channel, payload) {
  send(channel, payload);
  for (const s of singles.values()) if (!s.win.isDestroyed()) s.win.webContents.send(channel, payload);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  n.on('click', () => {
    showWindow();
    onClick?.();
  });
  n.show();
}

// ---------- yönetici olayları ----------

function wireManager() {
  let pending = false;
  manager.on('change', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      pushState();
    }, 250);
  });
  manager.on('settings', (s) => send('settings', s));
  manager.on('completed', (d) => {
    if (manager.settings.notifications) {
      notify(t('single.doneTitle'), d.filename, () => send('focus-item', d.id));
    }
  });
  manager.on('failed', (d) => {
    if (manager.settings.notifications) {
      const reason = d.errorKey ? t(d.errorKey, d.errorParams) : d.error || '';
      notify(t('single.failTitle'), `${d.filename}\n${reason}`, () => send('focus-item', d.id));
    }
  });
  manager.on('schedule', (what) => {
    if (manager.settings.notifications) {
      notify(t('settings.tabSchedule'), what === 'start' ? t('main.schedStarted') : t('main.schedStopped'));
    }
  });
}

/** Pencere ekranda değilse (tepside/simge durumunda) içine liste göndermenin anlamı yok. */
function onScreen(w) {
  return w && !w.isDestroyed() && w.isVisible() && !w.isMinimized();
}

function pushState() {
  const stats = manager.stats();
  // Tam liste yalnızca ana pencere görünürken gönderilir; görünür olunca 'show'/'restore' ile eşitlenir
  if (onScreen(win)) send('downloads', { downloads: manager.list(), stats });
  for (const s of singles.values()) {
    if (!s.downloadId || !onScreen(s.win)) continue;
    const d = manager.get(s.downloadId);
    s.win.webContents.send('item', d ? d.snapshot() : null);
  }
  if (win && !win.isDestroyed()) {
    if (stats.active === 0) win.setProgressBar(-1);
    else win.setProgressBar(stats.progress >= 0 ? stats.progress : 2, { mode: stats.progress >= 0 ? 'normal' : 'indeterminate' });
  }
  if (tray) {
    tray.setToolTip(stats.active ? `Grabbit — ${t('main.trayActive', { n: stats.active, speed: formatSpeed(stats.speed) })}` : 'Grabbit');
  }
}

function formatSpeed(bps) {
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
}

// ---------- IPC ----------

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });

  handle('state:get', () => ({
    downloads: manager.list(),
    stats: manager.stats(),
    settings: manager.settings,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
    bridge: { ...bridgeStatus, paired },
    tools: manager.tools.status(),
    mediaHosts: MEDIA_HOSTS,
    language: I18N.lang,
    languages: I18N.LANGS,
    mica: SUPPORTS_MICA,
    version: app.getVersion()
  }));
  handle('dl:probe', (url, headers, cookie, kind, jar) => manager.probe(url, headers, cookie, kind, jar));
  handle('tools:status', () => manager.tools.status());
  handle('tools:install', async () => {
    await manager.tools.install();
    return manager.tools.status();
  });
  ipcMain.handle('dl:add', async (e, entries) => {
    try {
      const res = await manager.add(entries);
      const ok = res.filter((r) => !r.error);
      const single = singleFor(e.sender);
      if (single && ok.length === 1) {
        // Bilgi penceresinden başlatıldı: aynı pencere ilerleme ekranına dönüşür
        single.downloadId = ok[0].id;
        single.payload = null;
      } else if (entries.length === 1 && ok.length === 1 && entries[0].startNow !== false && manager.settings.showProgressWindow) {
        openSingle({ downloadId: ok[0].id });
      }
      return { ok: true, data: res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('single:state', (e) => {
    const s = singleFor(e.sender);
    if (!s) return { ok: false, error: 'window not found' };
    const d = s.downloadId ? manager.get(s.downloadId) : null;
    return {
      ok: true,
      data: {
        payload: s.payload,
        item: d ? d.snapshot() : null,
        settings: manager.settings,
        tools: manager.tools.status(),
        language: I18N.lang,
        mica: SUPPORTS_MICA,
        categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label]))
      }
    };
  });
  handle('single:open', (id) => openSingle({ downloadId: id }));
  // Ana penceredeki "Yeni indirme"den video sitesi adresi: kalite seçimi için Dosya bilgisi penceresi
  handle('single:open-info', (payload) => openSingle({ payload: { ...payload, kind: 'media', source: 'Grabbit' } }));
  handle('app:show-main', () => showWindow());
  handle('browsers:list', () => detectBrowsers().map((b) => ({ ...b, paired: paired[b.name] || null })));
  handle('browsers:setup', async (id) => {
    const b = detectBrowsers().find((x) => x.id === id);
    if (!b) throw new Error(t('err.browserNotFound'));
    const r = await setupBrowser(b);
    // Geliştirici modu kurulumunda klasör seçme penceresine yapıştırılsın diye
    if (r.mode === 'manual') await clipboard.writeText(EXTENSION_DIR);
    return { ...r, extensionDir: EXTENSION_DIR };
  });
  handle('dl:start', (ids) => manager.start(ids));
  handle('dl:pause', (ids) => manager.pause(ids));
  handle('dl:start-all', () => manager.startAll());
  handle('dl:pause-all', () => manager.pauseAll());
  handle('dl:remove', (ids, deleteFiles) => manager.remove(ids, deleteFiles));
  handle('dl:redownload', (id) => manager.redownload(id));
  handle('dl:update-url', (id, url) => manager.updateUrl(id, url));
  handle('dl:set-limit', (id, kbps) => manager.setItemSpeedLimit(id, kbps));
  handle('dl:hash', (id, algo) => manager.computeHash(id, algo));
  handle('dl:expected-hash', (id, algo, expected) => manager.setExpectedHash(id, algo, expected));
  handle('dl:open', async (id) => {
    const d = manager.get(id);
    if (!d || d.status !== 'completed') throw new Error(t('err.notReady'));
    const err = await shell.openPath(d.savePath);
    if (err) throw new Error(err);
  });
  handle('dl:show', (id) => {
    const d = manager.get(id);
    if (!d) throw new Error(t('err.downloadNotFound'));
    if (d.status === 'completed') shell.showItemInFolder(d.savePath);
    else shell.openPath(d.dir);
  });
  handle('settings:set', (patch) => {
    const before = { ...manager.settings };
    const s = manager.updateSettings(patch);
    if (s.theme !== before.theme) nativeTheme.themeSource = s.theme;
    if (s.language !== before.language) {
      applyLanguage();
      // Tüm pencereler yeni dille yeniden çizilsin
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
    }
    if (s.bridgeEnabled !== before.bridgeEnabled || s.bridgePort !== before.bridgePort) applyBridge();
    return s;
  });
  handle('dialog:folder', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.pickFolder'),
      defaultPath: current || manager.settings.downloadDir,
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('clipboard:read', () => readClipboard());
  handle('clipboard:write', async (text) => {
    await clipboard.writeText(String(text));
  });
  handle('app:open-extension', () => shell.openPath(EXTENSION_DIR));
  handle('app:open-folder', (dir) => shell.openPath(dir || manager.settings.downloadDir));
}

// ---------- tarayıcı köprüsü ----------

function applyBridge() {
  if (bridge) {
    bridge.close();
    bridge = null;
  }
  const { bridgeEnabled, bridgePort } = manager.settings;
  bridgeStatus = { running: false, port: bridgePort, error: null };
  if (bridgeEnabled) {
    bridge = startBridge({
      port: bridgePort,
      version: app.getVersion(),
      onAdd: handleBridgeAdd,
      // Video düğmesine gelinince sayfa önceden yoklanır (motor kuruluysa)
      onPrefetch: ({ url, cookie, jar, headers }) => {
        if (manager.tools.ready) manager.probe(url, headers, cookie || '', 'media', jar).catch(() => {});
      },
      onPing: markPaired,
      getLang: () => I18N.lang,
      onError: (err) => {
        bridgeStatus = {
          running: false,
          port: bridgePort,
          error: err.code === 'EADDRINUSE' ? t('bridge.portInUse', { port: bridgePort }) : err.message,
          errorKey: err.code === 'EADDRINUSE' ? 'bridge.portInUse' : undefined
        };
        send('bridge', { ...bridgeStatus, paired });
      }
    });
    bridge.on('listening', () => {
      bridgeStatus = { running: true, port: bridgePort, error: null };
      send('bridge', { ...bridgeStatus, paired });
    });
  }
  send('bridge', { ...bridgeStatus, paired });
}

async function handleBridgeAdd({ urls, filename, cookie, jar, headers, kind, variantUrl, quality, source }) {
  if (manager.settings.askOnBridge) {
    if (urls.length === 1) {
      // Yoklama pencere açılırken başlasın; pencere aynı sonucu önbellekten alır
      manager.probe(urls[0], headers, cookie || '', kind, jar).catch(() => {});
      // IDM'deki "Dosya bilgisi" penceresi: ana pencereyi açmadan sor
      openSingle({ payload: { url: urls[0], filename, cookie, jar, headers, kind, variantUrl, quality, source } });
    } else {
      showWindow();
      send('open-add', { urls, headers });
    }
    return;
  }
  const res = await manager.add(
    urls.map((url) => ({ url, filename: urls.length === 1 ? filename : undefined, cookie, jar, headers, kind, variantUrl, quality }))
  );
  const ok = res.filter((r) => !r.error);
  if (ok.length === 1 && manager.settings.showProgressWindow) openSingle({ downloadId: ok[0].id });
  else if (manager.settings.notifications) notify(t('main.addedTitle'), t('toast.manyQueued', { n: ok.length }));
}

// ---------- pano izleme ----------

/** Electron 44+ pano API'si async (W3C tarzı); eski sürümlerde senkron. İkisinde de metin döner. */
async function readClipboard() {
  try {
    const t = await clipboard.readText();
    return typeof t === 'string' ? t : '';
  } catch {
    return ''; // pano başka bir uygulama tarafından kilitli olabilir
  }
}

function startClipboardWatch() {
  let last = null;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const text = await readClipboard();
      if (last === null || !manager.settings.clipboardWatch) {
        last = text; // açılıştaki/kapalıyken kopyalananları önerme
        return;
      }
      if (text !== last) {
        last = text;
        checkClipboardText(text);
      }
    } catch (err) {
      console.error('Clipboard watch error:', err);
    } finally {
      busy = false;
    }
  }, 1200);
}

function checkClipboardText(text) {
  if (!text || text.length > 20000) return;
  const known = new Set(manager.list().map((d) => d.url));
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>]+/gi) || [])].filter((u) => {
    if (known.has(u)) return false;
    try {
      return DOWNLOADABLE_EXT.has(extOf(decodeURIComponent(new URL(u).pathname)));
    } catch {
      return false;
    }
  });
  if (!urls.length) return;
  if (win && win.isVisible() && !win.isMinimized()) {
    send('clipboard-urls', urls);
  } else if (manager.settings.notifications) {
    notify(t('clip.found', { n: urls.length }), urls.length === 1 ? urls[0] : t('add.multi', { n: urls.length }), () =>
      send('open-add', { urls })
    );
  }
}

// ---------- kapanış ----------

app.on('before-quit', (e) => {
  quitting = true;
  if (shutdownDone || !manager) return;
  e.preventDefault();
  manager
    .shutdown()
    .catch(() => {})
    .finally(() => {
      shutdownDone = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  // Tepsi açıkken uygulama çalışmaya devam eder
});
