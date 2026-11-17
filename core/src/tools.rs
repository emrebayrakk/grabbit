//! Video siteleri motoru: yt-dlp (site çözümleyici, hızlı açılan klasör sürümü), FFmpeg (görüntü/ses
//! birleştirme) ve Deno (YouTube'un imza çözümü için JavaScript çalışma ortamı). Hepsi resmi GitHub
//! sürümlerinden indirilir ve yayınlanan SHA-256 değerleriyle doğrulanır.

use crate::util::{AppError, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct Source {
    pub url: String,
    pub sums: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Sources {
    pub ytdlp: Source,
    pub ffmpeg: Source,
    pub deno: Source,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            ytdlp: Source {
                url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip".into(),
                sums: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS".into(),
                name: "yt-dlp_win.zip".into(),
            },
            ffmpeg: Source {
                url: "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip".into(),
                sums: "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256".into(),
                name: "ffmpeg-master-latest-win64-gpl-shared.zip".into(),
            },
            deno: Source {
                url: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip".into(),
                sums: "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip.sha256sum".into(),
                name: "deno-x86_64-pc-windows-msvc.zip".into(),
            },
        }
    }
}

/// Çalıştırılacak program ve ön argümanları.
#[derive(Debug, Clone)]
pub struct Cmd {
    pub program: PathBuf,
    pub args: Vec<String>,
}

const UPDATE_EVERY: Duration = Duration::from_secs(3 * 24 * 3600); // siteler sık değiştiği için
const MB_YTDLP: u32 = 25;
const MB_FFMPEG: u32 = 85;
const MB_DENO: u32 = 43;

type StatusFn = Box<dyn Fn(Value) + Send + Sync>;

pub struct Tools {
    pub dir: PathBuf,
    pub sources: Mutex<Sources>,
    /// Testler için sahte yt-dlp / FFmpeg
    pub ytdlp_override: Mutex<Option<Cmd>>,
    pub ffmpeg_override: Mutex<Option<Cmd>>,
    installing: tokio::sync::Mutex<()>,
    busy: std::sync::atomic::AtomicBool,
    progress: Mutex<Option<Value>>,
    error: Mutex<Option<String>>,
    on_status: Mutex<Option<StatusFn>>,
}

impl Tools {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            dir: data_dir.join("tools"),
            sources: Mutex::new(Sources::default()),
            ytdlp_override: Mutex::new(None),
            ffmpeg_override: Mutex::new(None),
            installing: tokio::sync::Mutex::new(()),
            busy: Default::default(),
            progress: Mutex::new(None),
            error: Mutex::new(None),
            on_status: Mutex::new(None),
        })
    }

    pub fn on_status(&self, f: impl Fn(Value) + Send + Sync + 'static) {
        *self.on_status.lock().unwrap() = Some(Box::new(f));
    }

    fn emit(&self) {
        if let Some(f) = &*self.on_status.lock().unwrap() {
            f(self.status());
        }
    }

    pub fn ytdlp_dir(&self) -> PathBuf {
        self.dir.join("yt-dlp")
    }
    /// Eski sürümlerin kurduğu tek dosyalık yt-dlp
    pub fn legacy_ytdlp(&self) -> PathBuf {
        self.dir.join("yt-dlp.exe")
    }
    pub fn ytdlp_path(&self) -> PathBuf {
        let fast = self.ytdlp_dir().join("yt-dlp.exe");
        if fast.exists() {
            fast
        } else {
            self.legacy_ytdlp()
        }
    }
    pub fn ffmpeg_dir(&self) -> PathBuf {
        self.dir.join("ffmpeg")
    }
    pub fn deno_path(&self) -> PathBuf {
        self.dir.join("deno").join("deno.exe")
    }

    fn has_ytdlp(&self) -> bool {
        self.ytdlp_path().exists()
    }
    fn has_ffmpeg(&self) -> bool {
        self.ffmpeg_dir().join("ffmpeg.exe").exists()
    }
    fn has_deno(&self) -> bool {
        self.deno_path().exists()
    }

    pub fn ready(&self) -> bool {
        if self.ytdlp_override.lock().unwrap().is_some() {
            return true;
        }
        self.has_ytdlp() && self.has_ffmpeg() && self.has_deno()
    }

    /// Kurulması gereken parçaların yaklaşık boyutu (MB).
    pub fn missing_mb(&self) -> u32 {
        let mut mb = 0;
        if !self.ytdlp_dir().join("yt-dlp.exe").exists() {
            mb += MB_YTDLP;
        }
        if !self.has_ffmpeg() {
            mb += MB_FFMPEG;
        }
        if !self.has_deno() {
            mb += MB_DENO;
        }
        mb
    }

    pub fn status(&self) -> Value {
        json!({
            "ready": self.ready(),
            "installing": self.busy.load(std::sync::atomic::Ordering::SeqCst),
            "progress": self.progress.lock().unwrap().clone(),
            "error": self.error.lock().unwrap().clone(),
            "approxMb": if self.ready() { MB_YTDLP + MB_FFMPEG + MB_DENO } else { self.missing_mb() },
            "parts": { "ytdlp": self.has_ytdlp(), "ffmpeg": self.has_ffmpeg(), "deno": self.has_deno() },
        })
    }

    /// yt-dlp komutu. YouTube'un imza çözümü için Deno, JavaScript çalışma ortamı olarak verilir.
    pub fn ytdlp_command(&self) -> Cmd {
        if let Some(c) = self.ytdlp_override.lock().unwrap().clone() {
            return c;
        }
        let mut args = vec![];
        if self.has_deno() {
            args.push("--js-runtimes".into());
            args.push(format!("deno:{}", self.deno_path().display()));
        }
        Cmd { program: self.ytdlp_path(), args }
    }

    /// FFmpeg komutu; kurulu değilse None.
    pub fn ffmpeg_command(&self) -> Option<Cmd> {
        if let Some(c) = self.ffmpeg_override.lock().unwrap().clone() {
            return Some(c);
        }
        let exe = self.ffmpeg_dir().join("ffmpeg.exe");
        exe.exists().then_some(Cmd { program: exe, args: vec![] })
    }

    fn set_progress(&self, phase: &str, name: &str, received: u64, total: u64) {
        *self.progress.lock().unwrap() = Some(json!({
            "phaseKey": phase, "phaseParams": { "name": name }, "received": received, "total": total
        }));
        self.emit();
    }

    /// Eksik parçaları kurar. Aynı anda tek kurulum çalışır.
    pub async fn install(&self) -> Result<Value> {
        let _guard = self.installing.lock().await;
        if self.ready() {
            return Ok(self.status());
        }
        self.busy.store(true, std::sync::atomic::Ordering::SeqCst);
        *self.error.lock().unwrap() = None;
        self.emit();
        let res = self.install_inner().await;
        self.busy.store(false, std::sync::atomic::Ordering::SeqCst);
        *self.progress.lock().unwrap() = None;
        if let Err(e) = &res {
            *self.error.lock().unwrap() = Some(e.message());
        }
        self.emit();
        res.map(|_| self.status())
    }

    async fn install_inner(&self) -> Result<()> {
        tokio::fs::create_dir_all(&self.dir).await?;
        let sources = self.sources.lock().unwrap().clone();
        if !self.has_ytdlp() {
            self.install_ytdlp(None).await?;
        }
        if !self.has_deno() {
            let expected = expected_hash(&sources.deno.sums, &sources.deno.name).await?;
            self.install_zip(&sources.deno, &expected, "Deno", "deno.exe", &self.dir.join("deno")).await?;
        }
        if !self.has_ffmpeg() {
            let expected = expected_hash(&sources.ffmpeg.sums, &sources.ffmpeg.name).await?;
            self.install_zip(&sources.ffmpeg, &expected, "FFmpeg", "ffmpeg.exe", &self.ffmpeg_dir()).await?;
        }
        Ok(())
    }

    /// Paketi indirir, doğrular, açar ve `exe`'yi içeren klasörü `target` yapar (eskisi silinir).
    async fn install_zip(&self, src: &Source, expected: &str, label: &str, exe: &str, target: &Path) -> Result<()> {
        let zip = self.dir.join(format!("{}.zip", label.to_lowercase()));
        let fresh = self.dir.join(format!("{}-yeni", label.to_lowercase()));
        self.download(&src.url, &zip, label).await?;
        let r = async {
            verify(&zip, expected).await?;
            self.set_progress("tools.extracting", label, 0, 0);
            let _ = tokio::fs::remove_dir_all(&fresh).await;
            let (z, f) = (zip.clone(), fresh.clone());
            tokio::task::spawn_blocking(move || extract(&z, &f)).await.map_err(|e| AppError::raw(e.to_string()))??;
            let bin = find_dir(&fresh, exe, 4).ok_or_else(|| AppError::new("tools.errNoExe"))?;
            if target.exists() {
                // Çalışan bir program eski klasörü kilitliyse değiştirme başarısız olur: eskisi kalır
                let old = PathBuf::from(format!("{}-eski-{}", target.display(), crate::util::now_ms()));
                tokio::fs::rename(target, &old).await?;
                let _ = tokio::fs::remove_dir_all(&old).await;
            }
            tokio::fs::rename(&bin, target).await?;
            Ok::<_, AppError>(())
        }
        .await;
        let _ = tokio::fs::remove_dir_all(&fresh).await;
        let _ = tokio::fs::remove_file(&zip).await;
        r
    }

    async fn install_ytdlp(&self, expected: Option<String>) -> Result<()> {
        let src = self.sources.lock().unwrap().ytdlp.clone();
        let expected = match expected {
            Some(e) => e,
            None => expected_hash(&src.sums, &src.name).await?,
        };
        self.install_zip(&src, &expected, "yt-dlp", "yt-dlp.exe", &self.ytdlp_dir()).await?;
        tokio::fs::write(self.ytdlp_dir().join(".sha256"), &expected).await?;
        let _ = tokio::fs::remove_file(self.legacy_ytdlp()).await;
        tokio::fs::write(self.dir.join("updated"), crate::util::now_ms().to_string()).await?;
        Ok(())
    }

    async fn download(&self, url: &str, dest: &Path, label: &str) -> Result<()> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build()?;
        let res = client.get(url).header("User-Agent", "Grabbit").send().await?;
        if !res.status().is_success() {
            return Err(AppError::with("tools.errDownload", json!({ "name": label, "status": res.status().as_u16() })));
        }
        let total = res.content_length().unwrap_or(0);
        let mut f = tokio::io::BufWriter::new(tokio::fs::File::create(dest).await?);
        let mut received = 0u64;
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            f.write_all(&chunk).await?;
            received += chunk.len() as u64;
            if last.elapsed() > Duration::from_millis(300) {
                last = Instant::now();
                self.set_progress("tools.downloading", label, received, total);
            }
        }
        f.flush().await?;
        if total > 0 && received != total {
            return Err(AppError::with("tools.errIncomplete", json!({ "name": label })));
        }
        Ok(())
    }

    /// yt-dlp'yi arada bir güncelle. Klasör sürümü kendini güncelleyemez: yayınlanan özet değişmişse
    /// yenisi indirilir. Eski tek dosyalık kurulum hemen klasör sürümüne taşınır. Hata olursa sessiz geçilir.
    pub async fn maybe_update(&self) {
        if self.ytdlp_override.lock().unwrap().is_some() || !self.has_ytdlp() {
            return;
        }
        let Ok(_guard) = self.installing.try_lock() else { return };
        let legacy = !self.ytdlp_dir().join("yt-dlp.exe").exists();
        let last: i64 = std::fs::read_to_string(self.dir.join("updated")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        if !legacy && crate::util::now_ms() - last < UPDATE_EVERY.as_millis() as i64 {
            return;
        }
        let src = self.sources.lock().unwrap().ytdlp.clone();
        let Ok(expected) = expected_hash(&src.sums, &src.name).await else { return };
        let current = std::fs::read_to_string(self.ytdlp_dir().join(".sha256")).unwrap_or_default();
        if legacy || current.trim() != expected {
            let _ = self.install_ytdlp(Some(expected)).await;
        } else {
            let _ = tokio::fs::write(self.dir.join("updated"), crate::util::now_ms().to_string()).await;
        }
        *self.progress.lock().unwrap() = None;
    }
}

/// Özet dosyasında paketin SHA-256 değeri. "hash  ad" satırları ya da PowerShell çıktısı ("Hash : …").
pub async fn expected_hash(sums_url: &str, name: &str) -> Result<String> {
    let res = reqwest::Client::new().get(sums_url).header("User-Agent", "Grabbit").send().await?;
    if !res.status().is_success() {
        return Err(AppError::with("tools.errSums", json!({ "status": res.status().as_u16() })));
    }
    let text = res.text().await?;
    parse_sums(&text, name).ok_or_else(|| AppError::with("tools.errNoHash", json!({ "name": name })))
}

pub fn parse_sums(text: &str, name: &str) -> Option<String> {
    let is_hash = |h: &str| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit());
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(h), Some(f)) = (parts.next(), parts.next()) {
            if is_hash(h) && f.trim_start_matches('*') == name {
                return Some(h.to_lowercase());
            }
        }
        if let Some(rest) = line.trim().strip_prefix("Hash") {
            let h = rest.trim_start_matches([' ', ':']).trim();
            if is_hash(h) {
                return Some(h.to_lowercase());
            }
        }
    }
    None
}

async fn verify(file: &Path, expected: &str) -> Result<()> {
    let f = file.to_path_buf();
    let actual = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        std::io::copy(&mut std::fs::File::open(f)?, &mut h)?;
        Ok(hex::encode(h.finalize()))
    })
    .await
    .map_err(|e| AppError::raw(e.to_string()))??;
    if actual != expected {
        let _ = tokio::fs::remove_file(file).await;
        return Err(AppError::new("tools.errHash"));
    }
    Ok(())
}

fn extract(zip: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| AppError::new("tools.errUnzip"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| AppError::new("tools.errUnzip"))?;
        // Zip içinden klasör dışına yazmaya çalışan yolları atla
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut w = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut w)?;
        }
    }
    Ok(())
}

fn find_dir(root: &Path, exe: &str, depth: u32) -> Option<PathBuf> {
    if root.join(exe).exists() {
        return Some(root.to_path_buf());
    }
    if depth == 0 {
        return None;
    }
    for e in std::fs::read_dir(root).ok()?.flatten() {
        if e.file_type().ok()?.is_dir() {
            if let Some(f) = find_dir(&e.path(), exe, depth - 1) {
                return Some(f);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn sums_formats() {
        let h = "a".repeat(64);
        assert_eq!(super::parse_sums(&format!("{h}  yt-dlp_win.zip\n"), "yt-dlp_win.zip"), Some(h.clone()));
        let ps = format!("\nAlgorithm : SHA256\nHash      : {}\nPath      : C:\\x.zip\n", h.to_uppercase());
        assert_eq!(super::parse_sums(&ps, "deno.zip"), Some(h));
    }
}
