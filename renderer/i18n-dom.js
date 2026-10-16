'use strict';

/* global I18N */

// Kısa yol: t('anahtar', { parametre })
const t = (key, params) => I18N.t(key, params);

/**
 * HTML'deki çeviri işaretlerini doldurur:
 * data-i18n (metin), data-i18n-html (biçimli metin, yalnızca kendi dil dosyalarımızdan),
 * data-i18n-title, data-i18n-placeholder.
 */
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-html]').forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  root.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  document.documentElement.lang = I18N.lang;
}

/** Motorun dil anahtarıyla sakladığı hata/aşama metinleri. */
function errorText(d) {
  return d.errorKey ? t(d.errorKey, d.errorParams) : d.error || t('common.error');
}

function qualityLabel(id) {
  if (id === 'audio') return t('q.audio');
  if (id === 'best') return t('q.best');
  return id === '2160' ? t('q.2160') : `${id}p`;
}
