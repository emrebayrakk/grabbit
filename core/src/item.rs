//! İndirme öğesi: diske kaydedilen alanlar (eski sürümün downloads.json biçimiyle uyumlu) ve
//! çalışırken tutulan anlık durum.

use crate::http::{Auth, Headers};
use crate::limiter::RateLimiter;
use crate::util::{now_ms, PART_EXT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const HISTORY: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: u64,
    /// Bilinmiyorsa -1 (boyutu bilinmeyen akış)
    pub end: i64,
    pub downloaded: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub finished: bool,
    #[serde(skip)]
    pub active: bool,
}

impl Segment {
    pub fn done(&self) -> bool {
        self.finished || (self.end >= 0 && self.downloaded as i64 > self.end - self.start as i64)
    }
    pub fn remaining(&self) -> i64 {
        if self.end < 0 {
            return 0;
        }
        self.end - (self.start + self.downloaded) as i64 + 1
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checksum {
    pub algo: String,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

fn d_kind() -> String {
    "file".into()
}
fn d_true() -> bool {
    true
}
fn d_other() -> String {
    "other".into()
}
fn d_neg() -> i64 {
    -1
}
fn d_queued() -> String {
    "queued".into()
}
fn d_eight() -> u32 {
    8
}

/// Çalışırken tutulan, kaydedilmeyen durum.
#[derive(Debug, Clone, Default)]
pub struct Runtime {
    pub speed: f64,
    pub eta: Option<f64>,
    pub history: VecDeque<u64>,
    pub samples: VecDeque<u64>,
    pub last: Option<u64>,
    pub hash_progress: Option<f64>,
    /// Video sitesi indirmesinde aşama (dil anahtarı)
    pub phase: Option<String>,
    /// Video sitesi: akış başına (inen, toplam)
    pub phases: HashMap<String, (u64, u64)>,
    pub estimate: u64,
    pub active: u32,
    pub conn_limit: u32,
    pub reresolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemData {
    pub id: String,
    #[serde(default = "d_kind")]
    pub kind: String,
    pub url: String,
    #[serde(default)]
    pub final_url: Option<String>,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub custom_dir: Option<String>,
    #[serde(default = "d_true")]
    pub auto_name: bool,
    #[serde(default = "d_other")]
    pub category: String,
    #[serde(default = "d_neg")]
    pub size: i64,
    #[serde(default)]
    pub resumable: bool,
    #[serde(default)]
    pub probed: bool,
    #[serde(default = "d_queued")]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_key: Option<String>,
    #[serde(default)]
    pub error_params: Value,
    #[serde(default)]
    pub segments: Vec<Segment>,
    #[serde(default = "d_eight")]
    pub connections: u32,
    #[serde(default)]
    pub speed_limit: u64,
    #[serde(default)]
    pub headers: Headers,
    #[serde(default)]
    pub auth: Auth,
    #[serde(default)]
    pub checksum: Option<Checksum>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    // HLS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub total_segments: u32,
    #[serde(default)]
    pub done_segments: u32,
    /// HLS ve video sitelerinde inen miktar (dosyada parçalardan hesaplanır)
    #[serde(default)]
    pub downloaded: u64,
    // Video siteleri
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_cookies: Option<bool>,
    #[serde(skip)]
    pub rt: Runtime,
}

impl ItemData {
    pub fn new(id: String, kind: &str, url: String) -> Self {
        Self {
            id,
            kind: kind.into(),
            url,
            final_url: None,
            filename: "indirme".into(),
            dir: String::new(),
            custom_dir: None,
            auto_name: true,
            category: "other".into(),
            size: -1,
            resumable: kind != "file",
            probed: false,
            status: "queued".into(),
            error: None,
            error_key: None,
            error_params: Value::Null,
            segments: vec![],
            connections: 8,
            speed_limit: 0,
            headers: Headers::default(),
            auth: Auth::default(),
            checksum: None,
            created_at: now_ms(),
            completed_at: None,
            variant_url: None,
            audio_url: None,
            total_segments: 0,
            done_segments: 0,
            downloaded: 0,
            quality: None,
            title: None,
            use_cookies: None,
            rt: Runtime::default(),
        }
    }

    pub fn save_path(&self) -> PathBuf {
        PathBuf::from(&self.dir).join(&self.filename)
    }

    pub fn temp_path(&self) -> PathBuf {
        PathBuf::from(format!("{}{}", self.save_path().display(), PART_EXT))
    }

    /// Dosya indirmesinde inen miktar parçalardan hesaplanır.
    pub fn downloaded_now(&self) -> u64 {
        if self.kind == "file" {
            self.segments.iter().map(|s| s.downloaded).sum()
        } else {
            self.downloaded
        }
    }

    pub fn set_error(&mut self, err: &crate::util::AppError) {
        self.status = "error".into();
        self.error = Some(err.message());
        self.error_key = err.key_opt();
        self.error_params = err.params_opt();
    }

    pub fn clear_error(&mut self) {
        self.error = None;
        self.error_key = None;
        self.error_params = Value::Null;
    }

    /// Saniyede bir çağrılır: hız, kalan süre ve hız geçmişi.
    pub fn sample(&mut self) {
        let now = self.downloaded_now();
        if self.status != "downloading" {
            self.rt.last = Some(now);
            self.rt.samples.clear();
            self.rt.speed = 0.0;
            self.rt.eta = None;
            return;
        }
        let delta = now.saturating_sub(self.rt.last.unwrap_or(now));
        self.rt.last = Some(now);
        self.rt.samples.push_back(delta);
        while self.rt.samples.len() > 5 {
            self.rt.samples.pop_front();
        }
        self.rt.speed = self.rt.samples.iter().sum::<u64>() as f64 / self.rt.samples.len() as f64;
        self.rt.history.push_back(delta);
        while self.rt.history.len() > HISTORY {
            self.rt.history.pop_front();
        }
        self.rt.eta = (self.rt.speed > 0.0 && self.size > 0).then(|| ((self.size as f64 - now as f64) / self.rt.speed).max(0.0));
    }

    /// Arayüz için: bitişik tamamlanmış parçalar birleştirilir, [başlangıç, bitiş, inen, aktif] döner.
    fn compact_segments(&self) -> Vec<[i64; 4]> {
        let mut sorted: Vec<&Segment> = self.segments.iter().collect();
        sorted.sort_by_key(|s| s.start);
        let mut out: Vec<([i64; 4], bool)> = vec![];
        for s in sorted {
            let done = s.done();
            if let Some((prev, prev_done)) = out.last_mut() {
                if done && *prev_done && prev[1] + 1 == s.start as i64 {
                    prev[1] = s.end;
                    prev[2] += s.downloaded as i64;
                    continue;
                }
            }
            out.push(([s.start as i64, s.end, s.downloaded as i64, s.active as i64], done));
        }
        out.into_iter().take(256).map(|(a, _)| a).collect()
    }

    pub fn snapshot(&self) -> Value {
        let downloaded = self.downloaded_now();
        let completed = self.status == "completed";
        let mut s = json!({
            "id": self.id,
            "kind": self.kind,
            "url": self.url,
            "finalUrl": self.final_url,
            "filename": self.filename,
            "dir": self.dir,
            "savePath": self.save_path().to_string_lossy(),
            "category": self.category,
            "size": self.size,
            "downloaded": downloaded,
            "status": self.status,
            "error": self.error,
            "errorKey": self.error_key,
            "errorParams": self.error_params,
            "resumable": self.resumable,
            "probed": self.probed,
            "connections": self.connections,
            "activeConnections": self.rt.active,
            "speed": self.rt.speed,
            "eta": self.rt.eta,
            "speedLimit": self.speed_limit,
            "checksum": self.checksum,
            "hashProgress": self.rt.hash_progress,
            "createdAt": self.created_at,
            "completedAt": self.completed_at,
            "hasCookies": self.auth.cookie.as_deref().is_some_and(|c| !c.is_empty()),
            "history": if self.status == "downloading" { self.rt.history.iter().copied().collect::<Vec<_>>() } else { vec![] },
        });
        let o = s.as_object_mut().unwrap();
        match self.kind.as_str() {
            "hls" => {
                let progress = if completed {
                    1.0
                } else if self.total_segments > 0 {
                    self.done_segments as f64 / self.total_segments as f64
                } else {
                    0.0
                };
                o.insert("estimated".into(), json!(!completed));
                o.insert("resumable".into(), json!(true));
                o.insert("segmentsDone".into(), json!(self.done_segments));
                o.insert("segmentsTotal".into(), json!(self.total_segments));
                o.insert("progress".into(), json!(progress));
                let segs = if self.total_segments > 0 && self.size > 0 {
                    json!([[0, self.size - 1, (progress * self.size as f64).round() as i64, 0]])
                } else {
                    json!([])
                };
                o.insert("segments".into(), segs);
            }
            "media" => {
                o.insert("quality".into(), json!(self.quality));
                o.insert("title".into(), json!(self.title));
                o.insert("phase".into(), json!(self.rt.phase));
                o.insert("resumable".into(), json!(true));
                o.insert("estimated".into(), json!(!completed));
                let segs = if self.size > 0 {
                    json!([[0, self.size - 1, downloaded.min(self.size as u64), (self.status == "downloading") as i32]])
                } else {
                    json!([])
                };
                o.insert("segments".into(), segs);
                let progress = if completed {
                    json!(1)
                } else if self.size > 0 {
                    json!((downloaded as f64 / self.size as f64).min(1.0))
                } else {
                    Value::Null
                };
                o.insert("progress".into(), progress);
            }
            _ => {
                let progress = if completed {
                    json!(1)
                } else if self.size > 0 {
                    json!(downloaded as f64 / self.size as f64)
                } else {
                    Value::Null
                };
                o.insert("progress".into(), progress);
                o.insert("segments".into(), json!(self.compact_segments()));
            }
        }
        s
    }
}

/// Çalışan bir indirmenin denetimi.
pub struct RunHandle {
    pub cancel: CancellationToken,
    pub done: watch::Receiver<bool>,
}

pub struct Item {
    pub id: String,
    data: Mutex<ItemData>,
    pub run: Mutex<Option<RunHandle>>,
    pub limiter: RateLimiter,
}

impl Item {
    pub fn new(data: ItemData) -> Self {
        let limiter = RateLimiter::new(data.speed_limit * 1024);
        Self { id: data.id.clone(), data: Mutex::new(data), run: Mutex::new(None), limiter }
    }

    pub fn lock(&self) -> MutexGuard<'_, ItemData> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_running(&self) -> bool {
        self.run.lock().unwrap().is_some()
    }

    pub fn snapshot(&self) -> Value {
        self.lock().snapshot()
    }

    pub fn status(&self) -> String {
        self.lock().status.clone()
    }

    pub fn set_speed_limit(&self, kbps: u64) {
        self.lock().speed_limit = kbps;
        self.limiter.set_rate(kbps * 1024);
    }

    /// Diske yazılacak biçim (anlık alanlar hariç).
    pub fn to_json(&self) -> Value {
        let d = self.lock();
        let mut v = serde_json::to_value(&*d).unwrap_or(Value::Null);
        if d.kind == "file" {
            if let Some(o) = v.as_object_mut() {
                o.remove("downloaded");
                o.remove("totalSegments");
                o.remove("doneSegments");
            }
        }
        v
    }
}
