//! İndirme yöneticisi: kuyruk, kalıcılık, ayarlar, zamanlayıcı ve yoklama önbelleği.

use crate::fullsize::full_size_candidates;
use crate::hls::probe_hls;
use crate::http::{probe, Auth, Headers, JarCookie, ProbeInfo};
use crate::i18n;
use crate::item::{Checksum, Item, ItemData, RunHandle};
use crate::limiter::RateLimiter;
use crate::media::{is_media_site_url, probe_media};
use crate::settings::Settings;
use crate::tools::Tools;
use crate::util::{category_of, filename_from_url, normalize_url, origin_of, sanitize_filename, unique_path, AppError, Result};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;

const PROBE_CONCURRENCY: usize = 6;
const PROBE_TTL_MEDIA: Duration = Duration::from_secs(10 * 60); // video bilgisi (başlık, kaliteler) birkaç dakika geçerli
const PROBE_TTL_FILE: Duration = Duration::from_secs(30);
const PROGRESS_SAVE_MS: i64 = 10_000;

#[derive(Debug, Clone)]
pub enum Event {
    /// Liste/durum değişti (arayüz bunu seyreltir)
    Changed,
    Settings(Value),
    Completed(Value),
    Failed(Value),
    Schedule(&'static str),
    Tools(Value),
}

/// Arayüzden ya da eklentiden gelen ekleme isteği.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewEntry {
    pub url: String,
    pub filename: Option<String>,
    pub dir: Option<String>,
    pub connections: Option<u32>,
    pub start_now: Option<bool>,
    pub checksum: Option<Value>,
    pub headers: Option<Headers>,
    pub cookie: Option<String>,
    pub jar: Option<Vec<JarCookie>>,
    pub speed_limit: Option<f64>,
    pub probe_info: Option<Value>,
    pub kind: Option<String>,
    pub variant_url: Option<String>,
    pub quality: Option<String>,
}

type ProbeFut = Shared<BoxFuture<'static, std::result::Result<Value, AppError>>>;

struct ProbeEntry {
    at: Instant,
    ttl: Duration,
    fut: ProbeFut,
}

pub struct Manager {
    pub data_dir: PathBuf,
    default_download_dir: PathBuf,
    settings: RwLock<Settings>,
    pub limiter: RateLimiter,
    pub tools: Arc<Tools>,
    items: Arc<Mutex<IndexMap<String, Arc<Item>>>>,
    adding: Mutex<Vec<Arc<Item>>>,
    path_lock: tokio::sync::Mutex<()>,
    probes: Mutex<HashMap<String, ProbeEntry>>,
    events: broadcast::Sender<Event>,
    save_pending: Arc<AtomicBool>,
    save_lock: Arc<tokio::sync::Mutex<()>>,
    last_progress_save: AtomicI64,
    schedule_fired: Mutex<String>,
    pub progress_save_ms: AtomicI64,
    shutting_down: AtomicBool,
}

impl Manager {
    pub fn new(data_dir: PathBuf, default_download_dir: PathBuf) -> Arc<Self> {
        let tools = Tools::new(&data_dir);
        let (events, _) = broadcast::channel(512);
        let m = Arc::new(Self {
            data_dir,
            default_download_dir: default_download_dir.clone(),
            settings: RwLock::new(Settings { download_dir: default_download_dir.display().to_string(), ..Default::default() }),
            limiter: RateLimiter::new(0),
            tools: tools.clone(),
            items: Arc::new(Mutex::new(IndexMap::new())),
            adding: Mutex::new(vec![]),
            path_lock: tokio::sync::Mutex::new(()),
            probes: Mutex::new(HashMap::new()),
            events,
            save_pending: Arc::new(AtomicBool::new(false)),
            save_lock: Arc::default(),
            last_progress_save: AtomicI64::new(0),
            schedule_fired: Mutex::new(String::new()),
            progress_save_ms: AtomicI64::new(PROGRESS_SAVE_MS),
            shutting_down: AtomicBool::new(false),
        });
        let tx = m.events.clone();
        tools.on_status(move |s| {
            let _ = tx.send(Event::Tools(s));
        });
        m
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub fn settings(&self) -> RwLockReadGuard<'_, Settings> {
        self.settings.read().unwrap()
    }

    fn downloads_file(&self) -> PathBuf {
        self.data_dir.join("downloads.json")
    }
    fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    /// Ayarları ve listeyi yükler, saniyelik zamanlayıcıyı başlatır.
    pub async fn init(self: &Arc<Self>) -> Result<()> {
        tokio::fs::create_dir_all(&self.data_dir).await?;
        if let Some(v) = read_json(&self.settings_file()) {
            let mut s: Settings = serde_json::from_value(v.clone()).unwrap_or_default();
            if s == Settings::default() && v.is_object() {
                // Tür uyuşmazlığında alan alan uygula
                s.apply(&v);
            }
            if s.download_dir.is_empty() {
                s.download_dir = self.default_download_dir.display().to_string();
            }
            *self.settings.write().unwrap() = s;
        }
        let (rate, resume) = {
            let s = self.settings();
            (s.speed_limit * 1024, s.resume_on_start)
        };
        self.limiter.set_rate(rate);
        if let Some(Value::Array(list)) = read_json(&self.downloads_file()) {
            let mut items = self.items.lock().unwrap();
            for v in list {
                let Ok(mut d) = serde_json::from_value::<ItemData>(v) else { continue };
                if matches!(d.status.as_str(), "downloading" | "queued" | "verifying") {
                    d.status = if d.status == "verifying" {
                        "completed".into()
                    } else if resume {
                        "queued".into()
                    } else {
                        "paused".into()
                    };
                }
                for s in &mut d.segments {
                    s.active = false;
                }
                items.insert(d.id.clone(), Arc::new(Item::new(d)));
            }
        }
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            loop {
                iv.tick().await;
                let Some(m) = me.upgrade() else { break };
                if m.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                m.on_tick();
            }
        });
        self.schedule();
        Ok(())
    }

    // ---- olaylar ----

    pub fn changed(&self) {
        let _ = self.events.send(Event::Changed);
        self.save_soon();
    }

    pub fn emit_completed(&self, item: &Item) {
        let _ = self.events.send(Event::Completed(item.snapshot()));
        self.save_now();
    }

    pub fn emit_failed(&self, item: &Item) {
        let _ = self.events.send(Event::Failed(item.snapshot()));
        self.save_now();
    }

    pub fn list(&self) -> Vec<Value> {
        self.items.lock().unwrap().values().map(|i| i.snapshot()).collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Item>> {
        self.items.lock().unwrap().get(id).cloned()
    }

    fn require(&self, id: &str) -> Result<Arc<Item>> {
        self.get(id).ok_or_else(|| AppError::new("err.downloadNotFound"))
    }

    fn all(&self) -> Vec<Arc<Item>> {
        self.items.lock().unwrap().values().cloned().collect()
    }

    pub fn stats(&self) -> Value {
        let (mut speed, mut active, mut total, mut done) = (0.0, 0, 0i64, 0u64);
        for i in self.all() {
            let d = i.lock();
            if d.status != "downloading" {
                continue;
            }
            active += 1;
            speed += d.rt.speed;
            if d.size > 0 {
                total += d.size;
                done += d.downloaded_now();
            }
        }
        let progress = if total > 0 {
            json!(done as f64 / total as f64)
        } else if active > 0 {
            json!(-1)
        } else {
            Value::Null
        };
        json!({ "speed": speed, "active": active, "progress": progress })
    }

    // ---- yoklama ----

    /// Yoklama sonuçları kısa süre saklanır: tarayıcıdan gelen istekte yoklama pencere açılırken başlar,
    /// video düğmesine gelince önceden yapılır; pencere ya da indirme aynı işi tekrar beklemez.
    pub async fn probe(
        self: &Arc<Self>,
        url: &str,
        headers: Headers,
        cookie: String,
        kind: Option<String>,
        jar: Option<Vec<JarCookie>>,
    ) -> Result<Value> {
        let u = normalize_url(url)?;
        let media = kind.as_deref() == Some("media") || (kind.is_none() && is_media_site_url(&u));
        let has_cookies = !cookie.is_empty() || jar.as_ref().is_some_and(|j| !j.is_empty());
        let key = format!("{}\n{u}\n{has_cookies}\n{}", kind.as_deref().unwrap_or(""), self.settings().full_size_images);
        let fut = {
            let mut probes = self.probes.lock().unwrap();
            probes.retain(|_, e| e.at.elapsed() < e.ttl);
            match probes.get(&key) {
                Some(e) => e.fut.clone(),
                None => {
                    let me = self.clone();
                    let k2 = key.clone();
                    let fut: ProbeFut = async move {
                        let r = me.probe_now(&u, headers, cookie, kind, jar).await;
                        if r.is_err() {
                            // Hatalar saklanmaz: bir sonraki deneme yeniden yoklar
                            me.probes.lock().unwrap().remove(&k2);
                        }
                        r
                    }
                    .boxed()
                    .shared();
                    probes.insert(key, ProbeEntry { at: Instant::now(), ttl: if media { PROBE_TTL_MEDIA } else { PROBE_TTL_FILE }, fut: fut.clone() });
                    if probes.len() > 50 {
                        if let Some(oldest) = probes.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone()) {
                            probes.remove(&oldest);
                        }
                    }
                    fut
                }
            }
        };
        fut.await
    }

    async fn probe_now(self: &Arc<Self>, u: &str, headers: Headers, cookie: String, kind: Option<String>, jar: Option<Vec<JarCookie>>) -> Result<Value> {
        let auth = Auth { cookie: Some(cookie.clone()).filter(|c| !c.is_empty()), jar: None, origin: Some(origin_of(u)) };
        if kind.as_deref() == Some("media") || (kind.is_none() && is_media_site_url(u)) {
            let info = probe_media(self, u, Some(&cookie), jar.as_deref(), headers.referer.as_deref(), headers.user_agent.as_deref()).await?;
            if info["isLive"].as_bool() == Some(true) {
                return Err(AppError::new("err.live"));
            }
            let pref = self.settings().media_quality.clone();
            let qs = info["qualities"].as_array().cloned().unwrap_or_default();
            let pick = qs.iter().find(|q| q["id"] == pref.as_str()).or(qs.first()).cloned().unwrap_or(Value::Null);
            let ext = if pick["id"] == "audio" { "mp3" } else { "mp4" };
            let mut out = info.clone();
            let o = out.as_object_mut().unwrap();
            o.insert("filename".into(), json!(sanitize_filename(&format!("{}.{ext}", info["title"].as_str().unwrap_or("video")))));
            o.insert("defaultQuality".into(), pick["id"].clone());
            o.insert("size".into(), if pick["size"].is_number() { pick["size"].clone() } else { json!(-1) });
            o.insert("category".into(), json!(if ext == "mp3" { "music" } else { "video" }));
            return Ok(out);
        }
        if kind.as_deref() == Some("hls") || is_hls_url(u) {
            return self.probe_hls_info(u, &headers.with_origin(), &auth).await;
        }
        // Asıl adres, büyük sürüm adaylarıyla aynı anda yoklanır (büyüğü yoksa beklemeden hazır olsun)
        let plain = tokio::spawn({
            let (u, h, a) = (u.to_string(), headers.clone(), auth.clone());
            async move { probe(&u, &h, &a, Duration::from_secs(20)).await }
        });
        if let Some((url, info)) = self.upgrade_image(u, &headers, &auth).await {
            plain.abort();
            let mut v = serde_json::to_value(&info).unwrap();
            let o = v.as_object_mut().unwrap();
            o.insert("kind".into(), json!("file"));
            o.insert("category".into(), json!(category_of(&info.filename)));
            o.insert("upgradedUrl".into(), json!(url));
            o.insert("upgradedFrom".into(), json!(u));
            return Ok(v);
        }
        let info = plain.await.map_err(|e| AppError::raw(e.to_string()))??;
        if info.content_type.contains("mpegurl") {
            return self.probe_hls_info(u, &headers.with_origin(), &auth).await;
        }
        let mut v = serde_json::to_value(&info).unwrap();
        let o = v.as_object_mut().unwrap();
        o.insert("kind".into(), json!("file"));
        o.insert("category".into(), json!(category_of(&info.filename)));
        Ok(v)
    }

    async fn probe_hls_info(&self, u: &str, headers: &Headers, auth: &Auth) -> Result<Value> {
        let mut info = probe_hls(u, headers, auth).await?;
        if info["live"].as_bool() == Some(true) {
            return Err(AppError::new("err.live"));
        }
        let o = info.as_object_mut().unwrap();
        o.insert("filename".into(), json!(hls_filename(None, u)));
        o.insert("size".into(), json!(-1));
        o.insert("resumable".into(), json!(true));
        o.insert("category".into(), json!("video"));
        Ok(info)
    }

    /// Bilinen sitelerin küçük önizleme görselleri için büyük sürümü dener. Adaylar aynı anda
    /// denenir; sonuç öncelik sırasıyla seçilir. Yalnızca sunucu gerçekten görsel döndürürse kabul edilir.
    async fn upgrade_image(&self, url: &str, headers: &Headers, auth: &Auth) -> Option<(String, ProbeInfo)> {
        if !self.settings().full_size_images {
            return None;
        }
        let tries: Vec<_> = full_size_candidates(url)
            .into_iter()
            .take(4)
            .map(|c| {
                let (h, a) = (headers.clone(), auth.clone());
                tokio::spawn(async move {
                    match probe(&c, &h, &a, Duration::from_secs(8)).await {
                        Ok(info) if info.content_type.starts_with("image/") => Some((c, info)),
                        _ => None,
                    }
                })
            })
            .collect();
        let mut found = None;
        for t in tries {
            if found.is_some() {
                t.abort();
                continue;
            }
            if let Ok(Some(r)) = t.await {
                found = Some(r);
            }
        }
        found
    }

    // ---- ekleme ----

    pub async fn add(self: &Arc<Self>, entries: Vec<NewEntry>) -> Vec<Value> {
        use futures_util::stream::{self, StreamExt};
        // Toplu eklemede sunucuyu yüzlerce eşzamanlı yoklamayla boğmamak için en fazla 6 paralel
        let results: Vec<Value> = stream::iter(entries)
            .map(|e| {
                let me = self.clone();
                async move {
                    let url = e.url.clone();
                    me.add_one(e).await.unwrap_or_else(|err| json!({ "error": err.message(), "url": url }))
                }
            })
            .buffered(PROBE_CONCURRENCY)
            .collect()
            .await;
        self.schedule();
        self.save_soon();
        results
    }

    async fn add_one(self: &Arc<Self>, e: NewEntry) -> Result<Value> {
        let item = Arc::new(Item::new(self.new_download(&e)?));
        self.adding.lock().unwrap().push(item.clone());
        let r = self.prepare_and_register(&item, &e).await;
        self.adding.lock().unwrap().retain(|i| !Arc::ptr_eq(i, &item));
        r
    }

    fn new_download(&self, e: &NewEntry) -> Result<ItemData> {
        let pi = e.probe_info.as_ref();
        // Yoklamada görselin büyük sürümü bulunduysa onu indir
        let src = pi.and_then(|p| p["upgradedUrl"].as_str()).unwrap_or(&e.url);
        let url = normalize_url(src)?;
        let mut headers = Headers {
            referer: e.headers.as_ref().and_then(|h| h.referer.clone()),
            user_agent: e.headers.as_ref().and_then(|h| h.user_agent.clone()),
            origin: None,
        };
        let pk = pi.and_then(|p| p["kind"].as_str());
        let kind = if e.kind.as_deref() == Some("media") || pk == Some("media") || (e.kind.is_none() && is_media_site_url(&url)) {
            "media"
        } else if e.kind.as_deref() == Some("hls") || pk == Some("hls") || is_hls_url(&url) {
            "hls"
        } else {
            "file"
        };
        // HLS akışları oynatıcıda CORS ile çekilir: tarayıcı gibi Origin de gönder
        if kind == "hls" {
            headers = headers.with_origin();
        }
        let s = self.settings();
        let mut d = ItemData::new(uuid::Uuid::new_v4().to_string(), kind, url.clone());
        if kind == "hls" {
            d.variant_url = e.variant_url.as_deref().map(normalize_url).transpose()?;
        }
        if kind == "media" {
            d.quality = Some(
                e.quality.clone().or_else(|| pi.and_then(|p| p["defaultQuality"].as_str().map(str::to_string))).unwrap_or_else(|| s.media_quality.clone()),
            );
        }
        d.connections = e.connections.unwrap_or(s.connections).clamp(1, 32);
        d.speed_limit = e.speed_limit.unwrap_or(0.0).max(0.0) as u64;
        d.headers = headers;
        if e.cookie.as_deref().is_some_and(|c| !c.is_empty()) || e.jar.as_ref().is_some_and(|j| !j.is_empty()) {
            d.auth = Auth { cookie: e.cookie.clone().filter(|c| !c.is_empty()), jar: e.jar.clone(), origin: Some(origin_of(&url)) };
        }
        if let Some(c) = &e.checksum {
            if let Some(exp) = c["expected"].as_str().filter(|x| !x.trim().is_empty()) {
                d.checksum = Some(Checksum {
                    algo: c["algo"].as_str().unwrap_or("sha256").into(),
                    expected: Some(exp.trim().to_lowercase()),
                    ..Default::default()
                });
            }
        }
        d.custom_dir = e.dir.clone().filter(|x| !x.is_empty());
        d.auto_name = e.filename.as_deref().is_none_or(str::is_empty);
        Ok(d)
    }

    async fn prepare_and_register(self: &Arc<Self>, item: &Arc<Item>, e: &NewEntry) -> Result<Value> {
        let kind = item.lock().kind.clone();
        let start_now = e.start_now != Some(false);
        let status = if start_now { "queued" } else { "paused" };
        if kind == "media" {
            // Yoklama yapılmışsa ad başlıktan; yapılmamışsa indirme başlarken öğrenilir
            let info = e.probe_info.as_ref().filter(|p| p.is_object());
            let ext = {
                let mut d = item.lock();
                if let Some(info) = info {
                    d.title = info["title"].as_str().map(str::to_string);
                    d.probed = true;
                    d.use_cookies = info["usedCookies"].as_bool();
                    let q = d.quality.clone().unwrap_or_default();
                    d.size = info["qualities"]
                        .as_array()
                        .and_then(|qs| qs.iter().find(|x| x["id"] == q.as_str()))
                        .and_then(|x| x["size"].as_f64())
                        .map(|s| s as i64)
                        .unwrap_or(-1);
                }
                crate::media::quality_ext(d.quality.as_deref().unwrap_or("1080"))
            };
            static MEDIA_EXT: std::sync::LazyLock<regex::Regex> =
                std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.(mp4|mp3|m4a|webm|mkv)$").unwrap());
            let base = e
                .filename
                .clone()
                .filter(|f| !f.is_empty())
                .or_else(|| info.and_then(|i| i["title"].as_str().map(str::to_string)))
                .unwrap_or_else(|| "video".into());
            let base = MEDIA_EXT.replace(&base, "").into_owned();
            self.assign_path(item, Some(&format!("{base}.{ext}"))).await?;
            item.lock().status = status.into();
            return Ok(self.register(item.clone()));
        }
        if kind == "hls" {
            let url = item.lock().url.clone();
            self.assign_path(item, Some(&hls_filename(e.filename.as_deref(), &url))).await?;
            item.lock().status = status.into();
            return Ok(self.register(item.clone()));
        }
        let mut info: Option<ProbeInfo> = e.probe_info.as_ref().and_then(|p| serde_json::from_value(p.clone()).ok());
        if info.is_none() {
            // Hata olursa başlatılırken tekrar denenir; orada gösterilir
            let (url, h, a) = {
                let d = item.lock();
                (d.url.clone(), d.headers.clone(), d.auth.clone())
            };
            let plain = tokio::spawn({
                let (url, h, a) = (url.clone(), h.clone(), a.clone());
                async move { probe(&url, &h, &a, Duration::from_secs(15)).await.ok() }
            });
            if let Some((up_url, up)) = self.upgrade_image(&url, &h, &a).await {
                plain.abort();
                item.lock().url = up_url;
                info = Some(up);
            } else {
                info = plain.await.ok().flatten();
            }
        }
        if let Some(i) = &info {
            let mut d = item.lock();
            d.final_url = Some(i.final_url.clone());
            d.size = i.size;
            d.resumable = i.resumable;
            d.probed = true;
        }
        let name = e.filename.clone().filter(|f| !f.is_empty()).or(info.map(|i| i.filename));
        self.assign_path(item, name.as_deref()).await?;
        item.lock().status = status.into();
        Ok(self.register(item.clone()))
    }

    fn register(&self, item: Arc<Item>) -> Value {
        let snap = item.snapshot();
        self.items.lock().unwrap().insert(item.id.clone(), item);
        self.changed();
        self.save_now();
        snap
    }

    // ---- dosya yolları ----

    fn dir_for(&self, category: &str, custom: Option<&str>) -> PathBuf {
        if let Some(c) = custom {
            return PathBuf::from(c);
        }
        let s = self.settings();
        let base = PathBuf::from(&s.download_dir);
        // Klasör adları seçili dilde (ör. Music / Müzik / Musik)
        if s.categorize {
            base.join(sanitize_filename(&i18n::t(&format!("cat.{category}"), &Value::Null)))
        } else {
            base
        }
    }

    fn reserved(&self, except: &Item) -> HashSet<String> {
        let mut set = HashSet::new();
        let all: Vec<Arc<Item>> = self.all().into_iter().chain(self.adding.lock().unwrap().iter().cloned()).collect();
        for i in all {
            if std::ptr::eq(i.as_ref(), except) {
                continue;
            }
            let d = i.lock();
            if d.status != "completed" && !d.dir.is_empty() {
                set.insert(d.save_path().to_string_lossy().to_lowercase());
            }
        }
        set
    }

    /// Ad seçimi kilitle sıralanır: eşzamanlı iki ekleme aynı boş adı alamaz.
    pub async fn assign_path(&self, item: &Item, name: Option<&str>) -> Result<()> {
        let _g = self.path_lock.lock().await;
        let (fallback, custom) = {
            let d = item.lock();
            (filename_from_url(d.final_url.as_deref().unwrap_or(&d.url)), d.custom_dir.clone())
        };
        let raw = name.filter(|n| !n.is_empty()).map(str::to_string).or(Some(fallback).filter(|f| !f.is_empty())).unwrap_or_else(|| "indirme".into());
        let filename = sanitize_filename(&raw);
        let category = category_of(&filename);
        let dir = self.dir_for(category, custom.as_deref());
        let full = unique_path(&dir, &filename, &self.reserved(item))?;
        let mut d = item.lock();
        d.category = category.into();
        d.dir = dir.display().to_string();
        d.filename = full.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(filename);
        Ok(())
    }

    /// Bitince kullanılacak yol: o arada aynı adda dosya oluştuysa yeni bir ad.
    pub async fn final_path(&self, item: &Item) -> Result<PathBuf> {
        let _g = self.path_lock.lock().await;
        let (p, dir, name) = {
            let d = item.lock();
            (d.save_path(), PathBuf::from(&d.dir), d.filename.clone())
        };
        if !p.exists() {
            return Ok(p);
        }
        unique_path(&dir, &name, &self.reserved(item))
    }

    // ---- kuyruk ----

    pub fn schedule(self: &Arc<Self>) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let all = self.all();
        let running = all.iter().filter(|i| i.is_running()).count() as i64;
        let mut slots = self.settings().max_concurrent as i64 - running;
        for i in all {
            if slots <= 0 {
                break;
            }
            if i.status() == "queued" && !i.is_running() {
                slots -= 1;
                self.start_item(&i);
            }
        }
    }

    fn start_item(self: &Arc<Self>, item: &Arc<Item>) {
        let mut run = item.run.lock().unwrap();
        if run.is_some() {
            return;
        }
        let cancel = CancellationToken::new();
        let (tx, rx) = watch::channel(false);
        *run = Some(RunHandle { cancel: cancel.clone(), done: rx });
        drop(run);
        let (m, it) = (self.clone(), item.clone());
        let kind = item.lock().kind.clone();
        tokio::spawn(async move {
            match kind.as_str() {
                "hls" => crate::hls::run_hls(m.clone(), it.clone(), cancel).await,
                "media" => crate::media::run_media(m.clone(), it.clone(), cancel).await,
                _ => crate::download::run_file(m.clone(), it.clone(), cancel).await,
            }
            *it.run.lock().unwrap() = None;
            let _ = tx.send(true);
            m.changed();
            m.schedule();
        });
    }

    /// Çalışan indirmeyi durdurur; durum `next` olarak kalır.
    async fn stop(&self, item: &Item, next: &str) {
        let handle = item.run.lock().unwrap().as_ref().map(|h| (h.cancel.clone(), h.done.clone()));
        if let Some((cancel, mut done)) = handle {
            {
                let mut d = item.lock();
                d.status = next.into();
                cancel.cancel();
            }
            let _ = done.wait_for(|v| *v).await;
        } else if item.status() != "completed" {
            item.lock().status = next.into();
        }
        let mut d = item.lock();
        d.rt.speed = 0.0;
        d.rt.eta = None;
        drop(d);
        self.changed();
    }

    /// Kullanıcı açıkça "Başlat" dediğinde kuyruk sınırını beklemeden başlatır.
    pub fn start(self: &Arc<Self>, ids: &[String]) {
        for id in ids {
            if let Some(i) = self.get(id) {
                let st = i.status();
                if !i.is_running() && st != "completed" && st != "verifying" {
                    self.start_item(&i);
                }
            }
        }
    }

    pub async fn pause(self: &Arc<Self>, ids: &[String]) {
        let items: Vec<_> = ids.iter().filter_map(|id| self.get(id)).filter(|i| matches!(i.status().as_str(), "downloading" | "queued" | "error")).collect();
        futures_util::future::join_all(items.iter().map(|i| self.stop(i, "paused"))).await;
        self.schedule();
    }

    pub fn start_all(self: &Arc<Self>) {
        for i in self.all() {
            let mut d = i.lock();
            if matches!(d.status.as_str(), "paused" | "error") {
                d.status = "queued".into();
            }
        }
        self.changed();
        self.schedule();
    }

    pub async fn pause_all(self: &Arc<Self>) {
        let items: Vec<_> = self.all().into_iter().filter(|i| matches!(i.status().as_str(), "downloading" | "queued")).collect();
        futures_util::future::join_all(items.iter().map(|i| self.stop(i, "paused"))).await;
    }

    async fn cleanup_temp(&self, item: &Item) {
        let d = item.lock().clone();
        match d.kind.as_str() {
            "hls" => crate::hls::cleanup_temp(&d.temp_path()).await,
            "media" => crate::media::cleanup_temp(&d).await,
            _ => {
                let _ = tokio::fs::remove_file(d.temp_path()).await;
            }
        }
    }

    pub async fn remove(self: &Arc<Self>, ids: &[String], delete_files: bool) {
        for id in ids {
            let Some(item) = self.get(id) else { continue };
            if item.is_running() {
                self.stop(&item, "paused").await;
            }
            self.items.lock().unwrap().shift_remove(id);
            let (status, path) = {
                let d = item.lock();
                (d.status.clone(), d.save_path())
            };
            if status != "completed" {
                self.cleanup_temp(&item).await;
            } else if delete_files && path.exists() {
                let _ = trash::delete(&path);
            }
        }
        self.changed();
        self.save_now();
        self.schedule();
    }

    pub async fn redownload(self: &Arc<Self>, id: &str) -> Result<()> {
        let item = self.require(id)?;
        if item.is_running() {
            self.stop(&item, "paused").await;
        }
        self.cleanup_temp(&item).await;
        let (was_completed, path, name) = {
            let mut d = item.lock();
            let was = d.status == "completed";
            d.segments.clear();
            d.downloaded = 0;
            d.done_segments = 0;
            d.total_segments = 0;
            d.probed = false;
            d.final_url = None;
            d.clear_error();
            d.completed_at = None;
            if d.kind != "file" {
                d.size = -1;
                d.rt.phases.clear();
            }
            d.checksum = d.checksum.as_ref().filter(|c| c.expected.is_some()).map(|c| Checksum { algo: c.algo.clone(), expected: c.expected.clone(), ..Default::default() });
            (was, d.save_path(), d.filename.clone())
        };
        if was_completed && path.exists() {
            // Eski dosyanın üzerine yazma; yeni bir ad seç
            self.assign_path(&item, Some(&name)).await?;
        }
        item.lock().status = "queued".into();
        self.changed();
        self.schedule();
        Ok(())
    }

    pub async fn update_url(self: &Arc<Self>, id: &str, url: &str) -> Result<()> {
        let item = self.require(id)?;
        if item.is_running() {
            self.stop(&item, "paused").await;
        }
        let u = normalize_url(url)?;
        let mut d = item.lock();
        d.url = u.clone();
        d.final_url = None;
        if d.auth.cookie.is_some() {
            d.auth.origin = Some(origin_of(&u));
        }
        d.clear_error();
        drop(d);
        self.changed();
        Ok(())
    }

    pub fn set_item_speed_limit(&self, id: &str, kbps: u64) -> Result<()> {
        self.require(id)?.set_speed_limit(kbps);
        self.changed();
        Ok(())
    }

    pub async fn compute_hash(self: &Arc<Self>, id: &str, algo: &str) -> Result<Checksum> {
        let item = self.require(id)?;
        crate::download::compute_hash(self, &item, algo).await
    }

    pub fn set_expected_hash(&self, id: &str, algo: &str, expected: &str) -> Result<()> {
        let item = self.require(id)?;
        let mut d = item.lock();
        let mut c = d.checksum.clone().unwrap_or_default();
        c.algo = algo.into();
        c.expected = Some(expected.trim().to_lowercase()).filter(|e| !e.is_empty());
        if let (Some(a), Some(e)) = (&c.actual, &c.expected) {
            c.ok = Some(a == e);
        }
        d.checksum = Some(c);
        drop(d);
        self.changed();
        Ok(())
    }

    pub fn update_settings(self: &Arc<Self>, patch: &Value) -> Settings {
        let s = {
            let mut s = self.settings.write().unwrap();
            s.apply(patch);
            s.clone()
        };
        self.limiter.set_rate(s.speed_limit * 1024);
        self.save_settings();
        self.schedule();
        let _ = self.events.send(Event::Settings(serde_json::to_value(&s).unwrap()));
        s
    }

    // ---- zamanlayıcı & örnekleme ----

    fn on_tick(self: &Arc<Self>) {
        let mut any = false;
        for i in self.all() {
            let mut d = i.lock();
            d.sample();
            any |= d.status == "downloading";
        }
        if any {
            let _ = self.events.send(Event::Changed);
            // Elektrik kesilmesi / çökmede inen kısım kaybolmasın: ilerlemeyi düzenli kaydet
            let now = crate::util::now_ms();
            if now - self.last_progress_save.load(Ordering::SeqCst) >= self.progress_save_ms.load(Ordering::SeqCst) {
                self.last_progress_save.store(now, Ordering::SeqCst);
                self.save_soon();
            }
        }
        let sch = self.settings().schedule.clone();
        if sch.enabled {
            let now = chrono::Local::now();
            let hm = now.format("%H:%M").to_string();
            let key = format!("{} {hm}", now.format("%Y-%m-%d"));
            let mut fired = self.schedule_fired.lock().unwrap();
            if *fired != key {
                if hm == sch.start {
                    *fired = key;
                    drop(fired);
                    self.start_all();
                    let _ = self.events.send(Event::Schedule("start"));
                } else if !sch.stop.is_empty() && hm == sch.stop {
                    *fired = key;
                    drop(fired);
                    let me = self.clone();
                    tokio::spawn(async move { me.pause_all().await });
                    let _ = self.events.send(Event::Schedule("stop"));
                }
            }
        }
    }

    // ---- kalıcılık ----

    fn save_soon(&self) {
        if self.save_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (file, items, lock, pending) = (self.downloads_file(), self.items.clone(), self.save_lock.clone(), self.save_pending.clone());
        // Sık değişikliklerde diske bir kez yazılır: 1,5 sn sonraki güncel liste kaydedilir
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            pending.store(false, Ordering::SeqCst);
            write_list(&file, &items, &lock).await;
        });
    }

    /// Önemli değişiklikler (ekleme, bitiş, hata, kaldırma) beklemeden kaydedilir: çökme ya da elektrik
    /// kesintisinde kaybolmasın.
    fn save_now(&self) {
        let (file, items, lock) = (self.downloads_file(), self.items.clone(), self.save_lock.clone());
        tokio::spawn(async move { write_list(&file, &items, &lock).await });
    }

    pub async fn save(&self) -> Result<()> {
        let _g = self.save_lock.lock().await;
        let list: Vec<Value> = self.all().iter().map(|i| i.to_json()).collect();
        write_json_atomic(&self.downloads_file(), &Value::Array(list)).await
    }

    fn save_settings(&self) {
        let s = serde_json::to_value(&*self.settings()).unwrap();
        let file = self.settings_file();
        tokio::spawn(async move {
            let _ = write_json_atomic(&file, &s).await;
        });
    }

    /// Uygulama kapanırken: çalışanları durdur, açılışta devam edilsin diye "sırada" bırak.
    pub async fn shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let running: Vec<_> = self.all().into_iter().filter(|i| i.is_running()).collect();
        futures_util::future::join_all(running.iter().map(|i| self.stop(i, "queued"))).await;
        let _ = self.save().await;
    }
}

pub fn is_hls_url(url: &str) -> bool {
    url::Url::parse(url).map(|u| u.path().to_lowercase().ends_with(".m3u8")).unwrap_or(false)
}

/// HLS için dosya adı: verilen ad (ör. sayfa başlığı) ya da adresten; video uzantısı yoksa .ts eklenir.
pub fn hls_filename(name: Option<&str>, url: &str) -> String {
    static GENERIC: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^(index|master|playlist|chunklist|manifest|video)(_\w+)?$").unwrap());
    static M3U8: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.m3u8$").unwrap());
    static VIDEO: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.(ts|mp4|mkv|webm)$").unwrap());
    let mut n = name.unwrap_or("").trim().to_string();
    if n.is_empty() {
        n = M3U8.replace(&filename_from_url(url), "").into_owned();
        if n.is_empty() {
            n = "video".into();
        }
    }
    if GENERIC.is_match(&n) {
        let h = crate::util::host_of(url);
        if !h.is_empty() {
            n = format!("{} video", h.trim_start_matches("www."));
        }
    }
    n = M3U8.replace(&n, "").into_owned();
    if !VIDEO.is_match(&n) {
        n.push_str(".ts");
    }
    sanitize_filename(&n)
}

/// Listeyi yazar; yazımlar sırayla yapılır (aynı geçici dosyada çakışmasın).
async fn write_list(file: &Path, items: &Mutex<IndexMap<String, Arc<Item>>>, lock: &tokio::sync::Mutex<()>) {
    let _g = lock.lock().await;
    let list: Vec<Value> = items.lock().unwrap().values().map(|i| i.to_json()).collect();
    let _ = write_json_atomic(file, &Value::Array(list)).await;
}

fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

async fn write_json_atomic(file: &Path, data: &Value) -> Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    tokio::fs::write(&tmp, serde_json::to_vec_pretty(data).unwrap_or_default()).await?;
    tokio::fs::rename(&tmp, file).await?;
    Ok(())
}
