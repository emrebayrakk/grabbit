'use strict';

// Testler için FFmpeg taklidi: "-i görüntü -i ses ... çıktı" alır, çıktıya görüntü+ses baytlarını
// art arda yazar ve argümanları FAKE_FFMPEG_LOG dosyasına kaydeder.
const fs = require('fs');

const args = process.argv.slice(2);
if (process.env.FAKE_FFMPEG_LOG) fs.appendFileSync(process.env.FAKE_FFMPEG_LOG, JSON.stringify(args) + '\n');
const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
const out = args[args.length - 1];
fs.writeFileSync(out, Buffer.concat(inputs.map((f) => fs.readFileSync(f))));
