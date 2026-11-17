//! Windows bildirimleri; tıklanınca verilen iş çalışır (ör. ilgili indirmeyi göster).

pub fn show(identifier: &str, title: &str, body: &str, on_click: Option<Box<dyn FnOnce() + Send + 'static>>) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Sound, Toast};
        // Kurulu olmayan (geliştirme) sürümde Windows bilinmeyen uygulama kimliğinin bildirimini göstermez
        let dev = std::env::current_exe().map(|p| p.to_string_lossy().contains("\\target\\")).unwrap_or(false);
        let app_id = if dev { Toast::POWERSHELL_APP_ID } else { identifier };
        let mut lines = body.splitn(2, '\n');
        let mut toast = Toast::new(app_id).title(title).sound(Some(Sound::Default)).duration(Duration::Short);
        if let Some(l) = lines.next() {
            toast = toast.text1(l);
        }
        if let Some(l) = lines.next() {
            toast = toast.text2(l);
        }
        if let Some(f) = on_click {
            let mut f = Some(f);
            toast = toast.on_activated(move |_| {
                if let Some(f) = f.take() {
                    f();
                }
                Ok(())
            });
        }
        let _ = toast.show();
    }
    #[cfg(not(windows))]
    {
        let _ = (identifier, title, body, on_click);
    }
}
