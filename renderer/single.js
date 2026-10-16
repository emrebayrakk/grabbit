'use strict';

/* global I18N, t, applyI18n, errorText, qualityLabel, icon, fmtBytes, fmtSpeed, fmtKbLimit, fmtEta, fmtPct, hostOf, extLabel, statusLabel, escapeHtml */

// IDM tarzı tekli pencere: "Dosya bilgisi" → "İlerleme" → "Tamamlandı"

const $ = (sel) => document.querySelector(sel);
const CAT_ICON = { video: 'video', music: 'music', document: 'document', archive: 'archive', program: 'program', image: 'image', other: 'other' };
const LIMITS = [0, 128, 256, 512, 1024, 2048, 5120, 10240];

const S = { mode: null, payload: null, info: null, item: null, settings: {}, categories: {}, dir: '', variant: null, busy: false };

async function init() {
  const st = await api.singleState();
  I18N.setLanguage(st.language);
  applyI18n();
  document.documentElement.classList.toggle('mica', !!st.mica);
  S.settings = st.settings;
  S.categories = st.categories;
  S.tools = st.tools;
  api.on('tools', (status) => {
    S.tools = status;
    updateEngineProgress();
  });
  api.on('item', (it) => {
    if (!it) return window.close(); // listeden kaldırıldı
    S.item = it;
    render();
  });
  if (st.item) {
    S.item = st.item;
    render();
  } else if (st.payload) {
    S.payload = st.payload;
    renderInfo();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
    if (e.key === 'Enter' && S.mode === 'info' && !S.busy) startDownload(true);
  });
}

function setHead(kicker, name, category) {
  $('#sKicker').textContent = kicker;
  $('#sName').textContent = name;
  $('#sName').title = name;
  const badge = $('#sIcon');
  badge.className = `file-badge cat-${category || 'other'}`;
  const ext = extLabel(name || '');
  badge.innerHTML = icon(CAT_ICON[category] || 'file') + (ext ? `<span class="ext">${escapeHtml(ext)}</span>` : '');
}

function foot(html) {
  $('#sFoot').innerHTML = html;
}

// ------------------------------------------------------------ dosya bilgisi

async function renderInfo() {
  S.mode = 'info';
  const p = S.payload;
  const kicker = t('single.fileInfo') + (p.source ? ` · ${p.source}` : '');
  document.title = `${t('single.fileInfo')} — Grabbit`;
  setHead(kicker, p.filename || hostOf(p.url), p.kind === 'hls' || p.kind === 'media' ? 'video' : 'other');
  $('#sBody').innerHTML = `<div class="loading-line"><span class="spin"></span>${
    escapeHtml(p.kind === 'media' ? t('single.probingMedia') : t('add.probing'))
  }</div>`;
  foot(`<div class="grow"></div><button class="btn" id="fCancel">${t('common.cancel')}</button>`);
  $('#fCancel').onclick = () => window.close();

  // Hata nesnesinin ek alanları contextBridge'den geçmediği için motor durumunu önceden sor
  if (p.kind === 'media') {
    S.tools = await api.toolsStatus().catch(() => S.tools);
    if (!S.tools?.ready) return renderEngine();
  }
  S.probeError = null;
  try {
    S.info = await api.probe(p.url, p.headers || {}, p.cookie || '', p.kind, p.jar);
  } catch (err) {
    S.info = null;
    S.probeError = err.message;
    if (err.message === t('err.engineMissing')) return renderEngine();
  }
  const info = S.info;
  const isHls = info?.kind === 'hls' || (!info && p.kind === 'hls');
  const isMedia = info?.kind === 'media' || (!info && p.kind === 'media');
  // Kalite: eklentiden gelen tercih (ör. "MP3 olarak indir") > ayardaki varsayılan; videoda yoksa ilk seçenek
  S.quality = isMedia ? p.quality || info?.defaultQuality || S.settings.mediaQuality : null;
  if (isMedia && info?.qualities?.length && !info.qualities.some((q) => q.id === S.quality)) S.quality = info.qualities[0].id;
  const audioOnly = isMedia && S.quality === 'audio';

  let name;
  if (isHls) {
    const base = (p.filename || '').trim();
    name = base ? (/\.(ts|mp4|mkv|webm)$/i.test(base) ? base : base + '.ts') : info?.filename || 'video.ts';
  } else if (isMedia) {
    name = (info?.filename || 'video.mp4').replace(/\.(mp3|mp4)$/i, '') + (audioOnly ? '.mp3' : '.mp4');
  } else {
    name = p.filename || info?.filename || decodeURIComponent(p.url.split('?')[0].split('/').pop() || 'indirme');
  }
  let category = isHls ? 'video' : isMedia ? (audioOnly ? 'music' : 'video') : info?.category || 'other';
  setHead(kicker, name, category);
  $('#sName').hidden = true;
  const input = $('#sNameInput');
  input.hidden = false;
  input.value = name;
  input.oninput = () => {
    setHead($('#sKicker').textContent, input.value, category);
    $('#sName').hidden = true;
  };

  const rows = [[t('info.url'), `<span title="${escapeHtml(p.url)}">${escapeHtml(p.url)}</span>`]];
  if (!info) {
    rows.push([t('single.status'), `<span style="color:var(--err)">${escapeHtml(S.probeError || t('add.probeFail'))}</span>`]);
  } else if (isMedia) {
    rows.push([t('single.site'), escapeHtml([info.site, info.uploader].filter(Boolean).join(' · ') || hostOf(p.url))]);
    if (info.duration) rows.push([t('single.duration'), fmtEta(info.duration)]);
    rows.push([t('single.type'), escapeHtml(t('single.typeMedia'))]);
  } else if (isHls) {
    rows.push([t('single.type'), escapeHtml(t('single.typeHls'))]);
    if (info.duration) rows.push([t('single.duration'), fmtEta(info.duration)]);
    if (info.segments) rows.push([t('single.segments'), String(info.segments)]);
    if (info.encrypted) rows.push([t('single.encryption'), escapeHtml(t('single.aes'))]);
  } else {
    rows.push([t('info.size'), info.size >= 0 ? `<b>${fmtBytes(info.size)}</b>` : escapeHtml(t('common.unknown'))]);
    if (info.upgradedFrom) rows.push([t('pill.fullSize'), `<span class="pill ok">${t('single.fullSizeNote')}</span>`]);
    rows.push([t('single.type'), escapeHtml(t('cat.' + category)) + (info.contentType ? ` · <span style="color:var(--text-3)">${escapeHtml(info.contentType)}</span>` : '')]);
    rows.push([
      t('info.resume'),
      info.resumable ? `<span class="pill ok">${t('single.resumeYes')}</span>` : `<span class="pill warn">${t('single.resumeNo')}</span>`
    ]);
  }
  if (p.cookie) rows.push([t('info.session'), escapeHtml(t('single.cookies'))]);

  let quality = '';
  if (isMedia && info?.qualities?.length) {
    if (!info.qualities.some((q) => q.id === S.quality)) S.quality = info.qualities[0].id;
    quality = `<div class="field"><span>${t('single.quality')}</span><div class="quality">${info.qualities
      .map(
        (q) =>
          `<label><input type="radio" name="q" value="${escapeHtml(q.id)}" ${q.id === S.quality ? 'checked' : ''}/>${escapeHtml(qualityLabel(q.id))}${
            q.size ? ` <small style="color:var(--text-3)">≈ ${fmtBytes(q.size)}</small>` : ''
          }</label>`
      )
      .join('')}</div></div>`;
  } else if (isHls && info?.variants?.length) {
    S.variant = info.variants[0].url;
    quality = `<div class="field"><span>${t('single.quality')}</span><div class="quality">${info.variants
      .map(
        (v, i) =>
          `<label><input type="radio" name="q" value="${escapeHtml(v.url)}" ${i === 0 ? 'checked' : ''}/>${
            v.height ? `${v.height}p` : v.resolution || t('single.option', { n: i + 1 })
          }${v.bandwidth ? ` <small style="color:var(--text-3)">${(v.bandwidth / 1e6).toFixed(1)} Mbps</small>` : ''}</label>`
      )
      .join('')}</div></div>`;
  }

  const s = S.settings;
  const autoDir = () => (s.categorize ? `${s.downloadDir}\\${t('cat.' + category)}` : s.downloadDir);
  const thumb = isMedia && info?.thumbnail && /^https:\/\//.test(info.thumbnail) ? `<img class="thumb" src="${escapeHtml(info.thumbnail)}" alt="" />` : '';
  $('#sBody').innerHTML = `
    <div class="${thumb ? 'with-thumb' : ''}">${thumb}<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    ${quality}
    <label class="field"><span>${t('single.saveTo')}</span>
      <div class="input-btn"><input id="sDir" readonly placeholder="${escapeHtml(autoDir())}" /><button class="btn small" id="sDirBtn">${t('common.change')}</button></div>
    </label>`;
  $('#sBody').querySelectorAll('input[name=q]').forEach(
    (r) =>
      (r.onchange = () => {
        if (!isMedia) {
          S.variant = r.value;
          return;
        }
        // Ses seçilince uzantı ve kategori MP3 / Müzik olur
        S.quality = r.value;
        const ext = r.value === 'audio' ? 'mp3' : 'mp4';
        input.value = input.value.replace(/\.(mp3|mp4)$/i, '') + '.' + ext;
        category = ext === 'mp3' ? 'music' : 'video';
        setHead($('#sKicker').textContent, input.value, category);
        $('#sName').hidden = true;
        $('#sDir').placeholder = autoDir();
      })
  );
  $('#sDirBtn').onclick = async () => {
    const dir = await api.pickFolder(S.dir || s.downloadDir).catch(() => null);
    if (dir) {
      S.dir = dir;
      $('#sDir').value = dir;
    }
  };

  foot(`<div class="grow" id="fMsg"></div>
    <button class="btn" id="fCancel">${t('common.cancel')}</button>
    <button class="btn" id="fLater">${t('add.later')}</button>
    <button class="btn primary" id="fStart">${icon('download')}${t('single.start')}</button>`);
  $('#fCancel').onclick = () => window.close();
  $('#fLater').onclick = () => startDownload(false);
  $('#fStart').onclick = () => startDownload(true);
  $('#fStart').focus();
}

// ------------------------------------------------------------ video motoru kurulumu (onaylı)

function renderEngine() {
  S.mode = 'engine';
  const tools = S.tools || {};
  setHead(t('engine.needed'), t('engine.sites'), 'video');
  $('#sName').hidden = false;
  $('#sNameInput').hidden = true;
  $('#sBody').innerHTML = `
    <p style="margin:0 0 10px;color:var(--text-2)">${t('engine.intro')}</p>
    <dl class="kv">
      <dt>${t('info.size')}</dt><dd>${escapeHtml(t('engine.size', { mb: tools.approxMb || 102 }))}</dd>
      <dt>${t('engine.source')}</dt><dd>${escapeHtml(t('engine.sourceValue'))}</dd>
      <dt>${t('engine.security')}</dt><dd>${escapeHtml(t('engine.securityValue'))}</dd>
    </dl>
    <div class="big-bar" id="engBar" hidden><i style="width:0%"></i></div>
    <div class="note" id="engMsg"></div>`;
  foot(`<div class="grow"></div>
    <button class="btn" id="fCancel">${t('confirm.cancel')}</button>
    <button class="btn primary" id="engInstall">${icon('download')}${t('engine.installBtn')}</button>`);
  $('#fCancel').onclick = () => window.close();
  $('#engInstall').onclick = async () => {
    $('#engInstall').disabled = true;
    $('#engBar').hidden = false;
    try {
      await api.installTools();
      renderInfo();
    } catch (err) {
      $('#engMsg').innerHTML = `<span style="color:var(--err)">${escapeHtml(err.message)}</span>`;
      $('#engInstall').disabled = false;
    }
  };
  updateEngineProgress();
}

function updateEngineProgress() {
  if (S.mode !== 'engine') return;
  const pr = S.tools?.progress;
  const bar = $('#engBar');
  if (!pr || !bar) return;
  bar.hidden = false;
  const pct = pr.total ? (pr.received / pr.total) * 100 : 0;
  bar.classList.toggle('indeterminate', !pr.total);
  bar.firstChild.style.width = `${pct}%`;
  const phase = t(pr.phaseKey, pr.phaseParams);
  $('#engMsg').textContent = pr.total ? `${phase} — ${fmtBytes(pr.received)} / ${fmtBytes(pr.total)}` : phase;
}

async function startDownload(startNow) {
  if (S.busy || S.mode !== 'info') return;
  S.busy = true;
  const p = S.payload;
  const isHls = S.info?.kind === 'hls' || (!S.info && p.kind === 'hls');
  const isMedia = S.info?.kind === 'media' || (!S.info && p.kind === 'media');
  const entry = {
    url: p.url,
    filename: $('#sNameInput').value.trim() || undefined,
    dir: S.dir || undefined,
    kind: isHls ? 'hls' : isMedia ? 'media' : undefined,
    variantUrl: isHls ? S.variant || p.variantUrl : undefined,
    quality: isMedia ? S.quality : undefined,
    cookie: p.cookie,
    jar: p.jar,
    headers: p.headers,
    startNow,
    probeInfo: !isHls && S.info ? S.info : undefined
  };
  $('#sFoot').querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const [res] = await api.add([entry]);
    if (res.error) throw new Error(res.error);
    if (!startNow) return window.close();
    $('#sNameInput').hidden = true;
    $('#sName').hidden = false;
    S.item = res;
    render();
  } catch (err) {
    $('#fMsg').innerHTML = `<span style="color:var(--err)">${escapeHtml(err.message)}</span>`;
    $('#sFoot').querySelectorAll('button').forEach((b) => (b.disabled = false));
  } finally {
    S.busy = false;
  }
}

// ------------------------------------------------------------ ilerleme / sonuç

function render() {
  const d = S.item;
  if (!d) return;
  const mode = d.status === 'completed' ? 'done' : d.status === 'error' ? 'error' : 'progress';
  if (mode !== S.mode) {
    S.mode = mode;
    if (mode === 'progress') buildProgress();
    else if (mode === 'done') buildDone();
    else buildError();
  }
  if (mode === 'progress') updateProgress(d);
  if (mode === 'done') updateDone(d);
}

function buildProgress() {
  $('#sBody').innerHTML = `
    <dl class="kv">
      <dt>${t('info.url')}</dt><dd id="pUrl"></dd>
      <dt>${t('single.status')}</dt><dd id="pStatus"></dd>
      <dt>${t('single.fileSize')}</dt><dd id="pSize"></dd>
      <dt>${t('info.downloaded')}</dt><dd id="pDone"></dd>
      <dt>${t('info.speed')}</dt><dd id="pSpeed"></dd>
      <dt>${t('info.eta')}</dt><dd id="pEta"></dd>
      <dt>${t('info.resume')}</dt><dd id="pResume"></dd>
    </dl>
    <div class="big-bar" id="pBar"><i></i></div>
    <div class="seg-cap"><span>${t('single.connections')}</span><span id="pConn"></span></div>
    <canvas id="sSeg" height="22"></canvas>`;
  foot(`<div class="grow">${icon('gauge')}<select id="pLimit" title="${escapeHtml(t('details.limit'))}"></select></div>
    <button class="btn" id="pHide" title="${escapeHtml(t('single.hideTitle'))}">${t('common.hide')}</button>
    <button class="btn" id="pToggle"></button>
    <button class="btn danger" id="pCancel">${t('single.cancelDl')}</button>`);
  $('#pHide').onclick = () => window.close();
  $('#pToggle').onclick = () => {
    const d = S.item;
    if (['downloading', 'queued'].includes(d.status)) api.pause([d.id]);
    else api.start([d.id]);
  };
  $('#pCancel').onclick = async () => {
    if (!confirm(t('single.cancelConfirm'))) return;
    await api.remove([S.item.id], false);
    window.close();
  };
  $('#pLimit').onchange = (e) => api.setItemLimit(S.item.id, Number(e.target.value));
}

function updateProgress(d) {
  const pct = d.progress != null ? d.progress : null;
  const pctText = pct != null ? fmtPct(pct) : '';
  document.title = `${pctText ? pctText + ' — ' : ''}${d.filename}`;
  const conn = d.status === 'downloading' && d.activeConnections ? ` · ${t('row.connections', { n: d.activeConnections })}` : '';
  setHead(
    d.status === 'verifying' ? statusLabel('verifying') : `${statusLabel(d.status)}${conn}`,
    d.filename,
    d.category
  );
  $('#pUrl').textContent = d.url;
  $('#pUrl').title = d.url;
  $('#pStatus').textContent =
    d.kind === 'media' && d.phase && d.status === 'downloading'
      ? t(d.phase)
      : d.kind === 'hls' && d.segmentsTotal
        ? `${statusLabel(d.status)} — ${t('row.segments', { done: d.segmentsDone, total: d.segmentsTotal })}`
        : statusLabel(d.status);
  $('#pSize').textContent = d.size > 0 ? `${d.estimated ? '≈ ' : ''}${fmtBytes(d.size)}` : t('common.unknown');
  $('#pDone').textContent = `${fmtBytes(d.downloaded)}${pctText ? ` (${pctText})` : ''}`;
  $('#pSpeed').textContent = d.status === 'downloading' ? fmtSpeed(d.speed) : '—';
  $('#pEta').textContent = d.status === 'downloading' ? fmtEta(d.eta) : '—';
  $('#pResume').innerHTML =
    !d.probed && d.kind !== 'hls'
      ? escapeHtml(t('common.unknown'))
      : d.resumable
        ? `<span class="pill ok">${t('common.yes')}</span>`
        : `<span class="pill warn">${t('common.no')}</span>`;
  const bar = $('#pBar');
  const indet = d.status === 'downloading' && pct == null;
  bar.classList.toggle('indeterminate', indet);
  bar.firstChild.style.width = `${(pct || 0) * 100}%`;
  $('#pConn').textContent =
    d.kind === 'media'
      ? t('single.viaYtdlp')
      : d.kind === 'hls'
        ? t('single.parallelParts', { n: d.activeConnections })
        : t('single.activeOf', { a: d.activeConnections, n: d.connections });
  const active = ['downloading', 'queued'].includes(d.status);
  $('#pToggle').innerHTML = active ? `${icon('pause')}${t('act.pause')}` : `${icon('play')}${t('act.resume')}`;
  $('#pToggle').disabled = d.status === 'verifying';
  const sel = $('#pLimit');
  if (document.activeElement !== sel) {
    const vals = LIMITS.includes(d.speedLimit) ? LIMITS : [...LIMITS, d.speedLimit].sort((a, b) => a - b);
    sel.innerHTML = vals.map((v) => `<option value="${v}">${escapeHtml(v ? t('limit.label', { v: fmtKbLimit(v) }) : t('limit.none'))}</option>`).join('');
    sel.value = String(d.speedLimit || 0);
  }
  drawSeg(d);
}

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function drawSeg(d) {
  const c = $('#sSeg');
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = 22;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = cssVar('--bar-bg');
  ctx.fillRect(0, 0, w, h);
  if (!(d.size > 0)) return;
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, cssVar('--accent'));
  g.addColorStop(1, cssVar('--accent-2'));
  ctx.fillStyle = g;
  for (const [start, , done] of d.segments) if (done > 0) ctx.fillRect((start / d.size) * w, 0, Math.max(1, (done / d.size) * w), h);
  ctx.fillStyle = cssVar('--surface');
  for (const [start, , done, active] of d.segments) {
    ctx.fillRect((start / d.size) * w, 0, 1, h);
    if (active) {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.fillRect(((start + done) / d.size) * w - 1, 3, 2, h - 6);
      ctx.restore();
    }
  }
}

function buildDone() {
  const d = S.item;
  document.title = `${statusLabel('completed')} — ${d.filename}`;
  setHead(t('single.doneTitle'), d.filename, d.category);
  $('#sBody').innerHTML = `
    <div class="done-hero">
      <div class="ok-icon">${icon('check')}</div>
      <h2>${t('single.doneTitle')}</h2>
      <p id="dSummary"></p>
    </div>
    <dl class="kv" style="margin-top:14px">
      <dt>${t('single.savedTo')}</dt><dd class="wrap" id="dPath"></dd>
      <dt>${t('info.url')}</dt><dd id="dUrl"></dd>
    </dl>`;
  foot(`<div class="grow"></div>
    <button class="btn" id="dClose">${t('common.close')}</button>
    <button class="btn" id="dFolder">${icon('folder')}${t('settings.openFolder')}</button>
    <button class="btn primary" id="dOpen">${icon('open')}${t('act.open')}</button>`);
  $('#dClose').onclick = () => window.close();
  $('#dFolder').onclick = () => api.showInFolder(d.id).then(() => window.close());
  $('#dOpen').onclick = () => api.open(d.id).then(() => window.close()).catch((e) => alert(e.message));
  $('#dOpen').focus();
  updateDone(d);
}

function updateDone(d) {
  const took = d.completedAt && d.createdAt ? fmtEta((d.completedAt - d.createdAt) / 1000) : '';
  $('#dSummary').textContent = `${fmtBytes(d.size)}${took ? ` · ${t('single.took', { time: took })}` : ''}`;
  $('#dPath').textContent = d.savePath;
  $('#dUrl').textContent = d.url;
  $('#dUrl').title = d.url;
}

function buildError() {
  const d = S.item;
  document.title = `${statusLabel('error')} — ${d.filename}`;
  setHead(t('single.failTitle'), d.filename, d.category);
  $('#sBody').innerHTML = `
    <div class="done-hero err">
      <div class="ok-icon">${icon('alert')}</div>
      <h2>${t('single.failHeading')}</h2>
      <p>${escapeHtml(errorText(d))}</p>
    </div>
    <dl class="kv" style="margin-top:14px">
      <dt>${t('info.url')}</dt><dd>${escapeHtml(d.url)}</dd>
      <dt>${t('info.downloaded')}</dt><dd>${fmtBytes(d.downloaded)}${d.resumable ? ' — ' + escapeHtml(t('single.resumeOnRetry')) : ''}</dd>
    </dl>`;
  foot(`<div class="grow"></div>
    <button class="btn" id="eClose">${t('common.close')}</button>
    <button class="btn" id="eMain">${t('single.showMain')}</button>
    <button class="btn primary" id="eRetry">${icon('refresh')}${t('act.retry')}</button>`);
  $('#eClose').onclick = () => window.close();
  $('#eMain').onclick = () => api.showMain();
  $('#eRetry').onclick = () => api.start([d.id]);
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#d6363f">Grabbit: ${escapeHtml(err.stack || err)}</pre>`;
});
