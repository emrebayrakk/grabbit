//! YouTube, Instagram, TikTok vb. sitelerden video indirmesi (yt-dlp ile).
//! Duraklatınca süreç kapatılır; devam edince yt-dlp yarım `.part` dosyalarından sürdürür.

use crate::http::JarCookie;
use crate::item::Item;
use crate::manager::Manager;
use crate::util::{host_of, hidden_command, AppError, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

/// Videoyu tek dosya olarak vermeyen (parçalı/imzalı yayın yapan) siteler: yt-dlp ile çözülür.
/// Eklentideki karşılığı: extension/sites.js → TI_MEDIA_HOSTS (ikisi aynı tutulmalı).
pub const MEDIA_HOSTS: [&str; 30] = [
    "youtube.com", "youtu.be", "youtube-nocookie.com", "instagram.com", "tiktok.com", "twitter.com", "x.com",
    "facebook.com", "fb.watch", "twitch.tv", "vimeo.com", "dailymotion.com", "reddit.com", "redd.it",
    "soundcloud.com", "bilibili.com", "pinterest.com", "linkedin.com", "threads.net", "threads.com", "kick.com",
    "rumble.com", "bandcamp.com", "snapchat.com", "tumblr.com", "vk.com", "ok.ru", "streamable.com", "imgur.com", "9gag.com",
];

static DIRECT_FILE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\.(jpe?g|png|gif|webp|avif|bmp|pnj|svg|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$").unwrap()
});

pub fn is_media_site_url(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("").to_lowercase();
    if !MEDIA_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
        return false;
    }
    // Sitenin kendi dosya sunucusundaki doğrudan dosya (ör. 64.media.tumblr.com/…/foto.pnj) sayfa değildir
    !DIRECT_FILE.is_match(u.path())
}

fn is_youtube(url: &str) -> bool {
    let h = host_of(url);
    ["youtube.com", "youtu.be", "youtube-nocookie.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

const QUALITIES: [&str; 6] = ["2160", "1440", "1080", "720", "480", "360"];
const AUTH_ERRORS: [&str; 5] = ["media.errLogin", "media.errBot", "media.errAge", "media.errMembers", "media.errPrivate"];

/// yt-dlp hatasını anlaşılır bir AppError'a çevirir (dil anahtarıyla).
pub fn media_error(raw: &str, fatal: bool) -> AppError {
    static PREFIX: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^ERROR:\s*").unwrap());
    static SITE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^\[[^\]]+\]\s*[\w-]+:\s*").unwrap());
    let s = PREFIX.replace(raw.trim(), "");
    let s = SITE.replace(&s, "").trim().to_string();
    let l = s.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    let key = if has(&["needs to be reloaded"]) {
        Some("media.errSession")
    } else if has(&["drm"]) {
        Some("media.errDrm")
    } else if has(&["sign in to confirm", "not a bot"]) {
        Some("media.errBot")
    } else if has(&["private video", "this video is private"]) {
        Some("media.errPrivate")
    } else if has(&["login", "log in", "cookies", "authentication", "rate-limit reached"]) {
        Some("media.errLogin")
    } else if has(&["members-only", "members only", "join this channel"]) {
        Some("media.errMembers")
    } else if has(&["age-restrict", "age restrict", "confirm your age", "inappropriate"]) {
        Some("media.errAge")
    } else if has(&["unavailable", "not available", "removed", "deleted", "does not exist", "404"]) {
        Some("media.errGone")
    } else if has(&["live event will begin", "is live", "live stream"]) {
        Some("err.live")
    } else if has(&["unsupported url"]) {
        Some("media.errUnsupported")
    } else if has(&["requested format is not available"]) {
        Some("media.errFormat")
    } else if has(&["unable to download", "timed out", "connection", "network", "getaddrinfo"]) {
        Some("err.network")
    } else {
        None
    };
    match key {
        Some(k) => {
            // Tekrar denemekle düzelmeyecek durumlar
            let permanent = ["media.errDrm", "media.errPrivate", "media.errGone", "media.errUnsupported", "media.errMembers"].contains(&k);
            AppError { fatal: fatal || permanent, ..AppError::new(k) }
        }
        None => {
            let detail: String = s.lines().next().unwrap_or("").chars().take(300).collect();
            let detail = if detail.is_empty() { "yt-dlp".to_string() } else { detail };
            AppError { fatal, ..AppError::with("media.errGeneric", json!({ "detail": detail })) }
        }
    }
}

/// Tarayıcıdan gelen çerezleri yt-dlp'nin okuduğu Netscape biçiminde geçici dosyaya yazar.
/// `jar` varsa alan adı, yol, Secure ve süre aynen korunur; yoksa "ad=değer" dizesinden makul bir dosya üretilir.
pub async fn write_cookie_file(cookie: Option<&str>, url: &str, jar: Option<&[JarCookie]>) -> Option<PathBuf> {
    let mut lines = vec![];
    if let Some(jar) = jar.filter(|j| !j.is_empty()) {
        for c in jar.iter().filter(|c| !c.name.is_empty() && !c.domain.is_empty()) {
            // Yalnızca o alan adına ait çerez: başında nokta yok, alt alan adları FALSE
            let domain = if c.host_only {
                c.domain.trim_start_matches('.').to_string()
            } else if c.domain.starts_with('.') {
                c.domain.clone()
            } else {
                format!(".{}", c.domain)
            };
            let expiry = if c.session || c.expiration_date <= 0.0 { 0 } else { c.expiration_date.floor() as i64 };
            lines.push(format!(
                "{domain}\t{}\t{}\t{}\t{expiry}\t{}\t{}",
                if c.host_only { "FALSE" } else { "TRUE" },
                if c.path.is_empty() { "/" } else { &c.path },
                if c.secure { "TRUE" } else { "FALSE" },
                c.name,
                c.value
            ));
        }
    } else if let Some(cookie) = cookie.filter(|c| !c.is_empty()) {
        let host = host_of(url);
        if host.is_empty() {
            return None;
        }
        // Ayrıntı bilinmiyor: çerezler sitenin tamamı için geçerli sayılır (www.instagram.com → .instagram.com)
        let parts: Vec<&str> = host.split('.').collect();
        let domain = format!(".{}", parts[parts.len().saturating_sub(2)..].join("."));
        for part in cookie.split(';').map(str::trim) {
            if let Some(i) = part.find('=').filter(|i| *i > 0) {
                lines.push(format!("{domain}\tTRUE\t/\tTRUE\t2147483647\t{}\t{}", part[..i].trim(), part[i + 1..].trim()));
            }
        }
    }
    if lines.is_empty() {
        return None;
    }
    let file = std::env::temp_dir().join(format!("grabbit-cookies-{}.txt", uuid::Uuid::new_v4()));
    let body = format!("# Netscape HTTP Cookie File\n{}\n", lines.join("\n"));
    tokio::fs::write(&file, body).await.ok()?;
    Some(file)
}

fn common_args(cookie_file: Option<&Path>, referer: Option<&str>, user_agent: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["--no-playlist", "--no-colors", "--no-warnings", "--encoding", "utf-8"].map(String::from).to_vec();
    if let Some(c) = cookie_file {
        a.push("--cookies".into());
        a.push(c.display().to_string());
    }
    if let Some(r) = referer {
        a.push("--referer".into());
        a.push(r.into());
    }
    if let Some(u) = user_agent {
        a.push("--user-agent".into());
        a.push(u.into());
    }
    a
}

async fn run(m: &Manager, args: &[String], timeout: Duration) -> Result<String> {
    let cmd = m.tools.ytdlp_command();
    let child = hidden_command(&cmd.program)
        .args(&cmd.args)
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::with("media.errSpawn", json!({ "detail": e.to_string() })))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| AppError::new("err.slowServer"))?
        .map_err(|e| AppError::with("media.errSpawn", json!({ "detail": e.to_string() })))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| l.starts_with("ERROR")).unwrap_or(err.trim());
        return Err(media_error(line, false));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Çerezlerin hangi sırayla deneneceği. YouTube herkese açık videolarda çerez istemez ve tarayıcıdan
/// alınan oturum çerezlerini sık sık reddeder ("sayfayı yenileyin"): orada önce çerezsiz denenir.
fn cookie_attempts(url: &str, has_cookies: bool) -> Vec<bool> {
    if !has_cookies {
        vec![false]
    } else if is_youtube(url) {
        vec![false, true]
    } else {
        vec![true, false]
    }
}

// Yoklamada yt-dlp'nin verdiği tam bilgi. İndirme başlarken --load-info-json ile geri verilir:
// sayfa ikinci kez çözülmez (YouTube'da ~2-3 sn kazanç). Adresler zamanla geçersizleşir.
const INFO_TTL: Duration = Duration::from_secs(20 * 60);
const INFO_MAX: usize = 8;
static INFO_CACHE: LazyLock<Mutex<Vec<(String, String, Instant, bool)>>> = LazyLock::new(Default::default);

fn remember_info(url: &str, json: String, used_cookies: bool) {
    let mut c = INFO_CACHE.lock().unwrap();
    c.retain(|e| e.0 != url);
    c.push((url.to_string(), json, Instant::now(), used_cookies));
    while c.len() > INFO_MAX {
        c.remove(0);
    }
}

fn cached_info(url: &str) -> Option<(String, bool)> {
    let mut c = INFO_CACHE.lock().unwrap();
    c.retain(|e| e.2.elapsed() < INFO_TTL);
    c.iter().find(|e| e.0 == url).map(|e| (e.1.clone(), e.3))
}

fn forget_info(url: &str) {
    INFO_CACHE.lock().unwrap().retain(|e| e.0 != url);
}

/// Sayfadaki videonun başlığını, süresini ve indirilebilir kalitelerini öğrenir.
pub async fn probe_media(
    m: &Manager,
    url: &str,
    cookie: Option<&str>,
    jar: Option<&[JarCookie]>,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Value> {
    if !m.tools.ready() {
        return Err(AppError::new("err.engineMissing"));
    }
    let has = cookie.is_some_and(|c| !c.is_empty()) || jar.is_some_and(|j| !j.is_empty());
    let attempts = cookie_attempts(url, has);
    let mut first_error: Option<AppError> = None;
    for (i, &with_cookies) in attempts.iter().enumerate() {
        let cookie_file = if with_cookies { write_cookie_file(cookie, url, jar).await } else { None };
        let mut args = vec!["-J".to_string()];
        args.extend(common_args(cookie_file.as_deref(), referer, user_agent));
        args.push(url.to_string());
        let res = run(m, &args, Duration::from_secs(90)).await;
        if let Some(f) = &cookie_file {
            // Oturum çerezleri diskte beklemesin
            let _ = tokio::fs::remove_file(f).await;
        }
        let err = match res {
            Ok(out) => match serde_json::from_str::<Value>(&out) {
                Ok(info) => {
                    let mut result = if info["_type"] == "playlist" && info.get("formats").is_none() {
                        let Some(first) = info["entries"].as_array().and_then(|e| e.iter().find(|x| !x.is_null())) else {
                            return Err(AppError::new("media.errNoVideo"));
                        };
                        if first.get("formats").is_some() {
                            remember_info(url, first.to_string(), with_cookies);
                        }
                        summarize(first, url)
                    } else {
                        remember_info(url, out, with_cookies);
                        summarize(&info, url)
                    };
                    result["usedCookies"] = json!(with_cookies);
                    return Ok(result);
                }
                Err(e) => AppError::with("media.errGeneric", json!({ "detail": e.to_string() })),
            },
            Err(e) => e,
        };
        let last = i == attempts.len() - 1;
        // Çerezli deneme başarısızsa çerezsiz dene; çerezsiz deneme yalnızca giriş gerekiyorsa çerezle tekrarlanır
        let retry = !last && (with_cookies || AUTH_ERRORS.contains(&err.key.as_str()));
        if first_error.is_none() {
            first_error = Some(err.clone());
        }
        if !retry {
            return Err(if last && err.key == "media.errGeneric" { first_error.unwrap() } else { err });
        }
    }
    Err(first_error.unwrap_or_else(|| AppError::new("media.errNoVideo")))
}

fn summarize(info: &Value, url: &str) -> Value {
    let empty = vec![];
    let formats = info["formats"].as_array().unwrap_or(&empty);
    let codec = |f: &Value, k: &str| f[k].as_str().unwrap_or("").to_string();
    let size = |f: &Value| f["filesize"].as_f64().or_else(|| f["filesize_approx"].as_f64()).unwrap_or(0.0);
    let audio: Vec<&Value> = formats.iter().filter(|f| codec(f, "vcodec") == "none" && !codec(f, "acodec").is_empty() && codec(f, "acodec") != "none").collect();
    let best_audio = audio.iter().map(|f| size(f)).fold(0.0, f64::max);
    // Kalite kovası: yt-dlp'nin "res" ölçüsü gibi kısa kenar (dikey 1080x1920 de "1080p")
    let video: Vec<&Value> = formats
        .iter()
        .filter(|f| !codec(f, "vcodec").is_empty() && codec(f, "vcodec") != "none" && (f["height"].is_number() || f["width"].is_number()))
        .collect();
    let bucket = |f: &Value| -> Option<&'static str> {
        let (w, h) = (f["width"].as_f64(), f["height"].as_f64());
        let p = match (w, h) {
            (Some(w), Some(h)) => w.min(h),
            (_, Some(h)) => h,
            (Some(w), _) => w,
            _ => return None,
        };
        QUALITIES.into_iter().find(|q| p >= q.parse::<f64>().unwrap() * 0.95)
    };
    let mut qualities = vec![];
    for q in QUALITIES {
        let mut in_bucket: Vec<&&Value> = video.iter().filter(|f| bucket(f) == Some(q)).collect();
        if in_bucket.is_empty() {
            continue;
        }
        in_bucket.sort_by(|a, b| size(b).partial_cmp(&size(a)).unwrap_or(std::cmp::Ordering::Equal));
        let best = in_bucket[0];
        let v = size(best);
        let merged = if codec(best, "acodec").is_empty() || codec(best, "acodec") == "none" { v + best_audio } else { v };
        qualities.push(json!({ "id": q, "label": format!("{q}p"), "size": if merged > 0.0 { json!(merged) } else { Value::Null } }));
    }
    let has_video = !video.is_empty() || formats.iter().any(|f| !codec(f, "vcodec").is_empty() && codec(f, "vcodec") != "none");
    if qualities.is_empty() && has_video {
        qualities.push(json!({ "id": "best", "label": "best", "size": info["filesize_approx"] }));
    }
    if !audio.is_empty() || !has_video {
        qualities.push(json!({ "id": "audio", "label": "audio", "size": if best_audio > 0.0 { json!(best_audio) } else { Value::Null } }));
    }
    let s = |k: &str| info[k].as_str().map(str::to_string);
    json!({
        "kind": "media",
        "url": s("webpage_url").unwrap_or_else(|| url.to_string()),
        "title": s("title").or_else(|| s("id")).unwrap_or_else(|| "video".into()),
        "site": s("extractor_key").or_else(|| s("extractor")).unwrap_or_default(),
        "uploader": s("uploader").or_else(|| s("channel")).unwrap_or_default(),
        "duration": info["duration"],
        "thumbnail": info["thumbnail"],
        "qualities": qualities,
        "isLive": info["is_live"].as_bool().unwrap_or(false),
    })
}

/// Kalite seçimine göre (uzantı, yt-dlp biçim argümanları).
pub fn format_args(quality: &str) -> (&'static str, Vec<String>) {
    if quality == "audio" {
        return ("mp3", ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"].map(String::from).to_vec());
    }
    // Çözünürlük önce gelir (en yüksek ≤ seçilen); eşitlikte uyumlu H.264/MP4 tercih edilir
    let sort = if quality == "best" { "res,vcodec:h264,ext:mp4:m4a".to_string() } else { format!("res:{quality},vcodec:h264,ext:mp4:m4a") };
    ("mp4", vec!["-f".into(), "bv*+ba/b".into(), "-S".into(), sort, "--merge-output-format".into(), "mp4".into()])
}

/// Windows'ta yt-dlp ve başlattığı ffmpeg'i birlikte sonlandırır.
fn kill_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = crate::util::hidden_std_command("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn base_path(d: &crate::item::ItemData) -> PathBuf {
    let stem = match d.filename.rfind('.') {
        Some(i) if i > 0 => &d.filename[..i],
        _ => &d.filename,
    };
    PathBuf::from(&d.dir).join(stem)
}

/// Video indirmesinin yarım kalan dosyaları (.part, .ytdl, ara akışlar).
pub async fn cleanup_temp(d: &crate::item::ItemData) {
    if d.dir.is_empty() {
        return;
    }
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\.(part|ytdl|temp\.\w+|f\d+[\w-]*\.\w+)$|\.part-Frag\d+").unwrap());
    let base = base_path(d).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let Ok(mut rd) = tokio::fs::read_dir(&d.dir).await else { return };
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with(&format!("{base}.")) && RE.is_match(&name) {
            let _ = tokio::fs::remove_file(e.path()).await;
        }
    }
}

pub async fn run_media(m: Arc<Manager>, item: Arc<Item>, cancel: CancellationToken) {
    {
        let mut d = item.lock();
        // Başlamadan durdurulduysa durumu ezme (durdurma, durumu ve iptali aynı kilit altında yapar)
        if cancel.is_cancelled() {
            return;
        }
        d.status = "downloading".into();
        d.clear_error();
        d.rt.phase = Some("phase.preparing".into());
        d.rt.history.clear();
    }
    m.changed();
    let res = run_inner(&m, &item, &cancel).await;
    {
        let mut d = item.lock();
        d.rt.active = 0;
        d.rt.speed = 0.0;
        d.rt.eta = None;
        if d.status != "downloading" {
            d.rt.phase = None;
        }
    }
    if let Err(err) = res {
        if !(cancel.is_cancelled() && !err.fatal) {
            let mut d = item.lock();
            d.set_error(&err);
            d.rt.phase = None;
            drop(d);
            m.emit_failed(&item);
        }
    }
    m.changed();
}

async fn run_inner(m: &Arc<Manager>, item: &Arc<Item>, cancel: &CancellationToken) -> Result<()> {
    if !m.tools.ready() {
        return Err(AppError::fatal("err.engineMissingSettings"));
    }
    let (url, auth, headers, probed) = {
        let d = item.lock();
        (d.url.clone(), d.auth.clone(), d.headers.clone(), d.probed)
    };
    if !probed {
        let info = probe_media(m, &url, auth.cookie.as_deref(), auth.jar.as_deref(), headers.referer.as_deref(), headers.user_agent.as_deref());
        let Some(info) = crate::download::or_cancel(cancel, info).await else { return Ok(()) };
        let info = info?;
        if info["isLive"].as_bool() == Some(true) {
            return Err(AppError::fatal("err.live"));
        }
        let title = info["title"].as_str().unwrap_or("video").to_string();
        let auto = {
            let mut d = item.lock();
            d.use_cookies = info["usedCookies"].as_bool();
            d.title = Some(title.clone());
            d.probed = true;
            let q = d.quality.clone().unwrap_or_else(|| "1080".into());
            if let Some(s) = info["qualities"].as_array().and_then(|qs| qs.iter().find(|x| x["id"] == q.as_str())).and_then(|x| x["size"].as_f64()) {
                d.size = s as i64;
            }
            d.auto_name
        };
        if auto {
            let ext = format_args(&item.lock().quality.clone().unwrap_or_default()).0;
            m.assign_path(item, Some(&format!("{title}.{ext}"))).await?;
        }
        m.changed();
    }
    if cancel.is_cancelled() {
        return Ok(());
    }
    let (dir, quality, size, use_cookies, id, connections, speed_limit) = {
        let mut d = item.lock();
        d.rt.estimate = d.size.max(0) as u64;
        d.rt.phases.clear();
        (d.dir.clone(), d.quality.clone().unwrap_or_else(|| "1080".into()), d.size, d.use_cookies, d.id.clone(), d.connections, d.speed_limit)
    };
    let _ = size;
    tokio::fs::create_dir_all(&dir).await?;
    // Yoklamada çerezsiz çalıştıysa indirmede de çerez gönderme (YouTube oturum hatasını önler)
    let cookie_file = if use_cookies == Some(false) { None } else { write_cookie_file(auth.cookie.as_deref(), &url, auth.jar.as_deref()).await };
    let print_file = std::env::temp_dir().join(format!("grabbit-path-{id}.txt"));
    let _ = tokio::fs::remove_file(&print_file).await;
    let mut info_file: Option<PathBuf> = None;

    let res: Result<()> = async {
        let (_, fmt) = format_args(&quality);
        // Çıktı şablonunda % özel karakterdir
        let out = format!("{}.%(ext)s", base_path(&item.lock()).display().to_string().replace('%', "%%"));
        let limit = [speed_limit, m.settings().speed_limit].into_iter().filter(|v| *v > 0).min();
        let ffmpeg_dir = m.tools.ffmpeg_dir();
        let mut args = common_args(cookie_file.as_deref(), headers.referer.as_deref(), headers.user_agent.as_deref());
        args.extend(fmt);
        args.extend([
            "-o".into(),
            out,
            "--newline".into(),
            "--continue".into(),
            "--no-mtime".into(),
            "--ffmpeg-location".into(),
            ffmpeg_dir.display().to_string(),
            "-N".into(),
            connections.clamp(1, 16).to_string(),
            "--progress-template".into(),
            "download:TIPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s".into(),
            "--print-to-file".into(),
            "after_move:%(filepath)s".into(),
            print_file.display().to_string(),
        ]);
        if let Some(l) = limit {
            args.push("-r".into());
            args.push(format!("{l}K"));
        }
        // Yeni yoklandıysa sayfayı yeniden çözme; kayıtlı bilgi işe yaramazsa (süresi dolmuş adres) adresle dene
        match cached_info(&url).filter(|(_, used)| *used == cookie_file.is_some()) {
            Some((json, _)) => {
                let f = std::env::temp_dir().join(format!("grabbit-info-{id}.json"));
                tokio::fs::write(&f, json).await?;
                info_file = Some(f.clone());
                let mut a = args.clone();
                a.extend(["--load-info-json".into(), f.display().to_string()]);
                if let Err(e) = spawn(m, item, &a, cancel).await {
                    if cancel.is_cancelled() {
                        return Err(e);
                    }
                    forget_info(&url);
                    let mut a = args;
                    a.push(url.clone());
                    spawn(m, item, &a, cancel).await?;
                }
            }
            None => {
                let mut a = args;
                a.push(url.clone());
                spawn(m, item, &a, cancel).await?;
            }
        }
        if cancel.is_cancelled() {
            return Ok(());
        }
        let printed = tokio::fs::read_to_string(&print_file).await.unwrap_or_default();
        let final_path = printed.trim().lines().last().map(PathBuf::from).filter(|p| p.exists()).ok_or_else(|| AppError::new("media.errNoOutput"))?;
        let len = tokio::fs::metadata(&final_path).await?.len();
        {
            let mut d = item.lock();
            d.dir = final_path.parent().map(|p| p.display().to_string()).unwrap_or_default();
            d.filename = final_path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            d.size = len as i64;
            d.downloaded = len;
            d.rt.phase = None;
            d.status = "completed".into();
            d.completed_at = Some(crate::util::now_ms());
        }
        m.emit_completed(item);
        Ok(())
    }
    .await;
    for f in [cookie_file, Some(print_file), info_file].into_iter().flatten() {
        let _ = tokio::fs::remove_file(f).await;
    }
    res
}

async fn spawn(m: &Manager, item: &Item, args: &[String], cancel: &CancellationToken) -> Result<()> {
    let cmd = m.tools.ytdlp_command();
    let mut child = hidden_command(&cmd.program)
        .args(&cmd.args)
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::with("media.errSpawn", json!({ "detail": e.to_string() })))?;
    item.lock().rt.active = 1;
    let pid = child.id();
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut last_error = String::new();
    let mut out_done = false;
    let mut err_done = false;
    let status = loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                kill_tree(pid);
                let _ = child.kill().await;
                item.lock().rt.active = 0;
                return Ok(());
            }
            line = out.next_line(), if !out_done => match line {
                Ok(Some(l)) => on_line(m, item, l.trim()),
                _ => out_done = true,
            },
            line = err.next_line(), if !err_done => match line {
                Ok(Some(l)) => if l.to_uppercase().starts_with("ERROR:") { last_error = l },
                _ => err_done = true,
            },
            st = child.wait(), if out_done && err_done => break st,
        }
    };
    item.lock().rt.active = 0;
    let status = status.map_err(|e| AppError::with("media.errSpawn", json!({ "detail": e.to_string() })))?;
    if status.success() {
        Ok(())
    } else {
        let msg = if last_error.is_empty() { format!("yt-dlp exited with code {}", status.code().unwrap_or(-1)) } else { last_error };
        Err(media_error(&msg, false))
    }
}

fn on_line(m: &Manager, item: &Item, line: &str) {
    if let Some(rest) = line.strip_prefix("TIPROG ") {
        let p: Vec<&str> = rest.split(' ').collect();
        let n = |i: usize| p.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) as u64;
        let (done, total, est) = (n(0), n(1), n(2));
        let fid = p.get(3).copied().unwrap_or("?").to_string();
        let changed_phase = {
            let mut d = item.lock();
            // Görüntü ve ses ayrı akışlar: her birinin ilerlemesi ayrı tutulur, toplam gösterilir
            d.rt.phases.insert(fid, (done, if total > 0 { total } else { est }));
            let (mut sd, mut st) = (0, 0);
            for (pd, pt) in d.rt.phases.values() {
                sd += pd;
                st += (*pt).max(*pd);
            }
            d.downloaded = sd;
            if st > 0 {
                d.size = st.max(d.rt.estimate) as i64;
            }
            let changed = d.rt.phase.as_deref() != Some("phase.downloading");
            d.rt.phase = Some("phase.downloading".into());
            changed
        };
        if changed_phase {
            m.changed();
        }
        return;
    }
    let phase = if line.starts_with("[Merger]") {
        Some("phase.merging")
    } else if line.starts_with("[ExtractAudio]") {
        Some("phase.extracting")
    } else if line.starts_with("[FixupM3u8]") || line.starts_with("[VideoConvertor]") || line.starts_with("[FixupM4a]") {
        Some("phase.fixing")
    } else {
        None
    };
    if let Some(p) = phase {
        let mut d = item.lock();
        if d.rt.phase.as_deref() != Some(p) {
            d.rt.phase = Some(p.into());
            drop(d);
            m.changed();
        }
    }
}

/// yt-dlp'nin kalite argümanlarını eklenti/test tarafı için de açar.
pub fn quality_ext(quality: &str) -> &'static str {
    format_args(quality).0
}

pub type InfoMap = HashMap<String, Value>;
