//! Tarayıcı eklentisinin bağlandığı yerel sunucu (yalnızca 127.0.0.1).
//! Web sayfaları buraya istek atamasın diye: Origin varsa yalnızca eklenti kökenleri kabul edilir ve
//! JSON içerik türü zorunludur (sayfalardan gelen JSON istekleri CORS ön kontrolüne takılır).

use crate::http::{Headers, JarCookie};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

pub const QUALITIES: [&str; 8] = ["audio", "best", "2160", "1440", "1080", "720", "480", "360"];
const PING_BUDGET: Duration = Duration::from_millis(400);
const ADD_BUDGET: Duration = Duration::from_millis(800);

#[derive(Debug, Clone)]
pub struct AddRequest {
    pub urls: Vec<String>,
    pub kind: Option<String>,
    pub variant_url: Option<String>,
    pub quality: Option<String>,
    pub filename: Option<String>,
    pub cookie: Option<String>,
    pub jar: Option<Vec<JarCookie>>,
    pub headers: Headers,
    pub source: Option<String>,
}

pub trait BridgeHandler: Send + Sync + 'static {
    fn on_add(&self, req: AddRequest);
    fn on_prefetch(&self, req: AddRequest);
    fn on_ping(&self, name: &str, ext_version: &str, verified: bool);
    fn lang(&self) -> String;
}

#[derive(Clone)]
struct Ctx {
    port: u16,
    version: String,
    handler: Arc<dyn BridgeHandler>,
    /// Tarayıcının gerçek adı arka planda bulunur ve tanıtılan ada göre saklanır:
    /// istekler bunu beklemez, son bilinen adı kullanır.
    known: Arc<Mutex<HashMap<String, String>>>,
}

pub struct Bridge {
    stop: Option<oneshot::Sender<()>>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

/// Sunucuyu başlatır; port kullanılıyorsa hata döner.
pub async fn start(port: u16, version: &str, handler: Arc<dyn BridgeHandler>) -> std::io::Result<(Bridge, u16)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?.port();
    let ctx = Ctx { port: bound, version: version.into(), handler, known: Arc::default() };
    let app = axum::Router::new().fallback(handle).with_state(ctx);
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok((Bridge { stop: Some(tx) }, bound))
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

async fn handle(
    State(ctx): State<Ctx>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let origin = h("origin");
    let ext_origin = ["chrome-extension://", "moz-extension://", "edge-extension://", "safari-web-extension://"];
    if !origin.is_empty() && !ext_origin.iter().any(|p| origin.to_lowercase().starts_with(p)) {
        return reply(StatusCode::FORBIDDEN, json!({ "ok": false, "error": "forbidden" }));
    }
    let claimed: String = h("x-ti-browser").chars().take(40).collect();
    let ext_version: String = h("x-ti-version").chars().take(20).collect();

    // Bağlantının sahibi olan program (arka planda); bulunan ad tanıtılan ada göre saklanır
    let who = if claimed.is_empty() {
        None
    } else {
        let (claimed, ctx2, ver) = (claimed.clone(), ctx.clone(), ext_version.clone());
        let remote = addr.port();
        Some(tokio::spawn(async move {
            let c = tokio::task::spawn_blocking(move || crate::client::identify(remote, ctx2.port)).await.ok().flatten();
            let (name, verified) = match c.and_then(|c| c.browser) {
                Some(b) => {
                    ctx2.known.lock().unwrap().insert(claimed.clone(), b.clone());
                    (b, true)
                }
                None => (claimed, false),
            };
            ctx2.handler.on_ping(&name, &ver, verified);
            (name, verified)
        }))
    };
    let known = ctx.known.lock().unwrap().get(&claimed).cloned();
    // Daha önce tanındıysa beklemeden; ilk kez görülüyorsa kısa bir süre tanınmayı bekle
    let identity = |budget: Duration| async move {
        if let Some(k) = known {
            return Some((k, true));
        }
        match who {
            Some(j) => tokio::time::timeout(budget, j).await.ok().and_then(|r| r.ok()),
            None => None,
        }
    };

    let path = uri.path();
    if method == Method::GET && path == "/ping" {
        let w = identity(PING_BUDGET).await;
        return reply(
            StatusCode::OK,
            json!({
                "ok": true, "app": "Grabbit", "version": ctx.version,
                "browser": w.filter(|(_, v)| *v).map(|(n, _)| n),
                "lang": ctx.handler.lang(),
            }),
        );
    }
    if method == Method::POST && (path == "/add" || path == "/prefetch") {
        if !h("content-type").to_lowercase().starts_with("application/json") {
            return reply(StatusCode::UNSUPPORTED_MEDIA_TYPE, json!({ "ok": false, "error": "json bekleniyor" }));
        }
        let Ok(p) = serde_json::from_slice::<Value>(&body) else {
            return reply(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "json" }));
        };
        let is_http = |v: &Value| {
            v.as_str().filter(|s| {
                let l = s.to_lowercase();
                l.starts_with("http://") || l.starts_with("https://")
            })
            .map(str::to_string)
        };
        let urls: Vec<String> = match p["urls"].as_array() {
            Some(a) => a.iter().filter_map(is_http).take(500).collect(),
            None => is_http(&p["url"]).into_iter().collect(),
        };
        if urls.is_empty() {
            return reply(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "adres yok" }));
        }
        let s = |v: &Value, max: usize| v.as_str().map(|x| x.chars().take(max).collect::<String>());
        let single = urls.len() == 1;
        let mut req = AddRequest {
            kind: p["kind"].as_str().filter(|k| *k == "hls" || *k == "media").map(str::to_string),
            variant_url: is_http(&p["variantUrl"]),
            quality: p["quality"].as_str().filter(|q| QUALITIES.contains(q)).map(str::to_string),
            filename: s(&p["filename"], 200),
            cookie: if single { s(&p["cookie"], 16000) } else { None },
            jar: if single { clean_jar(&p["cookies"]) } else { None },
            headers: Headers { referer: s(&p["referer"], 2000), user_agent: s(&p["userAgent"], 500), origin: None },
            source: None,
            urls,
        };
        if path == "/prefetch" {
            // Video düğmesine gelindi: tıklanmadan önce sayfayı yokla (yalnızca tek adres)
            req.urls.truncate(1);
            ctx.handler.on_prefetch(req);
            return reply(StatusCode::ACCEPTED, json!({ "ok": true }));
        }
        req.source = identity(ADD_BUDGET).await.map(|(n, _)| n).or_else(|| (!claimed.is_empty()).then(|| claimed.clone()));
        // Yanıt beklenmez: yoklama uzun sürebilir ve eklenti 5 sn sonra vazgeçip tarayıcıya indirtir
        // (çift indirme). Kabul edildiği hemen bildirilir, ekleme arka planda sürer.
        ctx.handler.on_add(req);
        return reply(StatusCode::OK, json!({ "ok": true }));
    }
    reply(StatusCode::NOT_FOUND, json!({ "ok": false }))
}

/// Eklentinin gönderdiği çerez listesini doğrular (yalnızca beklenen alanlar, makul boyut).
pub fn clean_jar(list: &Value) -> Option<Vec<JarCookie>> {
    let s = |v: &Value, max: usize| v.as_str().map(|x| x.chars().take(max).collect::<String>()).unwrap_or_default();
    let jar: Vec<JarCookie> = list
        .as_array()?
        .iter()
        .take(300)
        .filter(|c| c["name"].is_string() && c["domain"].is_string())
        .map(|c| JarCookie {
            name: s(&c["name"], 256),
            value: s(&c["value"], 8192),
            domain: s(&c["domain"], 255),
            path: Some(s(&c["path"], 1024)).filter(|p| !p.is_empty()).unwrap_or_else(|| "/".into()),
            secure: c["secure"].as_bool().unwrap_or(false),
            host_only: c["hostOnly"].as_bool().unwrap_or(false),
            session: c["session"].as_bool().unwrap_or(false),
            expiration_date: c["expirationDate"].as_f64().unwrap_or(0.0),
        })
        .collect();
    (!jar.is_empty()).then_some(jar)
}
