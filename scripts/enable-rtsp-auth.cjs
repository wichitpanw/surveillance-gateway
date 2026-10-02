#!/usr/bin/env node
/*
  เปิดการยืนยันตัวตนของ RTSP บนพอร์ต 8555

  พอร์ต 8555 ชี้ตรงเข้า go2rtc ไม่ผ่าน Node — stream token คุมไม่ถึง ใครที่ถึงพอร์ตนี้ได้และ
  เดาชื่อ path ถูก (ชื่อคือ `cam_<id>` ซึ่งอยู่ในทุก response ของ /api/v1) ก็ดูกล้องได้เลย
  โดยไม่ต้องมี API key สคริปต์นี้ปิดช่องนั้นด้วยบัญชีผู้ใช้ระดับเซิร์ฟเวอร์ของ go2rtc เอง

  ทำสองอย่างให้ตรงกันในครั้งเดียว เพราะถ้าทำแยกกันแล้วพลาดข้างหนึ่ง อาการคือ RTSP ใช้ไม่ได้
  ทั้งระบบ:

    1. เขียน `rtsp: username/password` ลง go2rtc/go2rtc.yaml
    2. เขียนรหัสเดียวกันลง server/.rtsp-credentials.json ให้ Gateway ใส่ไปใน URL ที่แจกออกไป

  ขอบเขตกล้องยังบังคับที่ /api/v1 เหมือนเดิม — ที่นั่นคือที่เดียวที่รู้ว่าคีย์ไหนเห็นกล้องอะไร
  สิ่งที่ได้เพิ่มคือ "ต้องได้ URL มาจาก Gateway ก่อน" แทน "เดา path ถูกก็ดูได้"

  รันซ้ำได้: ถ้ามีรหัสอยู่แล้วจะไม่เปลี่ยน เว้นแต่สั่ง --rotate

  ใช้:
    node scripts/enable-rtsp-auth.cjs
    node scripts/enable-rtsp-auth.cjs --rotate
    node scripts/enable-rtsp-auth.cjs --disable
*/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
// override ได้เพื่อลองกับสำเนาก่อนแตะไฟล์จริง — ไฟล์จริงคือ config ของระบบที่รันอยู่
const YAML_PATH = process.env.GO2RTC_YAML || path.join(REPO, 'go2rtc', 'go2rtc.yaml');
const CREDENTIALS_PATH = process.env.RTSP_CREDENTIALS_PATH
  || path.join(REPO, 'server', '.rtsp-credentials.json');
const USERNAME = 'sgw';

const args = process.argv.slice(2);
const rotate = args.includes('--rotate');
const disable = args.includes('--disable');

function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/*
  แก้เฉพาะบล็อก `rtsp:` เท่านั้น ไม่เขียนไฟล์ทั้งใบใหม่

  go2rtc เขียน `streams:` กลับลงไฟล์นี้เองทุกครั้งที่กล้องถูกซิงก์เข้ามา ไฟล์จึงมีทั้ง
  ส่วนที่คนตั้งและส่วนที่โปรแกรมเขียน การ dump YAML ใหม่ทั้งไฟล์จะทำให้คอมเมนต์ที่อธิบายว่า
  ทำไมแต่ละค่าเป็นแบบนั้นหายไปทั้งหมด และนั่นคือของที่มีค่าที่สุดในไฟล์นี้
*/
function patchYaml(credentials) {
  const eol = fs.readFileSync(YAML_PATH, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  const lines = fs.readFileSync(YAML_PATH, 'utf8').split(/\r?\n/);

  const start = lines.findIndex((l) => l.trim() === 'rtsp:');
  if (start < 0) throw new Error('ไม่พบบล็อก rtsp: ใน go2rtc.yaml');

  // จบบล็อกที่บรรทัดแรกซึ่งไม่ได้ย่อหน้าและไม่ว่าง — YAML ระดับบนสุดตัวถัดไป
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end += 1;

  const body = lines.slice(start + 1, end).filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('username:') && !t.startsWith('password:');
  });

  if (credentials) {
    body.push(`  username: ${credentials.username}`);
    body.push(`  password: ${credentials.password}`);
  }

  // บล็อกถัดไปต้องมีบรรทัดว่างคั่นเหมือนเดิม — การกรองบรรทัดว่างข้างบนกินตัวคั่นไปด้วย
  const next = [...lines.slice(0, start + 1), ...body, '', ...lines.slice(end)];
  fs.writeFileSync(YAML_PATH, next.join(eol), 'utf8');
}

if (disable) {
  patchYaml(null);
  try {
    fs.unlinkSync(CREDENTIALS_PATH);
  } catch {
    // ไม่มีไฟล์อยู่แล้วก็คือปิดอยู่แล้ว
  }
  console.log('ปิด RTSP auth แล้ว — รีสตาร์ต go2rtc และ backend เพื่อให้มีผล');
  process.exit(0);
}

const existing = readCredentials();
const credentials = existing && !rotate
  ? existing
  : { username: USERNAME, password: crypto.randomBytes(18).toString('base64url') };

patchYaml(credentials);

// 0600 ไม่มีความหมายบน Windows แต่ไฟล์นี้ถูก .gitignore ไว้ และอยู่ในเครื่องเดียวกับ
// go2rtc.yaml ซึ่งมีรหัสผ่านกล้องทุกตัวอยู่แล้ว — ระดับการป้องกันจึงเท่ากันโดยธรรมชาติ
fs.writeFileSync(CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });

console.log(existing && !rotate ? 'ใช้รหัสเดิมที่มีอยู่' : 'สร้างรหัสใหม่แล้ว');
console.log(`  go2rtc.yaml           ${YAML_PATH}`);
console.log(`  credentials           ${CREDENTIALS_PATH}`);
console.log('');
console.log('ต้องรีสตาร์ตทั้งสองตัวถึงจะมีผล — go2rtc อ่าน yaml ตอนบูต และ Gateway อ่านไฟล์รหัสตอนบูต:');
console.log("  Start-ScheduledTask -TaskName 'CCTV Gateway (pm2 resurrect at boot)'");
console.log('');
console.log('client ที่ใช้ /api/v1 ไม่ต้องแก้อะไร — URL rtsp ที่ Gateway แจกจะมีบัญชีผู้ใช้ติดไปเอง');
console.log('เครื่องมือที่พิมพ์ URL ของ 8555 เองไว้ (VLC, ffmpeg, สคริปต์เก่า) ต้องใส่รหัสเพิ่ม');
