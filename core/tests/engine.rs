//! İndirme motorunu arayüz olmadan, yerel bir test sunucusuna karşı doğrular.
//! Senaryolar sırayla ve aynı yöneticiyle çalışır (gerçek kullanımdaki gibi birbirini etkiler).
//! Çalıştırma: cargo test -p grabbit-core --test engine -- --nocapture

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Response, Uri};
use grabbit_core::bridge::{AddRequest, BridgeHandler};
use grabbit_core::tools::{Cmd, Source, Tools};
use grabbit_core::{i18n, Manager, NewEntry};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- test verisi

fn random(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(n + 8);
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(n);
    out
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

static DATA: LazyLock<Vec<u8>> = LazyLock::new(|| random(24 * 1024 * 1024 + 12345, 1));
static SMALL: LazyLock<Vec<u8>> = LazyLock::new(|| random(4 * 1024 * 1024, 2));
static HLS_SEGS: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| (0..40).map(|i| random(64 * 1024, 100 + i)).collect());
static HLS_ALL: LazyLock<Vec<u8>> = LazyLock::new(|| HLS_SEGS.concat());
static HLS_KEY: LazyLock<Vec<u8>> = LazyLock::new(|| random(16, 3));
static AUD_TR: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| (0..10).map(|i| random(16 * 1024, 200 + i)).collect());
static AUD_EN: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| (0..10).map(|i| random(16 * 1024, 300 + i)).collect());
static IMG_SMALL: LazyLock<Vec<u8>> = LazyLock::new(|| random(2000, 4));
static IMG_BIG: LazyLock<Vec<u8>> = LazyLock::new(|| random(300_000, 5));

fn enc_seg(i: usize) -> Vec<u8> {
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    let mut iv = [0u8; 16];
    iv[12..].copy_from_slice(&(i as u32).to_be_bytes());
    let key: [u8; 16] = HLS_KEY.as_slice().try_into().unwrap();
    cbc::Encryptor::<aes::Aes128>::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&HLS_SEGS[i])
}

fn media_list(prefix: &str, end: bool) -> String {
    let mut s = String::from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n");
    if prefix == "e" {
        s.push_str("#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n");
    }
    s.push_str(&(0..40).map(|i| format!("#EXTINF:4.0,\n{prefix}{i}.ts")).collect::<Vec<_>>().join("\n"));
    s.push_str(if end { "\n#EXT-X-ENDLIST\n" } else { "\n" });
    s
}

fn audio_list(lang: &str) -> String {
    format!("#EXTM3U\n#EXT-X-TARGETDURATION:4\n{}\n#EXT-X-ENDLIST\n", (0..10).map(|i| format!("#EXTINF:4.0,\naud-{lang}-{i}.aac")).collect::<Vec<_>>().join("\n"))
}

// ---------------------------------------------------------------- test sunucusu

#[derive(Default)]
struct Srv {
    port: AtomicUsize,
    hls_low_hits: AtomicUsize,
    hls_slow: AtomicBool,
    flaky_hits: AtomicUsize,
    counted_hits: AtomicUsize,
    missing_hits: AtomicUsize,
    tool_zip_hits: AtomicUsize,
    tool_files: Mutex<(Vec<u8>, String)>,
    cookie_log: Mutex<Vec<(String, Option<String>)>>,
}

static SRV: LazyLock<Srv> = LazyLock::new(Srv::default);

fn resp(status: u16, headers: &[(&str, String)], body: impl Into<Body>) -> Response<Body> {
    let mut r = Response::builder().status(status);
    for (k, v) in headers {
        r = r.header(*k, HeaderValue::from_str(v).unwrap());
    }
    r.body(body.into()).unwrap()
}

fn serve_range(h: &HeaderMap, buf: &[u8], extra: &[(&str, String)]) -> Response<Body> {
    let range = h.get("range").and_then(|v| v.to_str().ok()).unwrap_or("");
    let re = regex::Regex::new(r"bytes=(\d+)-(\d*)").unwrap();
    let mut headers: Vec<(&str, String)> = extra.to_vec();
    headers.push(("Accept-Ranges", "bytes".into()));
    if let Some(c) = re.captures(range) {
        let start: usize = c[1].parse().unwrap();
        let end = if c[2].is_empty() { buf.len() - 1 } else { c[2].parse::<usize>().unwrap().min(buf.len() - 1) };
        if start >= buf.len() {
            return resp(416, &[("Content-Range", format!("bytes */{}", buf.len()))], Body::empty());
        }
        headers.push(("Content-Range", format!("bytes {start}-{end}/{}", buf.len())));
        return resp(206, &headers, Bytes::copy_from_slice(&buf[start..=end]));
    }
    resp(200, &headers, Bytes::copy_from_slice(buf))
}

async fn route(uri: Uri, h: HeaderMap) -> Response<Body> {
    let path = uri.path().to_string();
    let img = |b: &[u8], t: &str| serve_range(&h, b, &[("Content-Type", t.into())]);
    let m3u8 = |s: String| resp(200, &[("Content-Type", "application/vnd.apple.mpegurl".into())], s);
    match path.as_str() {
        "/img/foto-150x150.jpg" | "/img/yok-150x150.jpg" | "/img/sayfa-150x150.jpg" | "/img/avatar.pnj" => return img(&IMG_SMALL, "image/jpeg"),
        "/img/foto.jpg" => return img(&IMG_BIG, "image/jpeg"),
        "/img/sayfa.jpg" => return img("<html>giriş yapın</html>".as_bytes(), "text/html"),
        _ => {}
    }
    if let Some(c) = regex::Regex::new(r"^/hls/aud-(tr|en)-(\d+)\.aac$").unwrap().captures(&path) {
        let i: usize = c[2].parse().unwrap();
        let b = if &c[1] == "tr" { &AUD_TR[i] } else { &AUD_EN[i] };
        return resp(200, &[("Content-Type", "audio/aac".into())], b.clone());
    }
    if let Some(c) = regex::Regex::new(r"^/hls/(s|e|l)(\d+)\.ts$").unwrap().captures(&path) {
        let i: usize = c[2].parse().unwrap();
        if &c[1] == "l" {
            SRV.hls_low_hits.fetch_add(1, Ordering::SeqCst);
        }
        let body = if &c[1] == "e" { enc_seg(i) } else { HLS_SEGS[i].clone() };
        if SRV.hls_slow.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        return resp(200, &[("Content-Type", "video/mp2t".into())], body);
    }
    let port = SRV.port.load(Ordering::SeqCst);
    match path.as_str() {
        "/hls/master.m3u8" => m3u8("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhigh.m3u8\n".into()),
        "/hls/av-master.m3u8" => m3u8(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",URI=\"aud-en.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Türkçe\",LANGUAGE=\"tr\",DEFAULT=YES,URI=\"aud-tr.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO=\"aud\"\nhigh.m3u8\n".into(),
        ),
        "/hls/aud-tr.m3u8" => m3u8(audio_list("tr")),
        "/hls/aud-en.m3u8" => m3u8(audio_list("en")),
        "/hls/high.m3u8" => m3u8(media_list("s", true)),
        "/hls/low.m3u8" => m3u8(media_list("l", true)),
        "/hls/enc.m3u8" => m3u8(media_list("e", true)),
        "/hls/live.m3u8" => m3u8(media_list("s", false)),
        "/hls-guard/live.m3u8" | "/hls-guard/video.m3u8" => {
            // Çerçevedeki oynatıcıdan gelmeyen istekleri reddeden sunucu (Referer + Origin şart)
            let r = h.get("referer").and_then(|v| v.to_str().ok()).unwrap_or("");
            let o = h.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
            if !(r.starts_with("http://player.test/") && o == "http://player.test") {
                return resp(404, &[], Body::empty());
            }
            m3u8(regex::Regex::new(r"s(\d+)\.ts").unwrap().replace_all(&media_list("s", true), "/hls/s$1.ts").into_owned())
        }
        "/hls/key.bin" => resp(200, &[], HLS_KEY.clone()),
        "/file.bin" => serve_range(
            &h,
            &DATA,
            &[("Content-Disposition", "attachment; filename=\"test.bin\"; filename*=UTF-8''test%20dosyas%C4%B1.bin".into())],
        ),
        "/redirect" => resp(302, &[("Location", "/file.bin".into())], Body::empty()),
        "/counted.bin" => {
            SRV.counted_hits.fetch_add(1, Ordering::SeqCst);
            serve_range(&h, &SMALL, &[])
        }
        "/yok-onbellek.zip" => {
            SRV.missing_hits.fetch_add(1, Ordering::SeqCst);
            resp(404, &[], Body::empty())
        }
        "/tools/yt-dlp_win.zip" => {
            SRV.tool_zip_hits.fetch_add(1, Ordering::SeqCst);
            resp(200, &[], SRV.tool_files.lock().unwrap().0.clone())
        }
        "/tools/SHA2-256SUMS" => resp(200, &[], SRV.tool_files.lock().unwrap().1.clone()),
        "/norange.bin" => resp(200, &[], SMALL.clone()),
        "/chunked" => {
            let chunks: Vec<Result<Bytes, std::io::Error>> = SMALL.chunks(256 * 1024).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
            resp(200, &[("Content-Type", "application/pdf".into())], Body::from_stream(futures_util::stream::iter(chunks)))
        }
        "/flaky.bin" => {
            // İlk 3 parçalı istek 1 MB sonra kopar
            let hits = SRV.flaky_hits.fetch_add(1, Ordering::SeqCst) + 1;
            let range = h.get("range").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if hits <= 3 && !range.is_empty() {
                let c = regex::Regex::new(r"bytes=(\d+)-(\d*)").unwrap().captures(&range).unwrap();
                let start: usize = c[1].parse().unwrap();
                let end: usize = if c[2].is_empty() { DATA.len() - 1 } else { c[2].parse().unwrap() };
                let part = Bytes::copy_from_slice(&DATA[start..(start + 1024 * 1024).min(end + 1)]);
                let stream = futures_util::stream::iter(vec![Ok(part), Err(std::io::Error::other("koptu"))]);
                return resp(
                    206,
                    &[("Content-Range", format!("bytes {start}-{end}/{}", DATA.len())), ("Content-Length", (end - start + 1).to_string())],
                    Body::from_stream(stream),
                );
            }
            serve_range(&h, &DATA, &[])
        }
        "/slow.bin" | "/a/ayni.bin" | "/b/ayni.bin" => serve_range(&h, &SMALL, &[]),
        "/cookie-start" => {
            SRV.cookie_log.lock().unwrap().push((path.clone(), h.get("cookie").map(|c| c.to_str().unwrap().to_string())));
            resp(302, &[("Location", format!("http://localhost:{port}/cookie-end"))], Body::empty())
        }
        "/cookie-end" => {
            SRV.cookie_log.lock().unwrap().push((path.clone(), h.get("cookie").map(|c| c.to_str().unwrap().to_string())));
            serve_range(&h, &SMALL, &[])
        }
        _ => resp(404, &[], Body::empty()),
    }
}

async fn start_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    SRV.port.store(port as usize, Ordering::SeqCst);
    let app = axum::Router::new().fallback(route);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------- yardımcılar

fn entry(v: Value) -> NewEntry {
    serde_json::from_value(v).unwrap()
}

async fn add1(m: &Arc<Manager>, v: Value) -> Value {
    m.add(vec![entry(v)]).await.remove(0)
}

/// Öğe verilen durumlardan birine gelip çalışması bitene kadar bekler.
async fn wait_for(m: &Arc<Manager>, id: &str, statuses: &[&str]) -> Value {
    let t0 = Instant::now();
    loop {
        if let Some(i) = m.get(id) {
            let s = i.snapshot();
            if statuses.contains(&s["status"].as_str().unwrap_or("")) && !i.is_running() {
                return s;
            }
            if t0.elapsed() > Duration::from_secs(60) {
                panic!("Zaman aşımı; durum: {} {}", s["status"], s["error"]);
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn read(p: &Value) -> Vec<u8> {
    std::fs::read(p["savePath"].as_str().unwrap()).unwrap_or_default()
}

macro_rules! ensure {
    ($cond:expr) => { if !$cond { return Err(format!("koşul sağlanmadı: {}", stringify!($cond))); } };
    ($cond:expr, $($msg:tt)+) => { if !$cond { return Err(format!($($msg)+)); } };
}

macro_rules! eq {
    ($a:expr, $b:expr) => {{
        let (a, b) = (&$a, &$b);
        if a != b { return Err(format!("{} != {}: {:?} ≠ {:?}", stringify!($a), stringify!($b), a, b)); }
    }};
}

struct Suite {
    results: Vec<String>,
    failed: usize,
}

impl Suite {
    async fn case<F: std::future::Future<Output = Result<(), String>>>(&mut self, name: &str, f: F) {
        let t0 = Instant::now();
        let line = match f.await {
            Ok(()) => format!("  ✓ {name} ({} ms)", t0.elapsed().as_millis()),
            Err(e) => {
                self.failed += 1;
                format!("  ✗ {name}: {e}")
            }
        };
        println!("{line}");
        self.results.push(line);
    }
}

struct TestBridge {
    adds: Arc<Mutex<Vec<AddRequest>>>,
    prefetches: Arc<Mutex<Vec<AddRequest>>>,
}

impl BridgeHandler for TestBridge {
    fn on_add(&self, req: AddRequest) {
        let adds = self.adds.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            adds.lock().unwrap().push(req);
        });
    }
    fn on_prefetch(&self, req: AddRequest) {
        self.prefetches.lock().unwrap().push(req);
    }
    fn on_ping(&self, _: &str, _: &str, _: bool) {}
    fn lang(&self) -> String {
        "tr".into()
    }
}

fn fake_bytes(seed: &str, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    let mut h = Sha256::digest(seed.as_bytes()).to_vec();
    while out.len() < n {
        let take = (n - out.len()).min(32);
        out.extend_from_slice(&h[..take]);
        h = Sha256::digest(&h).to_vec();
    }
    out
}

fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, data) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn log_runs(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn has_arg(run: &Value, a: &str) -> bool {
    run["args"].as_array().unwrap().iter().any(|x| x == a)
}

// ---------------------------------------------------------------- senaryolar

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn engine_suite() {
    // Test beklentileri Türkçe hata metinleriyle yazıldı
    i18n::set_language("tr");
    let base = start_server().await;
    let tmp = std::env::temp_dir().join(format!("grabbit-test-{}", uuid::Uuid::new_v4()));
    let data_dir = tmp.join("data");
    let m = Manager::new(data_dir.clone(), tmp.join("dl"));
    m.init().await.unwrap();
    m.update_settings(&json!({ "categorize": false, "retries": 3, "maxConcurrent": 5 }));
    let mut s = Suite { results: vec![], failed: 0 };

    s.case("çok bağlantılı indirme + Türkçe dosya adı", async {
        let snap = add1(&m, json!({ "url": format!("{base}/file.bin"), "connections": 8 })).await;
        eq!(snap["filename"], "test dosyası.bin");
        eq!(snap["size"], DATA.len());
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&DATA));
        ensure!(!Path::new(&format!("{}.tipart", d["savePath"].as_str().unwrap())).exists(), "geçici dosya kalmamalı");
        Ok(())
    })
    .await;

    s.case("aynı ad tekrar → \"(1)\" eki", async {
        let snap = add1(&m, json!({ "url": format!("{base}/redirect") })).await;
        eq!(snap["filename"], "test dosyası (1).bin");
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&DATA));
        Ok(())
    })
    .await;

    s.case("Range desteklemeyen sunucu (tek bağlantı)", async {
        let snap = add1(&m, json!({ "url": format!("{base}/norange.bin") })).await;
        eq!(snap["resumable"], false);
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&SMALL));
        Ok(())
    })
    .await;

    s.case("boyutu bilinmeyen (chunked) akış + MIME ile uzantı", async {
        let snap = add1(&m, json!({ "url": format!("{base}/chunked") })).await;
        eq!(snap["filename"], "chunked.pdf");
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(d["size"], SMALL.len());
        eq!(sha(&read(&d)), sha(&SMALL));
        Ok(())
    })
    .await;

    s.case("kopan bağlantılarda yeniden deneme", async {
        let snap = add1(&m, json!({ "url": format!("{base}/flaky.bin"), "connections": 4 })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&DATA));
        Ok(())
    })
    .await;

    s.case("duraklat → devam et → bütünlük", async {
        m.update_settings(&json!({ "speedLimit": 4096 })); // 4 MB/s, duraklatmayı yakalayabilmek için
        let snap = add1(&m, json!({ "url": format!("{base}/file.bin"), "connections": 6 })).await;
        let id = snap["id"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        m.pause(&[id.clone()]).await;
        let d = m.get(&id).unwrap().snapshot();
        eq!(d["status"], "paused");
        let partial = d["downloaded"].as_u64().unwrap();
        ensure!(partial > 0 && partial < DATA.len() as u64, "kısmi olmalı: {partial}");
        ensure!(Path::new(&format!("{}.tipart", d["savePath"].as_str().unwrap())).exists());
        m.update_settings(&json!({ "speedLimit": 0 }));
        m.start(&[id.clone()]);
        let d = wait_for(&m, &id, &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&DATA));
        Ok(())
    })
    .await;

    s.case("genel hız sınırı (~2 MB/s, 4 MB dosya ≥ 1.5 sn)", async {
        m.update_settings(&json!({ "speedLimit": 2048 }));
        let t0 = Instant::now();
        let snap = add1(&m, json!({ "url": format!("{base}/slow.bin"), "connections": 4 })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        let ms = t0.elapsed().as_millis();
        m.update_settings(&json!({ "speedLimit": 0 }));
        eq!(d["status"], "completed");
        ensure!(ms >= 1500, "çok hızlı bitti: {ms} ms");
        Ok(())
    })
    .await;

    s.case("SHA-256 doğrulama", async {
        let snap = add1(&m, json!({ "url": format!("{base}/slow.bin"), "checksum": { "algo": "sha256", "expected": sha(&SMALL).to_uppercase() } })).await;
        let id = snap["id"].as_str().unwrap();
        wait_for(&m, id, &["completed", "error"]).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let d = wait_for(&m, id, &["completed"]).await;
        eq!(d["checksum"]["ok"], true);
        Ok(())
    })
    .await;

    s.case("çerez başka alan adına sızmıyor", async {
        SRV.cookie_log.lock().unwrap().clear();
        let snap = add1(&m, json!({ "url": format!("{base}/cookie-start"), "cookie": "oturum=gizli" })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        let log = SRV.cookie_log.lock().unwrap().clone();
        ensure!(log.iter().any(|(p, c)| p == "/cookie-start" && c.as_deref() == Some("oturum=gizli")), "asıl adrese çerez gitmeli");
        ensure!(log.iter().filter(|(p, _)| p == "/cookie-end").all(|(_, c)| c.is_none()), "başka origin çerez almamalı");
        Ok(())
    })
    .await;

    s.case("404 → anlaşılır hata", async {
        let snap = add1(&m, json!({ "url": format!("{base}/yok.zip") })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "error");
        ensure!(d["error"].as_str().unwrap().contains("404"), "{}", d["error"]);
        Ok(())
    })
    .await;

    s.case("toplu eklemede aynı adlı dosyalar çakışmıyor", async {
        let snaps = m
            .add(vec![
                entry(json!({ "url": format!("{base}/a/ayni.bin") })),
                entry(json!({ "url": format!("{base}/b/ayni.bin") })),
                entry(json!({ "url": format!("{base}/a/ayni.bin?x=2") })),
            ])
            .await;
        let names: std::collections::HashSet<String> = snaps.iter().map(|s| s["filename"].as_str().unwrap().to_string()).collect();
        eq!(names.len(), 3);
        for snap in &snaps {
            let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
            eq!(d["status"], "completed");
            eq!(sha(&read(&d)), sha(&SMALL));
        }
        Ok(())
    })
    .await;

    s.case("indirme sürerken ilerleme diske kaydediliyor", async {
        m.progress_save_ms.store(500, Ordering::SeqCst);
        m.update_settings(&json!({ "speedLimit": 1024 }));
        let snap = add1(&m, json!({ "url": format!("{base}/file.bin"), "connections": 4 })).await;
        let id = snap["id"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let saved: Value = serde_json::from_slice(&std::fs::read(data_dir.join("downloads.json")).unwrap()).unwrap();
        let saved = saved.as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).cloned().unwrap();
        let persisted: u64 = saved["segments"].as_array().unwrap().iter().map(|s| s["downloaded"].as_u64().unwrap()).sum();
        m.pause(&[id.clone()]).await;
        m.update_settings(&json!({ "speedLimit": 0 }));
        m.progress_save_ms.store(10_000, Ordering::SeqCst);
        eq!(saved["status"], "downloading");
        ensure!(persisted > 512 * 1024, "kaydedilen ilerleme: {persisted}");
        m.remove(&[id], false).await;
        Ok(())
    })
    .await;

    s.case("HLS: ana listeden en yüksek kalite + sayfa başlığıyla ad", async {
        let info = m.probe(&format!("{base}/hls/master.m3u8"), Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        eq!(info["type"], "master");
        let res: Vec<&str> = info["variants"].as_array().unwrap().iter().map(|v| v["resolution"].as_str().unwrap()).collect();
        eq!(res, vec!["1280x720", "640x360"]);
        let snap = add1(&m, json!({ "url": format!("{base}/hls/master.m3u8"), "filename": "Tatil Videosu" })).await;
        eq!(snap["filename"], "Tatil Videosu.ts");
        eq!(snap["category"], "video");
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&HLS_ALL));
        eq!(SRV.hls_low_hits.load(Ordering::SeqCst), 0);
        ensure!(!Path::new(&format!("{}.tipart.d", d["savePath"].as_str().unwrap())).exists(), "parça klasörü silinmeli");
        Ok(())
    })
    .await;

    s.case("HLS: seçilen kalite (variantUrl)", async {
        let snap = add1(&m, json!({ "url": format!("{base}/hls/master.m3u8"), "variantUrl": format!("{base}/hls/low.m3u8") })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(SRV.hls_low_hits.load(Ordering::SeqCst), 40);
        Ok(())
    })
    .await;

    s.case("HLS: ses ayrı akıştaysa (film siteleri) iner ve görüntüyle birleştirilir", async {
        let ff_log = tmp.join("fake-ffmpeg.log");
        std::env::set_var("FAKE_FFMPEG_LOG", &ff_log);
        *m.tools.ffmpeg_override.lock().unwrap() = Some(Cmd { program: PathBuf::from(env!("CARGO_BIN_EXE_fake-ffmpeg")), args: vec![] });
        let r: Result<(), String> = async {
            let snap = add1(&m, json!({ "url": format!("{base}/hls/av-master.m3u8"), "filename": "Film" })).await;
            let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
            eq!(d["status"], "completed");
            eq!(d["filename"], "Film.mp4");
            // Varsayılan (Türkçe) ses seçilir; çıktı = görüntü + ses (sahte ffmpeg art arda yazar)
            let expected: Vec<u8> = HLS_ALL.iter().copied().chain(AUD_TR.concat()).collect();
            eq!(sha(&read(&d)), sha(&expected));
            let args: Vec<String> = serde_json::from_str(std::fs::read_to_string(&ff_log).unwrap().trim()).unwrap();
            let i = args.iter().position(|a| a == "-map").unwrap();
            eq!(args[i..i + 6].to_vec(), vec!["-map", "0:v", "-map", "1:a", "-c", "copy"]);
            ensure!(!Path::new(&format!("{}.tipart.d", d["savePath"].as_str().unwrap())).exists());
            Ok(())
        }
        .await;
        *m.tools.ffmpeg_override.lock().unwrap() = None;
        r
    })
    .await;

    s.case("HLS: ayrı ses var ama FFmpeg yoksa indirmeden önce anlaşılır hata", async {
        let snap = add1(&m, json!({ "url": format!("{base}/hls/av-master.m3u8"), "filename": "Film2" })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "error");
        ensure!(d["error"].as_str().unwrap().contains("sesi ayrı"), "{}", d["error"]);
        eq!(d["downloaded"].as_u64().unwrap_or(0), 0);
        Ok(())
    })
    .await;

    s.case("HLS: AES-128 şifreli akış çözülüyor", async {
        let snap = add1(&m, json!({ "url": format!("{base}/hls/enc.m3u8") })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&HLS_ALL));
        Ok(())
    })
    .await;

    s.case("HLS: duraklat → devam (biten parçalar korunur)", async {
        SRV.hls_slow.store(true, Ordering::SeqCst);
        let snap = add1(&m, json!({ "url": format!("{base}/hls/high.m3u8"), "connections": 2 })).await;
        let id = snap["id"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        m.pause(&[id.clone()]).await;
        let before = m.get(&id).unwrap().snapshot()["segmentsDone"].as_u64().unwrap();
        ensure!(before > 0 && before < 40, "kısmi olmalı: {before}");
        SRV.hls_slow.store(false, Ordering::SeqCst);
        m.start(&[id.clone()]);
        let d = wait_for(&m, &id, &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&HLS_ALL));
        Ok(())
    })
    .await;

    s.case("HLS: çerçevedeki oynatıcının Referer/Origin bilgisiyle indirilir", async {
        let bad = add1(&m, json!({ "url": format!("{base}/hls-guard/video.m3u8") })).await;
        let b = wait_for(&m, bad["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(b["status"], "error");
        let snap = add1(&m, json!({ "url": format!("{base}/hls-guard/video.m3u8"), "headers": { "referer": "http://player.test/embed/42" } })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&HLS_ALL));
        Ok(())
    })
    .await;

    s.case("HLS: canlı yayın reddediliyor", async {
        let e = m.probe(&format!("{base}/hls/live.m3u8"), Default::default(), String::new(), None, None).await;
        ensure!(e.is_err_and(|e| e.message().to_lowercase().contains("canlı")));
        let snap = add1(&m, json!({ "url": format!("{base}/hls/live.m3u8") })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "error");
        ensure!(d["error"].as_str().unwrap().to_lowercase().contains("canlı"));
        Ok(())
    })
    .await;

    s.case("tam boyut görsel: küçük önizleme yerine orijinal iner", async {
        let info = m.probe(&format!("{base}/img/foto-150x150.jpg"), Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        eq!(info["upgradedUrl"], format!("{base}/img/foto.jpg"));
        eq!(info["size"], IMG_BIG.len());
        let snap = add1(&m, json!({ "url": format!("{base}/img/foto-150x150.jpg"), "probeInfo": info })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(sha(&read(&d)), sha(&IMG_BIG));
        eq!(d["category"], "image");
        Ok(())
    })
    .await;

    s.case("tam boyut görsel: yoklamasız (eklentiden doğrudan) eklemede de büyür", async {
        let snap = add1(&m, json!({ "url": format!("{base}/img/foto-150x150.jpg") })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["url"], format!("{base}/img/foto.jpg"));
        eq!(sha(&read(&d)), sha(&IMG_BIG));
        Ok(())
    })
    .await;

    s.case("tam boyut görsel: büyüğü yoksa (404) ya da görsel değilse küçüğü iner", async {
        for name in ["yok", "sayfa"] {
            let snap = add1(&m, json!({ "url": format!("{base}/img/{name}-150x150.jpg") })).await;
            let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
            eq!(d["status"], "completed");
            eq!(sha(&read(&d)), sha(&IMG_SMALL));
        }
        Ok(())
    })
    .await;

    s.case("tam boyut görsel: ayardan kapatılabilir", async {
        m.update_settings(&json!({ "fullSizeImages": false }));
        let info = m.probe(&format!("{base}/img/foto-150x150.jpg"), Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        m.update_settings(&json!({ "fullSizeImages": true }));
        ensure!(info.get("upgradedUrl").is_none());
        eq!(info["size"], IMG_SMALL.len());
        Ok(())
    })
    .await;

    s.case("Tumblr .pnj görseli gerçek uzantısıyla (.jpg) kaydedilir", async {
        let info = m.probe(&format!("{base}/img/avatar.pnj"), Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        eq!(info["filename"], "avatar.jpg");
        Ok(())
    })
    .await;

    s.case("video sitesinin dosya sunucusundaki görsel/video video motoruna gitmez", async {
        use grabbit_core::media::is_media_site_url as is_media;
        ensure!(!is_media("https://64.media.tumblr.com/c575/ddec-34/s96x96u_c1/abc095.pnj"));
        ensure!(!is_media("https://i.redd.it/abc.jpg"));
        ensure!(is_media("https://www.tumblr.com/blog/123456789"));
        ensure!(is_media("https://www.youtube.com/watch?v=x"));
        Ok(())
    })
    .await;

    s.case("yoklama önbelleği: aynı adres kısa sürede tekrar yoklanmaz, hata saklanmaz", async {
        SRV.counted_hits.store(0, Ordering::SeqCst);
        let u = format!("{base}/counted.bin");
        let (a, b) = tokio::join!(m.probe(&u, Default::default(), String::new(), None, None), m.probe(&u, Default::default(), String::new(), None, None));
        m.probe(&u, Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        eq!(SRV.counted_hits.load(Ordering::SeqCst), 1);
        eq!(a.unwrap()["size"], SMALL.len());
        eq!(b.unwrap()["size"], SMALL.len());
        SRV.missing_hits.store(0, Ordering::SeqCst);
        let miss = format!("{base}/yok-onbellek.zip");
        ensure!(m.probe(&miss, Default::default(), String::new(), None, None).await.is_err());
        ensure!(m.probe(&miss, Default::default(), String::new(), None, None).await.is_err());
        eq!(SRV.missing_hits.load(Ordering::SeqCst), 2);
        Ok(())
    })
    .await;

    s.case("köprü: ekleme yanıtı yoklamayı beklemez; ön yoklama ucu çalışır", async {
        let adds = Arc::new(Mutex::new(vec![]));
        let prefetches = Arc::new(Mutex::new(vec![]));
        let handler = Arc::new(TestBridge { adds: adds.clone(), prefetches: prefetches.clone() });
        let (bridge, port) = grabbit_core::bridge::start(0, "test", handler).await.map_err(|e| e.to_string())?;
        let at = format!("http://127.0.0.1:{port}");
        let post = |ep: &str, body: Value| {
            reqwest::Client::new().post(format!("{at}{ep}")).header("Content-Type", "application/json").header("X-TI-Browser", "Test").body(body.to_string()).send()
        };
        let t0 = Instant::now();
        let res = post("/add", json!({ "url": "https://example.test/a.zip" })).await.map_err(|e| e.to_string())?;
        eq!(res.status().as_u16(), 200);
        ensure!(t0.elapsed() < Duration::from_millis(1500), "yanıt {:?} sürdü", t0.elapsed());
        let pre = post("/prefetch", json!({ "url": "https://www.youtube.com/watch?v=x", "cookies": [{ "name": "a", "value": "b", "domain": ".youtube.com" }] }))
            .await
            .map_err(|e| e.to_string())?;
        eq!(pre.status().as_u16(), 202);
        let p = prefetches.lock().unwrap().clone();
        eq!(p.len(), 1);
        eq!(p[0].urls[0], "https://www.youtube.com/watch?v=x");
        eq!(p[0].jar.as_ref().unwrap()[0].name, "a");
        eq!(adds.lock().unwrap().len(), 0);
        // Web sayfalarından gelen istekler reddedilir
        let evil = reqwest::Client::new().get(format!("{at}/ping")).header("Origin", "https://evil.test").send().await.map_err(|e| e.to_string())?;
        eq!(evil.status().as_u16(), 403);
        drop(bridge);
        Ok(())
    })
    .await;

    s.case("yt-dlp: eski tek dosyalık kurulum hızlı klasör sürümüne taşınır, değişmeyince yeniden inmez", async {
        let root = tmp.join("tools-test");
        let pkg = |exe: &[u8]| make_zip(&[("yt-dlp.exe", exe), ("_internal/python.dll", b"x")]);
        let set = |z: Vec<u8>| {
            let sums = format!("{}  yt-dlp_win.zip\n{}  yt-dlp.exe\n", sha(&z), "0".repeat(64));
            *SRV.tool_files.lock().unwrap() = (z, sums);
        };
        set(pkg(b"klas\xc3\xb6r s\xc3\xbcr\xc3\xbcm\xc3\xbc"));
        SRV.tool_zip_hits.store(0, Ordering::SeqCst);
        let t = Tools::new(&root.join("data"));
        t.sources.lock().unwrap().ytdlp = Source { url: format!("{base}/tools/yt-dlp_win.zip"), sums: format!("{base}/tools/SHA2-256SUMS"), name: "yt-dlp_win.zip".into() };
        std::fs::create_dir_all(t.ffmpeg_dir()).unwrap();
        std::fs::write(t.ffmpeg_dir().join("ffmpeg.exe"), "").unwrap();
        std::fs::write(t.legacy_ytdlp(), "eski tek dosya").unwrap();
        eq!(t.ytdlp_path(), t.legacy_ytdlp());

        t.maybe_update().await;
        eq!(t.ytdlp_path(), t.ytdlp_dir().join("yt-dlp.exe"));
        eq!(std::fs::read_to_string(t.ytdlp_path()).unwrap(), "klasör sürümü");
        ensure!(t.ytdlp_dir().join("_internal").join("python.dll").exists());
        ensure!(!t.legacy_ytdlp().exists(), "eski dosya silinmeli");
        eq!(SRV.tool_zip_hits.load(Ordering::SeqCst), 1);

        // Süre dolsa da yayın değişmediyse indirilmez
        std::fs::write(t.dir.join("updated"), "0").unwrap();
        t.maybe_update().await;
        eq!(SRV.tool_zip_hits.load(Ordering::SeqCst), 1);

        // Yeni sürüm yayınlanınca yenisiyle değiştirilir
        set(pkg("yeni sürüm".as_bytes()));
        std::fs::write(t.dir.join("updated"), "0").unwrap();
        t.maybe_update().await;
        eq!(SRV.tool_zip_hits.load(Ordering::SeqCst), 2);
        eq!(std::fs::read_to_string(t.ytdlp_path()).unwrap(), "yeni sürüm");
        let mut names: Vec<String> = std::fs::read_dir(&t.dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        eq!(names, vec!["ffmpeg", "updated", "yt-dlp"]);
        Ok(())
    })
    .await;

    // ---- video siteleri (sahte yt-dlp ile) ----
    let fake_log = tmp.join("fake-ytdlp.log");
    std::env::set_var("FAKE_YTDLP_LOG", &fake_log);
    let yt = "https://www.youtube.com/watch?v=abc123";

    s.case("video sitesi: motor kurulu değilse anlaşılır hata", async {
        let e = m.probe(yt, Default::default(), String::new(), None, None).await;
        ensure!(e.is_err_and(|e| e.key == "err.engineMissing"));
        Ok(())
    })
    .await;

    *m.tools.ytdlp_override.lock().unwrap() = Some(Cmd { program: PathBuf::from(env!("CARGO_BIN_EXE_fake-ytdlp")), args: vec![] });

    s.case("video sitesi: yoklama → başlık ve kaliteler", async {
        let info = m.probe(yt, Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        eq!(info["kind"], "media");
        eq!(info["title"], "Deneme Videosu: Şarkı?");
        let ids: Vec<&str> = info["qualities"].as_array().unwrap().iter().map(|q| q["id"].as_str().unwrap()).collect();
        eq!(ids, vec!["1080", "720", "audio"]);
        eq!(info["filename"], "Deneme Videosu_ Şarkı_.mp4");
        eq!(info["qualities"][0]["size"].as_f64().unwrap(), (4 * 1024 * 1024) as f64); // görüntü + ses
        Ok(())
    })
    .await;

    s.case("video sitesi: 1080p indir, görüntü+ses birleşir", async {
        let info = m.probe(yt, Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        let snap = add1(&m, json!({ "url": yt, "probeInfo": info, "quality": "1080" })).await;
        eq!(snap["kind"], "media");
        eq!(snap["category"], "video");
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(d["filename"], "Deneme Videosu_ Şarkı_.mp4");
        let expected = [fake_bytes(&format!("{yt}137"), 3 * 1024 * 1024), fake_bytes(&format!("{yt}140"), 1024 * 1024)].concat();
        eq!(sha(&read(&d)), sha(&expected));
        let last = log_runs(&fake_log).pop().unwrap();
        ensure!(has_arg(&last, "res:1080,vcodec:h264,ext:mp4:m4a"), "kalite sıralaması iletilmeli");
        ensure!(has_arg(&last, "--load-info-json"), "yoklamadaki bilgi yeniden kullanılmalı");
        ensure!(!has_arg(&last, yt), "adres yeniden çözülmemeli");
        Ok(())
    })
    .await;

    s.case("video sitesi: kayıtlı bilginin süresi dolmuşsa adresle yeniden denenir", async {
        let url = "https://www.youtube.com/watch?v=expired1";
        let info = m.probe(url, Default::default(), String::new(), None, None).await.map_err(|e| e.message())?;
        std::fs::write(&fake_log, "").unwrap();
        let snap = add1(&m, json!({ "url": url, "probeInfo": info, "quality": "720" })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        let runs = log_runs(&fake_log);
        eq!(runs.len(), 2);
        ensure!(has_arg(&runs[0], "--load-info-json"));
        eq!(runs[1]["args"].as_array().unwrap().last().unwrap(), url);
        Ok(())
    })
    .await;

    s.case("video sitesi: yalnızca ses → mp3, Müzik kategorisi", async {
        let snap = add1(&m, json!({ "url": "https://youtu.be/ses123", "quality": "audio", "filename": "Şarkı" })).await;
        eq!(snap["filename"], "Şarkı.mp3");
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        eq!(d["category"], "music");
        eq!(read(&d).len(), 1024 * 1024);
        Ok(())
    })
    .await;

    s.case("video sitesi: duraklat → devam (yarım akıştan sürer)", async {
        std::env::set_var("FAKE_YTDLP_DELAY", "150");
        let url = "https://www.instagram.com/reel/XYZ/";
        let snap = add1(&m, json!({ "url": url, "quality": "1080" })).await;
        let id = snap["id"].as_str().unwrap().to_string();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        m.pause(&[id.clone()]).await;
        let partial = m.get(&id).unwrap().snapshot()["downloaded"].as_u64().unwrap();
        ensure!(partial > 0 && partial < 4 * 1024 * 1024, "kısmi olmalı: {partial}");
        std::env::set_var("FAKE_YTDLP_DELAY", "0");
        m.start(&[id.clone()]);
        let d = wait_for(&m, &id, &["completed", "error"]).await;
        eq!(d["status"], "completed");
        let expected = [fake_bytes(&format!("{url}137"), 3 * 1024 * 1024), fake_bytes(&format!("{url}140"), 1024 * 1024)].concat();
        eq!(sha(&read(&d)), sha(&expected));
        let re = regex::Regex::new(r"\.part$|\.f\d+\.").unwrap();
        let left: Vec<String> = std::fs::read_dir(d["dir"].as_str().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|f| re.is_match(f))
            .collect();
        ensure!(left.is_empty(), "artık dosyalar: {left:?}");
        Ok(())
    })
    .await;

    s.case("video sitesi: çerezler yt-dlp'ye dosyayla gider ve silinir", async {
        std::fs::write(&fake_log, "").unwrap();
        let snap = add1(&m, json!({ "url": "https://www.instagram.com/p/GIZLI/", "quality": "720", "cookie": "sessionid=abc; csrftoken=xyz" })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        let runs = log_runs(&fake_log);
        let dl = runs.iter().find(|r| !has_arg(r, "-J")).unwrap();
        let re = regex::Regex::new(r"\.instagram\.com\tTRUE\t/\tTRUE\t\d+\tsessionid\tabc").unwrap();
        ensure!(re.is_match(dl["cookie"].as_str().unwrap_or("")), "çerez dosyası: {}", dl["cookie"]);
        let args = dl["args"].as_array().unwrap();
        let file = args[args.iter().position(|a| a == "--cookies").unwrap() + 1].as_str().unwrap();
        ensure!(!Path::new(file).exists(), "geçici çerez dosyası silinmeli");
        Ok(())
    })
    .await;

    let jar = json!([
        { "name": "PREF", "value": "f6=40", "domain": "www.youtube.com", "path": "/", "secure": true, "hostOnly": true, "session": true },
        { "name": "SID", "value": "gizli", "domain": ".youtube.com", "path": "/", "secure": true, "hostOnly": false, "expirationDate": 1893456000.5 }
    ]);
    let jar_v: Vec<grabbit_core::http::JarCookie> = serde_json::from_value(jar.clone()).unwrap();

    s.case("YouTube: çerez olsa da önce çerezsiz denenir, indirmede de çerez gitmez", async {
        let mark = log_runs(&fake_log).len();
        let url = "https://www.youtube.com/watch?v=reload1";
        let info = m.probe(url, Default::default(), "SID=gizli".into(), Some("media".into()), Some(jar_v.clone())).await.map_err(|e| e.message())?;
        eq!(info["usedCookies"], false);
        let snap = add1(&m, json!({ "url": url, "probeInfo": info, "quality": "720", "cookie": "SID=gizli", "jar": jar })).await;
        let d = wait_for(&m, snap["id"].as_str().unwrap(), &["completed", "error"]).await;
        eq!(d["status"], "completed");
        let runs = &log_runs(&fake_log)[mark..];
        ensure!(runs.len() >= 2 && runs.iter().all(|r| !has_arg(r, "--cookies")), "hiçbir çağrıda çerez olmamalı");
        Ok(())
    })
    .await;

    s.case("Çerezli deneme \"sayfayı yenileyin\" verirse çerezsiz tekrar denenir", async {
        let mark = log_runs(&fake_log).len();
        let info = m
            .probe("https://www.instagram.com/reel/reload2/", Default::default(), "sessionid=x".into(), Some("media".into()), None)
            .await
            .map_err(|e| e.message())?;
        eq!(info["usedCookies"], false);
        let flags: Vec<bool> = log_runs(&fake_log)[mark..].iter().map(|r| has_arg(r, "--cookies")).collect();
        eq!(flags, vec![true, false]);
        Ok(())
    })
    .await;

    s.case("Tam çerez listesi Netscape dosyasına alan adı/yol/süre korunarak yazılır", async {
        let file = grabbit_core::media::write_cookie_file(None, "https://www.youtube.com/watch?v=x", Some(&jar_v)).await.unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::remove_file(&file).unwrap();
        let lines: Vec<Vec<&str>> = text.lines().map(|l| l.split('\t').collect()).collect();
        eq!(lines[1], vec!["www.youtube.com", "FALSE", "/", "TRUE", "0", "PREF", "f6=40"]);
        eq!(lines[2], vec![".youtube.com", "TRUE", "/", "TRUE", "1893456000", "SID", "gizli"]);
        Ok(())
    })
    .await;

    s.case("video sitesi: gizli video → anlaşılır hata", async {
        let e = m.probe("https://www.youtube.com/watch?v=private1", Default::default(), String::new(), None, None).await;
        ensure!(e.is_err_and(|e| e.message().contains("gizli")));
        Ok(())
    })
    .await;

    s.case("kalıcılık: kapat/aç sonrası liste geri geliyor", async {
        let count = m.list().len();
        m.shutdown().await;
        let m2 = Manager::new(data_dir.clone(), tmp.join("dl"));
        m2.init().await.map_err(|e| e.message())?;
        eq!(m2.list().len(), count);
        m2.shutdown().await;
        Ok(())
    })
    .await;

    println!("\n{}/{} test geçti", s.results.len() - s.failed, s.results.len());
    let _ = std::fs::remove_dir_all(&tmp);
    assert_eq!(s.failed, 0, "başarısız testler var");
}
