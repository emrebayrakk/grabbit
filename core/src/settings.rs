//! Ayarlar (settings.json; eski sürümle aynı alan adları).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Schedule {
    pub enabled: bool,
    pub start: String,
    pub stop: String,
}

impl Default for Schedule {
    fn default() -> Self {
        Self { enabled: false, start: "02:00".into(), stop: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub download_dir: String,
    pub categorize: bool,
    pub max_concurrent: u32,
    pub connections: u32,
    /// KB/s, 0 = sınırsız
    pub speed_limit: u64,
    pub retries: u32,
    pub resume_on_start: bool,
    pub minimize_to_tray: bool,
    pub notifications: bool,
    pub clipboard_watch: bool,
    pub theme: String,
    /// 'system' ya da dil kodu (en, tr, de, es, fr, ru)
    pub language: String,
    pub bridge_enabled: bool,
    pub bridge_port: u16,
    pub ask_on_bridge: bool,
    pub show_progress_window: bool,
    /// Küçük önizleme görsellerin (=s64, s64x64, name=small…) orijinal boyutunu indir
    pub full_size_images: bool,
    /// Video sitelerinde varsayılan kalite: 2160/1440/1080/720/480/360/best/audio
    pub media_quality: String,
    pub schedule: Schedule,
    /// İlk açılış kurulumu (video motoru + tarayıcı eklentisi) gösterildi mi
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: String::new(),
            categorize: true,
            max_concurrent: 3,
            connections: 8,
            speed_limit: 0,
            retries: 5,
            resume_on_start: true,
            minimize_to_tray: true,
            notifications: true,
            clipboard_watch: true,
            theme: "system".into(),
            language: "system".into(),
            bridge_enabled: true,
            bridge_port: 17890,
            ask_on_bridge: true,
            show_progress_window: true,
            full_size_images: true,
            media_quality: "1080".into(),
            schedule: Schedule::default(),
            onboarded: false,
        }
    }
}

/// JS'nin `Number(v)` davranışı: sayı, sayı metni ya da mantıksal değer.
fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok().or(s.trim().is_empty().then_some(0.0)),
        Value::Bool(b) => Some(*b as u8 as f64),
        _ => None,
    }
}

impl Settings {
    /// Arayüzden gelen kısmi güncellemeyi uygular; bilinmeyen ya da hatalı alanlar yok sayılır.
    pub fn apply(&mut self, patch: &Value) {
        let Some(patch) = patch.as_object() else { return };
        let mut cur = serde_json::to_value(&*self).unwrap();
        let obj = cur.as_object_mut().unwrap();
        for (k, v) in patch {
            let Some(old) = obj.get(k).cloned() else { continue };
            let new = match (&old, v) {
                (Value::Object(o), Value::Object(n)) => {
                    let mut m: Map<String, Value> = o.clone();
                    m.extend(n.clone());
                    Value::Object(m)
                }
                (Value::Number(_), v) => match as_number(v) {
                    Some(n) => serde_json::json!(n.round().max(0.0) as u64),
                    None => continue,
                },
                (Value::Bool(_), Value::Bool(b)) => Value::Bool(*b),
                (Value::String(_), Value::String(s)) => Value::String(s.clone()),
                (Value::String(_), Value::Null) => Value::String(String::new()),
                _ => continue,
            };
            let mut trial = obj.clone();
            trial.insert(k.clone(), new);
            if serde_json::from_value::<Settings>(Value::Object(trial.clone())).is_ok() {
                *obj = trial;
            }
        }
        if let Ok(s) = serde_json::from_value::<Settings>(cur) {
            *self = s;
        }
        self.max_concurrent = self.max_concurrent.clamp(1, 20);
        self.connections = self.connections.clamp(1, 32);
        self.retries = self.retries.min(50);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apply_patch() {
        let mut s = Settings::default();
        s.apply(&json!({ "maxConcurrent": "100", "speedLimit": "250", "theme": "dark", "bogus": 1, "schedule": { "enabled": true } }));
        assert_eq!(s.max_concurrent, 20);
        assert_eq!(s.speed_limit, 250);
        assert_eq!(s.theme, "dark");
        assert!(s.schedule.enabled);
        assert_eq!(s.schedule.start, "02:00");
        // Eski sürümün dosyası okunabilmeli
        let old: Settings = serde_json::from_value(json!({ "language": "tr", "bridgePort": 17891 })).unwrap();
        assert_eq!(old.bridge_port, 17891);
        assert!(!old.onboarded);
    }
}
