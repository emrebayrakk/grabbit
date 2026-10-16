'use strict';

/* global I18N, t, applyI18n, errorText, qualityLabel, icon, hydrateIcons, fmtBytes, fmtSpeed, fmtKbLimit, fmtEta, fmtPercent, fmtDate, hostOf, extLabel, statusLabel, escapeHtml */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  downloads: [],
  byId: new Map(),
  stats: { speed: 0, active: 0 },
  settings: {},
  categories: {},
  bridge: {},
  filter: 'all',
  search: '',
  sort: { key: 'createdAt', dir: -1 },
  selected: new Set(),
  focusId: null,
  anchorId: null,
  visible: []
};

const LIMIT_PRESETS = [0, 128, 256, 512, 1024, 2048, 5120, 10240, 20480];
const CAT_ICON = { video: 'video', music: 'music', document: 'document', archive: 'archive', program: 'program', image: 'image', other: 'other' };

// ---------------------------------------------------------------- başlangıç

async function init() {
  hydrateIcons();
  const s = await api.getState();
  I18N.setLanguage(s.language);
  applyI18n();
  document.documentElement.classList.toggle('mica', !!s.mica);
  state.settings = s.settings;
  state.languages = s.languages || {};
  state.categories = s.categories;
  state.bridge = s.bridge;
  state.tools = s.tools;
  state.mediaHosts = s.mediaHosts || [];
  buildCategoryNav();
  bindUi();
  applyDownloads(s);
  renderSettingsControls();
  renderBridge();

  api.on('downloads', applyDownloads);
  api.on('settings', (st) => {
    state.settings = st;
    renderSettingsControls();
  });
  api.on('tools', (t) => {
    state.tools = t;
    renderEngineRow();
  });
  api.on('bridge', (b) => {
    state.bridge = b;
    renderBridge();
  });
  api.on('open-add', (payload) => openAdd(payload || {}));
  api.on('focus-item', (id) => focusItem(id));
  api.on('clipboard-urls', (urls) => {
    toast(t('clip.found', { n: urls.length }), {
      sub: urls[0],
      timeout: 9000,
      actions: [{ label: t('common.download'), primary: true, onClick: () => openAdd({ urls }) }]
    });
  });
  window.addEventListener('resize', () => renderDetails(true));
}

function applyDownloads({ downloads, stats }) {
  state.downloads = downloads;
  state.byId = new Map(downloads.map((d) => [d.id, d]));
  state.stats = stats || state.stats;
  for (const id of [...state.selected]) if (!state.byId.has(id)) state.selected.delete(id);
  if (state.focusId && !state.byId.has(state.focusId)) state.focusId = null;
  render();
}

// ---------------------------------------------------------------- filtre & sıralama

function matchesFilter(d, f) {
  switch (f) {
    case 'all': return true;
    case 'active': return ['downloading', 'queued', 'verifying'].includes(d.status);
    case 'completed': return d.status === 'completed';
    case 'paused': return d.status === 'paused';
    case 'error': return d.status === 'error';
    default: return f.startsWith('cat:') && d.category === f.slice(4);
  }
}

function progressOf(d) {
  if (d.status === 'completed') return 1;
  return d.progress ?? (d.size > 0 ? d.downloaded / d.size : 0);
}

function computeVisible() {
  const loc = I18N.locale();
  const q = state.search.trim().toLocaleLowerCase(loc);
  const { key, dir } = state.sort;
  const list = state.downloads.filter(
    (d) => matchesFilter(d, state.filter) && (!q || d.filename.toLocaleLowerCase(loc).includes(q) || d.url.toLowerCase().includes(q))
  );
  const val = (d) => {
    switch (key) {
      case 'filename': return d.filename.toLocaleLowerCase(loc);
      case 'progress': return progressOf(d);
      case 'eta': return d.eta ?? Infinity;
      default: return d[key] ?? 0;
    }
  };
  list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y, loc) : x - y;
    return c * dir || b.createdAt - a.createdAt;
  });
  return list;
}

// ---------------------------------------------------------------- çizim

function render() {
  state.visible = computeVisible();
  renderList();
  const counts = computeCounts();
  renderNavCounts(counts);
  renderStatusbar(counts);
  renderToolbar();
  renderDetails();
}

const rowCache = new Map(); // id → { el, key }

function renderList() {
  const list = $('#list');
  const visibleIds = new Set(state.visible.map((d) => d.id));
  for (const [id, entry] of rowCache) {
    if (!visibleIds.has(id)) {
      entry.el.remove();
      rowCache.delete(id);
    }
  }
  let prev = null;
  for (const d of state.visible) {
    let entry = rowCache.get(d.id);
    if (!entry) {
      entry = { el: createRow(d), key: '' };
      rowCache.set(d.id, entry);
    }
    updateRow(entry, d);
    const expected = prev ? prev.nextSibling : list.firstChild;
    if (expected !== entry.el) list.insertBefore(entry.el, expected);
    prev = entry.el;
  }

  const empty = $('#empty');
  empty.hidden = state.visible.length > 0;
  if (!state.visible.length) {
    const none = state.downloads.length === 0;
    $('#emptyTitle').textContent = none ? t('empty.none') : state.search ? t('empty.noMatch') : t('empty.noView');
    $('#emptyText').innerHTML = none ? t('empty.hintNone') : t('empty.hintView');
  }
}

function createRow(d) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = d.id;
  el.innerHTML = `
    <div class="name">
      <span class="file-badge"></span>
      <div class="name-text"><div class="fn"></div><div class="sub"></div></div>
    </div>
    <div class="num c-size"></div>
    <div class="progress"><div class="bar"></div><div class="pline"><span class="st"></span><span class="pct"></span></div></div>
    <div class="num c-speed"></div>
    <div class="num c-eta"></div>
    <div class="num c-date"></div>
    <div class="hover-actions"></div>`;
  return el;
}

function updateRow(entry, d) {
  const el = entry.el;
  el.classList.toggle('sel', state.selected.has(d.id));
  const key = [d.status, d.downloaded, d.size, d.filename, d.speed, d.eta, d.error, d.activeConnections, d.hashProgress, d.checksum?.ok, d.category, d.phase].join('|');
  if (key === entry.key) return;
  entry.key = key;

  el.className = `row status-${d.status}${state.selected.has(d.id) ? ' sel' : ''}`;
  const badge = $('.file-badge', el);
  badge.className = `file-badge cat-${d.category}`;
  const ext = extLabel(d.filename);
  badge.innerHTML = icon(CAT_ICON[d.category] || 'file') + (ext ? `<span class="ext">${escapeHtml(ext)}</span>` : '');
  $('.fn', el).textContent = d.filename;
  $('.fn', el).title = d.filename;

  let sub = escapeHtml(hostOf(d.url));
  if (d.kind === 'hls') sub += ` · <span class="pill info">${t('pill.hls')}</span>`;
  if (d.kind === 'media') sub += ` · <span class="pill info">${t('pill.media')}</span>`;
  if (d.status === 'error') sub = `<span style="color:var(--err)">${escapeHtml(errorText(d))}</span>`;
  else if (d.status === 'downloading' && d.kind === 'media' && d.phase) sub += ` · ${escapeHtml(t(d.phase))}`;
  else if (d.status === 'downloading' && d.kind === 'hls' && d.segmentsTotal) sub += ` · ${t('row.segments', { done: d.segmentsDone, total: d.segmentsTotal })}`;
  else if (d.status === 'downloading' && d.activeConnections) sub += ` · ${t('row.connections', { n: d.activeConnections })}`;
  if (d.checksum?.ok === true) sub += ` <span class="pill ok">${t('pill.verified')}</span>`;
  if (d.checksum?.ok === false) sub += ` <span class="pill bad">${t('pill.hashBad')}</span>`;
  if (d.speedLimit) sub += ` <span class="pill warn">${fmtKbLimit(d.speedLimit)}</span>`;
  $('.sub', el).innerHTML = sub;

  $('.c-size', el).textContent =
    d.size > 0 ? (d.estimated ? '≈ ' : '') + fmtBytes(d.size) : d.status === 'completed' ? fmtBytes(d.downloaded) : '—';
  drawBar($('.bar', el), d);
  const st = d.status === 'verifying' && d.hashProgress != null ? t('row.verifying', { p: Math.round(d.hashProgress * 100) }) : statusLabel(d.status);
  $('.st', el).textContent = st;
  $('.pct', el).textContent =
    d.status === 'completed' ? '' : fmtPercent(d) ? `${fmtBytes(d.downloaded)} · ${fmtPercent(d)}` : d.downloaded ? fmtBytes(d.downloaded) : '';
  $('.c-speed', el).textContent = d.status === 'downloading' ? fmtSpeed(d.speed) : '';
  $('.c-eta', el).textContent = d.status === 'downloading' ? fmtEta(d.eta) : '';
  $('.c-date', el).textContent = fmtDate(d.completedAt || d.createdAt);
  $('.c-date', el).title = new Date(d.createdAt).toLocaleString(I18N.locale());

  const acts = [];
  if (d.status === 'completed') {
    acts.push(['open', 'open', t('act.open')]);
  } else if (['downloading', 'queued'].includes(d.status)) {
    acts.push(['pause', 'pause', t('act.pause')]);
  } else if (d.status !== 'verifying') {
    acts.push(['start', 'play', d.status === 'error' ? t('act.retry') : t('act.resume')]);
  }
  acts.push(['folder', 'folder', t('act.showInFolder')]);
  $('.hover-actions', el).innerHTML = acts
    .map(([a, ic, t]) => `<button class="icon-btn" data-act="${a}" title="${t}">${icon(ic)}</button>`)
    .join('');
}

function drawBar(bar, d) {
  if (d.kind === 'hls') {
    bar.classList.remove('indeterminate');
    bar.innerHTML = `<i style="left:0;width:${progressOf(d) * 100}%"></i>`;
    return;
  }
  const indeterminate = d.status === 'downloading' && !(d.size > 0);
  bar.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    bar.innerHTML = '<i></i>';
    return;
  }
  if (d.status === 'completed') {
    bar.innerHTML = '<i style="left:0;width:100%"></i>';
    return;
  }
  if (!(d.size > 0)) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML = d.segments
    .filter((s) => s[2] > 0)
    .map((s) => `<i style="left:${(s[0] / d.size) * 100}%;width:${Math.max(0.3, (s[2] / d.size) * 100)}%"></i>`)
    .join('');
}

function buildCategoryNav() {
  $('#catNav').innerHTML = Object.entries(state.categories)
    .map(
      ([k, label]) =>
        `<button class="nav-item cat-${k}" data-filter="cat:${k}"><span class="cat-dot" style="background:var(--cat)"></span>${escapeHtml(t('cat.' + k))}<span class="count"></span></button>`
    )
    .join('');
}

/** Tüm görünümlerin ve durumların sayısı tek geçişte. */
function computeCounts() {
  const c = { all: 0, active: 0, completed: 0, paused: 0, error: 0, downloading: 0, queued: 0 };
  for (const d of state.downloads) {
    c.all++;
    if (['downloading', 'queued', 'verifying'].includes(d.status)) c.active++;
    if (d.status in c) c[d.status]++;
    const k = 'cat:' + d.category;
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function renderNavCounts(counts) {
  $$('.nav-item[data-filter]').forEach((b) => {
    const f = b.dataset.filter;
    b.classList.toggle('active', f === state.filter);
    const text = String(counts[f] || '');
    const el = $('.count', b);
    if (el.textContent !== text) el.textContent = text;
  });
}

function renderStatusbar(counts) {
  const { speed } = state.stats;
  const { downloading, queued } = counts;
  $('#sbSpeed b').textContent = speed ? fmtSpeed(speed) : '0 KB/s';
  $('#sbActive').textContent =
    downloading || queued ? t('sb.active', { n: downloading }) + (queued ? ` · ${t('sb.queued', { n: queued })}` : '') : t('sb.idle');
}

function renderToolbar() {
  const sel = selectedItems();
  $('#startBtn').disabled = !sel.some((d) => ['paused', 'error', 'queued'].includes(d.status));
  $('#pauseBtn').disabled = !sel.some((d) => ['downloading', 'queued'].includes(d.status));
  $('#removeBtn').disabled = !sel.length;
}

function renderBridge() {
  const b = state.bridge || {};
  const names = Object.keys(b.paired || {});
  const el = $('#bridgeState');
  el.classList.toggle('on', !!b.running && names.length > 0);
  el.classList.toggle('err', !!b.error);
  $('.label', el).textContent = b.error
    ? t('bridge.error', { error: b.errorKey ? t(b.errorKey, { port: b.port }) : b.error })
    : !b.running
      ? t('bridge.off')
      : names.length
        ? t('bridge.paired', { names: names.map((n) => n.replace(/^(Google|Microsoft) /, '')).join(', ') })
        : t('bridge.unpaired');
  el.title = t('bridge.clickTitle');
  let hidden = false;
  try {
    hidden = localStorage.getItem('pairBannerHidden') === '1';
  } catch { /* yoksay */ }
  $('#pairBanner').hidden = hidden || names.length > 0 || !b.running;
  if (!$('#settingsModal').hidden) renderBrowsers();
}

const BROWSER_STYLE = {
  chrome: ['#1a73e8', 'C'],
  edge: ['#0c7cd5', 'E'],
  brave: ['#fb542b', 'B'],
  opera: ['#ff1b2d', 'O'],
  vivaldi: ['#ef3939', 'V']
};

async function renderBrowsers() {
  const box = $('#browserList');
  let list;
  try {
    list = await api.listBrowsers();
  } catch (err) {
    box.innerHTML = `<div class="note">${escapeHtml(err.message)}</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="note">${t('browsers.none')}</div>`;
    return;
  }
  box.innerHTML = list
    .map((b) => {
      const [color, letter] = BROWSER_STYLE[b.id] || ['#64748b', b.name[0]];
      const status = b.paired
        ? t('browsers.paired', { when: fmtDate(b.paired.lastSeen).toLocaleLowerCase(I18N.locale()) })
        : t('browsers.notInstalled');
      return `<div class="browser ${b.paired ? 'paired' : ''}">
        <span class="b-logo" style="background:${color}">${letter}</span>
        <div class="b-info"><b>${escapeHtml(b.name)}</b><small>${escapeHtml(status)}</small></div>
        <button class="btn small ${b.paired ? '' : 'primary'}" data-setup="${b.id}">${b.paired ? t('browsers.reinstall') : b.oneClick ? t('browsers.oneClick') : t('browsers.install')}</button>
      </div>`;
    })
    .join('');
}

function fillSelect(sel, values, current, label) {
  const vals = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  sel.innerHTML = vals.map((v) => `<option value="${v}">${escapeHtml(label(v))}</option>`).join('');
  sel.value = String(current);
}

function renderSettingsControls() {
  const s = state.settings;
  fillSelect($('#sbLimit'), LIMIT_PRESETS, s.speedLimit, (v) => (v ? t('limit.label', { v: fmtKbLimit(v) }) : t('limit.none')));
  fillSelect($('#sbConcurrent'), [1, 2, 3, 4, 5, 6, 8, 10], s.maxConcurrent, (v) => t('conc.label', { n: v }));
  const langSel = $('#languageSelect');
  if (!langSel.options.length) {
    langSel.innerHTML =
      `<option value="system">${escapeHtml(t('settings.langSystem'))}</option>` +
      Object.entries(state.languages).map(([code, name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join('');
  }
  $$('[data-setting]').forEach((input) => {
    const v = input.dataset.setting.split('.').reduce((o, k) => o?.[k], s);
    if (input.type === 'checkbox') input.checked = !!v;
    else if (document.activeElement !== input) input.value = v ?? '';
  });
}

// ---------------------------------------------------------------- ayrıntı paneli

function renderDetails(force) {
  const panel = $('#details');
  const d = state.focusId && state.selected.size === 1 ? state.byId.get(state.focusId) : null;
  if (!d) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const badge = $('#dIcon');
  if (badge.dataset.cat !== d.category) {
    badge.dataset.cat = d.category;
    badge.className = `file-badge cat-${d.category}`;
    badge.innerHTML = icon(CAT_ICON[d.category] || 'file');
  }
  $('#dName').textContent = d.filename;
  $('#dSub').textContent = d.savePath;

  const actKey = d.id + d.status;
  if (force || panel.dataset.actKey !== actKey) {
    panel.dataset.actKey = actKey;
    const btn = (act, ic, label, cls = '') => `<button class="btn small ${cls}" data-dact="${act}">${icon(ic)}${label}</button>`;
    const parts = [];
    if (d.status === 'completed') parts.push(btn('open', 'open', t('act.open'), 'primary'));
    if (['downloading', 'queued'].includes(d.status)) parts.push(btn('pause', 'pause', t('act.pause')));
    if (['paused', 'error'].includes(d.status)) parts.push(btn('start', 'play', d.status === 'error' ? t('act.retry') : t('act.resume'), 'primary'));
    if (d.status !== 'completed') parts.push(btn('window', 'open', t('act.window')));
    parts.push(btn('folder', 'folder', t('act.folder')));
    parts.push(btn('copy', 'copy', t('act.copyUrl')));
    if (d.status !== 'completed') parts.push(btn('url', 'edit', t('act.updateUrl')));
    parts.push(btn('redownload', 'refresh', t('act.redownload')));
    $('#dActions').innerHTML = parts.join('');
  }

  $('#dConn').textContent =
    d.status === 'downloading'
      ? t('conn.active', { a: d.activeConnections, n: d.connections })
      : !d.probed || d.resumable
        ? t('conn.upTo', { n: d.connections })
        : t('conn.single');

  const rows = [
    ['info.url', `<a data-dact="copy" title="${escapeHtml(t('info.copyTitle', { url: d.url }))}">${escapeHtml(d.url)}</a>`],
    ['info.size', d.size > 0 ? `${fmtBytes(d.size)} <span style="color:var(--text-3)">(${escapeHtml(t('info.bytes', { n: d.size.toLocaleString(I18N.locale()) }))})</span>` : t('common.unknown')],
    ['info.downloaded', `${fmtBytes(d.status === 'completed' ? d.size : d.downloaded)} ${fmtPercent(d) ? '· ' + fmtPercent(d) : ''}`],
    ['info.speed', d.status === 'downloading' ? fmtSpeed(d.speed) : '—'],
    ['info.eta', d.status === 'downloading' ? fmtEta(d.eta) : '—'],
    [
      'info.resume',
      !d.probed
        ? escapeHtml(t('info.resumeUnknown'))
        : d.resumable
          ? `<span class="pill ok">${t('info.resumeYes')}</span>`
          : `<span class="pill warn">${t('info.resumeNo')}</span>`
    ],
    ['info.added', new Date(d.createdAt).toLocaleString(I18N.locale())]
  ];
  if (d.completedAt) rows.push(['info.completed', new Date(d.completedAt).toLocaleString(I18N.locale())]);
  if (d.hasCookies) rows.push(['info.session', escapeHtml(t('info.cookies'))]);
  if (d.error) rows.push(['info.error', `<span>${escapeHtml(errorText(d))}</span>`, 'error']);
  patchInfo(rows);

  const limitSel = $('#dLimit');
  if (document.activeElement !== limitSel) fillSelect(limitSel, LIMIT_PRESETS, d.speedLimit || 0, (v) => fmtKbLimit(v));

  const hashBtn = $('#hashBtn');
  hashBtn.disabled = d.status !== 'completed';
  const algoSel = $('#hashAlgo');
  const exp = $('#hashExpected');
  if (panel.dataset.hashFor !== d.id) {
    panel.dataset.hashFor = d.id;
    algoSel.value = d.checksum?.algo || 'sha256';
    exp.value = d.checksum?.expected || '';
  }
  const res = $('#hashResult');
  res.className = 'hash-result';
  if (d.status === 'verifying') {
    res.textContent = t('hash.computing', { p: Math.round((d.hashProgress || 0) * 100) });
  } else if (d.checksum?.actual) {
    res.classList.add('mono');
    res.textContent = `${d.checksum.algo.toUpperCase()}: ${d.checksum.actual}`;
    if (d.checksum.ok === true) {
      res.classList.add('ok');
      res.textContent += '  ' + t('hash.match');
    } else if (d.checksum.ok === false) {
      res.classList.add('bad');
      res.textContent += '  ' + t('hash.mismatch');
    }
  } else {
    res.textContent = d.status === 'completed' ? t('hash.hintDone') : t('hash.hintPending');
  }

  drawSegments(d);
  drawSpark(d);
}

/**
 * Ayrıntı satırlarını yerinde günceller: yalnızca değişen hücreye dokunur, böylece
 * kullanıcının seçtiği metin (adres, yol) saniyede 4 kez silinmez.
 */
const cellHtml = new WeakMap();

function patchInfo(rows) {
  const dl = $('#dInfo');
  const key = rows.map((r) => r[0]).join('|');
  if (dl.dataset.key !== key) {
    dl.dataset.key = key;
    dl.innerHTML = rows.map(([k]) => `<dt>${escapeHtml(t(k))}</dt><dd></dd>`).join('');
  }
  const cells = dl.querySelectorAll('dd');
  rows.forEach(([, html, cls], i) => {
    const dd = cells[i];
    if (cellHtml.get(dd) !== html) {
      cellHtml.set(dd, html);
      dd.innerHTML = html;
    }
    if (dd.className !== (cls || '')) dd.className = cls || '';
  });
}

// getComputedStyle her çağrıda stil hesaplatır: renk belirteçlerini önbellekle, tema değişince yenile
const tokenCache = new Map();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => tokenCache.clear());

function cssVar(name) {
  let v = tokenCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    tokenCache.set(name, v);
  }
  return v;
}

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = Number(canvas.getAttribute('height'));
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  canvas.style.height = h + 'px';
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawSegments(d) {
  const { ctx, w, h } = prepCanvas($('#segCanvas'));
  ctx.fillStyle = cssVar('--bar-bg');
  ctx.fillRect(0, 0, w, h);
  const total = d.size > 0 ? d.size : 0;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, cssVar('--accent'));
  grad.addColorStop(1, cssVar('--accent-2'));
  if (d.status === 'completed') {
    ctx.fillStyle = cssVar('--ok');
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (!total) {
    ctx.fillStyle = cssVar('--text-3');
    ctx.font = '11px Segoe UI';
    ctx.fillText(d.status === 'downloading' ? t('seg.unknownSize', { size: fmtBytes(d.downloaded) }) : t('seg.noData'), 8, h / 2 + 4);
    return;
  }
  ctx.fillStyle = grad;
  for (const [start, , done] of d.segments) {
    if (done > 0) ctx.fillRect((start / total) * w, 0, Math.max(1, (done / total) * w), h);
  }
  // Aktif bağlantıların "kafası" ve parça sınırları
  const sep = cssVar('--surface');
  for (const [start, , done, active] of d.segments) {
    ctx.fillStyle = sep;
    ctx.fillRect((start / total) * w, 0, 1, h);
    if (active) {
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.9;
      ctx.fillRect(((start + done) / total) * w - 1, 3, 2, h - 6);
      ctx.globalAlpha = 1;
    }
  }
}

function drawSpark(d) {
  const { ctx, w, h } = prepCanvas($('#sparkCanvas'));
  ctx.fillStyle = cssVar('--surface-2');
  ctx.fillRect(0, 0, w, h);
  const hist = d.history || [];
  const label = $('#sparkLabel');
  if (hist.length < 2) {
    label.textContent = d.status === 'downloading' ? t('spark.preparing') : t('spark.idle');
    return;
  }
  const max = Math.max(...hist, 1);
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  label.textContent = t('spark.stats', { cur: fmtSpeed(hist[hist.length - 1]), avg: fmtSpeed(avg), max: fmtSpeed(max) });
  const step = w / 59;
  const x = (i) => w - (hist.length - 1 - i) * step;
  const y = (v) => h - 4 - (v / max) * (h - 22);
  ctx.beginPath();
  ctx.moveTo(x(0), h);
  hist.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(hist.length - 1), h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, cssVar('--accent') + '55');
  g.addColorStop(1, cssVar('--accent') + '05');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  hist.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

// ---------------------------------------------------------------- seçim

function selectedItems() {
  return [...state.selected].map((id) => state.byId.get(id)).filter(Boolean);
}

function selectOnly(id) {
  state.selected = new Set(id ? [id] : []);
  state.focusId = id;
  state.anchorId = id;
  render();
}

function onRowClick(e, id) {
  if (e.shiftKey && state.anchorId) {
    const ids = state.visible.map((d) => d.id);
    const a = ids.indexOf(state.anchorId);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!e.ctrlKey) state.selected.clear();
      ids.slice(lo, hi + 1).forEach((x) => state.selected.add(x));
    }
    state.focusId = id;
  } else if (e.ctrlKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.focusId = id;
    state.anchorId = id;
  } else {
    state.selected = new Set([id]);
    state.focusId = id;
    state.anchorId = id;
  }
  render();
}

function moveSelection(delta) {
  const ids = state.visible.map((d) => d.id);
  if (!ids.length) return;
  let i = ids.indexOf(state.focusId);
  i = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + delta));
  selectOnly(ids[i]);
  rowCache.get(ids[i])?.el.scrollIntoView({ block: 'nearest' });
}

function focusItem(id) {
  if (!state.byId.has(id)) return;
  if (!matchesFilter(state.byId.get(id), state.filter)) state.filter = 'all';
  state.search = '';
  $('#search').value = '';
  selectOnly(id);
  rowCache.get(id)?.el.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------- eylemler

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, { type: 'success' });
    return r;
  } catch (err) {
    toast(err.message, { type: 'error' });
    return undefined;
  }
}

function ids(items) {
  return items.map((d) => d.id);
}

function doStart(items) {
  const list = items.filter((d) => ['paused', 'error', 'queued'].includes(d.status));
  if (list.length) run(() => api.start(ids(list)));
}

function doPause(items) {
  const list = items.filter((d) => ['downloading', 'queued'].includes(d.status));
  if (list.length) run(() => api.pause(ids(list)));
}

function doToggle(items) {
  if (items.some((d) => ['downloading', 'queued'].includes(d.status))) doPause(items);
  else doStart(items);
}

async function doRemove(items) {
  if (!items.length) return;
  const completed = items.filter((d) => d.status === 'completed').length;
  const partial = items.length - completed;
  const r = await confirmDialog({
    title: t('remove.title', { n: items.length }),
    text:
      (items.length === 1 ? t('remove.textOne', { name: items[0].filename }) : t('remove.textMany')) +
      (partial ? ' ' + t('remove.partial') : ''),
    checkbox: completed ? t('remove.deleteFiles') : null,
    okLabel: t('act.remove')
  });
  if (!r.ok) return;
  await run(() => api.remove(ids(items), r.checked));
}

async function doUpdateUrl(d) {
  const r = await confirmDialog({
    title: t('url.title'),
    text: t('url.text'),
    input: d.url,
    okLabel: t('url.ok'),
    danger: false
  });
  if (!r.ok || !r.value.trim() || r.value.trim() === d.url) return;
  await run(() => api.updateUrl(d.id, r.value.trim()), t('url.done'));
}

async function doRedownload(d) {
  const r = await confirmDialog({
    title: t('redl.title'),
    text: d.status === 'completed' ? t('redl.textDone') : t('redl.textPartial'),
    okLabel: t('act.redownload'),
    danger: false
  });
  if (r.ok) run(() => api.redownload(d.id));
}

function itemAction(act, d) {
  switch (act) {
    case 'open': return run(() => api.open(d.id));
    case 'window': return run(() => api.openSingle(d.id));
    case 'folder': return run(() => api.showInFolder(d.id));
    case 'start': return doStart([d]);
    case 'pause': return doPause([d]);
    case 'copy': return run(() => api.writeClipboard(d.url), t('copy.urlDone'));
    case 'url': return doUpdateUrl(d);
    case 'redownload': return doRedownload(d);
    case 'remove': return doRemove([d]);
  }
}

// ---------------------------------------------------------------- bağlam menüsü

function showContextMenu(x, y) {
  const items = selectedItems();
  if (!items.length) return;
  const one = items.length === 1 ? items[0] : null;
  const canStart = items.some((d) => ['paused', 'error', 'queued'].includes(d.status));
  const canPause = items.some((d) => ['downloading', 'queued'].includes(d.status));
  const entries = [
    one && one.status === 'completed' && ['open', 'open', t('act.open'), 'Enter'],
    one && one.status !== 'completed' && ['window', 'download', t('ctx.progressWindow'), t('kbd.dbl')],
    one && ['folder', 'folder', t('act.showInFolder')],
    '-',
    canStart && ['start', 'play', t('act.start'), t('kbd.space')],
    canPause && ['pause', 'pause', t('act.pause'), t('kbd.space')],
    one && ['redownload', 'refresh', t('act.redownload')],
    one && one.status !== 'completed' && ['url', 'edit', t('act.updateUrl') + '…'],
    '-',
    ['copy', 'copy', items.length > 1 ? t('act.copyUrls') : t('act.copyUrl')],
    '-',
    ['remove', 'trash', t('act.remove') + '…', 'Del', 'danger']
  ].filter(Boolean);
  const menu = $('#ctxmenu');
  menu.innerHTML = entries
    .filter((e, i, arr) => e !== '-' || (i > 0 && arr[i - 1] !== '-' && i < arr.length - 1))
    .map((e) =>
      e === '-' ? '<hr>' : `<button data-cact="${e[0]}" class="${e[4] || ''}">${icon(e[1])}${e[2]}${e[3] ? `<span class="kbd">${e[3]}</span>` : ''}</button>`
    )
    .join('');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-cact]');
    if (!b) return;
    hideContextMenu();
    const act = b.dataset.cact;
    if (act === 'start') doStart(items);
    else if (act === 'pause') doPause(items);
    else if (act === 'remove') doRemove(items);
    else if (act === 'copy') run(() => api.writeClipboard(items.map((d) => d.url).join('\n')), t('copy.done'));
    else itemAction(act, one);
  };
}

function hideContextMenu() {
  $('#ctxmenu').hidden = true;
}

// ---------------------------------------------------------------- yeni indirme penceresi

const addState = { cookie: null, headers: {}, filename: null, dir: '', probe: null, probeUrl: null, seq: 0, timer: null };

function parseUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return [...new Set(found)];
}

async function openAdd({ urls, filename, cookie, headers } = {}) {
  hideContextMenu();
  let list = urls || [];
  if (!list.length) {
    try {
      list = parseUrls(await api.readClipboard());
    } catch { /* yoksay */ }
  }
  Object.assign(addState, {
    cookie: cookie || null,
    headers: headers || {},
    filename: filename || null,
    dir: '',
    probe: null,
    probeUrl: null
  });
  $('#addUrls').value = list.join('\n');
  $('#addConn').value = state.settings.connections;
  $('#addConnVal').textContent = state.settings.connections;
  $('#addLimit').value = 0;
  $('#addReferer').value = addState.headers.referer || '';
  $('#addHash').value = '';
  $('#addHashAlgo').value = 'sha256';
  $('#addCookieNote').hidden = !addState.cookie;
  $('.advanced').open = false;
  renderAddDir();
  openModal('addModal');
  const ta = $('#addUrls');
  ta.focus();
  ta.select();
  onAddUrlsChanged(true);
}

function renderAddDir() {
  const s = state.settings;
  $('#addDir').value = addState.dir || '';
  $('#addDir').placeholder = s.categorize ? t('add.autoDirCat', { dir: s.downloadDir }) : t('add.autoDir', { dir: s.downloadDir });
  $('#addDirReset').hidden = !addState.dir;
}

function onAddUrlsChanged(immediate) {
  clearTimeout(addState.timer);
  const urls = parseUrls($('#addUrls').value);
  $('#addNowBtn').disabled = $('#addLaterBtn').disabled = !urls.length;
  const known = new Set(state.downloads.map((d) => d.url));
  const dup = urls.filter((u) => known.has(u)).length;
  $('#addHint').textContent = dup ? (urls.length === 1 ? t('add.dupOne') : t('add.dupMany', { n: dup })) : '';
  const card = $('#probeCard');
  if (!urls.length) {
    card.hidden = true;
    return;
  }
  if (urls.length > 1) {
    addState.seq++;
    card.hidden = false;
    card.className = 'probe';
    card.innerHTML = `<span class="file-badge cat-other">${icon('layers')}</span>
      <div class="p-main"><b>${escapeHtml(t('add.multi', { n: urls.length }))}</b>
      <div class="multi">${urls.slice(0, 50).map((u) => `<div>${escapeHtml(u)}</div>`).join('')}${urls.length > 50 ? `<div>${escapeHtml(t('add.more', { n: urls.length - 50 }))}</div>` : ''}</div></div>`;
    return;
  }
  const url = urls[0];
  if (isMediaSite(url)) {
    // Video siteleri: kalite seçimi ve (gerekirse) motor kurulumu Dosya bilgisi penceresinde
    addState.seq++;
    addState.probe = null;
    card.hidden = false;
    card.className = 'probe';
    card.innerHTML = `<span class="file-badge cat-video">${icon('video')}</span>
      <div class="p-main"><b>${escapeHtml(t('add.mediaTitle', { host: hostOf(url) }))}</b>
      <div class="p-meta">${escapeHtml(state.tools?.ready ? t('add.mediaHint') : t('add.mediaHintEngine'))}</div></div>`;
    return;
  }
  if (addState.probeUrl === url && addState.probe) return;
  addState.timer = setTimeout(() => probeUrl(url), immediate ? 0 : 450);
}

async function probeUrl(url) {
  const seq = ++addState.seq;
  const card = $('#probeCard');
  card.hidden = false;
  card.className = 'probe loading';
  card.innerHTML = `<span class="file-badge cat-other">${icon('file')}</span><div class="p-main"><b>${escapeHtml(addState.filename || hostOf(url))}</b><div class="p-meta">${escapeHtml(t('add.probing'))}</div></div>`;
  try {
    const info = await api.probe(url, addState.headers, addState.cookie);
    if (seq !== addState.seq) return;
    addState.probe = info;
    addState.probeUrl = url;
    const name = addState.filename || info.filename;
    card.className = 'probe';
    card.innerHTML = `<span class="file-badge cat-${info.category}">${icon(CAT_ICON[info.category])}</span>
      <div class="p-main">
        <input id="addName" value="${escapeHtml(name)}" spellcheck="false" title="${escapeHtml(t('add.nameTitle'))}" />
        <div class="p-meta">
          <span><b>${info.size >= 0 ? fmtBytes(info.size) : escapeHtml(t('add.sizeUnknown'))}</b></span>·
          <span>${escapeHtml(t('cat.' + info.category))}</span>·
          <span>${escapeHtml(hostOf(info.finalUrl))}</span>
          ${info.upgradedFrom ? `<span class="pill ok">${t('pill.fullSize')}</span>` : ''}
          ${info.resumable ? `<span class="pill ok">${t('pill.resumable')}</span>` : `<span class="pill warn">${t('pill.notResumable')}</span>`}
        </div>
      </div>`;
  } catch (err) {
    if (seq !== addState.seq) return;
    addState.probe = null;
    addState.probeUrl = null;
    card.className = 'probe error';
    card.innerHTML = `<span class="file-badge cat-video">${icon('alert')}</span><div class="p-main"><b>${escapeHtml(t('add.probeFail'))}</b><div>${escapeHtml(t('add.probeFailHint', { error: err.message }))}</div></div>`;
  }
}

async function submitAdd(startNow) {
  const urls = parseUrls($('#addUrls').value);
  if (!urls.length) return;
  const single = urls.length === 1;
  if (single && isMediaSite(urls[0])) {
    closeModal('addModal');
    await run(() => api.openInfo({ url: urls[0], cookie: addState.cookie || undefined, headers: addState.headers }));
    return;
  }
  const nameInput = $('#addName');
  const name = single && nameInput ? nameInput.value.trim() : '';
  const hash = $('#addHash').value.trim();
  const headers = { ...addState.headers, referer: $('#addReferer').value.trim() || undefined };
  const entries = urls.map((url) => ({
    url,
    filename: single && name && (name !== addState.probe?.filename || addState.filename) ? name : undefined,
    dir: addState.dir || undefined,
    connections: Number($('#addConn').value),
    speedLimit: Number($('#addLimit').value) || 0,
    startNow,
    headers,
    cookie: single ? addState.cookie || undefined : undefined,
    checksum: single && hash ? { algo: $('#addHashAlgo').value, expected: hash } : undefined,
    probeInfo: single && addState.probeUrl === url ? addState.probe : undefined
  }));
  const btns = [$('#addNowBtn'), $('#addLaterBtn')];
  btns.forEach((b) => (b.disabled = true));
  const res = await run(() => api.add(entries));
  btns.forEach((b) => (b.disabled = false));
  if (!res) return;
  closeModal('addModal');
  const ok = res.filter((r) => !r.error);
  const bad = res.filter((r) => r.error);
  if (ok.length) {
    toast(
      ok.length === 1
        ? t(startNow ? 'toast.oneStarted' : 'toast.oneAdded', { name: ok[0].filename })
        : t(startNow ? 'toast.manyQueued' : 'toast.manyAdded', { n: ok.length }),
      { type: 'success' }
    );
    setTimeout(() => focusItem(ok[0].id), 300);
  }
  if (bad.length) toast(t('toast.failed', { n: bad.length, error: bad[0].error }), { type: 'error', timeout: 8000 });
}

// ---------------------------------------------------------------- pencereler

function openModal(id) {
  $$('.modal').forEach((m) => {
    if (m.id !== id && m.id !== 'confirmModal') m.hidden = true;
  });
  $('#' + id).hidden = false;
}

function closeModal(id) {
  $('#' + id).hidden = true;
  $('#list').focus();
}

function topModal() {
  return $$('.modal').filter((m) => !m.hidden).pop();
}

let confirmResolve = null;

function confirmDialog({ title, text, checkbox, input, okLabel = t('common.ok'), danger = true }) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmCheckWrap').hidden = !checkbox;
  $('#confirmCheck').checked = false;
  $('#confirmCheckLabel').textContent = checkbox || '';
  let inp = $('#confirmInput');
  if (input != null) {
    if (!inp) {
      inp = document.createElement('input');
      inp.id = 'confirmInput';
      inp.className = 'mono';
      inp.style.width = '100%';
      inp.spellcheck = false;
      $('#confirmText').after(inp);
    }
    inp.hidden = false;
    inp.value = input;
  } else if (inp) {
    inp.hidden = true;
  }
  const ok = $('#confirmOk');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  $('#confirmModal').hidden = false;
  setTimeout(() => (input != null ? inp.select() : ok.focus()), 0);
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function finishConfirm(okd) {
  if (!confirmResolve) return;
  const inp = $('#confirmInput');
  confirmResolve({ ok: okd, checked: $('#confirmCheck').checked, value: inp && !inp.hidden ? inp.value : '' });
  confirmResolve = null;
  $('#confirmModal').hidden = true;
}

function isMediaSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return state.mediaHosts.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function renderEngineRow() {
  const row = $('#engineRow');
  if (!row) return;
  const tools = state.tools || {};
  const btn = $('#engineBtn');
  row.classList.toggle('ready', !!tools.ready);
  if (tools.installing) {
    const pr = tools.progress;
    const phase = pr ? t(pr.phaseKey, pr.phaseParams) : '';
    $('#engineText').textContent = pr ? (pr.total ? t('engine.progress', { phase, p: Math.round((pr.received / pr.total) * 100) }) : phase) : t('engine.installing');
    btn.disabled = true;
    btn.textContent = t('engine.installingBtn');
    btn.hidden = false;
  } else if (tools.ready) {
    $('#engineText').textContent = t('engine.ready');
    btn.hidden = true;
  } else {
    $('#engineText').textContent = tools.error ? t('engine.failed', { error: tools.error }) : t('engine.sizeHint', { mb: tools.approxMb || 102 });
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = t('cap.install');
  }
}

function openSettings(tab) {
  renderSettingsControls();
  openModal('settingsModal');
  if (typeof tab === 'string') $(`#settingsTabs [data-tab="${tab}"]`).click();
  renderBrowsers();
  renderEngineRow();
}

async function saveSetting(input) {
  const path = input.dataset.setting.split('.');
  let v = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  const patch = path.length === 2 ? { [path[0]]: { [path[1]]: v } } : { [path[0]]: v };
  const s = await run(() => api.setSettings(patch));
  if (s) {
    state.settings = s;
    renderSettingsControls();
  }
}

// ---------------------------------------------------------------- bildirimler

function toast(msg, { type = '', sub, actions = [], timeout = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="t-msg">${escapeHtml(msg)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</div>`;
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn small ${a.primary ? 'primary' : ''}`;
    b.textContent = a.label;
    b.onclick = () => {
      el.remove();
      a.onClick();
    };
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.className = 'icon-btn';
  x.innerHTML = icon('x');
  x.onclick = () => el.remove();
  el.appendChild(x);
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

// ---------------------------------------------------------------- olay bağlama

function bindUi() {
  $('#newBtn').onclick = () => openAdd();
  $('#emptyAddBtn').onclick = () => openAdd();
  $('#settingsBtn').onclick = openSettings;
  $('#startBtn').onclick = () => doStart(selectedItems());
  $('#pauseBtn').onclick = () => doPause(selectedItems());
  $('#removeBtn').onclick = () => doRemove(selectedItems());
  $('#startAllBtn').onclick = () => run(() => api.startAll());
  $('#pauseAllBtn').onclick = () => run(() => api.pauseAll());

  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.filter = b.dataset.filter;
    render();
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  $('#listHeader').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const key = b.dataset.sort;
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'filename' ? 1 : -1 };
    $$('#listHeader button').forEach((x) => x.classList.toggle('sorted', x.dataset.sort === state.sort.key));
    b.classList.toggle('asc', state.sort.dir === 1);
    render();
  });
  $(`#listHeader [data-sort="${state.sort.key}"]`).classList.add('sorted');

  const list = $('#list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) {
      if (e.target === list) selectOnly(null);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      itemAction(act.dataset.act, state.byId.get(row.dataset.id));
      return;
    }
    onRowClick(e, row.dataset.id);
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('[data-act]')) return;
    const d = state.byId.get(row.dataset.id);
    itemAction(d.status === 'completed' ? 'open' : 'window', d);
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    if (!state.selected.has(row.dataset.id)) selectOnly(row.dataset.id);
    showContextMenu(e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctxmenu')) hideContextMenu();
  });

  // Ayrıntı paneli
  $('#dClose').onclick = () => selectOnly(null);
  $('#details').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dact]');
    const d = state.byId.get(state.focusId);
    if (b && d) itemAction(b.dataset.dact, d);
  });
  $('#dLimit').onchange = (e) => run(() => api.setItemLimit(state.focusId, Number(e.target.value)));
  $('#hashBtn').onclick = () => {
    const id = state.focusId;
    const algo = $('#hashAlgo').value;
    const expected = $('#hashExpected').value.trim();
    run(async () => {
      await api.setExpectedHash(id, algo, expected);
      const r = await api.computeHash(id, algo);
      if (r.ok === true) toast(t('hash.toastOk'), { type: 'success' });
      else if (r.ok === false) toast(t('hash.toastBad'), { type: 'error', timeout: 8000 });
    });
  };
  $('#hashExpected').onchange = (e) => run(() => api.setExpectedHash(state.focusId, $('#hashAlgo').value, e.target.value));

  // Durum çubuğu
  $('#sbLimit').onchange = (e) => saveSettingValue({ speedLimit: Number(e.target.value) });
  $('#sbConcurrent').onchange = (e) => saveSettingValue({ maxConcurrent: Number(e.target.value) });

  // Yeni indirme penceresi
  $('#addUrls').addEventListener('input', () => onAddUrlsChanged(false));
  $('#addConn').addEventListener('input', (e) => ($('#addConnVal').textContent = e.target.value));
  $('#addDirBtn').onclick = async () => {
    const dir = await run(() => api.pickFolder(addState.dir));
    if (dir) {
      addState.dir = dir;
      renderAddDir();
    }
  };
  $('#addDirReset').onclick = () => {
    addState.dir = '';
    renderAddDir();
  };
  $('#addNowBtn').onclick = () => submitAdd(true);
  $('#addLaterBtn').onclick = () => submitAdd(false);
  $('#addModal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.target.id === 'addName')) {
      e.preventDefault();
      submitAdd(true);
    }
  });

  // Ayarlar
  $('#settingsTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#settingsTabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  });
  $$('[data-setting]').forEach((input) => input.addEventListener('change', () => saveSetting(input)));
  $('#pickDownloadDir').onclick = async () => {
    const dir = await run(() => api.pickFolder(state.settings.downloadDir));
    if (dir) saveSettingValue({ downloadDir: dir });
  };
  $('#openDownloadDir').onclick = () => run(() => api.openFolder());
  $('#openExtBtn').onclick = () => run(() => api.openExtensionFolder());
  $('#engineBtn').onclick = () => run(() => api.installTools(), t('engine.done'));
  $('#browserList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-setup]');
    if (!b) return;
    const name = b.closest('.browser').querySelector('b').textContent;
    const r = await run(() => api.setupBrowser(b.dataset.setup));
    if (!r) return;
    const store = r.mode === 'store';
    $('#setupTitle').textContent = store ? t('cap.storeOpened', { name }) : t('cap.pageOpened', { name });
    $('#setupStore').hidden = !store;
    $('#setupManual').hidden = store;
    $('#setupSteps').hidden = false;
  });
  $('#bridgeState').onclick = () => openSettings('capture');
  $('#bridgeState').style.cursor = 'pointer';
  $('#pairBtn').onclick = () => openSettings('capture');
  $('#pairClose').onclick = () => {
    try {
      localStorage.setItem('pairBannerHidden', '1');
    } catch { /* yoksay */ }
    $('#pairBanner').hidden = true;
  };

  // Pencere kapatma
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (!c) return;
    const m = c.closest('.modal');
    if (m.id === 'confirmModal') finishConfirm(false);
    else closeModal(m.id);
  });
  $$('.modal').forEach((m) =>
    m.addEventListener('mousedown', (e) => {
      if (e.target !== m) return;
      if (m.id === 'confirmModal') finishConfirm(false);
      else closeModal(m.id);
    })
  );
  $('#confirmOk').onclick = () => finishConfirm(true);
  $('#confirmModal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finishConfirm(true);
  });

  document.addEventListener('keydown', onKeyDown);
  bindDragDrop();
}

async function saveSettingValue(patch) {
  const s = await run(() => api.setSettings(patch));
  if (s) {
    state.settings = s;
    renderSettingsControls();
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

async function onKeyDown(e) {
  const modal = topModal();
  if (e.key === 'Escape') {
    if (!$('#ctxmenu').hidden) return hideContextMenu();
    if (modal) return modal.id === 'confirmModal' ? finishConfirm(false) : closeModal(modal.id);
    if (document.activeElement === $('#search') && state.search) {
      $('#search').value = '';
      state.search = '';
      return render();
    }
    return selectOnly(null);
  }
  if (modal) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    return openAdd();
  }
  if (ctrl && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    return $('#search').focus();
  }
  if (isTyping(e)) return;
  if (ctrl && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    return openAdd();
  }
  if (ctrl && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selected = new Set(state.visible.map((d) => d.id));
    return render();
  }
  const sel = selectedItems();
  switch (e.key) {
    case 'Delete':
      return doRemove(sel);
    case ' ':
      e.preventDefault();
      return doToggle(sel);
    case 'Enter':
      if (sel.length === 1 && sel[0].status === 'completed') itemAction('open', sel[0]);
      return;
    case 'ArrowDown':
      e.preventDefault();
      return moveSelection(1);
    case 'ArrowUp':
      e.preventDefault();
      return moveSelection(-1);
  }
}

function bindDragDrop() {
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasLink = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'text/uri-list' || t === 'text/plain');
  window.addEventListener('dragenter', (e) => {
    if (!hasLink(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = parseUrls(text);
    if (urls.length) openAdd({ urls });
    else toast(t('drop.none'), { type: 'error' });
  });
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#d6363f">Grabbit: ${escapeHtml(err.stack || err)}</pre>`;
});
