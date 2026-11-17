'use strict';

const DEFAULTS = { port: 17890, intercept: true, minSizeMb: 0, videoButton: true };
const $ = (id) => document.getElementById(id);

async function refreshStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'ping' });
  $('status').className = 'status ' + (r?.ok ? 'on' : 'off');
  $('statusText').textContent = r?.ok ? tiT('paired', { browser: r.browser }) : tiT('notFound');
}

async function renderMedia() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const box = $('media');
  const sniffed = tab ? (await chrome.runtime.sendMessage({ type: 'getMedia', tabId: tab.id })) || [] : [];
  // YouTube, Instagram vb.: sayfanın videosu video motoruyla; diğer sitelerde reklam/önizleme ve tekrarlar elenir
  const list = tab ? tiPickMedia(sniffed, { mediaPage: tiIsMediaPage(tab.url), pageUrl: tab.url, allStreams: true, limit: 5 }) : [];
  if (!list.length) {
    box.innerHTML = '<div class="empty"></div>';
    box.firstChild.textContent = tiT('noMedia');
    return;
  }
  box.innerHTML = '';
  const pageTitle = (tab.title || '').replace(/\s*[-|–]\s*[^-|–]*$/, '');
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'm';
    const d = tiDescribe(m, tiT, { pageTitle });
    el.innerHTML = '<span class="tag"></span><div class="info"><b></b><small></small></div><button class="dl"></button>';
    el.querySelector('button').textContent = tiT('download');
    el.querySelector('.tag').textContent = d.tag;
    el.querySelector('b').textContent = d.title;
    el.querySelector('b').title = m.url;
    el.querySelector('small').textContent = d.sub;
    el.querySelector('button').onclick = async (e) => {
      e.target.textContent = '…';
      const r = await chrome.runtime.sendMessage({ type: 'download', item: m, tabId: tab.id });
      e.target.textContent = r?.ok ? '✓' : '!';
      e.target.title = r?.ok ? tiT('sentShort') : r?.error || '';
    };
    box.appendChild(el);
  }
}

function applyTexts() {
  document.querySelectorAll('[data-t]').forEach((el) => (el.textContent = tiT(el.dataset.t)));
}

async function init() {
  applyTexts();
  tiLoadLang(() => {
    applyTexts();
    refreshStatus();
    renderMedia();
  });
  const s = await chrome.storage.local.get(DEFAULTS);
  $('intercept').checked = s.intercept;
  $('videoButton').checked = s.videoButton;
  $('minSize').value = s.minSizeMb;
  $('port').value = s.port;
  $('intercept').onchange = (e) => chrome.storage.local.set({ intercept: e.target.checked });
  $('videoButton').onchange = (e) => chrome.storage.local.set({ videoButton: e.target.checked });
  $('minSize').onchange = (e) => chrome.storage.local.set({ minSizeMb: Math.max(0, Number(e.target.value) || 0) });
  $('port').onchange = async (e) => {
    await chrome.storage.local.set({ port: Number(e.target.value) || DEFAULTS.port });
    refreshStatus();
  };
  refreshStatus();
  renderMedia();
}

init();
