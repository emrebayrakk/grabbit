'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { AppError } = require('./utils');

// Video siteleri motoru: yt-dlp (site çözümleyici) + FFmpeg (görüntü/ses birleştirme).
// İkisi de resmi GitHub sürümlerinden indirilir ve yayınlanan SHA-256 değerleriyle doğrulanır.
const SOURCES = {
  // Klasör sürümü: tek dosyalık yt-dlp.exe her açılışta kendini geçici klasöre açar (~1 sn);
  // klasör sürümü hemen başlar. Yoklama ve indirme ikişer kez çalıştırdığı için fark hissedilir.
  ytdlp: {
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip',
    sums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
    name: 'yt-dlp_win.zip'
  },
  ffmpeg: {
    url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
    sums: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256',
    name: 'ffmpeg-master-latest-win64-gpl-shared.zip'
  }
};
const APPROX_MB = 102;
const UPDATE_EVERY_MS = 3 * 24 * 3600 * 1000; // siteler sık değiştiği için yt-dlp birkaç günde bir güncellenir

class Tools extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = path.join(dataDir, 'tools');
    // Testlerde sahte yt-dlp kullanılabilsin diye komut dışarıdan değiştirilebilir
    this.ytdlpCommand = null; // { cmd, args }
    this.ffmpegOverride = null; // testler için { cmd, args }
    this.sources = SOURCES; // testlerde yerel sunucuya yönlendirilebilir
    this._installing = null;
    this.progress = null;
    this.error = null;
  }

  get ytdlpDir() {
    return path.join(this.dir, 'yt-dlp');
  }

  /** Eski sürümlerin kurduğu tek dosyalık yt-dlp (klasör sürümüne geçilene kadar kullanılır). */
  get legacyYtdlpPath() {
    return path.join(this.dir, 'yt-dlp.exe');
  }

  get ytdlpPath() {
    const fast = path.join(this.ytdlpDir, 'yt-dlp.exe');
    return fs.existsSync(fast) ? fast : this.legacyYtdlpPath;
  }

  get ffmpegDir() {
    return path.join(this.dir, 'ffmpeg');
  }

  /** FFmpeg komutu (ayrı gelen görüntü ve sesi birleştirmek için); kurulu değilse null. */
  ffmpegCommand() {
    if (this.ffmpegOverride) return this.ffmpegOverride;
    const exe = path.join(this.ffmpegDir, 'ffmpeg.exe');
    return fs.existsSync(exe) ? { cmd: exe, args: [] } : null;
  }

  get ready() {
    if (this.ytdlpCommand) return true;
    return fs.existsSync(this.ytdlpPath) && fs.existsSync(path.join(this.ffmpegDir, 'ffmpeg.exe'));
  }

  /** yt-dlp'yi çalıştırmak için komut ve ön argümanlar. */
  /**
   * yt-dlp komutu. YouTube artık imza çözümü için bir JavaScript çalışma ortamı istiyor; ayrıca kurmak
   * yerine Grabbit'in içindeki Node.js kullanılır (Electron, ELECTRON_RUN_AS_NODE ile Node gibi çalışır).
   */
  command() {
    if (this.ytdlpCommand) return { env: process.env, ...this.ytdlpCommand };
    const args = [];
    const env = { ...process.env };
    if (process.versions.electron) {
      args.push('--js-runtimes', `node:${process.execPath}`);
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    return { cmd: this.ytdlpPath, args, env };
  }

  status() {
    return { ready: this.ready, installing: !!this._installing, progress: this.progress, error: this.error, approxMb: APPROX_MB };
  }

  _emit() {
    this.emit('status', this.status());
  }

  install() {
    if (!this._installing) {
      this.error = null;
      this._installing = this._install()
        .catch((err) => {
          this.error = err.message;
          throw err;
        })
        .finally(() => {
          this._installing = null;
          this.progress = null;
          this._emit();
        });
      this._emit();
    }
    return this._installing;
  }

  async _install() {
    await fsp.mkdir(this.dir, { recursive: true });
    if (!fs.existsSync(this.ytdlpPath)) await this._installYtdlp();
    if (!fs.existsSync(path.join(this.ffmpegDir, 'ffmpeg.exe'))) {
      const expected = await expectedHash(this.sources.ffmpeg.sums, this.sources.ffmpeg.name);
      const zip = path.join(this.dir, 'ffmpeg.zip');
      await this._download(this.sources.ffmpeg.url, zip, 'FFmpeg');
      await verify(zip, expected);
      this.progress = { phaseKey: 'tools.extracting', phaseParams: { name: 'FFmpeg' }, received: 0, total: 0 };
      this._emit();
      const out = path.join(this.dir, 'ffmpeg-acilan');
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.mkdir(out, { recursive: true });
      await unzip(zip, out);
      const bin = await findDir(out, (d) => fs.existsSync(path.join(d, 'ffmpeg.exe')));
      if (!bin) throw new AppError('tools.errNoExe');
      await fsp.rm(this.ffmpegDir, { recursive: true, force: true });
      await fsp.rename(bin, this.ffmpegDir);
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.rm(zip, { force: true });
    }
  }

  /** yt-dlp klasör sürümünü indirir, doğrular ve eskisinin yerine koyar (kurulum, güncelleme ve geçiş). */
  async _installYtdlp(expected) {
    const src = this.sources.ytdlp;
    expected = expected || (await expectedHash(src.sums, src.name));
    const zip = path.join(this.dir, 'yt-dlp.zip');
    const fresh = path.join(this.dir, 'yt-dlp-yeni');
    await this._download(src.url, zip, 'yt-dlp');
    await verify(zip, expected);
    this.progress = { phaseKey: 'tools.extracting', phaseParams: { name: 'yt-dlp' }, received: 0, total: 0 };
    this._emit();
    await fsp.rm(fresh, { recursive: true, force: true });
    await fsp.mkdir(fresh, { recursive: true });
    try {
      await unzip(zip, fresh);
      const bin = await findDir(fresh, (d) => fs.existsSync(path.join(d, 'yt-dlp.exe')));
      if (!bin) throw new AppError('tools.errNoExe');
      await fsp.writeFile(path.join(bin, '.sha256'), expected);
      // Çalışan bir yt-dlp eski klasörü kilitliyse değiştirme başarısız olur: eskisi kalır, sonra tekrar denenir
      const old = fs.existsSync(this.ytdlpDir) ? `${this.ytdlpDir}-eski-${Date.now()}` : null;
      if (old) await fsp.rename(this.ytdlpDir, old);
      await fsp.rename(bin, this.ytdlpDir);
      if (old) await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(this.legacyYtdlpPath, { force: true }).catch(() => {});
      await fsp.writeFile(path.join(this.dir, 'updated'), String(Date.now()));
    } finally {
      await fsp.rm(fresh, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(zip, { force: true }).catch(() => {});
    }
  }

  async _download(url, dest, label) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new AppError('tools.errDownload', { name: label, status: res.status });
    const total = Number(res.headers.get('content-length')) || 0;
    const fh = await fsp.open(dest, 'w');
    let received = 0;
    let lastEmit = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value);
        received += value.length;
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          this.progress = { phaseKey: 'tools.downloading', phaseParams: { name: label }, received, total };
          this._emit();
        }
      }
    } finally {
      await fh.close();
    }
    if (total && received !== total) throw new AppError('tools.errIncomplete', { name: label });
  }

  /**
   * yt-dlp'yi arada bir güncelle (YouTube vb. sık değişiyor). Klasör sürümü kendini güncelleyemez:
   * yayınlanan özet değişmişse yenisi indirilir. Eski tek dosyalık kurulum hemen klasör sürümüne taşınır.
   * Hata olursa sessiz geçilir; çalışan sürüm yerinde kalır.
   */
  async maybeUpdate() {
    if (this.ytdlpCommand || !this.ready || this._installing || this._updating) return;
    const legacy = !fs.existsSync(path.join(this.ytdlpDir, 'yt-dlp.exe'));
    const stamp = path.join(this.dir, 'updated');
    const last = Number(await fsp.readFile(stamp, 'utf8').catch(() => 0)) || 0;
    if (!legacy && Date.now() - last < UPDATE_EVERY_MS) return;
    this._updating = true;
    try {
      const src = this.sources.ytdlp;
      const expected = await expectedHash(src.sums, src.name);
      const current = await fsp.readFile(path.join(this.ytdlpDir, '.sha256'), 'utf8').catch(() => '');
      if (legacy || current.trim() !== expected) await this._installYtdlp(expected);
      else await fsp.writeFile(stamp, String(Date.now()));
    } catch {
      /* çevrimdışı ya da dosya kullanımda: bir dahaki sefere */
    } finally {
      this._updating = false;
      this.progress = null;
    }
  }
}

async function expectedHash(sumsUrl, name) {
  const res = await fetch(sumsUrl, { redirect: 'follow' });
  if (!res.ok) throw new AppError('tools.errSums', { status: res.status });
  const text = await res.text();
  for (const line of text.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new AppError('tools.errNoHash', { name });
}

async function verify(file, expected) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (b) => hash.update(b)).on('error', reject).on('end', resolve);
  });
  if (hash.digest('hex') !== expected) {
    await fsp.rm(file, { force: true });
    throw new AppError('tools.errHash');
  }
}

function unzip(zip, dest) {
  // Windows 10+ ile gelen bsdtar zip açabilir; olmazsa PowerShell
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true }, (err) => {
      if (!err) return resolve();
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
        { windowsHide: true },
        (err2) => (err2 ? reject(new AppError('tools.errUnzip')) : resolve())
      );
    });
  });
}

async function findDir(root, pred, depth = 4) {
  if (pred(root)) return root;
  if (depth <= 0) return null;
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = await findDir(path.join(root, e.name), pred, depth - 1);
    if (found) return found;
  }
  return null;
}

module.exports = { Tools, APPROX_MB };
