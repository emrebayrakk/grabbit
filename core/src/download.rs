//! Tek dosya indirmesi: parçalama, IDM tarzı dinamik bölme, kaldığı yerden devam, yeniden deneme.

use crate::http::{content_type, probe, request};
use crate::item::{Checksum, Item, Segment};
use crate::manager::Manager;
use crate::util::{parse_content_range, AppError, Result};
use futures_util::StreamExt;
use reqwest::header;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const MIN_SEGMENT: u64 = 1024 * 1024; // ilk bölmede bağlantı başına en az 1 MB
const MIN_SPLIT: i64 = 1024 * 1024; // dinamik bölmede her iki yarı en az 1 MB kalmalı
pub const STALL: Duration = Duration::from_secs(30); // bu süre veri gelmezse bağlantı yenilenir
const WRITE_BUFFER: usize = 512 * 1024; // diske en az bu büyüklükte bloklar halinde yaz
const FLUSH_EVERY: Duration = Duration::from_millis(250);

/// Ağ işlemini iptal belirteciyle yarıştırır; iptalde None.
pub async fn or_cancel<T>(cancel: &CancellationToken, fut: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        v = fut => Some(v),
    }
}

/// İptal edilebilir bekleme; iptal edildiyse false.
pub async fn sleep_or_cancel(cancel: &CancellationToken, d: Duration) -> bool {
    or_cancel(cancel, tokio::time::sleep(d)).await.is_some()
}

/// Hız sınırlarına göre bekler (genel + öğeye özel).
pub async fn throttle(m: &Manager, item: &Item, n: usize, cancel: &CancellationToken) {
    if let Some(d) = m.limiter.consume(n) {
        sleep_or_cancel(cancel, d).await;
    }
    if item.limiter.is_limited() {
        if let Some(d) = item.limiter.consume(n) {
            sleep_or_cancel(cancel, d).await;
        }
    }
}

pub async fn run_file(m: Arc<Manager>, item: Arc<Item>, cancel: CancellationToken) {
    {
        let mut d = item.lock();
        // Başlamadan durdurulduysa durumu ezme (durdurma, durumu ve iptali aynı kilit altında yapar)
        if cancel.is_cancelled() {
            return;
        }
        d.status = "downloading".into();
        d.clear_error();
        d.rt.history.clear();
        d.rt.conn_limit = d.connections.max(1);
        d.rt.reresolved = false;
    }
    m.changed();
    let fatal: Arc<Mutex<Option<AppError>>> = Arc::default();
    let result = run_inner(&m, &item, &cancel, &fatal).await;
    let failure = fatal.lock().unwrap().take().or(result.err());
    {
        let mut d = item.lock();
        for s in &mut d.segments {
            s.active = false;
        }
        d.rt.active = 0;
        d.rt.speed = 0.0;
        d.rt.eta = None;
    }
    if let Some(err) = failure {
        // Kullanıcı durdurduysa (ve hata bir bağlantıdan gelmediyse) hata gösterilmez
        if !(cancel.is_cancelled() && !err.fatal) {
            item.lock().set_error(&err);
            m.emit_failed(&item);
        }
    }
    m.changed();
}

async fn run_inner(m: &Arc<Manager>, item: &Arc<Item>, cancel: &CancellationToken, fatal: &Arc<Mutex<Option<AppError>>>) -> Result<()> {
    let probed = item.lock().probed;
    if !probed {
        let (url, headers, auth) = {
            let d = item.lock();
            (d.url.clone(), d.headers.clone(), d.auth.clone())
        };
        let Some(info) = or_cancel(cancel, probe(&url, &headers, &auth, Duration::from_secs(20))).await else { return Ok(()) };
        let info = info?;
        let auto = {
            let mut d = item.lock();
            d.final_url = Some(info.final_url.clone());
            d.size = info.size;
            d.resumable = info.resumable;
            d.probed = true;
            d.segments.clear();
            d.auto_name
        };
        if auto {
            m.assign_path(item, Some(&info.filename)).await?;
        }
        m.changed();
    }
    let (dir, temp, resumable) = {
        let d = item.lock();
        (PathBuf::from(&d.dir), d.temp_path(), d.resumable)
    };
    tokio::fs::create_dir_all(&dir).await?;
    let has_part = tokio::fs::try_exists(&temp).await.unwrap_or(false);
    {
        let mut d = item.lock();
        if !has_part || !resumable {
            // Devam edilemiyorsa ya da geçici dosya silinmişse baştan başla
            d.segments.clear();
        }
        if d.segments.is_empty() {
            let (r, sz, c) = (d.resumable, d.size, d.connections);
            init_segments(&mut d.segments, r, sz, c);
        }
    }
    if !(has_part && resumable) {
        std::fs::File::create(&temp)?;
    }

    let inner = cancel.child_token();
    run_segments(m, item, &inner, fatal).await;
    if let Some(e) = fatal.lock().unwrap().clone() {
        return Err(e);
    }
    if cancel.is_cancelled() {
        return Ok(());
    }
    finalize(m, item).await
}

pub fn init_segments(segments: &mut Vec<Segment>, resumable: bool, size: i64, connections: u32) {
    segments.clear();
    if resumable && size > 0 {
        let size = size as u64;
        let n = (connections as u64).min(size.div_ceil(MIN_SEGMENT)).max(1);
        let step = size / n;
        for i in 0..n {
            let end = if i == n - 1 { size as i64 - 1 } else { ((i + 1) * step) as i64 - 1 };
            segments.push(Segment { start: i * step, end, downloaded: 0, finished: false, active: false });
        }
    } else {
        segments.push(Segment { start: 0, end: if size > 0 { size - 1 } else { -1 }, ..Default::default() });
    }
}

async fn run_segments(m: &Arc<Manager>, item: &Arc<Item>, inner: &CancellationToken, fatal: &Arc<Mutex<Option<AppError>>>) {
    let mut set = JoinSet::new();
    loop {
        if !inner.is_cancelled() {
            let launch = {
                let mut d = item.lock();
                let limit = d.rt.conn_limit.max(1) as usize;
                let mut active = d.segments.iter().filter(|s| s.active).count();
                let mut out = vec![];
                for (i, s) in d.segments.iter_mut().enumerate() {
                    if active >= limit {
                        break;
                    }
                    if !s.active && !s.done() {
                        s.active = true;
                        active += 1;
                        out.push(i);
                    }
                }
                // Dinamik bölümleme: boşalan bağlantı, en çok işi kalan parçanın yarısını devralır
                while active < limit {
                    let Some(i) = split(&mut d) else { break };
                    d.segments[i].active = true;
                    active += 1;
                    out.push(i);
                }
                d.rt.active = active as u32;
                out
            };
            for idx in launch {
                set.spawn(worker(m.clone(), item.clone(), idx, inner.clone(), fatal.clone()));
            }
        }
        if set.join_next().await.is_none() {
            break;
        }
        if inner.is_cancelled() {
            while set.join_next().await.is_some() {}
            break;
        }
    }
}

fn split(d: &mut crate::item::ItemData) -> Option<usize> {
    if !d.resumable || d.size <= 0 {
        return None;
    }
    let (best, rem) = d
        .segments
        .iter()
        .enumerate()
        .filter(|(_, s)| s.active && s.end >= 0)
        .map(|(i, s)| (i, s.remaining()))
        .max_by_key(|(_, r)| *r)?;
    if rem < 2 * MIN_SPLIT {
        return None;
    }
    let b = &d.segments[best];
    let mid = b.start + b.downloaded + (rem / 2) as u64;
    let seg = Segment { start: mid, end: b.end, downloaded: 0, finished: false, active: false };
    d.segments[best].end = mid as i64 - 1;
    d.segments.push(seg);
    Some(d.segments.len() - 1)
}

fn fail(fatal: &Mutex<Option<AppError>>, inner: &CancellationToken, err: AppError) {
    let mut f = fatal.lock().unwrap();
    if f.is_none() {
        *f = Some(err.into_fatal());
        inner.cancel();
    }
}

async fn worker(m: Arc<Manager>, item: Arc<Item>, idx: usize, inner: CancellationToken, fatal: Arc<Mutex<Option<AppError>>>) {
    let mut attempt = 0u32;
    loop {
        if inner.is_cancelled() || item.lock().segments[idx].done() {
            break;
        }
        match fetch_segment(&m, &item, idx, &inner).await {
            Ok(()) => continue,
            Err((err, bytes)) => {
                if inner.is_cancelled() {
                    break;
                }
                let (url, final_url, reresolved) = {
                    let d = item.lock();
                    (d.url.clone(), d.final_url.clone(), d.rt.reresolved)
                };
                if matches!(err.status, Some(401 | 403 | 404 | 410)) && final_url.as_ref().is_some_and(|f| *f != url) && !reresolved {
                    // Yönlendirilen adresin süresi dolmuş olabilir: asıl adresten yeniden çözümle
                    let mut d = item.lock();
                    d.rt.reresolved = true;
                    d.final_url = None;
                    continue;
                }
                if err.fatal {
                    fail(&fatal, &inner, err);
                    break;
                }
                if bytes > 0 {
                    attempt = 0;
                }
                attempt += 1;
                if attempt > m.settings().retries {
                    // Sunucu fazla bağlantıyı reddediyor olabilir: diğerleri çalışıyorsa bu bağlantıyı bırak
                    let mut d = item.lock();
                    let active = d.segments.iter().filter(|s| s.active).count() as u32;
                    if active > 1 {
                        d.rt.conn_limit = (active - 1).max(1);
                        break;
                    }
                    drop(d);
                    fail(&fatal, &inner, err);
                    break;
                }
                let wait = Duration::from_millis((1000u64 << (attempt - 1).min(4)).min(15000));
                if !sleep_or_cancel(&inner, wait).await {
                    break;
                }
            }
        }
    }
    let mut d = item.lock();
    if let Some(s) = d.segments.get_mut(idx) {
        s.active = false;
    }
    d.rt.active = d.segments.iter().filter(|s| s.active).count() as u32;
}

/// Konumlu yazma (Windows: seek_write); tüm baytlar yazılana kadar.
fn write_at(file: &std::fs::File, mut buf: &[u8], mut pos: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, pos)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(file, buf, pos)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        pos += n as u64;
    }
    Ok(())
}

/// Bir parçayı indirir. Hata durumunda bu denemede yazılan bayt sayısı da döner.
async fn fetch_segment(m: &Manager, item: &Item, idx: usize, cancel: &CancellationToken) -> std::result::Result<(), (AppError, u64)> {
    let (url, headers, auth, resumable, pos0, end0, size, single, temp) = {
        let mut d = item.lock();
        if !d.resumable && d.segments[idx].downloaded > 0 {
            // Devam desteklenmiyor: bu bağlantı koptuysa baştan başlamak zorundayız
            d.segments[idx].downloaded = 0;
            let _ = std::fs::OpenOptions::new().write(true).open(d.temp_path()).and_then(|f| f.set_len(0));
        }
        let s = &d.segments[idx];
        (
            d.final_url.clone().unwrap_or_else(|| d.url.clone()),
            d.headers.clone(),
            d.auth.clone(),
            d.resumable,
            s.start + s.downloaded,
            s.end,
            d.size,
            d.segments.len() == 1,
            d.temp_path(),
        )
    };
    let range = resumable.then(|| format!("bytes={pos0}-{}", if end0 >= 0 { end0.to_string() } else { String::new() }));
    let file = std::fs::OpenOptions::new().write(true).open(&temp).map_err(|e| (AppError::from(e), 0))?;
    let file = Arc::new(file);

    let mut bytes = 0u64;
    let mut pos = pos0;
    let mut pending: Vec<u8> = Vec::with_capacity(WRITE_BUFFER);
    let mut last_flush = Instant::now();

    // Biriken veriyi diske yazar; parça bu sırada bölünmüş olabilir, güncel sona göre kırpar
    async fn flush(item: &Item, idx: usize, file: &Arc<std::fs::File>, pending: &mut Vec<u8>, pos: &mut u64, bytes: &mut u64) -> Result<()> {
        if pending.is_empty() {
            return Ok(());
        }
        let end = item.lock().segments[idx].end;
        let mut buf = std::mem::take(pending);
        if end >= 0 {
            let allowed = end - *pos as i64 + 1;
            if allowed <= 0 {
                return Ok(());
            }
            buf.truncate((allowed as usize).min(buf.len()));
        }
        let n = buf.len() as u64;
        let f = file.clone();
        let at = *pos;
        tokio::task::spawn_blocking(move || write_at(&f, &buf, at)).await.map_err(|e| AppError::raw(e.to_string()))??;
        *pos += n;
        *bytes += n;
        item.lock().segments[idx].downloaded += n;
        Ok(())
    }

    let result: Result<()> = async {
        let req = or_cancel(cancel, tokio::time::timeout(STALL, request(&url, &headers, &auth, range.as_deref()))).await;
        let Some(req) = req else { return Ok(()) };
        let (res, final_url) = req.map_err(|_| AppError::new("err.stalled"))??;
        {
            let mut d = item.lock();
            if d.final_url.is_none() {
                d.final_url = Some(final_url);
            }
        }
        let status = res.status().as_u16();
        if resumable {
            if status == 206 {
                if let Some((start, _, total)) =
                    res.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range)
                {
                    if start != pos0 {
                        return Err(AppError::fatal("err.wrongRange"));
                    }
                    if total >= 0 && size > 0 && total != size {
                        return Err(AppError::fatal("err.fileChanged"));
                    }
                }
            } else if res.status().is_success() && !(pos0 == 0 && single) {
                return Err(AppError::fatal("err.noLongerResumable"));
            } else if !res.status().is_success() {
                return Err(AppError::http(status));
            }
        } else if !res.status().is_success() {
            return Err(AppError::http(status));
        }
        let _ = content_type(&res);

        let mut stream = res.bytes_stream();
        loop {
            let next = or_cancel(cancel, tokio::time::timeout(STALL, stream.next())).await;
            let chunk = match next {
                None => break, // durduruldu: gelen veri yine de yazılır
                Some(Err(_)) => {
                    flush(item, idx, &file, &mut pending, &mut pos, &mut bytes).await?;
                    return Err(AppError::new("err.stalled"));
                }
                Some(Ok(None)) => break,
                Some(Ok(Some(Err(e)))) => {
                    flush(item, idx, &file, &mut pending, &mut pos, &mut bytes).await?;
                    return Err(e.into());
                }
                Some(Ok(Some(Ok(c)))) => c,
            };
            throttle(m, item, chunk.len(), cancel).await;
            if cancel.is_cancelled() {
                pending.extend_from_slice(&chunk);
                break;
            }
            let end = item.lock().segments[idx].end;
            let next_pos = pos + pending.len() as u64;
            let mut c = &chunk[..];
            if end >= 0 {
                let allowed = end - next_pos as i64 + 1;
                if allowed <= 0 {
                    break;
                }
                c = &c[..(allowed as usize).min(c.len())];
            }
            pending.extend_from_slice(c);
            if pending.len() >= WRITE_BUFFER || last_flush.elapsed() >= FLUSH_EVERY {
                flush(item, idx, &file, &mut pending, &mut pos, &mut bytes).await?;
                last_flush = Instant::now();
            }
            if end >= 0 && (pos + pending.len() as u64) as i64 > end {
                break;
            }
        }
        // Duraklatmada da gelen veriyi diske yaz: tekrar indirilmesin
        flush(item, idx, &file, &mut pending, &mut pos, &mut bytes).await?;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let mut d = item.lock();
        let seg = &mut d.segments[idx];
        if seg.end < 0 {
            // Boyutu bilinmeyen dosya: akış bittiyse dosya bitmiştir
            seg.finished = true;
            seg.end = pos as i64 - 1;
            d.size = pos as i64;
        } else if !seg.done() {
            return Err(AppError::new("err.closedEarly"));
        }
        Ok(())
    }
    .await;
    result.map_err(|e| (e, bytes))
}

async fn finalize(m: &Arc<Manager>, item: &Arc<Item>) -> Result<()> {
    let (temp, size) = {
        let d = item.lock();
        (d.temp_path(), d.size)
    };
    let len = tokio::fs::metadata(&temp).await?.len() as i64;
    if size > 0 {
        if len < size {
            return Err(AppError::raw("Dosya eksik indi — tekrar deneyin"));
        }
        if len > size {
            std::fs::OpenOptions::new().write(true).open(&temp)?.set_len(size as u64)?;
        }
    } else {
        item.lock().size = len;
    }
    let final_path = m.final_path(item).await?;
    rename_with_retry(&temp, &final_path).await?;
    let algo = {
        let mut d = item.lock();
        d.filename = final_path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        let size = d.size;
        d.segments = vec![Segment { start: 0, end: size - 1, downloaded: size.max(0) as u64, finished: true, active: false }];
        d.status = "completed".into();
        d.completed_at = Some(crate::util::now_ms());
        d.checksum.as_ref().filter(|c| c.expected.is_some()).map(|c| c.algo.clone())
    };
    m.emit_completed(item);
    if let Some(algo) = algo {
        let _ = compute_hash(m, item, &algo).await;
    }
    Ok(())
}

/// Antivirüs dosyayı kısa süre kilitleyebilir: birkaç kez dene.
pub async fn rename_with_retry(from: &std::path::Path, to: &std::path::Path) -> Result<()> {
    for i in 0.. {
        match tokio::fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) if i < 5 && (e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32)) => {
                tokio::time::sleep(Duration::from_millis(400 * (i + 1))).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!()
}

/// Tamamlanan dosyanın özetini hesaplar (ilerleme gösterilerek); beklenen özetle karşılaştırır.
pub async fn compute_hash(m: &Arc<Manager>, item: &Arc<Item>, algo: &str) -> Result<Checksum> {
    use sha2::digest::DynDigest;
    let mut hasher: Box<dyn DynDigest + Send> = match algo {
        "md5" => Box::new(md5::Md5::default()),
        "sha1" => Box::new(sha1::Sha1::default()),
        "sha256" => Box::new(sha2::Sha256::default()),
        "sha512" => Box::new(sha2::Sha512::default()),
        _ => return Err(AppError::raw("Desteklenmeyen algoritma")),
    };
    let path = {
        let mut d = item.lock();
        if d.status != "completed" {
            return Err(AppError::new("err.notCompleted"));
        }
        d.status = "verifying".into();
        d.rt.hash_progress = Some(0.0);
        d.save_path()
    };
    m.changed();
    let it = item.clone();
    let mm = m.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<String> {
        use std::io::Read;
        let mut f = std::fs::File::open(&path)?;
        let total = f.metadata()?.len().max(1);
        let mut buf = vec![0u8; 1024 * 1024];
        let mut read = 0u64;
        let mut last = Instant::now();
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            read += n as u64;
            if last.elapsed() > Duration::from_millis(250) {
                last = Instant::now();
                it.lock().rt.hash_progress = Some(read as f64 / total as f64);
                mm.changed();
            }
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| AppError::raw(e.to_string()))?;
    let out = {
        let mut d = item.lock();
        d.status = "completed".into();
        d.rt.hash_progress = None;
        match res {
            Ok(actual) => {
                let expected = d.checksum.as_ref().filter(|c| c.algo == algo).and_then(|c| c.expected.clone());
                let ok = expected.as_ref().map(|e| e.to_lowercase() == actual);
                let c = Checksum { algo: algo.into(), expected, actual: Some(actual), ok };
                d.checksum = Some(c.clone());
                Ok(c)
            }
            Err(e) => Err(e),
        }
    };
    m.changed();
    out
}
