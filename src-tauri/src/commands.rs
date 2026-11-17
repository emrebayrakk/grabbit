//! Arayüzün çağırdığı komutlar (ui/api.js → window.api).

use crate::app::{self, AppState};
use grabbit_core::browsers;
use grabbit_core::http::{Headers, JarCookie};
use grabbit_core::i18n::{self, t};
use grabbit_core::media::MEDIA_HOSTS;
use grabbit_core::NewEntry;
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

type R = Result<Value, String>;

fn ok<T: serde::Serialize>(v: T) -> R {
    Ok(serde_json::to_value(v).unwrap_or(Value::Null))
}

fn err(e: grabbit_core::util::AppError) -> String {
    e.message()
}

/// Kategori anahtarları (etiketleri arayüz seçili dilde gösterir).
fn categories() -> Value {
    grabbit_core::util::CATEGORIES.iter().map(|(k, _)| (k.to_string(), json!(t(&format!("cat.{k}"), &Value::Null)))).collect::<serde_json::Map<_, _>>().into()
}

fn languages() -> Value {
    i18n::LANGS.iter().map(|(c, n)| (c.to_string(), json!(n))).collect::<serde_json::Map<_, _>>().into()
}

#[tauri::command]
fn state_get(app: State<'_, AppState>) -> R {
    ok(json!({
        "downloads": app.m.list(),
        "stats": app.m.stats(),
        "settings": *app.m.settings(),
        "categories": categories(),
        "bridge": app::bridge_payload(&app),
        "tools": app.m.tools.status(),
        "mediaHosts": MEDIA_HOSTS,
        "language": i18n::lang(),
        "languages": languages(),
        "mica": app.mica,
        "version": app.handle.package_info().version.to_string(),
    }))
}

#[tauri::command]
async fn dl_probe(app: State<'_, AppState>, url: String, headers: Option<Headers>, cookie: Option<String>, kind: Option<String>, jar: Option<Vec<JarCookie>>) -> R {
    app.m.probe(&url, headers.unwrap_or_default(), cookie.unwrap_or_default(), kind, jar).await.map_err(err)
}

#[tauri::command]
fn tools_status(app: State<'_, AppState>) -> R {
    ok(app.m.tools.status())
}

#[tauri::command]
async fn tools_install(app: State<'_, AppState>) -> R {
    app.m.tools.install().await.map_err(err)
}

#[tauri::command]
async fn dl_add(app: State<'_, AppState>, window: WebviewWindow, entries: Vec<NewEntry>) -> R {
    let app = app.inner().clone();
    let start_now = entries.first().map(|e| e.start_now != Some(false)).unwrap_or(true);
    let count = entries.len();
    let res = app.m.add(entries).await;
    let ok_ids: Vec<String> = res.iter().filter(|r| r["id"].is_string()).filter_map(|r| r["id"].as_str().map(str::to_string)).collect();
    let label = window.label().to_string();
    let is_single = app.singles.lock().unwrap().contains_key(&label);
    if is_single && ok_ids.len() == 1 {
        // Bilgi penceresinden başlatıldı: aynı pencere ilerleme ekranına dönüşür
        if let Some(s) = app.singles.lock().unwrap().get_mut(&label) {
            s.download_id = Some(ok_ids[0].clone());
            s.payload = None;
        }
    } else if count == 1 && ok_ids.len() == 1 && start_now && app.m.settings().show_progress_window {
        app::open_single(&app, Some(ok_ids[0].clone()), None);
    }
    ok(res)
}

#[tauri::command]
fn single_state(app: State<'_, AppState>, window: WebviewWindow) -> R {
    let s = app.singles.lock().unwrap().get(window.label()).cloned().ok_or("window not found")?;
    let item = s.download_id.as_ref().and_then(|id| app.m.get(id)).map(|i| i.snapshot());
    ok(json!({
        "payload": s.payload,
        "item": item,
        "settings": *app.m.settings(),
        "tools": app.m.tools.status(),
        "language": i18n::lang(),
        "mica": app.mica,
        "categories": categories(),
    }))
}

// Pencere açan komutlar async olmalı: senkron komut ana iş parçacığında çalışır ve Windows'ta kilitlenir
#[tauri::command]
async fn single_open(app: State<'_, AppState>, id: String) -> R {
    app::open_single(&app, Some(id), None);
    ok(Value::Null)
}

/// Ana penceredeki "Yeni indirme"den video sitesi adresi: kalite seçimi için Dosya bilgisi penceresi.
#[tauri::command]
async fn single_open_info(app: State<'_, AppState>, payload: Value) -> R {
    let mut p = payload;
    if let Some(o) = p.as_object_mut() {
        o.insert("kind".into(), json!("media"));
        o.insert("source".into(), json!("Grabbit"));
    }
    app::open_single(&app, None, Some(p));
    ok(Value::Null)
}

#[tauri::command]
async fn app_show_main(app: State<'_, AppState>) -> R {
    app::show_main(&app.handle);
    ok(Value::Null)
}

#[tauri::command]
fn browsers_list(app: State<'_, AppState>) -> R {
    let paired = app.paired.lock().unwrap().clone();
    let list: Vec<Value> = browsers::detect()
        .into_iter()
        .map(|b| {
            let mut v = serde_json::to_value(&b).unwrap();
            v["paired"] = paired.get(&b.name).cloned().unwrap_or(Value::Null);
            v
        })
        .collect();
    ok(list)
}

#[tauri::command]
fn browsers_setup(app: State<'_, AppState>, id: String) -> R {
    let b = browsers::detect().into_iter().find(|b| b.id == id).ok_or_else(|| t("err.browserNotFound", &Value::Null))?;
    let (mode, registered) = browsers::setup(&b);
    // Geliştirici modu kurulumunda klasör seçme penceresine yapıştırılsın diye
    if mode == "manual" {
        let _ = app.handle.clipboard().write_text(app.extension_dir.display().to_string());
    }
    ok(json!({ "mode": mode, "registered": registered, "extensionDir": app.extension_dir.display().to_string() }))
}

#[tauri::command]
fn dl_start(app: State<'_, AppState>, ids: Vec<String>) -> R {
    app.m.start(&ids);
    ok(Value::Null)
}

#[tauri::command]
async fn dl_pause(app: State<'_, AppState>, ids: Vec<String>) -> R {
    app.m.pause(&ids).await;
    ok(Value::Null)
}

#[tauri::command]
fn dl_start_all(app: State<'_, AppState>) -> R {
    app.m.start_all();
    ok(Value::Null)
}

#[tauri::command]
async fn dl_pause_all(app: State<'_, AppState>) -> R {
    app.m.pause_all().await;
    ok(Value::Null)
}

#[tauri::command]
async fn dl_remove(app: State<'_, AppState>, ids: Vec<String>, delete_files: Option<bool>) -> R {
    app.m.remove(&ids, delete_files.unwrap_or(false)).await;
    ok(Value::Null)
}

#[tauri::command]
async fn dl_redownload(app: State<'_, AppState>, id: String) -> R {
    app.m.redownload(&id).await.map_err(err)?;
    ok(Value::Null)
}

#[tauri::command]
async fn dl_update_url(app: State<'_, AppState>, id: String, url: String) -> R {
    app.m.update_url(&id, &url).await.map_err(err)?;
    ok(Value::Null)
}

#[tauri::command]
fn dl_set_limit(app: State<'_, AppState>, id: String, kbps: Value) -> R {
    let k = kbps.as_f64().or_else(|| kbps.as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0).max(0.0) as u64;
    app.m.set_item_speed_limit(&id, k).map_err(err)?;
    ok(Value::Null)
}

#[tauri::command]
async fn dl_hash(app: State<'_, AppState>, id: String, algo: String) -> R {
    ok(app.m.compute_hash(&id, &algo).await.map_err(err)?)
}

#[tauri::command]
fn dl_expected_hash(app: State<'_, AppState>, id: String, algo: String, expected: Option<String>) -> R {
    app.m.set_expected_hash(&id, &algo, &expected.unwrap_or_default()).map_err(err)?;
    ok(Value::Null)
}

#[tauri::command]
fn dl_open(app: State<'_, AppState>, id: String) -> R {
    let item = app.m.get(&id).ok_or_else(|| t("err.notReady", &Value::Null))?;
    let (status, path) = {
        let d = item.lock();
        (d.status.clone(), d.save_path())
    };
    if status != "completed" {
        return Err(t("err.notReady", &Value::Null));
    }
    app.handle.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    ok(Value::Null)
}

#[tauri::command]
fn dl_show(app: State<'_, AppState>, id: String) -> R {
    let item = app.m.get(&id).ok_or_else(|| t("err.downloadNotFound", &Value::Null))?;
    let (status, path, dir) = {
        let d = item.lock();
        (d.status.clone(), d.save_path(), d.dir.clone())
    };
    if status == "completed" && path.exists() {
        app.handle.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
    } else {
        let _ = std::fs::create_dir_all(&dir);
        app.handle.opener().open_path(dir, None::<&str>).map_err(|e| e.to_string())?;
    }
    ok(Value::Null)
}

#[tauri::command]
async fn settings_set(app: State<'_, AppState>, patch: Value) -> R {
    let app = app.inner().clone();
    let before = app.m.settings().clone();
    let s = app.m.update_settings(&patch);
    if s.theme != before.theme {
        app::apply_theme(&app);
    }
    if s.language != before.language {
        app::apply_language(&app);
        app::reload_windows(&app);
    }
    if s.bridge_enabled != before.bridge_enabled || s.bridge_port != before.bridge_port {
        app::apply_bridge(&app).await;
    }
    ok(s)
}

#[tauri::command]
async fn dialog_folder(app: State<'_, AppState>, window: WebviewWindow, current: Option<String>) -> R {
    use tauri_plugin_dialog::DialogExt;
    let dir = current.filter(|c| !c.is_empty()).unwrap_or_else(|| app.m.settings().download_dir.clone());
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.handle
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(t("main.pickFolder", &Value::Null))
        .set_directory(dir)
        .pick_folder(move |p| {
            let _ = tx.send(p.and_then(|p| p.into_path().ok()));
        });
    ok(rx.await.ok().flatten().map(|p| p.display().to_string()))
}

#[tauri::command]
fn clipboard_read(app: State<'_, AppState>) -> R {
    ok(app.handle.clipboard().read_text().unwrap_or_default())
}

#[tauri::command]
fn clipboard_write(app: State<'_, AppState>, text: String) -> R {
    app.handle.clipboard().write_text(text).map_err(|e| e.to_string())?;
    ok(Value::Null)
}

#[tauri::command]
fn app_open_extension(app: State<'_, AppState>) -> R {
    app.handle.opener().open_path(app.extension_dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    ok(Value::Null)
}

#[tauri::command]
fn app_open_folder(app: State<'_, AppState>, dir: Option<String>) -> R {
    let d = dir.filter(|d| !d.is_empty()).unwrap_or_else(|| app.m.settings().download_dir.clone());
    let _ = std::fs::create_dir_all(&d);
    app.handle.opener().open_path(d, None::<&str>).map_err(|e| e.to_string())?;
    ok(Value::Null)
}

/// Arayüzdeki dış bağlantılar (yalnızca http/https) varsayılan tarayıcıda açılır.
#[tauri::command]
fn app_open_url(app: State<'_, AppState>, url: String) -> R {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("http only".into());
    }
    app.handle.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    ok(Value::Null)
}

#[tauri::command]
fn app_quit(app: State<'_, AppState>) -> R {
    app::quit(&app);
    ok(Value::Null)
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        state_get,
        dl_probe,
        tools_status,
        tools_install,
        dl_add,
        single_state,
        single_open,
        single_open_info,
        app_show_main,
        browsers_list,
        browsers_setup,
        dl_start,
        dl_pause,
        dl_start_all,
        dl_pause_all,
        dl_remove,
        dl_redownload,
        dl_update_url,
        dl_set_limit,
        dl_hash,
        dl_expected_hash,
        dl_open,
        dl_show,
        settings_set,
        dialog_folder,
        clipboard_read,
        clipboard_write,
        app_open_extension,
        app_open_folder,
        app_open_url,
        app_quit
    ]
}
