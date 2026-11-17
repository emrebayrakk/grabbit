//! HLS (m3u8) akışları: kalite seçimi, AES-128 çözme, ayrı ses akışını indirip görüntüyle birleştirme.
//! Parçalar `<dosya>.tipart.d` klasörüne yazılır; bitince sırayla birleştirilir (devam desteklenir).

use crate::download::{or_cancel, rename_with_retry, sleep_or_cancel, throttle, STALL};
use crate::http::{request, Auth, Headers};
use crate::item::Item;
use crate::manager::Manager;
use crate::util::{AppError, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    pub url: String,
    pub bandwidth: u64,
    pub resolution: String,
    pub height: u32,
    pub codecs: String,
    #[serde(skip)]
    pub audio: String,
}

#[derive(Debug, Clone)]
pub struct Rendition {
    pub group: String,
    pub url: String,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub struct Key {
    pub method: String,
    pub uri: Option<String>,
    pub iv: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Part {
    pub url: String,
    pub seq: u64,
    pub key: Option<Key>,
    pub file: String,
}

pub enum Playlist {
    Master { variants: Vec<Variant>, audio: Vec<Rendition> },
    Media { segments: Vec<Part>, map: Option<String>, end_list: bool, duration: f64 },
}

fn parse_attrs(s: &str) -> HashMap<String, String> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#"([A-Z0-9-]+)=("[^"]*"|[^,]*)"#).unwrap());
    RE.captures_iter(s).map(|c| (c[1].to_string(), c[2].trim_matches('"').to_string())).collect()
}

/// M3U8 çalma listesini çözer: ana liste (kaliteler) ya da medya listesi (parçalar).
pub fn parse_playlist(text: &str, base: &str) -> Result<Playlist> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if !lines.first().is_some_and(|l| l.starts_with("#EXTM3U")) {
        return Err(AppError::fatal("err.notPlaylist"));
    }
    let base_url = url::Url::parse(base).map_err(|_| AppError::fatal("err.notPlaylist"))?;
    let abs = |u: &str| base_url.join(u).map(|x| x.to_string()).unwrap_or_else(|_| u.to_string());

    if lines.iter().any(|l| l.starts_with("#EXT-X-STREAM-INF")) {
        let audio = lines
            .iter()
            .filter(|l| l.starts_with("#EXT-X-MEDIA:"))
            .map(|l| parse_attrs(&l[13..]))
            .filter(|a| a.get("TYPE").is_some_and(|t| t == "AUDIO") && a.contains_key("URI"))
            .map(|a| Rendition {
                group: a.get("GROUP-ID").cloned().unwrap_or_default(),
                url: abs(&a["URI"]),
                is_default: a.get("DEFAULT").is_some_and(|d| d == "YES"),
            })
            .collect();
        let mut variants = vec![];
        for (i, l) in lines.iter().enumerate() {
            if !l.starts_with("#EXT-X-STREAM-INF") {
                continue;
            }
            let a = parse_attrs(&l[l.find(':').map(|p| p + 1).unwrap_or(l.len())..]);
            let Some(uri) = lines[i + 1..].iter().find(|x| !x.starts_with('#')) else { continue };
            let resolution = a.get("RESOLUTION").cloned().unwrap_or_default();
            variants.push(Variant {
                url: abs(uri),
                bandwidth: a.get("BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0),
                height: resolution.split('x').nth(1).and_then(|h| h.parse().ok()).unwrap_or(0),
                resolution,
                codecs: a.get("CODECS").cloned().unwrap_or_default(),
                audio: a.get("AUDIO").cloned().unwrap_or_default(),
            });
        }
        variants.sort_by(|x, y| y.height.cmp(&x.height).then(y.bandwidth.cmp(&x.bandwidth)));
        return Ok(Playlist::Master { variants, audio });
    }

    let mut segments = vec![];
    let mut key: Option<Key> = None;
    let mut map = None;
    let mut seq = 0u64;
    let mut duration = 0.0;
    let mut pending = 0.0;
    let mut end_list = false;
    for l in &lines {
        if let Some(v) = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            seq = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = l.strip_prefix("#EXT-X-KEY:") {
            let a = parse_attrs(v);
            key = match a.get("METHOD").map(String::as_str) {
                Some("NONE") | None => None,
                Some(m) => Some(Key { method: m.into(), uri: a.get("URI").map(|u| abs(u)), iv: a.get("IV").cloned() }),
            };
        } else if let Some(v) = l.strip_prefix("#EXT-X-MAP:") {
            if let Some(u) = parse_attrs(v).get("URI") {
                map = Some(abs(u));
            }
        } else if let Some(v) = l.strip_prefix("#EXTINF:") {
            pending = v.split(',').next().and_then(|d| d.trim().parse().ok()).unwrap_or(0.0);
        } else if l.starts_with("#EXT-X-ENDLIST") {
            end_list = true;
        } else if !l.starts_with('#') {
            segments.push(Part { url: abs(l), seq: seq + segments.len() as u64, key: key.clone(), file: String::new() });
            duration += pending;
            pending = 0.0;
        }
    }
    Ok(Playlist::Media { segments, map, end_list, duration })
}

/// Görüntü kalitesinin ses grubundan çalınacak sesi seçer: oynatıcının varsayılanı, yoksa ilki.
pub fn pick_audio(audio: &[Rendition], variant: &Variant) -> Option<String> {
    if variant.audio.is_empty() {
        return None;
    }
    let group: Vec<_> = audio.iter().filter(|r| r.group == variant.audio).collect();
    group.iter().find(|r| r.is_default).or(group.first()).map(|r| r.url.clone())
}

async fn fetch_text(url: &str, headers: &Headers, auth: &Auth) -> Result<(String, String)> {
    let (res, final_url) = request(url, headers, auth, None).await?;
    if !res.status().is_success() {
        return Err(AppError::http(res.status().as_u16()));
    }
    Ok((res.text().await?, final_url))
}

/// Bir HLS adresinin ana mı medya listesi mi olduğunu, kalitelerini ve süresini döner.
pub async fn probe_hls(url: &str, headers: &Headers, auth: &Auth) -> Result<serde_json::Value> {
    let (text, final_url) = tokio::time::timeout(Duration::from_secs(20), fetch_text(url, headers, auth))
        .await
        .map_err(|_| AppError::new("err.slowServer"))??;
    Ok(match parse_playlist(&text, &final_url)? {
        Playlist::Master { variants, .. } => json!({ "kind": "hls", "type": "master", "variants": variants, "finalUrl": final_url }),
        Playlist::Media { segments, end_list, duration, .. } => json!({
            "kind": "hls", "type": "media", "variants": [], "finalUrl": final_url, "duration": duration,
            "segments": segments.len(), "live": !end_list, "encrypted": segments.iter().any(|s| s.key.is_some())
        }),
    })
}

fn part_dir(temp: &Path) -> PathBuf {
    PathBuf::from(format!("{}.d", temp.display()))
}

pub async fn cleanup_temp(temp: &Path) {
    let _ = tokio::fs::remove_dir_all(part_dir(temp)).await;
    let _ = tokio::fs::remove_file(temp).await;
}

pub async fn run_hls(m: Arc<Manager>, item: Arc<Item>, cancel: CancellationToken) {
    {
        let mut d = item.lock();
        // Başlamadan durdurulduysa durumu ezme (durdurma, durumu ve iptali aynı kilit altında yapar)
        if cancel.is_cancelled() {
            return;
        }
        d.status = "downloading".into();
        d.clear_error();
        d.rt.history.clear();
        d.rt.active = 0;
    }
    m.changed();
    let res = run_inner(&m, &item, &cancel).await;
    {
        let mut d = item.lock();
        d.rt.active = 0;
        d.rt.speed = 0.0;
        d.rt.eta = None;
    }
    if let Err(err) = res {
        if !(cancel.is_cancelled() && !err.fatal) {
            item.lock().set_error(&err);
            m.emit_failed(&item);
        }
    }
    m.changed();
}

async fn run_inner(m: &Arc<Manager>, item: &Arc<Item>, cancel: &CancellationToken) -> Result<()> {
    let (url, headers, auth, variant_url) = {
        let d = item.lock();
        (d.url.clone(), d.headers.clone(), d.auth.clone(), d.variant_url.clone())
    };
    let first = match fetch_text(&url, &headers, &auth).await {
        Ok(v) => v,
        // Ana liste artık açılmıyorsa (süresi dolmuş imza) önceden seçilen kaliteyle sürdür
        Err(e) => match &variant_url {
            Some(v) if !cancel.is_cancelled() => fetch_text(v, &headers, &auth).await?,
            _ => return Err(e),
        },
    };
    let mut pl = parse_playlist(&first.0, &first.1)?;
    if let Playlist::Master { variants, audio } = &pl {
        if variants.is_empty() {
            return Err(AppError::fatal("err.noVariants"));
        }
        // Seçilen kalite (yoksa en yüksek) ve onun ses grubundaki ses
        let variant = variants.iter().find(|v| Some(&v.url) == variant_url.as_ref()).unwrap_or(&variants[0]).clone();
        let audio_url = pick_audio(audio, &variant);
        {
            let mut d = item.lock();
            d.variant_url = Some(variant.url.clone());
            d.audio_url = audio_url;
        }
        let (t, f) = fetch_text(&variant.url, &headers, &auth).await?;
        pl = parse_playlist(&t, &f)?;
    }
    let Playlist::Media { segments, map, end_list, .. } = pl else { return Err(AppError::fatal("err.noVariants")) };

    let audio_url = item.lock().audio_url.clone();
    let mut audio = None;
    if let Some(a) = audio_url {
        let (t, f) = fetch_text(&a, &headers, &auth).await?;
        if let Playlist::Media { segments, map, .. } = parse_playlist(&t, &f)? {
            if !segments.is_empty() {
                audio = Some((segments, map));
            }
        }
    }
    let mux = if audio.is_some() { m.tools.ffmpeg_command() } else { None };
    if audio.is_some() && mux.is_none() {
        return Err(AppError::fatal("err.audioNeedsEngine"));
    }
    if !end_list {
        return Err(AppError::fatal("err.live"));
    }
    let all_keys = segments.iter().chain(audio.iter().flat_map(|(s, _)| s.iter())).filter_map(|s| s.key.as_ref());
    if all_keys.clone().any(|k| k.method != "AES-128") {
        return Err(AppError::fatal_with("media.errDrm", json!({})));
    }
    if segments.is_empty() {
        return Err(AppError::fatal("err.noSegments"));
    }
    {
        let mut d = item.lock();
        d.probed = true;
    }
    // fMP4 parçalar ya da görüntüyle birleştirilen ses: çıktı MP4'tür
    let rename = {
        let d = item.lock();
        (map.is_some() || audio.is_some()) && d.filename.to_lowercase().ends_with(".ts")
    };
    if rename {
        let name = {
            let d = item.lock();
            format!("{}.mp4", &d.filename[..d.filename.len() - 3])
        };
        m.assign_path(item, Some(&name)).await?;
    }

    // Görüntü parçaları "N.seg", ses parçaları "aN.seg"
    let track = |list: &[Part], map: &Option<String>, prefix: &str| -> Vec<Part> {
        map.iter()
            .map(|u| Part { url: u.clone(), seq: 0, key: None, file: String::new() })
            .chain(list.iter().cloned())
            .enumerate()
            .map(|(i, mut p)| {
                p.file = format!("{prefix}{i}.seg");
                p
            })
            .collect()
    };
    let video_parts = track(&segments, &map, "");
    let audio_parts = audio.as_ref().map(|(s, mp)| track(s, mp, "a")).unwrap_or_default();
    let parts: Vec<Part> = video_parts.iter().chain(audio_parts.iter()).cloned().collect();

    let temp = item.lock().temp_path();
    let dir = part_dir(&temp);
    tokio::fs::create_dir_all(&dir).await?;
    let mut done = HashSet::new();
    let mut bytes = 0u64;
    let mut rd = tokio::fs::read_dir(&dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        let valid = name.strip_suffix(".seg").is_some_and(|n| n.trim_start_matches('a').chars().all(|c| c.is_ascii_digit()) && !n.is_empty());
        if valid {
            bytes += e.metadata().await.map(|m| m.len()).unwrap_or(0);
            done.insert(name);
        }
    }
    {
        let mut d = item.lock();
        d.total_segments = parts.len() as u32;
        d.done_segments = done.len() as u32;
        d.downloaded = bytes;
        estimate(&mut d);
    }
    m.changed();

    let queue: Arc<Mutex<Vec<Part>>> = Arc::new(Mutex::new(parts.iter().filter(|p| !done.contains(&p.file)).cloned().rev().collect()));
    let keys: Arc<tokio::sync::Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
    let failure: Arc<Mutex<Option<AppError>>> = Arc::default();
    let inner = cancel.child_token();
    let n = item.lock().connections.clamp(1, 16);
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..n {
        let (m, item, queue, keys, failure, inner, dir) = (m.clone(), item.clone(), queue.clone(), keys.clone(), failure.clone(), inner.clone(), dir.clone());
        set.spawn(async move {
            loop {
                if inner.is_cancelled() {
                    break;
                }
                let Some(part) = queue.lock().unwrap().pop() else { break };
                item.lock().rt.active += 1;
                let r = fetch_part(&m, &item, &part, &dir, &keys, &inner).await;
                {
                    let mut d = item.lock();
                    d.rt.active = d.rt.active.saturating_sub(1);
                    if r.is_ok() && !inner.is_cancelled() {
                        d.done_segments += 1;
                        estimate(&mut d);
                    }
                }
                if let Err(e) = r {
                    if !inner.is_cancelled() {
                        failure.lock().unwrap().get_or_insert(e);
                        inner.cancel();
                    }
                    break;
                }
            }
        });
    }
    while set.join_next().await.is_some() {}
    if let Some(e) = failure.lock().unwrap().take() {
        return Err(e);
    }
    if cancel.is_cancelled() {
        return Ok(());
    }

    // Birleştir; ses ayrıysa görüntüyle tek dosyaya kat
    let join = |list: &[Part], out: PathBuf| {
        let files: Vec<PathBuf> = list.iter().map(|p| dir.join(&p.file)).collect();
        async move {
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let mut w = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(&out)?);
                for f in files {
                    std::io::copy(&mut std::fs::File::open(f)?, &mut w)?;
                }
                std::io::Write::flush(&mut w)
            })
            .await
            .map_err(|e| AppError::raw(e.to_string()))?
            .map_err(AppError::from)
        }
    };
    if audio_parts.is_empty() {
        join(&video_parts, temp.clone()).await?;
    } else {
        let v = dir.join("video.av");
        let a = dir.join("audio.av");
        join(&video_parts, v.clone()).await?;
        join(&audio_parts, a.clone()).await?;
        let ext = crate::util::ext_of(&item.lock().filename);
        mux_av(mux.as_ref().unwrap(), &v, &a, &temp, &ext).await?;
    }
    let size = tokio::fs::metadata(&temp).await?.len();
    {
        let mut d = item.lock();
        d.size = size as i64;
        d.downloaded = size;
    }
    let final_path = m.final_path(item).await?;
    rename_with_retry(&temp, &final_path).await?;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    {
        let mut d = item.lock();
        d.filename = final_path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        d.status = "completed".into();
        d.completed_at = Some(crate::util::now_ms());
    }
    m.emit_completed(item);
    Ok(())
}

fn estimate(d: &mut crate::item::ItemData) {
    if d.done_segments > 0 && d.total_segments > 0 {
        let est = (d.downloaded as f64 / d.done_segments as f64 * d.total_segments as f64).round() as i64;
        d.size = est.max(d.downloaded as i64);
    }
}

async fn fetch_part(
    m: &Manager,
    item: &Item,
    part: &Part,
    dir: &Path,
    keys: &tokio::sync::Mutex<HashMap<String, Vec<u8>>>,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut attempt = 0;
    loop {
        let mut got = 0u64;
        let r: Result<Vec<u8>> = async {
            let (headers, auth) = {
                let d = item.lock();
                (d.headers.clone(), d.auth.clone())
            };
            let Some(req) = or_cancel(cancel, tokio::time::timeout(STALL, request(&part.url, &headers, &auth, None))).await else {
                return Err(AppError::new("err.cancelled"));
            };
            let (res, _) = req.map_err(|_| AppError::new("err.stalled"))??;
            if !res.status().is_success() {
                return Err(AppError::http(res.status().as_u16()));
            }
            let mut stream = res.bytes_stream();
            let mut buf = Vec::new();
            loop {
                let Some(next) = or_cancel(cancel, tokio::time::timeout(STALL, stream.next())).await else {
                    return Err(AppError::new("err.cancelled"));
                };
                match next {
                    Err(_) => return Err(AppError::new("err.stalled")),
                    Ok(None) => break,
                    Ok(Some(Err(e))) => return Err(e.into()),
                    Ok(Some(Ok(c))) => {
                        throttle(m, item, c.len(), cancel).await;
                        got += c.len() as u64;
                        item.lock().downloaded += c.len() as u64;
                        buf.extend_from_slice(&c);
                    }
                }
            }
            match &part.key {
                Some(k) => decrypt(&buf, k, part.seq, &headers, &auth, keys).await,
                None => Ok(buf),
            }
        }
        .await;
        match r {
            Ok(data) => {
                let file = dir.join(&part.file);
                let tmp = dir.join(format!("{}.tmp", part.file));
                let len = data.len() as u64;
                tokio::fs::write(&tmp, &data).await?;
                tokio::fs::rename(&tmp, &file).await?;
                // Şifre çözme boyutu değiştirebilir
                let mut d = item.lock();
                d.downloaded = d.downloaded + len - got;
                return Ok(());
            }
            Err(e) => {
                {
                    let mut d = item.lock();
                    d.downloaded = d.downloaded.saturating_sub(got);
                }
                if cancel.is_cancelled() || e.fatal {
                    return Err(e);
                }
                attempt += 1;
                if attempt > m.settings().retries {
                    return Err(e);
                }
                let wait = Duration::from_millis((1000u64 << (attempt - 1).min(4)).min(15000));
                if !sleep_or_cancel(cancel, wait).await {
                    return Err(AppError::new("err.cancelled"));
                }
            }
        }
    }
}

async fn decrypt(
    buf: &[u8],
    key: &Key,
    seq: u64,
    headers: &Headers,
    auth: &Auth,
    keys: &tokio::sync::Mutex<HashMap<String, Vec<u8>>>,
) -> Result<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let Some(uri) = &key.uri else { return Err(AppError::fatal("err.noKeyUri")) };
    let k = {
        let mut cache = keys.lock().await;
        if let Some(k) = cache.get(uri) {
            k.clone()
        } else {
            let (res, _) = request(uri, headers, auth, None).await?;
            if !res.status().is_success() {
                return Err(AppError::http_key(res.status().as_u16(), "err.keyFetch"));
            }
            let k = res.bytes().await?.to_vec();
            cache.insert(uri.clone(), k.clone());
            k
        }
    };
    let iv: [u8; 16] = match &key.iv {
        Some(iv) => {
            let h = iv.trim_start_matches("0x").trim_start_matches("0X");
            let padded = format!("{h:0>32}");
            hex::decode(&padded).ok().and_then(|v| v.try_into().ok()).unwrap_or([0; 16])
        }
        None => {
            let mut iv = [0u8; 16];
            iv[12..].copy_from_slice(&(seq as u32).to_be_bytes());
            iv
        }
    };
    let k: [u8; 16] = k.as_slice().try_into().map_err(|_| AppError::fatal("err.keyFetch"))?;
    cbc::Decryptor::<aes::Aes128>::new(&k.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(buf)
        .map_err(|_| AppError::raw("AES decrypt failed"))
}

/// Ayrı inen görüntü ve sesi yeniden kodlamadan tek dosyada birleştirir (FFmpeg).
async fn mux_av(cmd: &crate::tools::Cmd, video: &Path, audio: &Path, out: &Path, ext: &str) -> Result<()> {
    let format = match ext {
        "mkv" => "matroska",
        "ts" => "mpegts",
        "mov" => "mov",
        _ => "mp4",
    };
    let output = crate::util::hidden_command(&cmd.program)
        .args(&cmd.args)
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(video)
        .arg("-i")
        .arg(audio)
        .args(["-map", "0:v", "-map", "1:a", "-c", "copy", "-f", format])
        .arg(out)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::with("err.muxFailed", json!({ "detail": e.to_string() })))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let detail = err.trim().lines().last().map(str::to_string).unwrap_or_else(|| output.status.to_string());
        return Err(AppError::with("err.muxFailed", json!({ "detail": detail })));
    }
    Ok(())
}
