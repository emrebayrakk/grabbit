//! Testler için yt-dlp taklidi: -J ile bilgi verir, indirmede iki akış (görüntü+ses) yazar,
//! .part dosyasından devam eder, birleştirir ve son yolu --print-to-file dosyasına yazar.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::Path;

/// İçerik adresten türetilir: test aynı baytları bekleyebilsin.
fn bytes(seed: &str, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    let mut h = Sha256::digest(seed.as_bytes()).to_vec();
    while out.len() < n {
        let take = (n - out.len()).min(32);
        out.extend_from_slice(&h[..take]);
        h = Sha256::digest(&h).to_vec();
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    // --load-info-json: sayfa yeniden çözülmez, adres kayıtlı bilgiden gelir
    let info_json = opt("--load-info-json");
    let url = match &info_json {
        Some(f) => serde_json::from_str::<serde_json::Value>(&fs::read_to_string(f).unwrap()).unwrap()["webpage_url"].as_str().unwrap().to_string(),
        None => args.last().cloned().unwrap_or_default(),
    };
    if let Ok(log) = std::env::var("FAKE_YTDLP_LOG") {
        let cookie = opt("--cookies").and_then(|c| fs::read_to_string(c).ok());
        let line = serde_json::json!({ "args": args, "cookie": cookie });
        let mut f = fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
        writeln!(f, "{line}").unwrap();
    }
    let fail = |msg: &str| -> ! {
        eprintln!("{msg}");
        std::process::exit(1);
    };
    // Kayıtlı bilgideki adreslerin süresi dolmuş gibi davran
    if info_json.is_some() && url.contains("expired") {
        fail("ERROR: unable to download video data: HTTP Error 403: Forbidden");
    }
    // Tarayıcı çerezleriyle çağrılınca YouTube'un verdiği oturum hatasını taklit et
    if url.contains("reload") && args.iter().any(|a| a == "--cookies") {
        fail("ERROR: [youtube] reload1: The page needs to be reloaded.");
    }
    if url.contains("private") {
        fail("ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video");
    }
    const VIDEO: usize = 3 * 1024 * 1024;
    const AUDIO: usize = 1024 * 1024;
    if args.iter().any(|a| a == "-J") {
        let info = serde_json::json!({
            "id": "abc123", "title": "Deneme Videosu: Şarkı?", "extractor_key": "Youtube", "uploader": "Kanal",
            "duration": 215, "webpage_url": url, "thumbnail": "https://i.ytimg.com/vi/abc123/hq.jpg",
            "formats": [
                { "format_id": "140", "vcodec": "none", "acodec": "mp4a", "filesize": AUDIO },
                { "format_id": "136", "vcodec": "avc1", "acodec": "none", "height": 720, "filesize": 2 * 1024 * 1024 },
                { "format_id": "137", "vcodec": "avc1", "acodec": "none", "height": 1080, "filesize": VIDEO }
            ]
        });
        print!("{info}");
        return;
    }
    let audio_only = args.iter().any(|a| a == "-x");
    let ext = if audio_only { "mp3" } else { "mp4" };
    let out = opt("-o").unwrap().replace("%(ext)s", ext).replace("%%", "%");
    let print_file = args.iter().position(|a| a == "--print-to-file").and_then(|i| args.get(i + 2)).cloned();
    let streams: Vec<(&str, usize)> = if audio_only { vec![("140", AUDIO)] } else { vec![("137", VIDEO), ("140", AUDIO)] };
    let delay: u64 = std::env::var("FAKE_YTDLP_DELAY").ok().and_then(|d| d.parse().ok()).unwrap_or(0);
    let stem = out.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(out.clone());
    let mut parts = vec![];
    for (fid, size) in streams {
        let part = format!("{stem}.f{fid}.{ext}");
        parts.push(part.clone());
        let data = bytes(&format!("{url}{fid}"), size);
        let part_file = format!("{part}.part");
        if !Path::new(&part).exists() {
            let mut pos = fs::metadata(&part_file).map(|m| m.len() as usize).unwrap_or(0);
            while pos < size {
                let n = (256 * 1024).min(size - pos);
                let mut f = fs::OpenOptions::new().create(true).append(true).open(&part_file).unwrap();
                f.write_all(&data[pos..pos + n]).unwrap();
                pos += n;
                println!("TIPROG {pos} {size} NA {fid}");
                std::io::stdout().flush().unwrap();
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
            }
            fs::rename(&part_file, &part).unwrap();
        }
    }
    if audio_only {
        println!("[ExtractAudio] Destination: {out}");
    } else {
        println!("[Merger] Merging formats into \"{out}\"");
    }
    let mut all = vec![];
    for p in &parts {
        all.extend(fs::read(p).unwrap());
    }
    fs::write(&out, all).unwrap();
    for p in &parts {
        let _ = fs::remove_file(p);
    }
    if let Some(pf) = print_file {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(pf).unwrap();
        writeln!(f, "{out}").unwrap();
    }
}
