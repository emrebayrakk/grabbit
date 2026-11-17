'use strict';

// Grabbit dil çekirdeği: ana süreçte (require) ve pencerelerde (<script>) aynı şekilde çalışır.
// Dil dosyaları i18n/locales/<kod>.js içindedir; eksik anahtarda İngilizceye, o da yoksa anahtarın kendisine düşer.
(function (g) {
  const LANGS = { en: 'English', tr: 'Türkçe', de: 'Deutsch', es: 'Español', fr: 'Français', ru: 'Русский' };
  const BCP47 = { en: 'en-US', tr: 'tr-TR', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU' };
  const isNode = typeof module !== 'undefined' && module.exports;
  const nodeCatalogs = {};
  const catalogs = () => (isNode ? nodeCatalogs : g.GRABBIT_LOCALES || {});
  const pluralRules = {};
  let lang = 'en';

  if (isNode) {
    for (const code of Object.keys(LANGS)) nodeCatalogs[code] = require(`./locales/${code}.js`);
  }

  /** Ayardaki tercih ('system' ya da dil kodu) ve sistem dilinden kullanılacak dili seçer. */
  function resolve(pref, systemLocale) {
    if (pref && pref !== 'system' && LANGS[pref]) return pref;
    const base = String(systemLocale || '').toLowerCase().split(/[-_]/)[0];
    return LANGS[base] ? base : 'en';
  }

  function setLanguage(code) {
    lang = LANGS[code] ? code : 'en';
  }

  /**
   * Çeviri. Parametreler {ad} biçiminde yerleştirilir. Değer nesne ise çoğul biçimi
   * Intl.PluralRules ile `n` parametresine göre seçilir ({ one, few, many, other }).
   */
  function t(key, params) {
    const c = catalogs();
    let v = c[lang]?.[key] ?? c.en?.[key] ?? key;
    if (v && typeof v === 'object') {
      const rules = pluralRules[lang] || (pluralRules[lang] = new Intl.PluralRules(BCP47[lang]));
      const form = rules.select(Number(params?.n ?? 0));
      v = v[form] ?? v.other ?? v.one ?? key;
    }
    if (!params) return v;
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? params[k] : m));
  }

  const api = {
    LANGS,
    t,
    resolve,
    setLanguage,
    get lang() {
      return lang;
    },
    /** Sayı/tarih biçimlendirme için BCP 47 etiketi (ör. tr-TR). */
    locale: () => BCP47[lang]
  };

  if (isNode) module.exports = api;
  else g.I18N = api;
})(typeof self !== 'undefined' ? self : globalThis);
