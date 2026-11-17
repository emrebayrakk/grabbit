//! Uygulama kabuğu: pencereler, sistem tepsisi, bildirimler, tarayıcı köprüsü, pano izleme.

use crate::notify;
use grabbit_core::bridge::{AddRequest, Bridge, BridgeHandler};
use grabbit_core::i18n::{self, t};
use grabbit_core::util::{ext_of, CATEGORIES};
use grabbit_core::{Event, Manager, NewEntry};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Effect, EffectsBuilder, ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, Manager as _, RunEvent, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const MAIN: &str = "main";

/// Tekli indirme penceresinin durumu (IDM tarzı "Dosya bilgisi" / ilerleme penceresi).
#[derive(Default, Clone)]
pub struct Single {
    pub download_id: Option<String>,
    pub payload: Option<Value>,
}

pub struct App {
    pub handle: AppHandle,
    pub m: Arc<Manager>,
    pub singles: Mutex<HashMap<String, Single>>,
    bridge: Mutex<Option<Bridge>>,
    pub bridge_status: Mutex<Value>,
    /// Eklentisi bağlanan tarayıcılar: ad → { lastSeen, version, verified }
    pub paired: Mutex<Map<String, Value>>,
    quitting: AtomicBool,
    tray_hint_shown: AtomicBool,
    single_seq: AtomicU32,
    pub extension_dir: PathBuf,
    pub mica: bool,
    push_pending: AtomicBool,
}

pub type AppState = Arc<App>;

fn data_dir() -> PathBuf {
    // Taşınabilir kullanım / test için veri klasörü dışarıdan verilebilir
    if let Some(d) = std::env::var_os("GRABBIT_DATA").or_else(|| std::env::var_os("TURBO_INDIR_DATA")) {
        return PathBuf::from(d);
    }
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| dirs::config_dir().unwrap_or_default());
    let dir = appdata.join("Grabbit");
    migrate_from_turbo_indir(&appdata.join("Turbo İndir"), &dir);
    dir
}

/// Uygulamanın eski adı "Turbo İndir" idi: liste, ayarlar, eşleşen tarayıcılar ve video motoru taşınır.
fn migrate_from_turbo_indir(old: &std::path::Path, new: &std::path::Path) {
    if !old.exists() || new.join("settings.json").exists() || new.join("downloads.json").exists() {
        return;
    }
    let _ = std::fs::create_dir_all(new);
    for f in ["settings.json", "downloads.json", "browsers.json"] {
        let _ = std::fs::copy(old.join(f), new.join(f));
    }
    if old.join("tools").exists() && !new.join("tools").exists() {
        let _ = std::fs::rename(old.join("tools"), new.join("tools"));
    }
}

/// Windows 11 22H2+ (yapı 22621) yarı saydam "Mica" zemini destekler; eskilerde düz renk.
fn supports_mica() -> bool {
    #[cfg(windows)]
    {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        let build: String = key.and_then(|k| k.get_value("CurrentBuildNumber")).unwrap_or_default();
        build.parse::<u32>().unwrap_or(0) >= 22621
    }
    #[cfg(not(windows))]
    false
}

fn extension_dir(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("extension")).unwrap_or_default();
    if bundled.join("manifest.json").exists() {
        return bundled;
    }
    // Geliştirme: depo içindeki klasör
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("extension").canonicalize().unwrap_or(bundled)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_async(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(crate::commands::handler())
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            let m = Manager::new(data_dir(), dirs::download_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Downloads")));
            tauri::async_runtime::block_on(m.init()).map_err(|e| e.message())?;
            let paired = std::fs::read(m.data_dir.join("browsers.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok())
                .unwrap_or_default()
                .into_iter()
                // Doğrulanmamış kayıtları at (eski sürümler eklentinin beyanına güveniyordu)
                .filter(|(_, v)| v["verified"].as_bool() == Some(true))
                .collect();
            let app = Arc::new(App {
                extension_dir: extension_dir(&handle),
                handle: handle.clone(),
                m: m.clone(),
                singles: Mutex::default(),
                bridge: Mutex::new(None),
                bridge_status: Mutex::new(json!({ "running": false, "port": 0, "error": null })),
                paired: Mutex::new(paired),
                quitting: AtomicBool::new(false),
                tray_hint_shown: AtomicBool::new(false),
                single_seq: AtomicU32::new(0),
                mica: supports_mica(),
                push_pending: AtomicBool::new(false),
            });
            tauri_app.manage(app.clone());
            apply_language(&app);
            // Köprü pencereden önce açılır: arayüz ilk durumu doğru görsün
            tauri::async_runtime::block_on(apply_bridge(&app));
            if !std::env::args().any(|a| a == "--hidden") {
                create_main(&app)?;
            }
            create_tray(&app)?;
            wire_events(&app);
            start_clipboard_watch(&app);
            // yt-dlp'yi arka planda güncel tut (siteler sık değişir); uygulama günlerce tepside kalabilir
            let mm = m.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    mm.tools.maybe_update().await;
                    tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Grabbit başlatılamadı")
        .run(|handle, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let app = handle.state::<AppState>().inner().clone();
                // Tepsi açıkken uygulama çalışmaya devam eder; çıkışta indirmeler "sırada" kaydedilir
                if code.is_none() && !app.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

/// Çıkış: çalışan indirmeler durdurulur ve açılışta devam edilsin diye kaydedilir.
pub fn quit(app: &AppState) {
    if app.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.m.shutdown().await;
        app.handle.exit(0);
    });
}

// ---------------------------------------------------------------- dil, tema

fn theme_of(s: &str) -> Option<Theme> {
    match s {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}

pub fn apply_language(app: &AppState) {
    let pref = app.m.settings().language.clone();
    let sys = sys_locale::get_locale().unwrap_or_default();
    i18n::set_language(i18n::resolve(&pref, &sys));
    rebuild_tray_menu(app);
}

pub fn apply_theme(app: &AppState) {
    let theme = theme_of(&app.m.settings().theme);
    for w in app.handle.webview_windows().values() {
        let _ = w.set_theme(theme);
    }
}

/// Tüm pencereler yeni dille yeniden çizilsin.
pub fn reload_windows(app: &AppState) {
    for w in app.handle.webview_windows().values() {
        let _ = w.eval("location.reload()");
    }
}

// ---------------------------------------------------------------- pencereler

fn base_window<'a>(app: &'a AppState, label: &'a str, page: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let mut b = WebviewWindowBuilder::new(&app.handle, label, WebviewUrl::App(page.into()))
        .title("Grabbit")
        .decorations(false)
        .theme(theme_of(&app.m.settings().theme));
    if app.mica {
        b = b.transparent(true).effects(EffectsBuilder::new().effect(Effect::Mica).build());
    }
    b
}

fn create_main(app: &AppState) -> tauri::Result<WebviewWindow> {
    let w = base_window(app, MAIN, "index.html").inner_size(1200.0, 760.0).min_inner_size(880.0, 540.0).center().build()?;
    let a = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::CloseRequested { .. } => {
            if !a.quitting.load(Ordering::SeqCst) && a.m.settings().minimize_to_tray {
                // Pencere gizlenmez, kapatılır: arayüz (WebView2) bellekten tamamen çıkar, tepside yalnızca
                // indirme motoru çalışır. Tepsiden açılınca pencere yeniden oluşturulur.
                if !a.tray_hint_shown.swap(true, Ordering::SeqCst) && a.m.settings().notifications {
                    notify::show(&a.handle.config().identifier, &t("main.trayHintTitle", &Value::Null), &t("main.trayHintBody", &Value::Null), None);
                }
            } else {
                quit(&a);
            }
        }
        // Gizliyken gönderilmeyen güncellemeleri pencere görününce eşitle
        WindowEvent::Focused(true) => push_state(&a),
        _ => {}
    });
    Ok(w)
}

/// Pencere oluşturmak ana iş parçacığından yapılırsa Windows'ta kilitlenir (WebView2 aynı iş parçacığını
/// bekler): ana iş parçacığında çalışan olaylardan (tepsi, menü, ikinci örnek) arka plan görevine aktarılır.
pub fn show_main_async(handle: &AppHandle) {
    let h = handle.clone();
    tauri::async_runtime::spawn(async move { show_main(&h) });
}

pub fn show_main(handle: &AppHandle) {
    let app = handle.state::<AppState>().inner().clone();
    let w = match app.handle.get_webview_window(MAIN) {
        Some(w) => w,
        None => match create_main(&app) {
            Ok(w) => w,
            Err(_) => return,
        },
    };
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    push_state(&app);
}

/// Tekli indirme penceresi: tarayıcıdan gelen dosyanın bilgisi ya da bir indirmenin ilerlemesi.
pub fn open_single(app: &AppState, download_id: Option<String>, payload: Option<Value>) {
    if let Some(id) = &download_id {
        let existing = app.singles.lock().unwrap().iter().find(|(_, s)| s.download_id.as_ref() == Some(id)).map(|(l, _)| l.clone());
        if let Some(w) = existing.and_then(|l| app.handle.get_webview_window(&l)) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
    }
    let label = format!("single-{}", app.single_seq.fetch_add(1, Ordering::SeqCst) + 1);
    let height = match &payload {
        Some(p) if p["kind"] == "media" => 540.0,
        Some(_) => 470.0,
        None => 448.0,
    };
    let from_browser = payload.is_some();
    app.singles.lock().unwrap().insert(label.clone(), Single { download_id, payload });
    let built = base_window(app, &label, "single.html")
        .inner_size(560.0, height)
        .resizable(false)
        .maximizable(false)
        .center()
        // Tarayıcıdan gelen soru tarayıcının arkasında kalmasın
        .always_on_top(from_browser)
        .build();
    match built {
        Ok(w) => {
            let a = app.clone();
            let l = label.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    a.singles.lock().unwrap().remove(&l);
                }
            });
            if from_browser {
                let w2 = w.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = w2.set_always_on_top(false);
                });
            }
        }
        Err(_) => {
            app.singles.lock().unwrap().remove(&label);
        }
    }
}

fn on_screen(w: &WebviewWindow) -> bool {
    w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)
}

/// Ana pencere ve tüm tekli pencerelere gönderir.
pub fn broadcast(app: &AppState, channel: &str, payload: Value) {
    let _ = app.handle.emit(channel, payload);
}

pub fn send_main(app: &AppState, channel: &str, payload: Value) {
    let _ = app.handle.emit_to(MAIN, channel, payload);
}

pub fn bridge_payload(app: &AppState) -> Value {
    let mut b = app.bridge_status.lock().unwrap().clone();
    b["paired"] = Value::Object(app.paired.lock().unwrap().clone());
    b
}

fn format_speed(bps: f64) -> String {
    if bps >= 1024.0 * 1024.0 {
        format!("{:.1} MB/s", bps / 1024.0 / 1024.0)
    } else {
        format!("{} KB/s", (bps / 1024.0).round())
    }
}

pub fn push_state(app: &AppState) {
    let stats = app.m.stats();
    // Tam liste yalnızca ana pencere görünürken gönderilir; görünür olunca eşitlenir
    if let Some(w) = app.handle.get_webview_window(MAIN) {
        if on_screen(&w) {
            let _ = app.handle.emit_to(MAIN, "downloads", json!({ "downloads": app.m.list(), "stats": stats }));
        }
        let active = stats["active"].as_u64().unwrap_or(0);
        let p = stats["progress"].as_f64();
        let state = if active == 0 {
            ProgressBarState { status: Some(ProgressBarStatus::None), progress: None }
        } else if let Some(p) = p.filter(|p| *p >= 0.0) {
            ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some((p * 100.0).round() as u64) }
        } else {
            ProgressBarState { status: Some(ProgressBarStatus::Indeterminate), progress: None }
        };
        let _ = w.set_progress_bar(state);
    }
    let singles: Vec<(String, String)> = app.singles.lock().unwrap().iter().filter_map(|(l, s)| s.download_id.clone().map(|d| (l.clone(), d))).collect();
    for (label, id) in singles {
        if let Some(w) = app.handle.get_webview_window(&label) {
            if on_screen(&w) {
                let snap = app.m.get(&id).map(|i| i.snapshot()).unwrap_or(Value::Null);
                // Yalnızca bu pencereye: Window::emit tüm pencerelere gönderir
                let _ = app.handle.emit_to(label.as_str(), "item", snap);
            }
        }
    }
    if let Some(tray) = app.handle.tray_by_id("tray") {
        let active = stats["active"].as_u64().unwrap_or(0);
        let tip = if active > 0 {
            format!("Grabbit — {}", t("main.trayActive", &json!({ "n": active, "speed": format_speed(stats["speed"].as_f64().unwrap_or(0.0)) })))
        } else {
            "Grabbit".into()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

// ---------------------------------------------------------------- tepsi

fn tray_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let n = Value::Null;
    Menu::with_items(
        handle,
        &[
            &MenuItem::with_id(handle, "show", t("main.trayShow", &n), true, None::<&str>)?,
            &MenuItem::with_id(handle, "new", format!("{}…", t("nav.new", &n)), true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "start-all", t("tb.startAll", &n), true, None::<&str>)?,
            &MenuItem::with_id(handle, "pause-all", t("tb.pauseAll", &n), true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "quit", t("main.quit", &n), true, None::<&str>)?,
        ],
    )
}

fn rebuild_tray_menu(app: &AppState) {
    if let (Some(tray), Ok(menu)) = (app.handle.tray_by_id("tray"), tray_menu(&app.handle)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn create_tray(app: &AppState) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray.png"))?;
    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("Grabbit")
        .menu(&tray_menu(&app.handle)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|handle, event| {
            let app = handle.state::<AppState>().inner().clone();
            match event.id().as_ref() {
                "show" => show_main_async(handle),
                "new" => {
                    let a = app.clone();
                    tauri::async_runtime::spawn(async move {
                        show_main(&a.handle);
                        send_main(&a, "open-add", json!({}));
                    });
                }
                "start-all" => app.m.start_all(),
                "pause-all" => {
                    let m = app.m.clone();
                    tauri::async_runtime::spawn(async move { m.pause_all().await });
                }
                "quit" => quit(&app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_async(tray.app_handle());
            }
        })
        .build(&app.handle)?;
    Ok(())
}

// ---------------------------------------------------------------- yönetici olayları

fn wire_events(app: &AppState) {
    let mut rx = app.m.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => Event::Changed,
                Err(_) => break,
            };
            let notifications = app.m.settings().notifications;
            match ev {
                Event::Changed => {
                    // Sık değişiklikler seyreltilir: en fazla 250 ms'de bir gönderilir
                    if !app.push_pending.swap(true, Ordering::SeqCst) {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            a.push_pending.store(false, Ordering::SeqCst);
                            push_state(&a);
                        });
                    }
                }
                Event::Settings(s) => send_main(&app, "settings", s),
                Event::Tools(s) => broadcast(&app, "tools", s),
                Event::Completed(d) if notifications => {
                    let a = app.clone();
                    let id = d["id"].clone();
                    notify::show(
                        &app.handle.config().identifier,
                        &t("single.doneTitle", &Value::Null),
                        d["filename"].as_str().unwrap_or(""),
                        Some(Box::new(move || {
                            tauri::async_runtime::spawn(async move {
                                show_main(&a.handle);
                                send_main(&a, "focus-item", id);
                            });
                        })),
                    );
                }
                Event::Failed(d) if notifications => {
                    let reason = match d["errorKey"].as_str() {
                        Some(k) => t(k, &d["errorParams"]),
                        None => d["error"].as_str().unwrap_or("").to_string(),
                    };
                    let a = app.clone();
                    let id = d["id"].clone();
                    notify::show(
                        &app.handle.config().identifier,
                        &t("single.failTitle", &Value::Null),
                        &format!("{}\n{reason}", d["filename"].as_str().unwrap_or("")),
                        Some(Box::new(move || {
                            tauri::async_runtime::spawn(async move {
                                show_main(&a.handle);
                                send_main(&a, "focus-item", id);
                            });
                        })),
                    );
                }
                Event::Schedule(what) if notifications => {
                    let body = t(if what == "start" { "main.schedStarted" } else { "main.schedStopped" }, &Value::Null);
                    notify::show(&app.handle.config().identifier, &t("settings.tabSchedule", &Value::Null), &body, None);
                }
                _ => {}
            }
        }
    });
}

// ---------------------------------------------------------------- tarayıcı köprüsü

struct AppBridge(AppState);

impl BridgeHandler for AppBridge {
    fn on_add(&self, req: AddRequest) {
        let app = self.0.clone();
        tauri::async_runtime::spawn(async move { handle_bridge_add(&app, req).await });
    }

    fn on_prefetch(&self, req: AddRequest) {
        // Video düğmesine gelinince sayfa önceden yoklanır (motor kuruluysa)
        let m = self.0.m.clone();
        if !m.tools.ready() {
            return;
        }
        tauri::async_runtime::spawn(async move {
            let _ = m.probe(&req.urls[0], req.headers, req.cookie.unwrap_or_default(), Some("media".into()), req.jar).await;
        });
    }

    fn on_ping(&self, name: &str, version: &str, verified: bool) {
        mark_paired(&self.0, name, version, verified);
    }

    fn lang(&self) -> String {
        i18n::lang().into()
    }
}

/// Windows'ta yalnızca bağlantının sahibi olan programdan doğrulanan tarayıcı kaydedilir:
/// eklentinin kendi beyanı yanıltıcı olabilir (Vivaldi kendini Chrome diye tanıtır).
fn mark_paired(app: &AppState, name: &str, version: &str, verified: bool) {
    if cfg!(windows) && !verified {
        return;
    }
    let is_new = {
        let mut p = app.paired.lock().unwrap();
        let prev_version = p.get(name).and_then(|v| v["version"].as_str().map(str::to_string)).unwrap_or_default();
        let is_new = !p.contains_key(name);
        let version = if version.is_empty() { prev_version } else { version.to_string() };
        p.insert(name.into(), json!({ "lastSeen": grabbit_core::util::now_ms(), "version": version, "verified": verified }));
        is_new
    };
    if is_new {
        send_main(app, "bridge", bridge_payload(app));
    }
    let file = app.m.data_dir.join("browsers.json");
    let data = Value::Object(app.paired.lock().unwrap().clone());
    tauri::async_runtime::spawn(async move {
        let _ = tokio::fs::write(file, data.to_string()).await;
    });
}

async fn handle_bridge_add(app: &AppState, req: AddRequest) {
    let (ask, show_progress, notifications) = {
        let s = app.m.settings();
        (s.ask_on_bridge, s.show_progress_window, s.notifications)
    };
    if ask {
        if req.urls.len() == 1 {
            // Yoklama pencere açılırken başlar; pencere aynı sonucu önbellekten alır
            let (m, r) = (app.m.clone(), req.clone());
            tauri::async_runtime::spawn(async move {
                let _ = m.probe(&r.urls[0], r.headers, r.cookie.unwrap_or_default(), r.kind, r.jar).await;
            });
            // IDM'deki "Dosya bilgisi" penceresi: ana pencereyi açmadan sor
            let payload = json!({
                "url": req.urls[0], "filename": req.filename, "cookie": req.cookie, "jar": req.jar,
                "headers": req.headers, "kind": req.kind, "variantUrl": req.variant_url, "quality": req.quality, "source": req.source,
            });
            open_single(app, None, Some(payload));
        } else {
            show_main(&app.handle);
            send_main(app, "open-add", json!({ "urls": req.urls, "headers": req.headers }));
        }
        return;
    }
    let single = req.urls.len() == 1;
    let entries: Vec<NewEntry> = req
        .urls
        .iter()
        .map(|u| NewEntry {
            url: u.clone(),
            filename: if single { req.filename.clone() } else { None },
            cookie: req.cookie.clone(),
            jar: req.jar.clone(),
            headers: Some(req.headers.clone()),
            kind: req.kind.clone(),
            variant_url: req.variant_url.clone(),
            quality: req.quality.clone(),
            ..Default::default()
        })
        .collect();
    let res = app.m.add(entries).await;
    let ok: Vec<&Value> = res.iter().filter(|r| r["id"].is_string()).collect();
    if ok.len() == 1 && show_progress {
        open_single(app, ok[0]["id"].as_str().map(str::to_string), None);
    } else if notifications {
        notify::show(&app.handle.config().identifier, &t("main.addedTitle", &Value::Null), &t("toast.manyQueued", &json!({ "n": ok.len() })), None);
    }
}

pub async fn apply_bridge(app: &AppState) {
    *app.bridge.lock().unwrap() = None; // eskisi kapanır
    let (enabled, port) = {
        let s = app.m.settings();
        (s.bridge_enabled, s.bridge_port)
    };
    *app.bridge_status.lock().unwrap() = json!({ "running": false, "port": port, "error": null });
    if enabled {
        // Eski sunucunun portu bırakması için kısa bir an
        tokio::time::sleep(Duration::from_millis(50)).await;
        let version = app.handle.package_info().version.to_string();
        match grabbit_core::bridge::start(port, &version, Arc::new(AppBridge(app.clone()))).await {
            Ok((b, _)) => {
                *app.bridge.lock().unwrap() = Some(b);
                *app.bridge_status.lock().unwrap() = json!({ "running": true, "port": port, "error": null });
            }
            Err(e) => {
                let in_use = e.kind() == std::io::ErrorKind::AddrInUse || e.raw_os_error() == Some(10048);
                *app.bridge_status.lock().unwrap() = json!({
                    "running": false, "port": port,
                    "error": if in_use { t("bridge.portInUse", &json!({ "port": port })) } else { e.to_string() },
                    "errorKey": if in_use { json!("bridge.portInUse") } else { Value::Null },
                });
            }
        }
    }
    send_main(app, "bridge", bridge_payload(app));
}

// ---------------------------------------------------------------- pano izleme

fn start_clipboard_watch(app: &AppState) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last: Option<String> = None;
        let mut iv = tokio::time::interval(Duration::from_millis(1200));
        loop {
            iv.tick().await;
            // Pano başka bir uygulama tarafından kilitli olabilir
            let text = app.handle.clipboard().read_text().unwrap_or_default();
            if last.is_none() || !app.m.settings().clipboard_watch {
                last = Some(text); // açılıştaki/kapalıyken kopyalananları önerme
                continue;
            }
            if last.as_deref() != Some(text.as_str()) {
                last = Some(text.clone());
                check_clipboard_text(&app, &text);
            }
        }
    });
}

fn check_clipboard_text(app: &AppState, text: &str) {
    if text.is_empty() || text.len() > 20000 {
        return;
    }
    static URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)https?://[^\s"'<>]+"#).unwrap());
    let known: std::collections::HashSet<String> = app.m.list().iter().filter_map(|d| d["url"].as_str().map(str::to_string)).collect();
    let mut urls: Vec<String> = vec![];
    for m in URL.find_iter(text) {
        let u = m.as_str().to_string();
        if known.contains(&u) || urls.contains(&u) {
            continue;
        }
        let e = ext_of(&grabbit_core::util::filename_from_url(&u));
        let ok = !e.is_empty() && CATEGORIES.iter().any(|(_, exts)| exts.contains(&e.as_str()));
        if ok {
            urls.push(u);
        }
    }
    if urls.is_empty() {
        return;
    }
    let visible = app.handle.get_webview_window(MAIN).is_some_and(|w| on_screen(&w));
    if visible {
        send_main(app, "clipboard-urls", json!(urls));
    } else if app.m.settings().notifications {
        let n = urls.len();
        let body = if n == 1 { urls[0].clone() } else { t("add.multi", &json!({ "n": n })) };
        let a = app.clone();
        notify::show(
            &app.handle.config().identifier,
            &t("clip.found", &json!({ "n": n })),
            &body,
            Some(Box::new(move || {
                tauri::async_runtime::spawn(async move {
                    show_main(&a.handle);
                    send_main(&a, "open-add", json!({ "urls": urls }));
                });
            })),
        );
    }
}
