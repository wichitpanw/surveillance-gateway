#!/usr/bin/env node
/**
 * ล็อก API ของ go2rtc ให้ฟังเฉพาะ loopback (127.0.0.1:<พอร์ตเดิม>) ในไฟล์ go2rtc.yaml ที่มีอยู่แล้ว
 *
 * ทำไม: API ของ go2rtc (1984 central / 1994 edge 001) ไม่มี auth — เปิดบน 0.0.0.0 แปลว่าใครใน LAN ก็
 * อ่านรายการสตรีม (URL กล้องพร้อมรหัสผ่าน) และเพิ่ม/ลบสตรีมได้ · gateway คุยกับ go2rtc ผ่าน 127.0.0.1 อยู่แล้ว
 * และส่งต่อสิ่งที่ผู้ใช้ต้องใช้ผ่านพอร์ต 5173/5273 ที่ตรวจ token (server.js proxyToStreamCore)
 * ตัวสร้าง yaml ใหม่ (setup-edge.ps1 / setup-edge.sh / edge-sim.ps1) เขียน 127.0.0.1 ให้แล้ว — สคริปต์นี้แก้ไฟล์เก่า
 *
 *   node scripts/lock-go2rtc-api.cjs [ไฟล์.yaml ...]
 *     ไม่ใส่ไฟล์ = Windows: <repo>/go2rtc/go2rtc.yaml และ D:\gateway-edge\go2rtc.yaml · Linux: /var/lib/gw-edge/go2rtc.yaml
 *     --dry-run    บอกว่าจะเปลี่ยนอะไรโดยไม่เขียนไฟล์
 *
 * แตะเฉพาะบรรทัด listen ในบล็อก api: บนสุด (RTSP / WebRTC / สตรีมไม่แตะ) · สำรองเป็น <ไฟล์>.bak ก่อนเขียน
 * รันซ้ำได้ (ไฟล์ที่ล็อกแล้วไม่เขียนซ้ำ) · ไม่พิมพ์เนื้อหาอื่นของไฟล์ — ส่วน streams มี URL กล้องพร้อมรหัสผ่าน
 * go2rtc อ่าน api.listen ตอนเริ่มเท่านั้น → แก้แล้วต้อง restart go2rtc (0-go2rtc / 1-go2rtc-edge) จาก shell admin
 * ไฟล์ของ production ถูกสร้างโดย process elevated — ต้องรันสคริปต์นี้จาก shell admin เช่นกัน
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 1984; // ค่าเริ่มต้นของ go2rtc เมื่อไม่มี api.listen
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
let files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  files = process.platform === 'win32'
    ? [path.join(__dirname, '..', 'go2rtc', 'go2rtc.yaml'), 'D:\\gateway-edge\\go2rtc.yaml']
    : ['/var/lib/gw-edge/go2rtc.yaml'];
}

/** ค่าของ listen ไม่มีเครื่องหมายคำพูดและคอมเมนต์ท้ายบรรทัด */
function unquote(v) {
  return v.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** พอร์ตจากค่า listen แบบ ":1984" / "0.0.0.0:1984" / "1984" — null ถ้าอ่านไม่ออก */
function portOf(value) {
  const m = /(?:^|:)(\d{1,5})$/.exec(value);
  return m ? Number(m[1]) : null;
}

/** คืน { text, from, to } หรือ { skip: เหตุผล } — ไม่แตะบรรทัดอื่นนอกจากบรรทัด listen ของ api */
function lock(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const apiAt = lines.findIndex((l) => /^api:\s*(#.*)?$/.test(l));
  if (apiAt < 0) {
    // ไม่มีบล็อก api = go2rtc ฟัง :1984 ทุก interface — เติมบล็อกไว้บนสุด
    const to = `127.0.0.1:${DEFAULT_PORT}`;
    return { text: [`api:`, `  listen: "${to}"`, ...lines].join(eol), from: '(ไม่มีบล็อก api — ค่าเริ่มต้น :1984)', to };
  }
  let end = lines.length;
  for (let i = apiAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) { end = i; break; }
  }
  const listenAt = lines.slice(apiAt + 1, end).findIndex((l) => /^\s+listen\s*:/.test(l));
  if (listenAt < 0) {
    const indent = (lines.slice(apiAt + 1, end).find((l) => /^\s+\S/.test(l) && !/^\s+#/.test(l)) || '  ').match(/^\s*/)[0] || '  ';
    const to = `127.0.0.1:${DEFAULT_PORT}`;
    lines.splice(apiAt + 1, 0, `${indent}listen: "${to}"`);
    return { text: lines.join(eol), from: '(ไม่มี api.listen — ค่าเริ่มต้น :1984)', to };
  }
  const idx = apiAt + 1 + listenAt;
  const [, indent, raw] = /^(\s+)listen\s*:\s*(.*)$/.exec(lines[idx]);
  const from = unquote(raw);
  if (from === '') return { skip: 'api.listen ว่าง (ปิด API อยู่แล้ว)' };
  if (LOOPBACK.test(from)) return { skip: `ล็อกอยู่แล้ว (${from})` };
  const port = portOf(from);
  if (!port) return { skip: `อ่านพอร์ตจาก api.listen ไม่ออก (${from}) — แก้เอง` };
  const to = `127.0.0.1:${port}`;
  lines[idx] = `${indent}listen: "${to}"`;
  return { text: lines.join(eol), from, to };
}

let failed = 0;
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`- ${file}: ไม่มีไฟล์ — ข้าม`); continue; }
  try {
    const before = fs.readFileSync(file, 'utf8');
    const r = lock(before);
    if (r.skip) { console.log(`= ${file}: ${r.skip}`); continue; }
    if (dryRun) { console.log(`~ ${file}: api.listen ${r.from} → ${r.to} (dry-run ไม่เขียน)`); continue; }
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, r.text);
    console.log(`✓ ${file}: api.listen ${r.from} → ${r.to} (สำรองไว้ที่ ${path.basename(file)}.bak)`);
  } catch (err) {
    failed++;
    console.error(`✗ ${file}: ${err.code || ''} ${err.message.split('\n')[0]}`);
  }
}
if (!dryRun) console.log('แก้แล้วต้อง restart go2rtc ที่ไฟล์นั้นเป็นของ (0-go2rtc / 1-go2rtc-edge / systemctl restart gw-edge) จึงมีผล');
process.exit(failed ? 1 : 0);
