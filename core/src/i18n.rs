//! Dil çekirdeği: arayüzle aynı dil dosyalarını (ui/i18n/locales/*.js) kullanır.
//! Dosyalar derlemede gömülür; eksik anahtarda İngilizceye, o da yoksa anahtarın kendisine düşer.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

pub const LANGS: [(&str, &str); 6] = [
    ("en", "English"),
    ("tr", "Türkçe"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("fr", "Français"),
    ("ru", "Русский"),
];

const SOURCES: [(&str, &str); 6] = [
    ("en", include_str!("../../ui/i18n/locales/en.js")),
    ("tr", include_str!("../../ui/i18n/locales/tr.js")),
    ("de", include_str!("../../ui/i18n/locales/de.js")),
    ("es", include_str!("../../ui/i18n/locales/es.js")),
    ("fr", include_str!("../../ui/i18n/locales/fr.js")),
    ("ru", include_str!("../../ui/i18n/locales/ru.js")),
];

/// Dil dosyası bir JS sarmalayıcısının içinde nesne sabitidir: `…, 'en', { 'anahtar': 'değer', … });`
/// Nesne kısmı JSON5 olarak çözülür (tek tırnak, sondaki virgül).
pub fn parse_locale(code: &str, src: &str) -> Result<Map<String, Value>, String> {
    let marker = format!("'{code}', {{");
    let start = src.find(&marker).ok_or("dil işaretçisi yok")? + marker.len() - 1;
    let end = src.rfind('}').ok_or("kapanış yok")?;
    json5::from_str::<Map<String, Value>>(&src[start..=end]).map_err(|e| e.to_string())
}

static CATALOGS: LazyLock<HashMap<&'static str, Map<String, Value>>> = LazyLock::new(|| {
    SOURCES
        .iter()
        .map(|(code, src)| (*code, parse_locale(code, src).unwrap_or_default()))
        .collect()
});

static LANG: RwLock<&'static str> = RwLock::new("en");

pub fn catalog(code: &str) -> Option<&'static Map<String, Value>> {
    CATALOGS.get(code)
}

pub fn set_language(code: &str) {
    let found = LANGS.iter().find(|(c, _)| *c == code).map(|(c, _)| *c).unwrap_or("en");
    *LANG.write().unwrap() = found;
}

pub fn lang() -> &'static str {
    *LANG.read().unwrap()
}

/// Ayardaki tercih ('system' ya da dil kodu) ve sistem dilinden kullanılacak dili seçer.
pub fn resolve(pref: &str, system_locale: &str) -> &'static str {
    if let Some((c, _)) = LANGS.iter().find(|(c, _)| *c == pref) {
        return c;
    }
    let base = system_locale.to_lowercase();
    let base = base.split(['-', '_']).next().unwrap_or("");
    LANGS.iter().find(|(c, _)| *c == base).map(|(c, _)| *c).unwrap_or("en")
}

/// Intl.PluralRules karşılığı (yalnızca desteklenen diller, tam sayılar).
fn plural_form(lang: &str, n: f64) -> &'static str {
    let i = n.abs().trunc() as u64;
    let int = n.fract() == 0.0;
    match lang {
        "ru" if int => {
            let (m10, m100) = (i % 10, i % 100);
            if m10 == 1 && m100 != 11 {
                "one"
            } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
                "few"
            } else {
                "many"
            }
        }
        "ru" => "other",
        "fr" if i <= 1 => "one",
        _ if int && i == 1 => "one",
        _ => "other",
    }
}

/// Çeviri: parametreler {ad} biçiminde yerleştirilir; çoğul değerlerde `n` parametresine göre biçim seçilir.
pub fn t(key: &str, params: &Value) -> String {
    let lang = lang();
    let raw = CATALOGS
        .get(lang)
        .and_then(|c| c.get(key))
        .or_else(|| CATALOGS.get("en").and_then(|c| c.get(key)));
    let text = match raw {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(forms)) => {
            let n = params.get("n").and_then(Value::as_f64).unwrap_or(0.0);
            let form = plural_form(lang, n);
            forms
                .get(form)
                .or_else(|| forms.get("other"))
                .or_else(|| forms.get("one"))
                .and_then(Value::as_str)
                .unwrap_or(key)
                .to_string()
        }
        _ => key.to_string(),
    };
    fill(&text, params)
}

/// `{ad}` yer tutucularını parametrelerle doldurur; olmayanlar olduğu gibi kalır.
pub fn fill(text: &str, params: &Value) -> String {
    let Some(map) = params.as_object() else { return text.to_string() };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && close > 0 => {
                let name = &after[..close];
                match map.get(name) {
                    Some(Value::String(s)) => out.push_str(s),
                    Some(Value::Null) | None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                    Some(v) => out.push_str(&v.to_string()),
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_locales_parse_and_match_english() {
        let en = catalog("en").unwrap();
        assert!(en.len() > 300);
        for (code, _) in LANGS {
            let c = catalog(code).unwrap_or_else(|| panic!("{code} çözülemedi"));
            for k in en.keys() {
                assert!(c.contains_key(k), "{code}: eksik anahtar {k}");
            }
            for k in c.keys() {
                assert!(en.contains_key(k), "{code}: fazla anahtar {k}");
            }
        }
    }

    #[test]
    fn plural_and_params() {
        set_language("ru");
        assert_eq!(plural_form("ru", 1.0), "one");
        assert_eq!(plural_form("ru", 3.0), "few");
        assert_eq!(plural_form("ru", 11.0), "many");
        assert!(t("row.connections", &json!({ "n": 5 })).contains("5"));
        set_language("en");
        assert_eq!(t("err.httpGeneric", &json!({ "status": 502 })), "Server error (HTTP 502)");
        assert_eq!(t("yok.anahtar", &Value::Null), "yok.anahtar");
        assert_eq!(fill("a {x} {y}", &json!({ "x": "1" })), "a 1 {y}");
    }
}
