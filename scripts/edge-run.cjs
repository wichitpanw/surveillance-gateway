/**
 * ตัวคุมโปรเซสของ edge ที่ติดตั้งจากชุด flash drive (docs/EDGE-KIT.md) — ใช้แทน pm2
 *
 * pm2 ต้องลงแบบ global (ต้องใช้ internet) และบน Windows ติดเรื่องสิทธิ์กับ named pipe (agents.md ข้อ 5)
 * ชุดติดตั้งจึงให้ Scheduled Task (Windows) หรือ systemd (Linux) รันไฟล์นี้ไฟล์เดียว แล้วไฟล์นี้เปิดแอป
 * ตามรายการใน ecosystem.edge.config.cjs — ค่าทุกอย่างยังมาจากที่เดียวกับ pm2 (edge.json ผ่าน GW_EDGE_CONFIG)
 *
 *   node scripts/edge-run.cjs --config <state>/edge.json      (หรือตั้ง GW_EDGE_CONFIG)
 *
 * - แอปตายก็เปิดใหม่ หน่วง 2 วิ · ตายเร็วติดกันหน่วงเพิ่มจนถึง 30 วิ
 * - log ของแต่ละแอปไปที่ <stateDir>/logs/<ชื่อ>.log เกิน 20 MB หมุนเป็น .1 (เก็บรุ่นเดียว)
 * - เก็บ PID ลูกไว้ใน <stateDir>/edge-run.pids — ตอนเริ่มปิดตัวที่ค้างจากรอบก่อน
 * - อัปเดตผ่านสาย link: เห็น <state>/updates/apply.json (gateway เขียนเมื่อคนกดติดตั้ง) → แตกแพ็กเกจเป็น app.new
 *   → หยุดแอป → app → app.prev, app.new → app → เปิดใหม่ → ภายใน 5 นาทีเวอร์ชันใหม่ต้องต่อ central ติด
 *   (<state>/updates/link-ok.json) ไม่งั้นถอยกลับเป็น app.prev · ตัวคุมเองเป็นรุ่นใหม่ตอนบูตครั้งถัดไป
 */
const fs = require('fs');
const { readAccepted } = require('./edge-update-state.cjs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

// --config <edge.json> — Scheduled Task ของ Windows ตั้ง env ให้ไม่ได้ จึงรับเป็น argument แทน GW_EDGE_CONFIG
const cfgArg = process.argv.indexOf('--config');
if (cfgArg > 0 && process.argv[cfgArg + 1]) process.env.GW_EDGE_CONFIG = path.resolve(process.argv[cfgArg + 1]);

// โครงของชุดติดตั้ง: <root>/app/scripts/edge-run.cjs + <root>/app/BUILD — เท่านั้นที่สลับโปรแกรมได้
const appDir = path.resolve(__dirname, '..');
const rootDir = path.dirname(appDir);
// กู้คืนกรณีไฟดับระหว่างสลับโฟลเดอร์: ถ้าถูกเรียกจาก app.prev หรือ app/ หายแต่ app.prev ยังอยู่ ให้สลับกลับทันที
if (path.basename(appDir) === 'app.prev' && !fs.existsSync(path.join(rootDir, 'app'))) {
  try { fs.renameSync(appDir, path.join(rootDir, 'app')); } catch { /* ถูกล็อก */ }
}
const kitLayout = path.basename(appDir) === 'app' && fs.existsSync(path.join(appDir, 'BUILD'));
// ถือ cwd ไว้ใน app/ = Windows เปลี่ยนชื่อโฟลเดอร์นั้นไม่ได้ตอนอัปเดต
if (kitLayout) process.chdir(rootDir);
process.env.GW_EDGE_RUNNER = kitLayout ? 'edge-run' : 'edge-run-dev';

const ecosystemPath = path.join(appDir, 'ecosystem.edge.config.cjs');
/** อ่าน ecosystem ใหม่จากดิสก์ — หลังสลับโปรแกรม ไฟล์เป็นของเวอร์ชันใหม่ */
function loadEcosystem() {
  delete require.cache[require.resolve(ecosystemPath)];
  return require(ecosystemPath);
}
let ecosystem = loadEcosystem();
const gateway = ecosystem?.apps?.find((a) => a.name === '3-edge-gateway');
if (!gateway?.env?.GATEWAY_STATE_DIR) {
  throw new Error(`ไม่พบ 3-edge-gateway หรือ GATEWAY_STATE_DIR ใน ${ecosystemPath}`);
}
const stateDir = gateway.env.GATEWAY_STATE_DIR;
const logDir = path.join(stateDir, 'logs');
const updDir = path.join(stateDir, 'updates');
const pidFile = path.join(stateDir, 'edge-run.pids');
const MAX_LOG = 20 * 1024 * 1024;
// GW_EDGE_UPDATE_HEALTH_MS ใช้ย่อเวลาตอนทดสอบการถอยกลับเท่านั้น
const HEALTH_WAIT_MS = Number(process.env.GW_EDGE_UPDATE_HEALTH_MS) || 5 * 60_000;

fs.mkdirSync(logDir, { recursive: true });

const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' });
// ข้อความของตัวคุมเอง — Scheduled Task ไม่มีหน้าจอ จึงเขียนลง logs/edge-run.log ด้วย
const say = (msg) => {
  const line = `[edge-run ${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(logDir, 'edge-run.log'), `${line}\n`); } catch { /* ไม่สำคัญพอจะหยุด */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
};

/** ปิดโปรเซสที่ค้างจากรอบก่อน — เฉพาะ PID ที่เราเคยบันทึก และชื่อโปรแกรมยังตรง (PID อาจถูกนำไปใช้ใหม่) */
function killLeftovers() {
  const old = readJson(pidFile) || [];
  for (const { pid, exe } of old) {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        if (!out.toLowerCase().includes(`"${path.basename(exe).toLowerCase()}"`)) continue;
      }
      process.kill(pid);
      say(`ปิด ${path.basename(exe)} (PID ${pid}) ที่ค้างจากรอบก่อน`);
    } catch { /* ไม่มีแล้ว */ }
  }
}

const children = new Map(); // ชื่อแอป → { child, alive }
const savePids = () => {
  const list = [...children.values()].filter((c) => c.child?.pid).map((c) => ({ pid: c.child.pid, exe: c.child.spawnfile }));
  try { fs.writeFileSync(pidFile, JSON.stringify(list)); } catch { /* ไม่สำคัญพอจะหยุด */ }
};

/**
 * log ต่อท้ายไฟล์ของแอป — เขียนเองแบบ sync เพื่อนับขนาดได้ เกิน MAX_LOG ก็ปิด เปลี่ยนชื่อเป็น .1 แล้วเปิดใหม่
 * (ไฟล์ที่เปิดค้างไว้เปลี่ยนชื่อบน Windows ไม่ได้ จึงถือ fd เองแทน createWriteStream)
 */
function openLog(name) {
  const file = path.join(logDir, `${name}.log`);
  let fd = null;
  let size = 0;
  const open = () => {
    try { size = fs.statSync(file).size; } catch { size = 0; }
    fd = fs.openSync(file, 'a');
  };
  const rotate = () => {
    try { fs.closeSync(fd); } catch { /* ปิดไปแล้ว */ }
    try { fs.renameSync(file, `${file}.1`); } catch { /* .1 ถูกล็อก — เขียนต่อไฟล์เดิม */ }
    open();
  };
  open();
  if (size > MAX_LOG) rotate();
  return {
    write(chunk) {
      try {
        fs.writeSync(fd, chunk);
        size += chunk.length;
        if (size > MAX_LOG) rotate();
      } catch { /* ดิสก์เต็ม ฯลฯ — อย่าทำให้แอปล้มตาม */ }
    },
    close() {
      try { fs.closeSync(fd); } catch { /* ปิดไปแล้ว */ }
    },
  };
}

let stopping = false;

/** เปิดแอปหนึ่งตัวและดูแลให้เปิดใหม่เมื่อตาย จนกว่าจะถูกสั่งหยุด (entry.alive = false) */
function run(app) {
  const interpreted = app.interpreter !== 'none';
  const exe = interpreted ? process.execPath : app.script;
  const args = interpreted ? [app.script] : String(app.args || '').split(/\s+/).filter(Boolean);
  const entry = { child: null, alive: true, exited: null };
  children.set(app.name, entry);
  let delay = 2000;

  const start = () => {
    if (stopping || !entry.alive) return;
    const log = openLog(app.name);
    const startedAt = Date.now();
    const child = spawn(exe, args, {
      cwd: app.cwd,
      env: { ...process.env, ...(app.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    entry.child = child;
    entry.exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdout.on('data', (d) => log.write(d));
    child.stderr.on('data', (d) => log.write(d));
    savePids();
    say(`เปิด ${app.name} (PID ${child.pid})`);

    child.on('error', (err) => say(`${app.name} เปิดไม่ได้: ${err.message}`));
    child.on('exit', (code, signal) => {
      entry.child = null;
      savePids();
      log.close();
      if (stopping || !entry.alive) return;
      // ตายเร็ว (< 10 วิ) ติดกัน = น่าจะตั้งค่าผิด ไม่ต้องรีบเปิดถี่ ๆ
      delay = Date.now() - startedAt < 10_000 ? Math.min(delay * 2, 30_000) : 2000;
      say(`${app.name} หยุด (code ${code ?? '-'}${signal ? `, ${signal}` : ''}) — เปิดใหม่ใน ${delay / 1000} วิ`);
      setTimeout(start, delay);
    });
  };
  start();
}

const startApps = () => { for (const app of ecosystem.apps) run(app); };

/** หยุดทุกแอปและรอจนตายจริง (ไม่เกิน 15 วิ) */
async function stopApps() {
  const waits = [];
  for (const entry of children.values()) {
    entry.alive = false;
    if (entry.child) {
      waits.push(entry.exited);
      try { entry.child.kill(); } catch { /* ไม่มีแล้ว */ }
    }
  }
  await Promise.race([Promise.all(waits), sleep(15_000)]);
  children.clear();
  savePids();
}

// ── อัปเดตผ่านสาย link ─────────────────────────────────────────────────────────

/** เปลี่ยนชื่อโฟลเดอร์ — Windows อาจติด antivirus/indexer ชั่วครู่ ลองซ้ำ */
async function renameRetry(from, to) {
  for (let i = 0; ; i += 1) {
    try { fs.renameSync(from, to); return; } catch (err) {
      if (i >= 9) throw err;
      await sleep(1000);
    }
  }
}

const writeResult = (r) => {
  fs.mkdirSync(updDir, { recursive: true });
  fs.writeFileSync(path.join(updDir, 'last-result.json'), `${JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2)}\n`);
};
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** รอให้เวอร์ชัน build ต่อ central ติด (gateway เขียน link-ok.json) หลังเวลา since */
async function waitLinked(build, since) {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    const ok = readJson(path.join(updDir, 'link-ok.json'));
    if (ok && ok.build === build && ok.at > since) return true;
    await sleep(5000);
  }
  return false;
}

/**
 * ตรวจ sig2 + ลำดับ issuedAt ของ manifest (กันเล่นซ้ำ manifest เก่าเพื่อลดเวอร์ชัน) — คืนข้อความปัญหา หรือ null
 * เขียนซ้ำจาก scripts/edge-update-key.cjs (payloadV2Of / checkManifestOrder) แทนการ require ไฟล์นั้นจาก app/
 * เพราะไฟล์รุ่นก่อน 2026-09-29 รัน main() ตอน require แล้ว process.exit — ตัวคุมจะตายทั้งตัว · แก้ที่หนึ่งต้องแก้อีกที่
 */
function verifyV2(m) {
  if (!m.sig2 || !m.issuedAt) return 'ไม่มี sig2/issuedAt (เซ็นด้วยสคริปต์รุ่นเก่า)';
  const issued = Date.parse(String(m.issuedAt));
  if (!Number.isFinite(issued)) return 'issuedAt ไม่ถูกรูปแบบ';
  let pem;
  try { pem = fs.readFileSync(path.join(appDir, 'scripts', 'edge-kit', 'edge-update.pub.pem'), 'utf8'); } catch { return 'ไม่พบ public key'; }
  const payload = JSON.stringify({
    v: 2, build: String(m.build), platform: String(m.platform), file: String(m.file),
    size: Number(m.size), sha256: String(m.sha256), issuedAt: String(m.issuedAt),
  });
  try {
    if (!crypto.verify(null, Buffer.from(payload), pem, Buffer.from(String(m.sig2), 'base64'))) return 'sig2 ไม่ถูกต้อง';
  } catch (err) {
    return `ตรวจ sig2 ไม่ได้: ${err.message}`;
  }
  let last;
  try { last = readAccepted(updDir, { requireExisting: true }); } catch (err) { return err.message; }
  const prev = last ? Date.parse(String(last.issuedAt)) : NaN;
  if (Number.isFinite(prev)) {
    if (issued < prev) return `manifest ออกเมื่อ ${m.issuedAt} เก่ากว่าที่เคยรับ (${last.issuedAt}) — ไม่ลดเวอร์ชัน`;
    if (issued === prev && last.sha256 && last.sha256 !== m.sha256) return 'manifest เวลาเดียวกับที่เคยรับแต่คนละแพ็กเกจ';
  }
  return null;
}

let applying = false;

async function applyUpdate() {
  const reqFile = path.join(updDir, 'apply.json');
  if (applying || !fs.existsSync(reqFile)) return;
  applying = true;
  const req = readJson(reqFile);
  let fromBuild = '?';
  try { fromBuild = fs.readFileSync(path.join(appDir, 'BUILD'), 'utf8').trim(); } catch { /* ไม่มี BUILD */ }
  const appNew = path.join(rootDir, 'app.new');
  const appPrev = path.join(rootDir, 'app.prev');
  const appFailed = path.join(rootDir, 'app.failed');
  let swapped = false;
  let appsStopped = false;
  try {
    if (!kitLayout) throw new Error('เครื่องนี้ไม่ได้ติดตั้งจากชุด flash drive');
    const pending = readJson(path.join(updDir, 'pending.json'));
    if (!req || !pending || pending.sha256 !== req.sha256) throw new Error('ไม่มีแพ็กเกจที่ตรงกับคำขอ');
    // ตรวจซ้ำก่อนแตก — ไฟล์อยู่บนดิสก์มาระยะหนึ่งแล้ว
    const { verifyManifest } = require(path.join(appDir, 'server', 'shared', 'edge-update-manifest.js'));
    const problem = verifyManifest(pending) || verifyV2(pending);
    if (problem) throw new Error(`manifest: ${problem}`);
    const pkg = path.join(updDir, pending.file);
    if (sha256Of(pkg) !== pending.sha256) throw new Error('sha256 ของแพ็กเกจไม่ตรง');

    say(`อัปเดต ${fromBuild} → ${pending.build}: แตกแพ็กเกจ`);
    fs.rmSync(appNew, { recursive: true, force: true });
    fs.mkdirSync(appNew, { recursive: true });
    const tar = spawnSync(tarBin, ['-xzf', pkg, '-C', appNew], { windowsHide: true, encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`แตกแพ็กเกจไม่ได้: ${(tar.stderr || tar.error?.message || '').trim()}`);
    const newBuild = fs.readFileSync(path.join(appNew, 'BUILD'), 'utf8').trim();
    if (newBuild !== pending.build) throw new Error(`BUILD ในแพ็กเกจ (${newBuild}) ไม่ตรงกับ manifest (${pending.build})`);
    if (!fs.existsSync(path.join(appNew, 'scripts', 'edge-run.cjs'))) throw new Error('แพ็กเกจไม่ครบ');

    say('หยุดแอปเพื่อสลับโปรแกรม');
    await stopApps();
    appsStopped = true;
    fs.rmSync(appPrev, { recursive: true, force: true });
    await renameRetry(appDir, appPrev);
    swapped = true;
    await renameRetry(appNew, appDir);
    ecosystem = loadEcosystem();
    const since = Date.now();
    startApps();
    say(`เปิดเวอร์ชัน ${pending.build} แล้ว — รอให้ต่อ central ติด (ไม่เกิน ${Math.round(HEALTH_WAIT_MS / 1000)} วินาที)`);

    if (await waitLinked(pending.build, since)) {
      say(`อัปเดตเป็น ${pending.build} สำเร็จ (ของเดิมเก็บไว้ที่ app.prev)`);
      writeResult({ ok: true, build: pending.build, from: fromBuild });
      for (const f of [pending.file, 'pending.json']) fs.rmSync(path.join(updDir, f), { force: true });
    } else {
      throw new Error(`เวอร์ชัน ${pending.build} ต่อ central ไม่ติดภายใน ${Math.round(HEALTH_WAIT_MS / 1000)} วินาที`);
    }
  } catch (err) {
    say(`อัปเดตไม่สำเร็จ: ${err.message}`);
    let rolledBack = false;
    if (swapped) {
      try {
        say(`ถอยกลับเป็น ${fromBuild}`);
        await stopApps();
        fs.rmSync(appFailed, { recursive: true, force: true });
        if (fs.existsSync(appDir)) await renameRetry(appDir, appFailed);
        await renameRetry(appPrev, appDir);
        rolledBack = true;
      } catch (e) {
        say(`ถอยกลับไม่สำเร็จ: ${e.message} — ต้องติดตั้งใหม่จาก flash drive`);
      }
    }
    if (appsStopped && fs.existsSync(appDir)) {
      ecosystem = loadEcosystem();
      startApps();
    }
    fs.rmSync(appNew, { recursive: true, force: true });
    writeResult({ ok: false, build: req?.build || null, from: fromBuild, rolledBack, error: err.message });
  } finally {
    fs.rmSync(reqFile, { force: true });
    applying = false;
  }
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  say('กำลังหยุดทุกแอป');
  for (const entry of children.values()) {
    try { entry.child?.kill(); } catch { /* ไม่มีแล้ว */ }
  }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

killLeftovers();
say(`edge ${gateway.env.GATEWAY_NODE_NUMBER} · state ${stateDir} · gateway :${gateway.env.GATEWAY_PORT}${kitLayout ? ` · build ${fs.readFileSync(path.join(appDir, 'BUILD'), 'utf8').trim()}` : ''}`);
startApps();
if (kitLayout) setInterval(() => { applyUpdate().catch((err) => say(`อัปเดตผิดพลาด: ${err.message}`)); }, 5000);
