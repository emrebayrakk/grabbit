//! Ortak yardımcılar: hata türü, dosya adı, kategori, adres işlemleri.

use crate::i18n;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const PART_EXT: &str = ".tipart";
pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// Kategoriler (sıra önemli: ilk eşleşen kazanır).
pub const CATEGORIES: [(&str, &[&str]); 7] = [
    ("video", &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts", "m2ts"]),
    ("music", &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff"]),
    ("document", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp", "csv", "epub", "md"]),
    ("archive", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zst", "cab"]),
    ("program", &["exe", "msi", "msix", "appx", "apk", "dmg", "pkg", "deb", "rpm", "appimage", "iso", "img"]),
    ("image", &["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "tif", "ico", "heic", "avif", "psd"]),
    ("other", &[]),
];

pub fn mime_ext(ct: &str) -> Option<&'static str> {
    Some(match ct {
        "application/pdf" => "pdf",
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/x-rar-compressed" | "application/vnd.rar" => "rar",
        "application/x-7z-compressed" => "7z",
        "application/gzip" => "gz",
        "application/x-msdownload" => "exe",
        "application/x-msi" => "msi",
        "application/vnd.android.package-archive" => "apk",
        "application/json" => "json",
        "text/html" => "html",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        _ => return None,
    })
}

/// Kullanıcıya gösterilen hata: dil anahtarı ve parametreleriyle saklanır; metin seçili dilde üretilir.
#[derive(Debug, Clone)]
pub struct AppError {
    pub key: String,
    pub params: Value,
    /// Tekrar denemekle düzelmeyecek hata
    pub fatal: bool,
    pub status: Option<u16>,
    /// Anahtarı olmayan (beklenmeyen) hatanın ham metni
    pub raw: Option<String>,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn new(key: &str) -> Self {
        Self { key: key.into(), params: Value::Null, fatal: false, status: None, raw: None }
    }
    pub fn with(key: &str, params: Value) -> Self {
        Self { params, ..Self::new(key) }
    }
    pub fn fatal(key: &str) -> Self {
        Self { fatal: true, ..Self::new(key) }
    }
    pub fn fatal_with(key: &str, params: Value) -> Self {
        Self { fatal: true, params, ..Self::new(key) }
    }
    pub fn raw(msg: impl Into<String>) -> Self {
        Self { key: String::new(), params: Value::Null, fatal: false, status: None, raw: Some(msg.into()) }
    }
    /// HTTP durumu: 5xx, 429 ve 408 geçicidir; diğerleri tekrar denemekle düzelmez.
    pub fn http(status: u16) -> Self {
        let key = match status {
            401 => "err.http401",
            403 => "err.http403",
            404 => "err.http404",
            410 => "err.http410",
            416 => "err.http416",
            429 => "err.http429",
            _ => "err.httpGeneric",
        };
        Self {
            key: key.into(),
            params: json!({ "status": status }),
            fatal: !(status >= 500 || status == 429 || status == 408),
            status: Some(status),
            raw: None,
        }
    }
    pub fn http_key(status: u16, key: &str) -> Self {
        Self { key: key.into(), ..Self::http(status) }
    }
    pub fn into_fatal(mut self) -> Self {
        self.fatal = true;
        self
    }
    /// Seçili dildeki metin.
    pub fn message(&self) -> String {
        match &self.raw {
            Some(r) if self.key.is_empty() => r.clone(),
            _ => i18n::t(&self.key, &self.params),
        }
    }
    /// Arayüze kaydedilen anahtar (anahtarsız hatada None).
    pub fn key_opt(&self) -> Option<String> {
        (!self.key.is_empty()).then(|| self.key.clone())
    }
    pub fn params_opt(&self) -> Value {
        self.params.clone()
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for AppError {}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return AppError::new("err.slowServer");
        }
        // Kaynak zincirinden daha anlaşılır bir neden bul
        let mut text = e.to_string().to_lowercase();
        let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
        while let Some(s) = src {
            text.push(' ');
            text.push_str(&s.to_string().to_lowercase());
            src = s.source();
        }
        let key = if text.contains("dns") || text.contains("no such host") || text.contains("name or service") || text.contains("11001") {
            "err.dns"
        } else if text.contains("refused") || text.contains("10061") {
            "err.refused"
        } else if text.contains("reset") || text.contains("10054") {
            "err.reset"
        } else if text.contains("timed out") || text.contains("10060") {
            "err.timeout"
        } else if text.contains("certificate") || text.contains("cert") {
            "err.cert"
        } else {
            "err.network"
        };
        AppError::new(key)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        match e.kind() {
            PermissionDenied => AppError::new("err.noWrite"),
            StorageFull => AppError::new("err.diskFull"),
            _ if e.raw_os_error() == Some(112) => AppError::new("err.diskFull"), // ERROR_DISK_FULL
            _ => AppError::raw(e.to_string()),
        }
    }
}

pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn category_of(name: &str) -> &'static str {
    let e = ext_of(name);
    CATEGORIES.iter().find(|(_, exts)| exts.contains(&e.as_str())).map(|(k, _)| *k).unwrap_or("other")
}

static RESERVED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$").unwrap());

pub fn sanitize_filename(name: &str) -> String {
    let mut n: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    n = n.trim().trim_end_matches(['.', ' ']).to_string();
    if n.is_empty() {
        n = "download".into();
    }
    if RESERVED.is_match(&n) {
        n = format!("_{n}");
    }
    if n.chars().count() > 180 {
        let e = ext_of(&n);
        let keep = |k: usize| n.chars().take(k).collect::<String>();
        n = if !e.is_empty() && e.len() < 12 { format!("{}.{}", keep(180 - e.len() - 1), e) } else { keep(180) };
    }
    n
}

fn pct_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8().map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

/// Content-Disposition başlığından dosya adı (RFC 5987 dahil). Başlık ham bayt olarak verilir:
/// birçok sunucu UTF-8 baytlarını doğrudan gönderir.
pub fn filename_from_disposition(raw: &[u8]) -> Option<String> {
    let header = match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| b as char).collect(), // latin1
    };
    static STAR: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)filename\*\s*=\s*([^']*)'[^']*'([^;]+)"#).unwrap());
    static QUOTED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)filename\s*=\s*"((?:\\.|[^"])*)""#).unwrap());
    static PLAIN: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)filename\s*=\s*([^;]+)"#).unwrap());
    if let Some(m) = STAR.captures(&header) {
        let v = m[2].trim().trim_matches('"');
        if let Ok(d) = percent_encoding::percent_decode_str(v).decode_utf8() {
            return Some(d.into_owned());
        }
    }
    let m = QUOTED.captures(&header).or_else(|| PLAIN.captures(&header))?;
    let mut v = String::new();
    let mut chars = m[1].trim().chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                v.push(n);
            }
        } else {
            v.push(c);
        }
    }
    (!v.is_empty()).then_some(v)
}

pub fn filename_from_url(url: &str) -> String {
    let Ok(u) = url::Url::parse(url) else { return String::new() };
    let last = u.path_segments().and_then(|mut s| s.rfind(|p| !p.is_empty())).unwrap_or("");
    pct_decode(last)
}

/// "bytes 0-0/1234" → (başlangıç, bitiş, toplam; bilinmiyorsa -1)
pub fn parse_content_range(h: &str) -> Option<(u64, u64, i64)> {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)bytes\s+(\d+)-(\d+)/(\d+|\*)").unwrap());
    let m = RE.captures(h)?;
    let total = if &m[3] == "*" { -1 } else { m[3].parse().ok()? };
    Some((m[1].parse().ok()?, m[2].parse().ok()?, total))
}

pub fn origin_of(url: &str) -> String {
    url::Url::parse(url).map(|u| u.origin().ascii_serialization()).unwrap_or_default()
}

pub fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_default()
}

/// Adresi doğrular ve tam biçime getirir; şemasız adreslere https eklenir.
pub fn normalize_url(url: &str) -> Result<String> {
    let s = url.trim();
    static SCHEME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());
    let candidate = if SCHEME.is_match(s) { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&candidate)
        .map_err(|_| AppError::with("err.badUrl", json!({ "url": s.chars().take(80).collect::<String>() })))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(AppError::new("err.httpOnly"));
    }
    Ok(u.to_string())
}

/// dir içinde, ne diskte ne de `reserved` içinde olan bir dosya yolu bulur: "ad (1).ext" gibi.
pub fn unique_path(dir: &Path, name: &str, reserved: &HashSet<String>) -> Result<PathBuf> {
    let e = ext_of(name);
    let base = if e.is_empty() { name } else { &name[..name.len() - e.len() - 1] };
    for i in 0..10000 {
        let candidate = if i == 0 {
            name.to_string()
        } else if e.is_empty() {
            format!("{base} ({i})")
        } else {
            format!("{base} ({i}).{e}")
        };
        let full = dir.join(&candidate);
        if reserved.contains(&full.to_string_lossy().to_lowercase()) {
            continue;
        }
        let part = PathBuf::from(format!("{}{}", full.display(), PART_EXT));
        if full.exists() || part.exists() {
            continue;
        }
        return Ok(full);
    }
    Err(AppError::new("err.noFilename"))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Pencere açmadan çalışan alt süreç (Windows'ta konsol penceresi görünmesin).
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

pub fn hidden_std_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename("a:b?.txt"), "a_b_.txt");
        assert_eq!(sanitize_filename("con.txt"), "_con.txt");
        assert_eq!(sanitize_filename("  ...  "), "download");
        assert_eq!(
            filename_from_disposition("attachment; filename=\"test.bin\"; filename*=UTF-8''test%20dosyas%C4%B1.bin".as_bytes()).unwrap(),
            "test dosyası.bin"
        );
        assert_eq!(filename_from_disposition("attachment; filename=\"şarkı.mp3\"".as_bytes()).unwrap(), "şarkı.mp3");
        assert_eq!(filename_from_url("https://x.com/a/b%20c.zip?x=1"), "b c.zip");
        assert_eq!(category_of("a.MP4"), "video");
        assert_eq!(parse_content_range("bytes 0-0/1234"), Some((0, 0, 1234)));
        assert_eq!(normalize_url("example.com/a").unwrap(), "https://example.com/a");
        assert!(normalize_url("ftp://x").is_err());
    }
}
