// ถ่ายหน้า video.html ทีละเฟรมด้วย Edge headless (CDP) แล้วส่งเข้า ffmpeg เป็น MP4
// ใช้: node render-video.mjs <video.html> <out.mp4> [--fps 25] [--stills 3,20,40 --outdir <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const WebSocket = require(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../../server/node_modules/ws'));

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const [htmlFile, outFile] = args;
if (!htmlFile || !outFile) throw new Error('ใช้: node render-video.mjs <video.html> <out.mp4>');
const FPS = Number(opt('--fps', 25));
const stills = opt('--stills', null);
const outdir = opt('--outdir', path.dirname(outFile));
const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9333;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ntvid-'));
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1920,1080', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pageWs() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((x) => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* ยังไม่ขึ้น */ }
    await sleep(200);
  }
  throw new Error('ต่อ Edge headless ไม่ได้');
}

const ws = new WebSocket(await pageWs(), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.j(new Error(msg.error.message)) : p.r(msg.result); } else if (msg.method) events.push(msg);
});
const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
const evalP = async (expr) => { const res = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval error'); return res.result.value; };

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: pathToFileURL(path.resolve(htmlFile)).href });
for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i += 1) await sleep(100);
const TOTAL = await evalP('document.fonts.ready.then(() => new Promise(r => setTimeout(r, 1500))).then(() => window.TOTAL)');
const missing = await evalP("[...document.fonts].filter(f => f.status !== 'loaded').map(f => f.family).join(',')");
console.log(`ยาว ${TOTAL} วินาที · ${FPS} fps · ฟอนต์ที่ยังไม่โหลด: ${missing || '-'}`);

const frame = async (t, q = 92) => {
  await evalP(`(window.renderAt(${t}), new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const { data } = await cdp('Page.captureScreenshot', { format: q ? 'jpeg' : 'png', ...(q ? { quality: q } : {}) });
  return Buffer.from(data, 'base64');
};

try {
  if (stills) {
    fs.mkdirSync(outdir, { recursive: true });
    for (const t of stills.split(',').map(Number)) {
      const file = path.join(outdir, `still_${String(t).replace('.', '_')}.png`);
      fs.writeFileSync(file, await frame(t, 0));
      console.log('still', file);
    }
  } else {
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      '-vf', 'scale=out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((r, j) => ff.on('exit', (c) => (c === 0 ? r() : j(new Error(`ffmpeg exit ${c}`)))));
    const n = Math.round(TOTAL * FPS);
    const t0 = Date.now();
    for (let i = 0; i < n; i += 1) {
      const buf = await frame(i / FPS);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % (FPS * 10) === 0) console.log(`frame ${i}/${n} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    ff.stdin.end();
    await done;
    console.log('เสร็จ', outFile, fs.statSync(outFile).size, 'bytes', `${Math.round((Date.now() - t0) / 1000)} s`);
  }
} finally {
  ws.close();
  browser.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge ยังถือไฟล์ */ }
}
