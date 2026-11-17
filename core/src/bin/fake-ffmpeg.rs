//! Testler için FFmpeg taklidi: "-i görüntü -i ses ... çıktı" alır, çıktıya görüntü+ses baytlarını
//! art arda yazar ve argümanları FAKE_FFMPEG_LOG dosyasına kaydeder.

use std::fs;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(log) = std::env::var("FAKE_FFMPEG_LOG") {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
        writeln!(f, "{}", serde_json::to_string(&args).unwrap()).unwrap();
    }
    let inputs: Vec<&String> = args.iter().enumerate().filter(|(i, a)| *a == "-i" && *i + 1 < args.len()).map(|(i, _)| &args[i + 1]).collect();
    let mut out = vec![];
    for f in inputs {
        out.extend(fs::read(f).unwrap());
    }
    fs::write(args.last().unwrap(), out).unwrap();
}
