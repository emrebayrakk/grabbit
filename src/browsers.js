'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Eklenti mağazada yayınlanınca kimlikleri buraya yazılır; boşsa geliştirici modu ile kurulum kullanılır.
let STORE = { chrome: '', edge: '' };
try {
  STORE = { ...STORE, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'extension-store.json'), 'utf8')) };
} catch { /* dosya yoksa mağaza kurulumu kapalı */ }

const CHROME_UPDATE = 'https://clients2.google.com/service/update2/crx';
const EDGE_UPDATE = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx';

// Chromium tabanlı, eklentimizi çalıştırabilen tarayıcılar.
// regKey: tarayıcının açılışta okuduğu "harici eklenti" kayıt defteri anahtarı (yönetici izni gerekmez).
const CANDIDATES = [
  { id: 'chrome', name: 'Google Chrome', scheme: 'chrome', exe: ['Google\\Chrome\\Application\\chrome.exe'], store: 'chrome', regKey: 'Software\\Google\\Chrome\\Extensions' },
  { id: 'edge', name: 'Microsoft Edge', scheme: 'edge', exe: ['Microsoft\\Edge\\Application\\msedge.exe'], store: 'edge', regKey: 'Software\\Microsoft\\Edge\\Extensions' },
  { id: 'brave', name: 'Brave', scheme: 'brave', exe: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], store: 'chrome', regKey: 'Software\\BraveSoftware\\Brave-Browser\\Extensions' },
  { id: 'opera', name: 'Opera', scheme: 'opera', exe: ['Programs\\Opera\\opera.exe', 'Programs\\Opera GX\\opera.exe'], store: 'chrome' },
  { id: 'vivaldi', name: 'Vivaldi', scheme: 'vivaldi', exe: ['Vivaldi\\Application\\vivaldi.exe'], store: 'chrome' }
];

function roots() {
  const env = process.env;
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
}

/** Bu tarayıcı için mağaza kurulumu mümkünse mağaza bilgisini döner. */
function storeFor(c) {
  if (c.store === 'edge' && STORE.edge) {
    return { url: `https://microsoftedge.microsoft.com/addons/detail/${STORE.edge}`, extId: STORE.edge, updateUrl: EDGE_UPDATE };
  }
  // Edge, Chrome Web Mağazası'ndan da kurabilir
  if (STORE.chrome && (c.store === 'chrome' || c.store === 'edge')) {
    return { url: `https://chromewebstore.google.com/detail/${STORE.chrome}`, extId: STORE.chrome, updateUrl: CHROME_UPDATE };
  }
  return null;
}

/** Bilgisayarda kurulu tarayıcıları bulur. */
function detectBrowsers() {
  const found = [];
  for (const c of CANDIDATES) {
    let exePath = null;
    for (const root of roots()) {
      for (const rel of c.exe) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) {
          exePath = p;
          break;
        }
      }
      if (exePath) break;
    }
    if (exePath) found.push({ id: c.id, name: c.name, scheme: c.scheme, exe: exePath, oneClick: !!storeFor(c) });
  }
  return found;
}

function launch(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** HKCU altına harici eklenti kaydı: tarayıcı açılışta "Yeni eklenti eklendi" diye sorar. */
function registerExternal(regKey, info) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !regKey) return resolve(false);
    execFile(
      'reg',
      ['add', `HKCU\\${regKey}\\${info.extId}`, '/v', 'update_url', '/t', 'REG_SZ', '/d', info.updateUrl, '/f'],
      { windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

/**
 * Eklentiyi kurdurur. Mağazada yayınlıysa: kayıt defterine harici eklenti yazar ve mağaza sayfasını açar
 * (tek tık "Ekle"). Değilse: eklentiler sayfasını açar; son adım geliştirici modu ile kullanıcıda.
 */
async function setupBrowser(browser) {
  const c = CANDIDATES.find((x) => x.id === browser.id);
  const store = c && storeFor(c);
  if (store) {
    const registered = await registerExternal(c.regKey, store);
    launch(browser.exe, [store.url]);
    return { mode: 'store', registered };
  }
  launch(browser.exe, [`${browser.scheme}://extensions/`]);
  return { mode: 'manual' };
}

module.exports = { detectBrowsers, setupBrowser, storeFor, CANDIDATES };
