'use strict';

// İndirme motorunu Electron olmadan, yerel bir test sunucusuna karşı doğrular.
// Çalıştırma: npm test

const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { DownloadManager } = require('../src/engine/manager');
const I18N = require('../i18n/i18n');

// Test beklentileri Türkçe hata metinleriyle yazıldı
I18N.setLanguage('tr');

const DATA = crypto.randomBytes(24 * 1024 * 1024 + 12345);
const SMALL = crypto.randomBytes(4 * 1024 * 1024);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// HLS: 40 parça, her biri 64 KB; şifreli sürüm AES-128-CBC
const HLS_SEGS = Array.from({ length: 40 }, () => crypto.randomBytes(64 * 1024));
const HLS_ALL = Buffer.concat(HLS_SEGS);
const HLS_KEY = crypto.randomBytes(16);
const encSeg = (i) => {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(i, 12);
  const c = crypto.createCipheriv('aes-128-cbc', HLS_KEY, iv);
  return Buffer.concat([c.update(HLS_SEGS[i]), c.final()]);
};
const mediaList = (prefix, end = true) =>
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  (prefix === 'e' ? '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' : '') +
  HLS_SEGS.map((_, i) => `#EXTINF:4.0,\n${prefix}${i}.ts`).join('\n') +
  (end ? '\n#EXT-X-ENDLIST\n' : '\n');
// Sesi ayrı akışta olan film sitesi düzeni: Türkçe varsayılan, İngilizce seçenek
const AUD_TR = Array.from({ length: 10 }, () => crypto.randomBytes(16 * 1024));
const AUD_EN = Array.from({ length: 10 }, () => crypto.randomBytes(16 * 1024));
const audioList = (lang) =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + AUD_TR.map((_, i) => `#EXTINF:4.0,\naud-${lang}-${i}.aac`).join('\n') + '\n#EXT-X-ENDLIST\n';
let hlsLowHits = 0;
let hlsSlow = false;

let flakyHits = 0;
let countedHits = 0;
// yt-dlp kurulum/güncelleme sınaması için sunulan paket ve özet dosyası
const toolFiles = { zip: null, sums: '' };
let toolZipHits = 0;
const cookieLog = [];

function serveRange(req, res, buf, extraHeaders = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    if (start >= buf.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...extraHeaders
    });
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Length': buf.length, 'Accept-Ranges': 'bytes', ...extraHeaders });
  res.end(buf);
}

const IMG_SMALL = crypto.randomBytes(2000);
const IMG_BIG = crypto.randomBytes(300000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const img = (buf, type = 'image/jpeg') => serveRange(req, res, buf, { 'Content-Type': type });
  switch (url.pathname) {
    case '/img/foto-150x150.jpg':
    case '/img/yok-150x150.jpg':
    case '/img/sayfa-150x150.jpg':
      return img(IMG_SMALL);
    case '/img/foto.jpg':
      return img(IMG_BIG);
    case '/img/avatar.pnj':
      return img(IMG_SMALL);
    case '/img/sayfa.jpg':
      return img(Buffer.from('<html>giriş yapın</html>'), 'text/html');
  }
  const am = /^\/hls\/aud-(tr|en)-(\d+)\.aac$/.exec(url.pathname);
  if (am) {
    const body = (am[1] === 'tr' ? AUD_TR : AUD_EN)[Number(am[2])];
    res.writeHead(200, { 'Content-Type': 'audio/aac', 'Content-Length': body.length });
    return res.end(body);
  }
  const hm = /^\/hls\/(s|e|l)(\d+)\.ts$/.exec(url.pathname);
  if (hm) {
    if (hm[1] === 'l') hlsLowHits++;
    const body = hm[1] === 'e' ? encSeg(Number(hm[2])) : HLS_SEGS[Number(hm[2])];
    const send = () => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
      res.end(body);
    };
    return hlsSlow ? setTimeout(send, 150) : send();
  }
  switch (url.pathname) {
    case '/hls/master.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhigh.m3u8\n'
      );
    case '/hls/av-master.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n' +
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="aud-en.m3u8"\n' +
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,URI="aud-tr.m3u8"\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="aud"\nhigh.m3u8\n'
      );
    case '/hls/aud-tr.m3u8':
    case '/hls/aud-en.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(audioList(url.pathname.includes('-tr') ? 'tr' : 'en'));
    case '/hls/high.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(mediaList('s'));
    case '/hls/low.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(mediaList('l'));
    case '/hls/enc.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(mediaList('e'));
    case '/hls/live.m3u8':
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(mediaList('s', false));
    case '/hls-guard/live.m3u8':
    case '/hls-guard/video.m3u8': {
      // Çerçevedeki oynatıcıdan gelmeyen istekleri reddeden sunucu (Referer + Origin şart)
      const okHeaders = (req.headers.referer || '').startsWith('http://player.test/') && req.headers.origin === 'http://player.test';
      if (!okHeaders) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(mediaList('s').replace(/s(\d+)\.ts/g, '/hls/s$1.ts'));
    }
    case '/hls/key.bin':
      res.writeHead(200);
      return res.end(HLS_KEY);
    case '/file.bin':
      return serveRange(req, res, DATA, {
        // RFC 5987 ile kodlanmış Türkçe dosya adı
        'Content-Disposition': `attachment; filename="test.bin"; filename*=UTF-8''${encodeURIComponent('test dosyası.bin')}`
      });
    case '/redirect':
      res.writeHead(302, { Location: '/file.bin' });
      return res.end();
    case '/counted.bin':
      countedHits++;
      return serveRange(req, res, SMALL);
    case '/tools/yt-dlp_win.zip':
      toolZipHits++;
      res.writeHead(200, { 'Content-Length': toolFiles.zip.length });
      return res.end(toolFiles.zip);
    case '/tools/SHA2-256SUMS':
      res.writeHead(200);
      return res.end(toolFiles.sums);
    case '/norange.bin':
      res.writeHead(200, { 'Content-Length': SMALL.length });
      return res.end(SMALL);
    case '/chunked': {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      let i = 0;
      const step = 256 * 1024;
      const push = () => {
        if (i >= SMALL.length) return res.end();
        res.write(SMALL.subarray(i, i + step));
        i += step;
        setImmediate(push);
      };
      return push();
    }
    case '/flaky.bin': {
      // İlk 3 istek 1 MB sonra kopar
      flakyHits++;
      if (flakyHits <= 3 && req.headers.range) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : DATA.length - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1 });
        res.write(DATA.subarray(start, Math.min(start + 1024 * 1024, end + 1)));
        return setTimeout(() => res.destroy(), 20);
      }
      return serveRange(req, res, DATA);
    }
    case '/slow.bin':
    case '/a/ayni.bin':
    case '/b/ayni.bin':
      return serveRange(req, res, SMALL);
    case '/cookie-start':
      cookieLog.push({ path: url.pathname, cookie: req.headers.cookie || null });
      res.writeHead(302, { Location: `http://localhost:${server.address().port}/cookie-end` });
      return res.end();
    case '/cookie-end':
      cookieLog.push({ path: url.pathname, cookie: req.headers.cookie || null });
      return serveRange(req, res, SMALL);
    default:
      res.writeHead(404);
      res.end();
  }
});

function waitFor(mgr, id, statuses, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      mgr.off('change', check);
      reject(new Error(`Zaman aşımı; durum: ${mgr.get(id)?.status} ${mgr.get(id)?.error || ''}`));
    }, timeout);
    function check() {
      const d = mgr.get(id);
      if (d && statuses.includes(d.status) && !d.isRunning) {
        clearTimeout(t);
        mgr.off('change', check);
        resolve(d);
      }
    }
    mgr.on('change', check);
    check();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'grabbit-test-'));
  const mgr = new DownloadManager({ dataDir: path.join(tmp, 'data'), defaultDownloadDir: path.join(tmp, 'dl') });
  await mgr.init();
  mgr.updateSettings({ categorize: false, retries: 3, maxConcurrent: 5 });

  const results = [];
  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      results.push(`  ✓ ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push(`  ✗ ${name}: ${err.stack || err}`);
      process.exitCode = 1;
    }
    console.log(results[results.length - 1]);
  }

  await test('çok bağlantılı indirme + Türkçe dosya adı', async () => {
    const [snap] = await mgr.add([{ url: base + '/file.bin', connections: 8 }]);
    assert.strictEqual(snap.filename, 'test dosyası.bin');
    assert.strictEqual(snap.size, DATA.length);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(DATA));
    assert.ok(!fs.existsSync(d.tempPath), 'geçici dosya kalmamalı');
  });

  await test('aynı ad tekrar → "(1)" eki', async () => {
    const [snap] = await mgr.add([{ url: base + '/redirect' }]);
    assert.strictEqual(snap.filename, 'test dosyası (1).bin');
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(DATA));
  });

  await test('Range desteklemeyen sunucu (tek bağlantı)', async () => {
    const [snap] = await mgr.add([{ url: base + '/norange.bin' }]);
    assert.strictEqual(snap.resumable, false);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(SMALL));
  });

  await test('boyutu bilinmeyen (chunked) akış + MIME ile uzantı', async () => {
    const [snap] = await mgr.add([{ url: base + '/chunked' }]);
    assert.strictEqual(snap.filename, 'chunked.pdf');
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(d.size, SMALL.length);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(SMALL));
  });

  await test('kopan bağlantılarda yeniden deneme', async () => {
    const [snap] = await mgr.add([{ url: base + '/flaky.bin', connections: 4 }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(DATA));
  });

  await test('duraklat → devam et → bütünlük', async () => {
    mgr.updateSettings({ speedLimit: 4096 }); // 4 MB/s, duraklatmayı yakalayabilmek için
    const [snap] = await mgr.add([{ url: base + '/file.bin', connections: 6 }]);
    const d = mgr.get(snap.id);
    await new Promise((r) => setTimeout(r, 1500));
    await mgr.pause([snap.id]);
    assert.strictEqual(d.status, 'paused');
    const partial = d.downloaded;
    assert.ok(partial > 0 && partial < DATA.length, `kısmi olmalı: ${partial}`);
    assert.ok(fs.existsSync(d.tempPath));
    mgr.updateSettings({ speedLimit: 0 });
    mgr.start([snap.id]);
    await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(DATA));
  });

  await test('genel hız sınırı (~2 MB/s, 4 MB dosya ≥ 1.5 sn)', async () => {
    mgr.updateSettings({ speedLimit: 2048 });
    const t0 = Date.now();
    const [snap] = await mgr.add([{ url: base + '/slow.bin', connections: 4 }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    const ms = Date.now() - t0;
    mgr.updateSettings({ speedLimit: 0 });
    assert.strictEqual(d.status, 'completed', d.error);
    assert.ok(ms >= 1500, `çok hızlı bitti: ${ms} ms`);
  });

  await test('SHA-256 doğrulama', async () => {
    const [snap] = await mgr.add([{ url: base + '/slow.bin', checksum: { algo: 'sha256', expected: sha(SMALL).toUpperCase() } }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(d.checksum?.ok, true, JSON.stringify(d.checksum));
  });

  await test('çerez başka alan adına sızmıyor', async () => {
    cookieLog.length = 0;
    const [snap] = await mgr.add([{ url: base + '/cookie-start', cookie: 'oturum=gizli' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.ok(cookieLog.some((l) => l.path === '/cookie-start' && l.cookie === 'oturum=gizli'), 'asıl adrese çerez gitmeli');
    assert.ok(cookieLog.filter((l) => l.path === '/cookie-end').every((l) => l.cookie === null), 'başka origin çerez almamalı');
  });

  await test('404 → anlaşılır hata', async () => {
    const [snap] = await mgr.add([{ url: base + '/yok.zip' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'error');
    assert.match(d.error, /404/);
  });

  await test('toplu eklemede aynı adlı dosyalar çakışmıyor', async () => {
    const snaps = await mgr.add([{ url: base + '/a/ayni.bin' }, { url: base + '/b/ayni.bin' }, { url: base + '/a/ayni.bin?x=2' }]);
    const names = snaps.map((s) => s.filename);
    assert.strictEqual(new Set(names).size, 3, 'adlar farklı olmalı: ' + names.join(', '));
    for (const s of snaps) {
      const d = await waitFor(mgr, s.id, ['completed', 'error']);
      assert.strictEqual(d.status, 'completed', d.error);
      assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(SMALL));
    }
  });

  await test('indirme sürerken ilerleme diske kaydediliyor', async () => {
    mgr.progressSaveMs = 500;
    mgr.updateSettings({ speedLimit: 1024 });
    const [snap] = await mgr.add([{ url: base + '/file.bin', connections: 4 }]);
    await new Promise((r) => setTimeout(r, 3500));
    const saved = JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'downloads.json'), 'utf8')).find((x) => x.id === snap.id);
    const persisted = saved.segments.reduce((a, s) => a + s.downloaded, 0);
    await mgr.pause([snap.id]);
    mgr.updateSettings({ speedLimit: 0 });
    mgr.progressSaveMs = 10000;
    assert.strictEqual(saved.status, 'downloading');
    assert.ok(persisted > 512 * 1024, `kaydedilen ilerleme: ${persisted}`);
    await mgr.remove([snap.id]);
  });

  await test('HLS: ana listeden en yüksek kalite + sayfa başlığıyla ad', async () => {
    const info = await mgr.probe(base + '/hls/master.m3u8');
    assert.strictEqual(info.type, 'master');
    assert.deepStrictEqual(info.variants.map((v) => v.resolution), ['1280x720', '640x360']);
    const [snap] = await mgr.add([{ url: base + '/hls/master.m3u8', filename: 'Tatil Videosu' }]);
    assert.strictEqual(snap.filename, 'Tatil Videosu.ts');
    assert.strictEqual(snap.category, 'video');
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(HLS_ALL));
    assert.strictEqual(hlsLowHits, 0, 'düşük kalite indirilmemeli');
    assert.ok(!fs.existsSync(d.partDir), 'parça klasörü silinmeli');
  });

  await test('HLS: seçilen kalite (variantUrl)', async () => {
    const [snap] = await mgr.add([{ url: base + '/hls/master.m3u8', variantUrl: base + '/hls/low.m3u8' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(hlsLowHits, 40);
  });

  await test('HLS: ses ayrı akıştaysa (film siteleri) iner ve görüntüyle birleştirilir', async () => {
    const ffLog = path.join(tmp, 'fake-ffmpeg.log');
    process.env.FAKE_FFMPEG_LOG = ffLog;
    mgr.tools.ffmpegOverride = { cmd: process.execPath, args: [path.join(__dirname, 'fake-ffmpeg.js')] };
    try {
      const [snap] = await mgr.add([{ url: base + '/hls/av-master.m3u8', filename: 'Film' }]);
      const d = await waitFor(mgr, snap.id, ['completed', 'error']);
      assert.strictEqual(d.status, 'completed', d.error);
      assert.strictEqual(d.filename, 'Film.mp4', 'sesli çıktı mp4 olmalı');
      // Varsayılan (Türkçe) ses seçilir; çıktı = görüntü + ses (sahte ffmpeg art arda yazar)
      assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(Buffer.concat([HLS_ALL, ...AUD_TR])));
      const ffArgs = JSON.parse(fs.readFileSync(ffLog, 'utf8').trim());
      assert.deepStrictEqual(ffArgs.slice(ffArgs.indexOf('-map'), ffArgs.indexOf('-map') + 6), ['-map', '0:v', '-map', '1:a', '-c', 'copy']);
      assert.ok(!fs.existsSync(d.partDir), 'parça klasörü silinmeli');
    } finally {
      mgr.tools.ffmpegOverride = null;
    }
  });

  await test('HLS: ayrı ses var ama FFmpeg yoksa indirmeden önce anlaşılır hata', async () => {
    const [snap] = await mgr.add([{ url: base + '/hls/av-master.m3u8', filename: 'Film2' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'error');
    assert.match(d.error, /sesi ayrı/);
    assert.strictEqual(d.downloaded || 0, 0);
  });

  await test('HLS: AES-128 şifreli akış çözülüyor', async () => {
    const [snap] = await mgr.add([{ url: base + '/hls/enc.m3u8' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(HLS_ALL));
  });

  await test('HLS: duraklat → devam (biten parçalar korunur)', async () => {
    hlsSlow = true;
    const [snap] = await mgr.add([{ url: base + '/hls/high.m3u8', connections: 2 }]);
    const d = mgr.get(snap.id);
    await new Promise((r) => setTimeout(r, 1200));
    await mgr.pause([snap.id]);
    const doneBefore = d.doneSegments;
    assert.ok(doneBefore > 0 && doneBefore < 40, `kısmi olmalı: ${doneBefore}`);
    hlsSlow = false;
    mgr.start([snap.id]);
    await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(HLS_ALL));
  });

  await test('HLS: çerçevedeki oynatıcının Referer/Origin bilgisiyle indirilir', async () => {
    const [bad] = await mgr.add([{ url: base + '/hls-guard/video.m3u8' }]);
    const b = await waitFor(mgr, bad.id, ['completed', 'error']);
    assert.strictEqual(b.status, 'error', 'Referer olmadan sunucu reddetmeli');
    const [snap] = await mgr.add([{ url: base + '/hls-guard/video.m3u8', headers: { referer: 'http://player.test/embed/42' } }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(HLS_ALL));
  });

  await test('HLS: canlı yayın reddediliyor', async () => {
    await assert.rejects(() => mgr.probe(base + '/hls/live.m3u8'), /canlı/i);
    const [snap] = await mgr.add([{ url: base + '/hls/live.m3u8' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'error');
    assert.match(d.error, /[Cc]anlı/);
  });

  await test('tam boyut görsel: küçük önizleme yerine orijinal iner', async () => {
    const info = await mgr.probe(base + '/img/foto-150x150.jpg');
    assert.strictEqual(info.upgradedUrl, base + '/img/foto.jpg');
    assert.strictEqual(info.size, IMG_BIG.length);
    const [snap] = await mgr.add([{ url: base + '/img/foto-150x150.jpg', probeInfo: info }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(IMG_BIG));
    assert.strictEqual(d.category, 'image');
  });

  await test('tam boyut görsel: yoklamasız (eklentiden doğrudan) eklemede de büyür', async () => {
    const [snap] = await mgr.add([{ url: base + '/img/foto-150x150.jpg' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.url, base + '/img/foto.jpg');
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(IMG_BIG));
  });

  await test('tam boyut görsel: büyüğü yoksa (404) ya da görsel değilse küçüğü iner', async () => {
    for (const name of ['yok', 'sayfa']) {
      const [snap] = await mgr.add([{ url: base + `/img/${name}-150x150.jpg` }]);
      const d = await waitFor(mgr, snap.id, ['completed', 'error']);
      assert.strictEqual(d.status, 'completed', d.error);
      assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(IMG_SMALL), name);
    }
  });

  await test('tam boyut görsel: ayardan kapatılabilir', async () => {
    mgr.updateSettings({ fullSizeImages: false });
    const info = await mgr.probe(base + '/img/foto-150x150.jpg');
    mgr.updateSettings({ fullSizeImages: true });
    assert.strictEqual(info.upgradedUrl, undefined);
    assert.strictEqual(info.size, IMG_SMALL.length);
  });

  await test('Tumblr .pnj görseli gerçek uzantısıyla (.jpg) kaydedilir', async () => {
    const info = await mgr.probe(base + '/img/avatar.pnj');
    assert.strictEqual(info.filename, 'avatar.jpg');
  });

  await test('video sitesinin dosya sunucusundaki görsel/video video motoruna gitmez', async () => {
    const { isMediaSiteUrl } = require('../src/engine/media');
    const pnj = 'https://64.media.tumblr.com/c575/ddec-34/s96x96u_c1/abc095.pnj';
    assert.strictEqual(isMediaSiteUrl(pnj), false);
    assert.strictEqual(isMediaSiteUrl('https://i.redd.it/abc.jpg'), false);
    assert.strictEqual(isMediaSiteUrl('https://www.tumblr.com/blog/123456789'), true);
    assert.strictEqual(isMediaSiteUrl('https://www.youtube.com/watch?v=x'), true);
    // Eklentideki karşılığı da aynı kararı vermeli
    const vm = require('vm');
    const ctx = vm.createContext({ URL });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sites.js'), 'utf8'), ctx);
    assert.strictEqual(ctx.tiIsMediaPage(pnj), false);
    assert.strictEqual(ctx.tiIsMediaPage('https://www.tumblr.com/blog/123456789'), true);
  });

  await test('eklenti: sağ tıklanan görselin srcset içindeki en büyük sürümü seçilir', async () => {
    const vm = require('vm');
    const ctx = vm.createContext({ URL });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sites.js'), 'utf8'), ctx);
    const T = 'https://64.media.tumblr.com/h/k-34/';
    const best = ctx.tiBestImage({
      src: T + 's96x96u_c1/a.pnj',
      width: 96,
      base: 'https://www.tumblr.com/blog',
      sets: [`${T}s64x64u_c1/b.pnj 64w, ${T}s96x96u_c1/a.pnj 96w, ${T}s512x512u_c1/c.pnj 512w,${T}s128x128u_c1/d.pnj 128w`]
    });
    assert.strictEqual(best, T + 's512x512u_c1/c.pnj');
    // x yoğunluğu, göreli adres ve srcset'siz görsel
    assert.strictEqual(ctx.tiBestImage({ src: 'https://s.test/a.jpg', width: 300, base: 'https://s.test/p/', sets: ['a.jpg 1x, big.jpg 2x'] }), 'https://s.test/p/big.jpg');
    assert.strictEqual(ctx.tiBestImage({ src: 'https://s.test/a.jpg', width: 300, sets: [] }), 'https://s.test/a.jpg');
  });

  await test('yoklama önbelleği: aynı adres kısa sürede tekrar yoklanmaz, hata saklanmaz', async () => {
    countedHits = 0;
    const [a, b] = await Promise.all([mgr.probe(base + '/counted.bin'), mgr.probe(base + '/counted.bin')]);
    await mgr.probe(base + '/counted.bin');
    assert.strictEqual(countedHits, 1, 'tek istek gitmeli');
    assert.strictEqual(a.size, SMALL.length);
    assert.strictEqual(b.size, SMALL.length);
    await assert.rejects(() => mgr.probe(base + '/yok-onbellek.zip'));
    await assert.rejects(() => mgr.probe(base + '/yok-onbellek.zip'));
    assert.ok(!mgr._probes.has(['', base + '/yok-onbellek.zip', false, true].join('\n')), 'hata önbellekte kalmamalı');
  });

  await test('köprü: ekleme yanıtı yoklamayı beklemez; ön yoklama ucu çalışır', async () => {
    const { startBridge } = require('../src/bridge');
    const adds = [];
    const prefetches = [];
    const bridge = startBridge({
      port: 0,
      version: 'test',
      onAdd: (p) => new Promise((r) => setTimeout(() => r(adds.push(p)), 3000)),
      onPrefetch: (p) => prefetches.push(p)
    });
    await new Promise((r) => bridge.once('listening', r));
    const at = `http://127.0.0.1:${bridge.address().port}`;
    const post = (ep, body) =>
      fetch(at + ep, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TI-Browser': 'Test' }, body: JSON.stringify(body) });
    try {
      const t0 = Date.now();
      const res = await post('/add', { url: 'https://example.test/a.zip' });
      assert.strictEqual(res.status, 200);
      assert.ok(Date.now() - t0 < 1500, `yanıt ${Date.now() - t0} ms sürdü`);
      const pre = await post('/prefetch', { url: 'https://www.youtube.com/watch?v=x', cookies: [{ name: 'a', value: 'b', domain: '.youtube.com' }] });
      assert.strictEqual(pre.status, 202);
      assert.strictEqual(prefetches.length, 1);
      assert.strictEqual(prefetches[0].url, 'https://www.youtube.com/watch?v=x');
      assert.strictEqual(prefetches[0].jar[0].name, 'a');
      assert.strictEqual(adds.length, 0, 'ekleme arka planda sürmeli');
    } finally {
      bridge.close();
    }
  });

  await test('yt-dlp: eski tek dosyalık kurulum hızlı klasör sürümüne taşınır, değişmeyince yeniden inmez', async () => {
    const { Tools } = require('../src/engine/tools');
    const root = path.join(tmp, 'tools-test');
    const pkg = path.join(root, 'paket');
    await fsp.mkdir(path.join(pkg, '_internal'), { recursive: true });
    await fsp.writeFile(path.join(pkg, 'yt-dlp.exe'), 'klasör sürümü');
    await fsp.writeFile(path.join(pkg, '_internal', 'python.dll'), 'x');
    const zipFile = path.join(root, 'yt-dlp_win.zip');
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    require('child_process').execFileSync(tar, ['-a', '-c', '-f', zipFile, '-C', pkg, 'yt-dlp.exe', '_internal']);
    toolFiles.zip = await fsp.readFile(zipFile);
    toolFiles.sums = `${sha(toolFiles.zip)}  yt-dlp_win.zip\n${'0'.repeat(64)}  yt-dlp.exe\n`;
    toolZipHits = 0;

    const t = new Tools(path.join(root, 'data'));
    t.sources = { ...t.sources, ytdlp: { url: base + '/tools/yt-dlp_win.zip', sums: base + '/tools/SHA2-256SUMS', name: 'yt-dlp_win.zip' } };
    await fsp.mkdir(t.ffmpegDir, { recursive: true });
    await fsp.writeFile(path.join(t.ffmpegDir, 'ffmpeg.exe'), '');
    await fsp.writeFile(t.legacyYtdlpPath, 'eski tek dosya');
    assert.strictEqual(t.ytdlpPath, t.legacyYtdlpPath);

    await t.maybeUpdate();
    assert.strictEqual(t.ytdlpPath, path.join(t.ytdlpDir, 'yt-dlp.exe'));
    assert.strictEqual(await fsp.readFile(t.ytdlpPath, 'utf8'), 'klasör sürümü');
    assert.ok(fs.existsSync(path.join(t.ytdlpDir, '_internal', 'python.dll')));
    assert.ok(!fs.existsSync(t.legacyYtdlpPath), 'eski dosya silinmeli');
    assert.strictEqual(toolZipHits, 1);

    // Süre dolsa da yayın değişmediyse indirilmez
    await fsp.writeFile(path.join(t.dir, 'updated'), '0');
    await t.maybeUpdate();
    assert.strictEqual(toolZipHits, 1);

    // Yeni sürüm yayınlanınca yenisiyle değiştirilir
    await fsp.writeFile(path.join(pkg, 'yt-dlp.exe'), 'yeni sürüm');
    await fsp.rm(zipFile);
    require('child_process').execFileSync(tar, ['-a', '-c', '-f', zipFile, '-C', pkg, 'yt-dlp.exe', '_internal']);
    toolFiles.zip = await fsp.readFile(zipFile);
    toolFiles.sums = `${sha(toolFiles.zip)}  yt-dlp_win.zip\n`;
    await fsp.writeFile(path.join(t.dir, 'updated'), '0');
    await t.maybeUpdate();
    assert.strictEqual(toolZipHits, 2);
    assert.strictEqual(await fsp.readFile(t.ytdlpPath, 'utf8'), 'yeni sürüm');
    assert.deepStrictEqual((await fsp.readdir(t.dir)).sort(), ['ffmpeg', 'updated', 'yt-dlp']);
  });

  // ---- video siteleri (sahte yt-dlp ile) ----
  const fakeLog = path.join(tmp, 'fake-ytdlp.log');
  process.env.FAKE_YTDLP_LOG = fakeLog;
  const fakeBytes = (seed, n) => {
    const out = Buffer.alloc(n);
    let h = crypto.createHash('sha256').update(seed).digest();
    for (let i = 0; i < n; i += 32) {
      h.copy(out, i, 0, Math.min(32, n - i));
      h = crypto.createHash('sha256').update(h).digest();
    }
    return out;
  };
  const YT = 'https://www.youtube.com/watch?v=abc123';

  await test('video sitesi: motor kurulu değilse anlaşılır hata', async () => {
    await assert.rejects(() => mgr.probe(YT), (e) => e.code === 'TOOLS_MISSING');
  });

  mgr.tools.ytdlpCommand = { cmd: process.execPath, args: [path.join(__dirname, 'fake-ytdlp.js')] };

  await test('video sitesi: yoklama → başlık ve kaliteler', async () => {
    const info = await mgr.probe(YT);
    assert.strictEqual(info.kind, 'media');
    assert.strictEqual(info.title, 'Deneme Videosu: Şarkı?');
    assert.deepStrictEqual(info.qualities.map((q) => q.id), ['1080', '720', 'audio']);
    assert.strictEqual(info.filename, 'Deneme Videosu_ Şarkı_.mp4');
    assert.strictEqual(info.qualities[0].size, 4 * 1024 * 1024); // görüntü + ses
  });

  await test('video sitesi: 1080p indir, görüntü+ses birleşir', async () => {
    const info = await mgr.probe(YT);
    const [snap] = await mgr.add([{ url: YT, probeInfo: info, quality: '1080' }]);
    assert.strictEqual(snap.kind, 'media');
    assert.strictEqual(snap.category, 'video');
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(d.filename, 'Deneme Videosu_ Şarkı_.mp4');
    const expected = Buffer.concat([fakeBytes(YT + '137', 3 * 1024 * 1024), fakeBytes(YT + '140', 1024 * 1024)]);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(expected));
    const lastArgs = JSON.parse(fs.readFileSync(fakeLog, 'utf8').trim().split('\n').pop()).args;
    assert.ok(lastArgs.includes('res:1080,vcodec:h264,ext:mp4:m4a'), 'kalite sıralaması iletilmeli');
    assert.ok(lastArgs.includes('--load-info-json'), 'yoklamadaki bilgi yeniden kullanılmalı (sayfa ikinci kez çözülmez)');
    assert.ok(!lastArgs.includes(YT), 'adres yeniden çözülmemeli');
  });

  await test('video sitesi: kayıtlı bilginin süresi dolmuşsa adresle yeniden denenir', async () => {
    const url = 'https://www.youtube.com/watch?v=expired1';
    const info = await mgr.probe(url);
    fs.writeFileSync(fakeLog, '');
    const [snap] = await mgr.add([{ url, probeInfo: info, quality: '720' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    const runs = fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l).args);
    assert.strictEqual(runs.length, 2);
    assert.ok(runs[0].includes('--load-info-json'));
    assert.strictEqual(runs[1][runs[1].length - 1], url);
  });

  await test('video sitesi: yalnızca ses → mp3, Müzik kategorisi', async () => {
    const url = 'https://youtu.be/ses123';
    const [snap] = await mgr.add([{ url, quality: 'audio', filename: 'Şarkı' }]);
    assert.strictEqual(snap.filename, 'Şarkı.mp3');
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    assert.strictEqual(d.category, 'music');
    assert.strictEqual((await fsp.stat(d.savePath)).size, 1024 * 1024);
  });

  await test('video sitesi: duraklat → devam (yarım akıştan sürer)', async () => {
    process.env.FAKE_YTDLP_DELAY = '150';
    const url = 'https://www.instagram.com/reel/XYZ/';
    const [snap] = await mgr.add([{ url, quality: '1080' }]);
    const d = mgr.get(snap.id);
    await new Promise((r) => setTimeout(r, 1200));
    await mgr.pause([snap.id]);
    const partial = d.downloaded;
    assert.ok(partial > 0 && partial < 4 * 1024 * 1024, `kısmi olmalı: ${partial}`);
    process.env.FAKE_YTDLP_DELAY = '0';
    mgr.start([snap.id]);
    await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    const expected = Buffer.concat([fakeBytes(url + '137', 3 * 1024 * 1024), fakeBytes(url + '140', 1024 * 1024)]);
    assert.strictEqual(sha(await fsp.readFile(d.savePath)), sha(expected));
    const leftovers = (await fsp.readdir(d.dir)).filter((f) => /\.part$|\.f\d+\./.test(f));
    assert.deepStrictEqual(leftovers, []);
  });

  await test('video sitesi: çerezler yt-dlp\'ye dosyayla gider ve silinir', async () => {
    fs.writeFileSync(fakeLog, '');
    const url = 'https://www.instagram.com/p/GIZLI/';
    const [snap] = await mgr.add([{ url, quality: '720', cookie: 'sessionid=abc; csrftoken=xyz' }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    const runs = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dl = runs.find((r) => !r.args.includes('-J'));
    assert.match(dl.cookie, /\.instagram\.com\tTRUE\t\/\tTRUE\t\d+\tsessionid\tabc/);
    const cookieFile = dl.args[dl.args.indexOf('--cookies') + 1];
    assert.ok(!fs.existsSync(cookieFile), 'geçici çerez dosyası silinmeli');
  });

  const logLines = () => fs.readFileSync(fakeLog, 'utf8').split(/\r?\n/).filter(Boolean);
  const runsSince = (mark) => logLines().slice(mark).map((l) => JSON.parse(l));
  const logLength = () => logLines().length;
  const JAR = [
    { name: 'PREF', value: 'f6=40', domain: 'www.youtube.com', path: '/', secure: true, hostOnly: true, session: true },
    { name: 'SID', value: 'gizli', domain: '.youtube.com', path: '/', secure: true, hostOnly: false, expirationDate: 1893456000.5 }
  ];

  await test('YouTube: çerez olsa da önce çerezsiz denenir, indirmede de çerez gitmez', async () => {
    const mark = logLength();
    const url = 'https://www.youtube.com/watch?v=reload1';
    const info = await mgr.probe(url, {}, 'SID=gizli', 'media', JAR);
    assert.strictEqual(info.usedCookies, false);
    const [snap] = await mgr.add([{ url, probeInfo: info, quality: '720', cookie: 'SID=gizli', jar: JAR }]);
    const d = await waitFor(mgr, snap.id, ['completed', 'error']);
    assert.strictEqual(d.status, 'completed', d.error);
    const runs = runsSince(mark);
    assert.ok(runs.length >= 2 && runs.every((r) => !r.args.includes('--cookies')), 'hiçbir çağrıda çerez olmamalı');
  });

  await test('Çerezli deneme "sayfayı yenileyin" verirse çerezsiz tekrar denenir', async () => {
    const mark = logLength();
    const url = 'https://www.instagram.com/reel/reload2/';
    const info = await mgr.probe(url, {}, 'sessionid=x', 'media');
    assert.strictEqual(info.usedCookies, false);
    const runs = runsSince(mark);
    assert.deepStrictEqual(runs.map((r) => r.args.includes('--cookies')), [true, false]);
  });

  await test('Tam çerez listesi Netscape dosyasına alan adı/yol/süre korunarak yazılır', async () => {
    const { writeCookieFile } = require('../src/engine/media');
    const file = await writeCookieFile(null, 'https://www.youtube.com/watch?v=x', JAR);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.split('\t'));
    fs.rmSync(file);
    assert.deepStrictEqual(lines[1], ['www.youtube.com', 'FALSE', '/', 'TRUE', '0', 'PREF', 'f6=40']);
    assert.deepStrictEqual(lines[2], ['.youtube.com', 'TRUE', '/', 'TRUE', '1893456000', 'SID', 'gizli']);
  });

  await test('video sitesi: gizli video → anlaşılır hata', async () => {
    await assert.rejects(() => mgr.probe('https://www.youtube.com/watch?v=private1'), /gizli/);
  });

  await test('kalıcılık: kapat/aç sonrası liste geri geliyor', async () => {
    await mgr.shutdown();
    const mgr2 = new DownloadManager({ dataDir: path.join(tmp, 'data'), defaultDownloadDir: path.join(tmp, 'dl') });
    await mgr2.init();
    assert.strictEqual(mgr2.downloads.size, mgr.downloads.size);
    await mgr2.shutdown();
  });

  const failed = results.filter((r) => r.includes('✗')).length;
  console.log(`\n${results.length - failed}/${results.length} test geçti`);
  server.close();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
