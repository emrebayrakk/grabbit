'use strict';

// Kodda kullanılan dil anahtarlarının her dil dosyasında bulunduğunu ve {parametre}lerin
// dillerde tutarlı olduğunu denetler. Çalıştırma: npm run check-i18n
const fs = require('fs');
const path = require('path');
const I18N = require('../i18n/i18n');

const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'renderer')).map((f) => path.join('renderer', f)),
  ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join('src', f)),
  ...fs.readdirSync(path.join(root, 'src', 'engine')).map((f) => path.join('src', 'engine', f))
].filter((f) => /\.(js|html)$/.test(f));

const used = new Set();
const add = (k) => k && k.includes('.') && !k.endsWith('.') && used.add(k);
for (const rel of files) {
  const s = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of s.matchAll(/\bt\(\s*'([\w.]+)'/g)) add(m[1]);
  for (const m of s.matchAll(/'((?:err|media|tools|phase|bridge|toast|info)\.\w+)'/g)) add(m[1]);
  for (const m of s.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([^"]+)"/g)) add(m[1]);
}
// Dinamik oluşturulan anahtarlar
for (const c of ['video', 'music', 'document', 'archive', 'program', 'image', 'other']) used.add('cat.' + c);
for (const c of ['queued', 'downloading', 'paused', 'completed', 'error', 'verifying']) used.add('status.' + c);
for (const c of ['401', '403', '404', '410', '416', '429']) used.add('err.http' + c);
for (const c of ['dns', 'refused', 'reset', 'timeout', 'diskFull', 'noWrite', 'cert', 'slowServer', 'network', 'unknown', 'httpGeneric']) used.add('err.' + c);

const locales = {};
for (const code of Object.keys(I18N.LANGS)) locales[code] = require(path.join(root, 'i18n', 'locales', `${code}.js`));

const params = (v) => {
  const s = typeof v === 'object' ? Object.values(v).join(' ') : String(v);
  return [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
};

let problems = 0;
for (const [code, msgs] of Object.entries(locales)) {
  const missing = [...used].filter((k) => !(k in msgs));
  const extra = Object.keys(msgs).filter((k) => !used.has(k));
  const badParams = Object.keys(msgs).filter((k) => locales.en[k] !== undefined && params(msgs[k]) !== params(locales.en[k]));
  if (missing.length) console.log(`${code}: eksik ${missing.length} → ${missing.join(', ')}`);
  if (extra.length) console.log(`${code}: kullanılmayan ${extra.length} → ${extra.join(', ')}`);
  if (badParams.length) console.log(`${code}: parametreleri İngilizceden farklı → ${badParams.join(', ')}`);
  problems += missing.length + badParams.length;
}
console.log(`${used.size} anahtar, ${Object.keys(locales).length} dil: ${problems ? problems + ' sorun' : 'tamam'}`);
process.exitCode = problems ? 1 : 0;
