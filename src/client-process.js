'use strict';

const { execFile } = require('child_process');

// Tarayıcılar (Vivaldi gibi) kendini User-Agent'ta Chrome diye tanıtabildiği için
// köprüye bağlanan TCP bağlantısının sahibi olan programa Windows'tan bakarız.
const EXE_NAMES = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'brave.exe': 'Brave',
  'opera.exe': 'Opera',
  'vivaldi.exe': 'Vivaldi'
};

const cache = new Map(); // "uzakPort" → { name, at }

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout))
    );
  });
}

/** 127.0.0.1:remotePort → 127.0.0.1:localPort bağlantısının sahibi olan PID. */
async function pidFor(remotePort, localPort) {
  const out = await run('netstat', ['-a', '-n', '-o', '-p', 'TCP']);
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;
    if (cols[1].endsWith(`:${remotePort}`) && cols[2].endsWith(`:${localPort}`)) return Number(cols[4]) || null;
  }
  return null;
}

async function imageName(pid) {
  const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const m = /^"([^"]+)"/.exec(out.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * İstek gönderen programın adını döner: { exe, browser } (browser tanınmıyorsa null).
 * Windows dışında ya da bulunamazsa null döner.
 */
async function identifyClient(socket) {
  if (process.platform !== 'win32' || !socket?.remotePort) return null;
  const key = `${socket.remotePort}:${socket.localPort}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const pid = await pidFor(socket.remotePort, socket.localPort);
  const exe = pid ? await imageName(pid) : null;
  const value = exe ? { exe, browser: EXE_NAMES[exe] || null } : null;
  cache.set(key, { value, at: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = { identifyClient, EXE_NAMES };
