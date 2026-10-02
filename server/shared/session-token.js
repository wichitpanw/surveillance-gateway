/**
 * session ของผู้ใช้หน้าเว็บ — แทนการส่ง username/password เป็น header ทุกคำขอ
 *
 * เดิมหน้าเว็บเก็บรหัสผ่านจริงไว้ใน localStorage แล้วส่งทุกคำขอ: XSS ครั้งเดียวหรือเครื่องที่ใช้ร่วมกัน
 * ก็ได้รหัสผ่านของคนไปทั้งบัญชี (และคนมักใช้รหัสซ้ำกับระบบอื่น) ตอนนี้ /api/login ออก token ที่เซ็นแล้ว
 * หน้าเว็บถือแค่ token นั้น
 *
 * ### แบบ stateless ตั้งใจ
 * - ไม่มีตาราง session — ตรวจด้วย HMAC-SHA256 อย่างเดียว ถูกกว่า scrypt ต่อคำขอหลายพันเท่า
 * - payload: id ผู้ใช้ + เวลาหมดอายุ (12 ชม.) + ลายนิ้วมือของ hash รหัสผ่านใน DB
 *   → เปลี่ยนรหัสผ่านแล้ว token เดิมทุกใบใช้ไม่ได้ทันที (ลายนิ้วมือไม่ตรง) โดยไม่ต้องเก็บ deny-list
 * - ลบไฟล์กุญแจแล้ว restart = ทุกคนต้อง login ใหม่ (ใช้ตอนสงสัยว่ากุญแจรั่ว)
 *
 * กุญแจคนละใบกับ stream token และขึ้นต้นคนละเวอร์ชัน (`s1`) — token ดูวิดีโอใช้แทน session ไม่ได้ และกลับกัน
 */
const crypto = require('crypto');
const fs = require('fs');
const { stateFile } = require('./instance');

const SECRET_PATH = process.env.GATEWAY_SESSION_SECRET_FILE || stateFile('.session-secret');
const VERSION = 's1';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let cachedSecret = null;

/** อ่านกุญแจ สร้างใหม่ (0600) ถ้ายังไม่มีหรือเสีย — รูปแบบเดียวกับ gateway/stream-token.js */
function loadSecret() {
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = Buffer.from(fs.readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
    if (cachedSecret.length !== 32) throw new Error('ความยาวกุญแจไม่ถูกต้อง');
  } catch {
    cachedSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, cachedSecret.toString('hex'), { mode: 0o600 });
    console.log(`[Auth] สร้างไฟล์กุญแจ session ที่ ${SECRET_PATH}`);
  }
  return cachedSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (payload) => b64url(crypto.createHmac('sha256', loadSecret()).update(payload).digest());

/** ลายนิ้วมือของค่า password ใน DB (hash) — ไม่ใส่ hash เต็มลง token ใส่แค่ 16 ตัวของ sha256 */
function passwordFingerprint(storedPassword) {
  return crypto.createHash('sha256').update(`pw\0${storedPassword || ''}`).digest('hex').slice(0, 16);
}

/** ออก session ให้ผู้ใช้หนึ่งคน — user คือแถวจากตาราง users (ต้องมี id และ password ที่เก็บใน DB) */
function signSession(user, ttlMs = SESSION_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = b64url(JSON.stringify({ u: String(user.id), e: exp, f: passwordFingerprint(user.password) }));
  return { token: `${VERSION}.${payload}.${mac(payload)}`, expiresAt: exp };
}

/** รูปแบบ token ที่ checkAuth ควรลองตรวจ — แยกจาก API key (`sgw_`) และ stream token (`v1.`) */
const looksLikeSession = (token) => typeof token === 'string' && token.startsWith(`${VERSION}.`);

/**
 * ตรวจลายเซ็นและอายุ คืน { u, e, f } หรือ null — ยังไม่ได้เทียบลายนิ้วมือ
 * (ผู้เรียกต้องโหลดแถวผู้ใช้มาเทียบด้วย fingerprintMatches เพราะรหัสอาจเปลี่ยนไปแล้ว)
 */
function verifySession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== 'string' || typeof data.e !== 'number' || Date.now() > data.e) return null;
  return data;
}

/** token ใบนี้ออกให้รหัสผ่านชุดที่ยังอยู่ใน DB ไหม */
const fingerprintMatches = (claims, storedPassword) => {
  const x = Buffer.from(String(claims?.f || ''));
  const y = Buffer.from(passwordFingerprint(storedPassword));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** ดึง session จาก `Authorization: Bearer s1....` — คืน '' ถ้าไม่มีหรือเป็น Bearer ชนิดอื่น */
function sessionFromRequest(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers?.authorization || ''));
  return m && looksLikeSession(m[1]) ? m[1] : '';
}

module.exports = {
  signSession, verifySession, fingerprintMatches, sessionFromRequest, looksLikeSession, SESSION_TTL_MS, SECRET_PATH,
};
