//! Yönlendirmeleri elle takip eden istemci ve dosya yoklama. Çerez yalnızca, çerezin alındığı
//! adresle aynı kökene (origin) giden isteklere eklenir; böylece bir sitenin çerezleri başka
//! bir alan adına sızmaz.

use crate::util::{
    ext_of, filename_from_disposition, filename_from_url, mime_ext, origin_of, parse_content_range, sanitize_filename, AppError,
    Result, DEFAULT_UA,
};
use reqwest::{header, Client, Response};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Headers {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl Headers {
    /// Referer varsa aynı kökeni Origin olarak da ekler (çerçevedeki oynatıcılar akışı CORS ile çeker).
    pub fn with_origin(&self) -> Headers {
        let mut h = self.clone();
        if h.origin.is_none() {
            if let Some(r) = &h.referer {
                let o = origin_of(r);
                if !o.is_empty() && o != "null" {
                    h.origin = Some(o);
                }
            }
        }
        h
    }
}

/// Tarayıcının gönderdiği tam çerez kaydı (video motoru için).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JarCookie {
    pub name: String,
    #[serde(default)]
    pub value: String,
    pub domain: String,
    #[serde(default = "root_path")]
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub session: bool,
    #[serde(default)]
    pub expiration_date: f64,
}

fn root_path() -> String {
    "/".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jar: Option<Vec<JarCookie>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl Auth {
    pub fn has_cookies(&self) -> bool {
        self.cookie.as_deref().is_some_and(|c| !c.is_empty()) || self.jar.as_ref().is_some_and(|j| !j.is_empty())
    }
}

pub static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .expect("http istemcisi")
});

const REDIRECTS: [u16; 5] = [301, 302, 303, 307, 308];

/// İstek gönderir; yönlendirmeleri izler. Dönen ikinci değer son adres.
pub async fn request(url: &str, headers: &Headers, auth: &Auth, range: Option<&str>) -> Result<(Response, String)> {
    let mut current = url.to_string();
    for _ in 0..=10 {
        let mut req = CLIENT
            .get(&current)
            .header(header::USER_AGENT, headers.user_agent.as_deref().unwrap_or(DEFAULT_UA))
            .header(header::ACCEPT, "*/*")
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(r) = &headers.referer {
            req = req.header(header::REFERER, r);
        }
        if let Some(o) = &headers.origin {
            req = req.header(header::ORIGIN, o);
        }
        if let (Some(c), Some(o)) = (&auth.cookie, &auth.origin) {
            if !c.is_empty() && origin_of(&current) == *o {
                req = req.header(header::COOKIE, c);
            }
        }
        if let Some(r) = range {
            req = req.header(header::RANGE, r);
        }
        let res = req.send().await?;
        if REDIRECTS.contains(&res.status().as_u16()) {
            let loc = res.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
            let Some(loc) = loc else { return Err(AppError::new("err.noLocation")) };
            current = url::Url::parse(&current)
                .and_then(|base| base.join(&loc))
                .map(|u| u.to_string())
                .map_err(|_| AppError::new("err.noLocation"))?;
            continue;
        }
        return Ok((res, current));
    }
    Err(AppError::new("err.tooManyRedirects"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub final_url: String,
    pub size: i64,
    pub resumable: bool,
    pub content_type: String,
    pub filename: String,
}

pub fn content_type(res: &Response) -> String {
    res.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// Dosyanın adını, boyutunu ve parça parça indirilebilir olup olmadığını öğrenir.
pub async fn probe(url: &str, headers: &Headers, auth: &Auth, timeout: Duration) -> Result<ProbeInfo> {
    tokio::time::timeout(timeout, probe_inner(url, headers, auth))
        .await
        .map_err(|_| AppError::new("err.slowServer"))?
}

async fn probe_inner(url: &str, headers: &Headers, auth: &Auth) -> Result<ProbeInfo> {
    let (mut res, mut final_url) = request(url, headers, auth, Some("bytes=0-0")).await?;
    if matches!(res.status().as_u16(), 416 | 405 | 501) {
        // Bazı sunucular Range'i hiç anlamaz ya da boş dosyada 416 döner
        (res, final_url) = request(url, headers, auth, None).await?;
    }
    let status = res.status().as_u16();
    if !res.status().is_success() {
        return Err(AppError::http(status));
    }
    let mut size = -1i64;
    let mut resumable = false;
    if status == 206 {
        if let Some((_, _, total)) = res.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range) {
            if total >= 0 {
                size = total;
                resumable = true;
            }
        }
    } else if let Some(cl) = res.content_length() {
        size = cl as i64;
    }
    let ct = content_type(&res);
    let mut name = res
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| filename_from_disposition(v.as_bytes()))
        .filter(|s| !s.is_empty())
        .or_else(|| Some(filename_from_url(&final_url)).filter(|s| !s.is_empty()))
        .or_else(|| Some(filename_from_url(url)).filter(|s| !s.is_empty()))
        .unwrap_or_default();
    if !name.is_empty() && ext_of(&name).is_empty() {
        if let Some(e) = mime_ext(&ct) {
            name = format!("{name}.{e}");
        }
    }
    // Tumblr'ın .pnj / .gifv adresleri gerçekte jpg/png/gif döndürür: dosya gerçek uzantıyla açılabilsin
    let e = ext_of(&name);
    if (e == "pnj" || e == "gifv") && ct.starts_with("image/") {
        if let Some(real) = mime_ext(&ct) {
            name = format!("{}.{}", &name[..name.len() - e.len() - 1], real);
        }
    }
    if name.is_empty() {
        name = match mime_ext(&ct) {
            Some(e) => format!("download.{e}"),
            None => "download".into(),
        };
    }
    // Tek baytlık yanıtı okuyup bitirmek bağlantıyı açık tutar: indirmenin ilk bağlantısı
    // TCP/TLS el sıkışmasını yeniden yapmaz. Büyük gövde gelirse bırakılır (bağlantı kapanır).
    if status == 206 && res.content_length().is_some_and(|l| l <= 64 * 1024) {
        let _ = res.bytes().await;
    }
    Ok(ProbeInfo { final_url, size, resumable, content_type: ct, filename: sanitize_filename(&name) })
}
