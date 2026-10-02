/**
 * บัญชีผู้ใช้ของ RTSP บนพอร์ต 8555
 *
 * พอร์ต 8555 ชี้ตรงเข้า go2rtc ไม่ผ่าน Node — token ของ stream-token.js จึงคุมมันไม่ได้เลย
 * (ดูหัวข้อ "ข้อจำกัดที่ต้องรู้" ในไฟล์นั้น) ใครที่เข้าถึงพอร์ตนี้ได้และเดาชื่อ path ถูก
 * ก็ดูกล้องตัวนั้นได้ทันทีโดยไม่ต้องมี API key
 *
 * ทางแก้ที่ go2rtc มีให้คือ username/password ระดับเซิร์ฟเวอร์ ไม่ใช่ต่อสตรีม — ขอบเขตของกล้อง
 * ยังคงถูกบังคับที่ /api/v1 เหมือนเดิม เพราะที่นั่นคือที่เดียวที่รู้ว่าคีย์ไหนเห็นกล้องอะไร
 * สิ่งที่ชั้นนี้เพิ่มคือ "ต้องได้ URL มาจาก Gateway ก่อน" ไม่ใช่ "เดา path ถูกก็ดูได้"
 *
 * รหัสผ่านอยู่ในไฟล์นอกฐานข้อมูล ไม่ใช่ในโค้ดหรือใน ecosystem ที่ commit ขึ้น git —
 * รูปแบบเดียวกับ .stream-token-secret และ .gateway-key-secret ตัวไฟล์ถูกสร้างโดย
 * `node scripts/enable-rtsp-auth.js` ซึ่งเขียนรหัสเดียวกันลง go2rtc.yaml ให้ด้วย
 *
 * ไม่มีไฟล์ = ยังไม่ได้เปิดใช้ ทุกอย่างทำงานเหมือนเดิมทุกประการ นี่คือสถานะของระบบก่อนหน้านี้
 * และเป็นเหตุผลที่ทุกจุดที่เรียกใช้ต้องรับ null ได้
 */
const fs = require('fs');

const CREDENTIALS_PATH = require('../shared/instance').stateFile('.rtsp-credentials.json');

let cached;

/**
 * คืน `{ username, password }` หรือ null ถ้ายังไม่ได้เปิด RTSP auth
 *
 * อ่านครั้งเดียวแล้วจำไว้ เพราะถูกเรียกทุกครั้งที่มีคนขอ URL ของสตรีม การเปลี่ยนรหัสต้อง
 * รีสตาร์ต backend อยู่แล้ว — go2rtc เองก็ต้องรีสตาร์ตเพื่ออ่าน yaml ใหม่เหมือนกัน
 */
function rtspCredentials() {
  if (cached !== undefined) return cached;

  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    cached = raw.username && raw.password
      ? { username: String(raw.username), password: String(raw.password) }
      : null;
  } catch {
    cached = null;
  }

  return cached;
}

/**
 * ใส่บัญชีผู้ใช้เข้าไปใน URL rtsp:// ที่ Gateway แจกออกไป
 *
 * ต้อง encode ทั้งชื่อและรหัส — รหัสที่สคริปต์สร้างเป็น hex อยู่แล้วก็จริง แต่ถ้าวันหนึ่งมีคน
 * ตั้งรหัสเองแล้วมี `@` หรือ `:` อยู่ข้างใน URL จะถูกตัดผิดที่ทันทีโดยไม่มี error ให้เห็น
 */
function withRtspCredentials(url) {
  const creds = rtspCredentials();
  if (!creds) return url;

  const user = encodeURIComponent(creds.username);
  const pass = encodeURIComponent(creds.password);
  return url.replace(/^rtsp:\/\//, `rtsp://${user}:${pass}@`);
}

module.exports = { rtspCredentials, withRtspCredentials, CREDENTIALS_PATH };
