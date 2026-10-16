'use strict';

const DEFAULTS = { port: 17890, intercept: true, minSizeMb: 0, videoButton: true };
const $ = (id) => document.getElementById(id);

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

async function refreshStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'ping' });
  $('status').className = 'status ' + (r?.ok ? 'on' : 'off');
  $('statusText').textContent = r?.ok ? tiT('paired', { browser: r.browser }) : tiT('notFound');
}

async function renderMedia() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const box = $('media');
  const list = tab ? (await chrome.runtime.sendMessage({ type: 'getMedia', tabId: tab.id })) || [] : [];
  // YouTube, Instagram vb.: sayfanın videosu video motoruyla indirilir
  if (tab && tiIsMediaPage(tab.url)) {
    list.unshift({ type: 'page', url: tab.url, size: -1 }, { type: 'page', url: tab.url, size: -1, quality: 'audio' });
  }
  if (!list?.length) {
    box.innerHTML = '<div class="empty"></div>';
    box.firstChild.textContent = tiT('noMedia');
    return;
  }
  box.innerHTML = '';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'm';
    let host = '';
    try {
      host = new URL(m.url).host;
    } catch { /* yoksay */ }
    const name = decodeURIComponent(m.url.split('?')[0].split('/').pop() || '');
    const tag = m.type === 'page' ? (m.quality === 'audio' ? 'MP3' : tiT('siteTag')) : m.type === 'hls' ? m.quality || 'HLS' : m.type === 'audio' ? tiT('audioTag') : (name.split('.').pop() || 'VIDEO').toUpperCase().slice(0, 5);
    const title = m.type === 'page' ? (m.quality === 'audio' ? tiT('mp3Title') : tiT('pageVideo')) : m.type === 'hls' ? (m.variants?.length ? tiT('hlsTitleQ', { n: m.variants.length }) : tiT('hlsTitle')) : name;
    el.innerHTML = '<span class="tag"></span><div class="info"><b></b><small></small></div><button class="dl"></button>';
    el.querySelector('button').textContent = tiT('download');
    el.querySelector('.tag').textContent = tag;
    el.querySelector('b').textContent = title;
    el.querySelector('b').title = m.url;
    el.querySelector('small').textContent = [fmtSize(m.size), host].filter(Boolean).join(' · ');
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
