//! Birçok site görselleri küçük önizleme olarak sunar ve boyutu adreste taşır (ör. YouTube "=s64",
//! Tumblr "s64x64", X "name=small"). Bu kurallar aynı görselin büyük/orijinal sürümünün adresini üretir.
//! Adaylar en büyükten başlayarak denenir; hiçbiri yoksa asıl adres kullanılır.

use regex::Regex;
use std::sync::LazyLock;

const IMG_EXT: &str = "(?:jpe?g|png|gif|webp|avif|bmp|pnj|gifv)";

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

/// Görselin büyük sürümleri için aday adresler (en iyiden kötüye). Kural uymazsa boş.
pub fn full_size_candidates(url: &str) -> Vec<String> {
    let Ok(u) = url::Url::parse(url) else { return vec![] };
    if !matches!(u.scheme(), "http" | "https") {
        return vec![];
    }
    let host = u.host_str().unwrap_or("").to_lowercase();
    let path = u.path().to_string();
    let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
    let origin = u.origin().ascii_serialization();
    let mut out: Vec<String> = vec![];
    let mut add = |x: String| {
        if x != url && !out.contains(&x) {
            out.push(x);
        }
    };
    let ends = |h: &str, d: &str| h == d || h.ends_with(&format!(".{d}"));

    // YouTube/Google avatarları: ...=s64-c-k-c0x00ffffff-no-rj, =w120-h90, /s64-c/
    if ends(&host, "ggpht.com") || ends(&host, "googleusercontent.com") {
        static EQ: LazyLock<Regex> = LazyLock::new(|| re(r"=[swh]\d+[^/?#]*$"));
        static EQ_T: LazyLock<Regex> = LazyLock::new(|| re(r"=[swh]\d+[^/]*$"));
        static SEG: LazyLock<Regex> = LazyLock::new(|| re(r"/[swh]\d+(-[\w-]+)?/([^/]+)$"));
        if EQ_T.is_match(&format!("{path}{query}")) {
            add(EQ.replace(url, "=s0").into_owned());
        }
        if SEG.is_match(&path) {
            add(SEG.replace(url, "/s0/$2").into_owned());
        }
    }

    // YouTube küçük resimleri: default / mqdefault / hqdefault / sddefault → maxresdefault
    static YT: LazyLock<Regex> = LazyLock::new(|| re(r"/vi(_webp)?/[^/]+/\w+\.(jpg|webp)$"));
    if ends(&host, "ytimg.com") && YT.is_match(&path) {
        static NAME: LazyLock<Regex> = LazyLock::new(|| re(r"/\w+\.(jpg|webp)$"));
        let base = format!("{origin}{}", NAME.replace(&path.replace("/vi_webp/", "/vi/"), ""));
        for n in ["maxresdefault", "sddefault", "hqdefault"] {
            add(format!("{base}/{n}.jpg"));
        }
    }

    // Tumblr: /s64x64u_c1/foto.jpg → s2048x3072; eski tumblr_xxx_500.jpg → _1280; avatar_xxx_64.pnj → _512
    if ends(&host, "tumblr.com") {
        static PNJ: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\.pnj($|[?#])"));
        static GIFV: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\.gifv($|[?#])"));
        static SIZED: LazyLock<Regex> = LazyLock::new(|| re(r"/s\d+x\d+\w*/"));
        static OLD: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)_\d{{2,4}}(\.{IMG_EXT})($|[?#])")));
        // .pnj / .gifv tarayıcı dışı isteklere HTML dönebilir: doğrudan .png / .gif sürümünü de dene
        let plain = |x: &str| GIFV.replace(&PNJ.replace(x, ".png$1"), ".gif$1").into_owned();
        let mut sized = vec![];
        if SIZED.is_match(&path) {
            sized.push(SIZED.replace(url, "/s2048x3072/").into_owned());
        }
        if OLD.is_match(&path) {
            let big = if path.contains("/avatar_") { "512" } else { "1280" };
            sized.push(OLD.replace(url, format!("_{big}$1$2").as_str()).into_owned());
        }
        for s in sized {
            add(plain(&s));
            add(s);
        }
        add(plain(url));
    }

    // X / Twitter: ?format=jpg&name=small → name=orig; foto.jpg:small; profil _normal / _bigger → orijinal
    if host == "pbs.twimg.com" {
        static MEDIA: LazyLock<Regex> = LazyLock::new(|| re(r"^(/media/[^.:]+)(?:\.(\w+))?(?::\w+)?$"));
        if let Some(c) = MEDIA.captures(&path) {
            let fmt = u
                .query_pairs()
                .find(|(k, _)| k == "format")
                .map(|(_, v)| v.into_owned())
                .or_else(|| c.get(2).map(|m| m.as_str().to_string()))
                .unwrap_or_else(|| "jpg".into());
            for name in ["orig", "4096x4096", "large"] {
                add(format!("{origin}{}?format={fmt}&name={name}", &c[1]));
            }
        }
        static PROFILE: LazyLock<Regex> = LazyLock::new(|| re(r"_(normal|bigger|mini|\d+x\d+)(\.\w+)($|[?#])"));
        if PROFILE.is_match(&path) {
            add(PROFILE.replace(url, "$2$3").into_owned());
        }
    }

    // Pinterest: /236x/…, /474x/, /736x/ → /originals/
    static PIN: LazyLock<Regex> = LazyLock::new(|| re(r"^(https?://[^/]+)/\d+x\d*/"));
    if host == "i.pinimg.com" && re(r"^/\d+x\d*/").is_match(&path) {
        add(PIN.replace(url, "$1/originals/").into_owned());
        add(PIN.replace(url, "$1/736x/").into_owned());
    }

    // Reddit önizlemesi: preview.redd.it/ID.jpg?width=… → i.redd.it/ID.jpg
    if host == "preview.redd.it" {
        let name = path.rsplit('/').next().unwrap_or("");
        if re(r"^[\w-]+\.\w+$").is_match(name) {
            add(format!("https://i.redd.it/{}", re(r"^.*-([a-z0-9]{13}\.\w+)$").replace(name, "$1")));
        }
    }

    // Imgur: i.imgur.com/AbCdEfGs.jpg (s/b/t/m/l/h son eki küçük boyuttur) → AbCdEfG.jpg
    if host == "i.imgur.com" {
        if let Some(c) = re(r"^/([A-Za-z0-9]{5,7})[sbtmlh]\.(\w+)$").captures(&path) {
            add(format!("{origin}/{}.{}", &c[1], &c[2]));
        }
    }

    // Wikipedia / Wikimedia küçük resmi: /thumb/a/ab/Dosya.jpg/220px-Dosya.jpg → /a/ab/Dosya.jpg
    if host == "upload.wikimedia.org" && path.contains("/thumb/") {
        add(re(r"/thumb(/[^/]+/[^/]+/[^/]+)/[^/]+$").replace(url, "$1").into_owned());
    }

    // Gravatar ?s=64 → s=2048; Discord ?size=64 → size=4096
    if ends(&host, "gravatar.com") && re(r"[?&](s|size)=\d+").is_match(&query) {
        add(re(r"([?&])(s|size)=\d+").replace(url, "${1}${2}=2048").into_owned());
    }
    let discord = ends(&host, "discordapp.com") || ends(&host, "discordapp.net") || ends(&host, "discord.com");
    if discord && u.query_pairs().any(|(k, _)| k == "size") {
        let mut x = u.clone();
        let pairs: Vec<(String, String)> =
            u.query_pairs().map(|(k, v)| {
                let v = if k == "size" { "4096".to_string() } else { v.into_owned() };
                (k.into_owned(), v)
            }).collect();
        x.query_pairs_mut().clear().extend_pairs(pairs);
        add(x.to_string());
    }

    // WordPress ve benzerleri: foto-150x150.jpg → foto.jpg (orijinal yükleme)
    static WP: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)-\d{{2,4}}x\d{{2,4}}(\.{IMG_EXT})($|[?#])")));
    if WP.is_match(&path) {
        add(WP.replace(url, "$1$2").into_owned());
    }
    // WordPress Jetpack görsel hızlandırıcı: i0.wp.com/…?resize=150,150 / ?w=300 → parametresiz
    if re(r"^i\d\.wp\.com$").is_match(&host) && re(r"[?&](resize|w|h|fit)=").is_match(&query) {
        add(format!("{origin}{path}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::full_size_candidates as c;

    #[test]
    fn rules() {
        assert_eq!(c("https://yt3.ggpht.com/abc=s64-c-k-c0x00ffffff-no-rj")[0], "https://yt3.ggpht.com/abc=s0");
        assert_eq!(c("https://i.ytimg.com/vi/x1/hqdefault.jpg")[0], "https://i.ytimg.com/vi/x1/maxresdefault.jpg");
        assert_eq!(c("https://64.media.tumblr.com/h/k/s64x64u_c1/a.pnj")[0], "https://64.media.tumblr.com/h/k/s2048x3072/a.png");
        assert_eq!(c("https://pbs.twimg.com/media/AbC?format=jpg&name=small")[0], "https://pbs.twimg.com/media/AbC?format=jpg&name=orig");
        assert_eq!(c("https://pbs.twimg.com/profile_images/1/x_normal.jpg")[0], "https://pbs.twimg.com/profile_images/1/x.jpg");
        assert_eq!(c("https://i.pinimg.com/236x/aa/bb.jpg")[0], "https://i.pinimg.com/originals/aa/bb.jpg");
        assert_eq!(c("https://i.imgur.com/AbCdEfGs.jpg")[0], "https://i.imgur.com/AbCdEfG.jpg");
        assert_eq!(c("http://site.test/img/foto-150x150.jpg")[0], "http://site.test/img/foto.jpg");
        assert!(c("https://example.com/a.jpg").is_empty());
    }
}
