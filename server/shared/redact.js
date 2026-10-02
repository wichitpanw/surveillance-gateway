/**
 * ตัดรหัสผ่านที่ฝังใน URL ออกก่อนเขียน log หรือส่ง error กลับ
 *
 * `cameras.rtsp` มี user:pass ของกล้องฝังอยู่ และ ffmpeg/ffprobe พิมพ์ URL เต็มลง stderr เมื่อเปิดไม่ได้
 * ข้อความนั้นเคยไหลตรงไปที่ console.error และ JSON ที่ตอบหน้าเว็บ — รหัสกล้องจึงไปนอนอยู่ใน log ของ pm2
 * ใช้ได้กับทุก scheme ที่มีรูป `scheme://user:pass@host` (rtsp, rtsps, http, https)
 */
const CREDENTIAL_URL = /\b(rtsps?|https?):\/\/[^@/\s"'<>]+@/gi;

/** แทนส่วน user:pass ใน URL ทุกตัวในข้อความด้วย `***` — รับอะไรก็ได้ คืนสตริงเสมอ */
function redactUrls(text) {
  if (text == null) return '';
  return String(text).replace(CREDENTIAL_URL, (_, scheme) => `${scheme}://***@`);
}

/** Error ตัวใหม่ที่ message ถูกตัดรหัสแล้ว — คง status/code เดิมไว้ให้ผู้เรียกที่อ่านค่าพวกนั้น */
function redactError(err) {
  if (!err) return err;
  const out = new Error(redactUrls(err.message || err));
  if (err.status) out.status = err.status;
  if (err.code) out.code = err.code;
  if (err.stack) out.stack = redactUrls(err.stack);
  return out;
}

module.exports = { redactUrls, redactError };
