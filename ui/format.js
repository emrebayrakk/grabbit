'use strict';

/* global I18N, t */

// Sayı biçimleri seçili dile göre (tr: "12,5", en: "12.5"); dil değişince yeniden kurulur
const numFormats = {};
function nf(kind) {
  const loc = I18N.locale();
  const key = `${loc}:${kind}`;
  if (!numFormats[key]) {
    numFormats[key] =
      kind === 'pct'
        ? new Intl.NumberFormat(loc, { style: 'percent', maximumFractionDigits: 1 })
        : new Intl.NumberFormat(loc, { maximumFractionDigits: kind === 1 ? 1 : 2 });
  }
  return numFormats[key];
}

function fmtBytes(n) {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(v >= 100 ? nf(1) : nf(2)).format(v >= 100 ? Math.round(v) : v)} ${units[i]}`;
}

function fmtSpeed(bps) {
  if (!bps) return '—';
  return fmtBytes(Math.round(bps)) + '/s';
}

function fmtKbLimit(kbps) {
  if (!kbps) return t('limit.unlimited');
  return kbps >= 1024 ? `${nf(1).format(kbps / 1024)} MB/s` : `${kbps} KB/s`;
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.round(sec);
  if (sec < 60) return t('eta.s', { s: sec });
  const m = Math.floor(sec / 60);
  if (m < 60) return t('eta.ms', { m, s: sec % 60 });
  const h = Math.floor(m / 60);
  if (h < 24) return t('eta.hm', { h, m: m % 60 });
  return t('eta.dh', { d: Math.floor(h / 24), h: h % 24 });
}

function fmtPct(p) {
  return nf('pct').format(Math.min(1, Math.max(0, p)));
}

function fmtPercent(d) {
  if (d.status === 'completed') return fmtPct(1);
  const p = d.progress ?? (d.size > 0 ? d.downloaded / d.size : null);
  if (p == null) return '';
  return fmtPct(p);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const loc = I18N.locale();
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t('date.today', { time });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('date.yesterday', { time });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function extLabel(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && name.length - i <= 6 ? name.slice(i + 1).toUpperCase() : '';
}

function statusLabel(status) {
  return t('status.' + status);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
