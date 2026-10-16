'use strict';

// Testler için yt-dlp taklidi: -J ile bilgi verir, indirmede iki akış (görüntü+ses) yazar,
// .part dosyasından devam eder, birleştirir ve son yolu --print-to-file dosyasına yazar.
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// --load-info-json: sayfa yeniden çözülmez, adres kayıtlı bilgiden gelir
const infoJson = opt('--load-info-json');
const url = infoJson ? JSON.parse(fs.readFileSync(infoJson, 'utf8')).webpage_url : args[args.length - 1];
if (process.env.FAKE_YTDLP_LOG) {
  const cookieFile = opt('--cookies');
  fs.appendFileSync(
    process.env.FAKE_YTDLP_LOG,
    JSON.stringify({ args, cookie: cookieFile && fs.existsSync(cookieFile) ? fs.readFileSync(cookieFile, 'utf8') : null }) + '\n'
  );
}

// Kayıtlı bilgideki adreslerin süresi dolmuş gibi davran
if (infoJson && /expired/.test(url)) {
  process.stderr.write('ERROR: unable to download video data: HTTP Error 403: Forbidden\n');
  process.exit(1);
}

// Tarayıcı çerezleriyle çağrılınca YouTube'un verdiği oturum hatasını taklit et
if (/reload/.test(url) && args.includes('--cookies')) {
  process.stderr.write('ERROR: [youtube] reload1: The page needs to be reloaded.\n');
  process.exit(1);
}

if (/private/.test(url)) {
  process.stderr.write('ERROR: [youtube] abc123: Private video. Sign in if you\'ve been granted access to this video\n');
  process.exit(1);
}

// İçerik URL'den türetilir: test aynı baytları bekleyebilsin
const bytes = (seed, n) => {
  const out = Buffer.alloc(n);
  let h = crypto.createHash('sha256').update(seed).digest();
  for (let i = 0; i < n; i += 32) {
    h.copy(out, i, 0, Math.min(32, n - i));
    h = crypto.createHash('sha256').update(h).digest();
  }
  return out;
};
const VIDEO = 3 * 1024 * 1024;
const AUDIO = 1024 * 1024;

if (args.includes('-J')) {
  process.stdout.write(
    JSON.stringify({
      id: 'abc123',
      title: 'Deneme Videosu: Şarkı?',
      extractor_key: 'Youtube',
      uploader: 'Kanal',
      duration: 215,
      webpage_url: url,
      thumbnail: 'https://i.ytimg.com/vi/abc123/hq.jpg',
      formats: [
        { format_id: '140', vcodec: 'none', acodec: 'mp4a', filesize: AUDIO },
        { format_id: '136', vcodec: 'avc1', acodec: 'none', height: 720, filesize: 2 * 1024 * 1024 },
        { format_id: '137', vcodec: 'avc1', acodec: 'none', height: 1080, filesize: VIDEO }
      ]
    })
  );
  process.exit(0);
}

const audioOnly = args.includes('-x');
const ext = audioOnly ? 'mp3' : 'mp4';
const out = opt('-o').replace('%(ext)s', ext).replace(/%%/g, '%');
const printIdx = args.indexOf('--print-to-file');
const printFile = printIdx >= 0 ? args[printIdx + 2] : null;
const streams = audioOnly ? [['140', AUDIO]] : [['137', VIDEO], ['140', AUDIO]];
const delay = Number(process.env.FAKE_YTDLP_DELAY || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const parts = [];
  for (const [fid, size] of streams) {
    const part = out.replace(/\.\w+$/, `.f${fid}.${ext}`);
    parts.push(part);
    const data = bytes(url + fid, size);
    const partFile = part + '.part';
    if (!fs.existsSync(part)) {
      let pos = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
      while (pos < size) {
        const n = Math.min(256 * 1024, size - pos);
        fs.appendFileSync(partFile, data.subarray(pos, pos + n));
        pos += n;
        process.stdout.write(`TIPROG ${pos} ${size} NA ${fid}\n`);
        if (delay) await sleep(delay);
      }
      fs.renameSync(partFile, part);
    }
  }
  process.stdout.write(audioOnly ? `[ExtractAudio] Destination: ${out}\n` : `[Merger] Merging formats into "${out}"\n`);
  fs.writeFileSync(out, Buffer.concat(parts.map((p) => fs.readFileSync(p))));
  for (const p of parts) fs.rmSync(p, { force: true });
  if (printFile) fs.appendFileSync(printFile, out + '\n');
  process.exit(0);
})();
