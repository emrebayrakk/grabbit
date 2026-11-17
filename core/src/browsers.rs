//! Kurulu Chromium tabanlı tarayıcıları bulur ve eklentiyi kurdurur.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::LazyLock;

/// Eklenti mağazada yayınlanınca kimlikleri buraya yazılır; boşsa geliştirici modu ile kurulum kullanılır.
static STORE: LazyLock<(String, String)> = LazyLock::new(|| {
    let v: Value = serde_json::from_str(include_str!("../extension-store.json")).unwrap_or_default();
    (v["chrome"].as_str().unwrap_or("").to_string(), v["edge"].as_str().unwrap_or("").to_string())
});

const CHROME_UPDATE: &str = "https://clients2.google.com/service/update2/crx";
const EDGE_UPDATE: &str = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

struct Candidate {
    id: &'static str,
    name: &'static str,
    scheme: &'static str,
    exe: &'static [&'static str],
    store: &'static str,
    /// Tarayıcının açılışta okuduğu "harici eklenti" kayıt defteri anahtarı (yönetici izni gerekmez)
    reg_key: Option<&'static str>,
}

const CANDIDATES: [Candidate; 5] = [
    Candidate { id: "chrome", name: "Google Chrome", scheme: "chrome", exe: &[r"Google\Chrome\Application\chrome.exe"], store: "chrome", reg_key: Some(r"Software\Google\Chrome\Extensions") },
    Candidate { id: "edge", name: "Microsoft Edge", scheme: "edge", exe: &[r"Microsoft\Edge\Application\msedge.exe"], store: "edge", reg_key: Some(r"Software\Microsoft\Edge\Extensions") },
    Candidate { id: "brave", name: "Brave", scheme: "brave", exe: &[r"BraveSoftware\Brave-Browser\Application\brave.exe"], store: "chrome", reg_key: Some(r"Software\BraveSoftware\Brave-Browser\Extensions") },
    Candidate { id: "opera", name: "Opera", scheme: "opera", exe: &[r"Programs\Opera\opera.exe", r"Programs\Opera GX\opera.exe"], store: "chrome", reg_key: None },
    Candidate { id: "vivaldi", name: "Vivaldi", scheme: "vivaldi", exe: &[r"Vivaldi\Application\vivaldi.exe"], store: "chrome", reg_key: None },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub id: String,
    pub name: String,
    pub scheme: String,
    pub exe: String,
    pub one_click: bool,
}

struct StoreInfo {
    url: String,
    ext_id: String,
    update_url: &'static str,
}

fn store_for(c: &Candidate) -> Option<StoreInfo> {
    let (chrome, edge) = &*STORE;
    if c.store == "edge" && !edge.is_empty() {
        return Some(StoreInfo { url: format!("https://microsoftedge.microsoft.com/addons/detail/{edge}"), ext_id: edge.clone(), update_url: EDGE_UPDATE });
    }
    // Edge, Chrome Web Mağazası'ndan da kurabilir
    if !chrome.is_empty() && (c.store == "chrome" || c.store == "edge") {
        return Some(StoreInfo { url: format!("https://chromewebstore.google.com/detail/{chrome}"), ext_id: chrome.clone(), update_url: CHROME_UPDATE });
    }
    None
}

fn roots() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect()
}

/// Bilgisayarda kurulu tarayıcıları bulur.
pub fn detect() -> Vec<Browser> {
    let mut found = vec![];
    for c in &CANDIDATES {
        let exe = roots().into_iter().flat_map(|r| c.exe.iter().map(move |rel| r.join(rel))).find(|p| p.exists());
        if let Some(exe) = exe {
            found.push(Browser { id: c.id.into(), name: c.name.into(), scheme: c.scheme.into(), exe: exe.display().to_string(), one_click: store_for(c).is_some() });
        }
    }
    found
}

fn launch(exe: &str, arg: &str) {
    let _ = std::process::Command::new(exe).arg(arg).spawn();
}

/// HKCU altına harici eklenti kaydı: tarayıcı açılışta "Yeni eklenti eklendi" diye sorar.
#[cfg(windows)]
fn register_external(reg_key: Option<&str>, info: &StoreInfo) -> bool {
    let Some(key) = reg_key else { return false };
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    hkcu.create_subkey(format!(r"{key}\{}", info.ext_id))
        .and_then(|(k, _)| k.set_value("update_url", &info.update_url))
        .is_ok()
}

#[cfg(not(windows))]
fn register_external(_: Option<&str>, _: &StoreInfo) -> bool {
    false
}

/// Eklentiyi kurdurur. Mağazada yayınlıysa: kayıt defterine harici eklenti yazar ve mağaza sayfasını açar
/// (tek tık "Ekle"). Değilse: eklentiler sayfasını açar; son adım geliştirici modu ile kullanıcıda.
/// Dönen değer: (mod, kayıt yazıldı mı)
pub fn setup(browser: &Browser) -> (&'static str, bool) {
    let c = CANDIDATES.iter().find(|c| c.id == browser.id);
    if let Some(store) = c.and_then(store_for) {
        let registered = register_external(c.and_then(|c| c.reg_key), &store);
        launch(&browser.exe, &store.url);
        return ("store", registered);
    }
    launch(&browser.exe, &format!("{}://extensions/", browser.scheme));
    ("manual", false)
}
