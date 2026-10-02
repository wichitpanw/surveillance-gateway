/**
 * backup ของ edge ที่ติดตั้งจากชุด flash drive บน Windows — หลักการเดียวกับ scripts/backup-edge.sh (Linux)
 * เขียนเป็น node เพราะเครื่องนั้นมีแค่ node.exe ที่มากับชุดติดตั้ง ไม่มี bash
 *
 *   node scripts/edge-backup.cjs --config <state>/edge.json
 *
 * แต่ละรอบเป็นโฟลเดอร์ <stateDir>/backups/<yyyyMMdd-HHmmss>/ มี vms.db (VACUUM INTO ผ่าน sqlite-backup.cjs)
 * + .gateway-key-secret, .rtsp-credentials.json, .stream-token-secret, .session-secret, .ai-worker-key, go2rtc.yaml, edge.json
 * เก็บ 30 วัน แต่เหลือ 3 รอบล่าสุดเสมอ · **กู้ DB กับ .gateway-key-secret จากรอบเดียวกันเสมอ**
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const cfgArg = process.argv.indexOf('--config');
if (cfgArg > 0 && process.argv[cfgArg + 1]) process.env.GW_EDGE_CONFIG = path.resolve(process.argv[cfgArg + 1]);
const gateway = require(path.join(__dirname, '..', 'ecosystem.edge.config.cjs')).apps.find((a) => a.name === '3-edge-gateway');
const stateDir = gateway.env.GATEWAY_STATE_DIR;
const dest = path.join(stateDir, 'backups');
const KEEP_DAYS = 30;
const KEEP_MIN = 3;

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const stamp = stampOf(new Date());
const run = path.join(dest, stamp);
fs.mkdirSync(run, { recursive: true });
console.log(`=== backup ${stamp} → ${run} ===`);

execFileSync(process.execPath, [path.join(__dirname, 'sqlite-backup.cjs'), path.join(stateDir, 'vms.db'), path.join(run, 'vms.db')], { stdio: 'inherit' });
console.log(`  vms.db (${(fs.statSync(path.join(run, 'vms.db')).size / 1e6).toFixed(1)} MB)`);

for (const f of ['.gateway-key-secret', '.rtsp-credentials.json', '.stream-token-secret', '.session-secret', '.ai-worker-key', 'go2rtc.yaml', 'edge.json']) {
  const src = path.join(stateDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(run, f));
    console.log(`  ${f}`);
  }
}

// เก็บกวาด: ข้าม KEEP_MIN รอบล่าสุด แล้วลบรอบที่เก่ากว่า KEEP_DAYS
const cut = stampOf(new Date(Date.now() - KEEP_DAYS * 86_400_000));
const runs = fs.readdirSync(dest).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort().reverse();
for (const name of runs.slice(KEEP_MIN)) {
  if (name < cut) {
    fs.rmSync(path.join(dest, name), { recursive: true, force: true });
    console.log(`  ลบรอบเก่า ${name}`);
  }
}
console.log('เสร็จ');
