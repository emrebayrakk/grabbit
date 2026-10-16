'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const EVENTS = ['downloads', 'settings', 'bridge', 'clipboard-urls', 'open-add', 'focus-item', 'item', 'tools'];

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  toolsStatus: () => call('tools:status'),
  installTools: () => call('tools:install'),
  singleState: () => call('single:state'),
  openSingle: (id) => call('single:open', id),
  openInfo: (payload) => call('single:open-info', payload),
  showMain: () => call('app:show-main'),
  listBrowsers: () => call('browsers:list'),
  setupBrowser: (id) => call('browsers:setup', id),
  probe: (url, headers, cookie, kind, jar) => call('dl:probe', url, headers, cookie, kind, jar),
  add: (entries) => call('dl:add', entries),
  start: (ids) => call('dl:start', ids),
  pause: (ids) => call('dl:pause', ids),
  startAll: () => call('dl:start-all'),
  pauseAll: () => call('dl:pause-all'),
  remove: (ids, deleteFiles) => call('dl:remove', ids, deleteFiles),
  redownload: (id) => call('dl:redownload', id),
  updateUrl: (id, url) => call('dl:update-url', id, url),
  setItemLimit: (id, kbps) => call('dl:set-limit', id, kbps),
  computeHash: (id, algo) => call('dl:hash', id, algo),
  setExpectedHash: (id, algo, expected) => call('dl:expected-hash', id, algo, expected),
  open: (id) => call('dl:open', id),
  showInFolder: (id) => call('dl:show', id),
  setSettings: (patch) => call('settings:set', patch),
  pickFolder: (current) => call('dialog:folder', current),
  readClipboard: () => call('clipboard:read'),
  writeClipboard: (text) => call('clipboard:write', text),
  openExtensionFolder: () => call('app:open-extension'),
  openFolder: (dir) => call('app:open-folder', dir),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) return () => {};
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  }
});
