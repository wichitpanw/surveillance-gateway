/**
 * รหัสผ่านผู้ใช้เว็บ — เก็บเป็น scrypt hash แทน plaintext (2026-09-25)
 *
 * รูปแบบ: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` · ใช้ crypto ของ Node ไม่เพิ่ม dependency
 * แถวเก่าที่ยังเป็น plaintext (DB ก่อนหน้านี้ หรือกู้จาก backup เก่า) ยังตรวจได้ และถูกแปลงเป็น hash
 * ตอนเริ่มระบบ (hashLegacyPasswords) และตอน login สำเร็จ
 *
 * หน้าเว็บส่ง username/password เป็น header ทุกคำขอ (ไม่มี session) — scrypt ต่อคำขอหนักเกินไป
 * จึงจำผลที่ตรวจผ่านแล้วไว้ในหน่วยความจำ ผูกกับค่า hash ในฐานข้อมูล: เปลี่ยนรหัสแล้ว hash ใหม่ไม่ตรงกับที่จำไว้
 */
const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const PREFIX = 'scrypt$';

const isHashed = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

const scrypt = (plain, salt, n, r, p) => new Promise((resolve, reject) => {
  crypto.scrypt(String(plain), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});

/** สร้าง hash ใหม่จากรหัสที่ผู้ใช้ตั้ง */
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, N, R, P);
  return `${PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// ผลตรวจที่ผ่านแล้ว: sha256(ค่าใน DB + รหัสที่ส่งมา) → เวลาที่จำ · ไม่เก็บรหัสจริงไว้ในหน่วยความจำ
const verified = new Map();
const VERIFIED_TTL_MS = 10 * 60 * 1000;
const VERIFIED_MAX = 1000;

const cacheKey = (stored, plain) => crypto.createHash('sha256').update(`${stored}\0${plain}`).digest('hex');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** ตรวจรหัสกับค่าในฐานข้อมูล (hash หรือ plaintext แบบเก่า) คืน true/false */
async function verifyPassword(plain, stored) {
  if (plain == null || plain === '' || stored == null || stored === '') return false;
  if (!isHashed(stored)) return safeEqual(plain, stored);

  const key = cacheKey(stored, plain);
  const seenAt = verified.get(key);
  if (seenAt && Date.now() - seenAt < VERIFIED_TTL_MS) return true;

  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = await scrypt(plain, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  } catch {
    return false;
  }
  const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  if (ok) {
    if (verified.size >= VERIFIED_MAX) verified.clear();
    verified.set(key, Date.now());
  }
  return ok;
}

/**
 * แปลงรหัส plaintext ที่เหลือในตาราง users เป็น hash — เรียกตอนเริ่มระบบ รันซ้ำได้
 * UPDATE มีเงื่อนไขค่าเดิม กันเขียนทับรหัสที่เพิ่งถูกเปลี่ยนระหว่างนั้น
 */
function hashLegacyPasswords(db) {
  return new Promise((resolve) => {
    db.all("SELECT id, password FROM users WHERE password IS NOT NULL AND password <> '' AND password NOT LIKE 'scrypt$%'", async (err, rows) => {
      if (err || !rows?.length) return resolve(0);
      let done = 0;
      for (const row of rows) {
        const hashed = await hashPassword(row.password);
        await new Promise((ok) => db.run('UPDATE users SET password = ? WHERE id = ? AND password = ?', [hashed, row.id, row.password], () => ok()));
        done += 1;
      }
      console.log(`[Auth] แปลงรหัสผ่าน plaintext เป็น hash ${done} บัญชี`);
      resolve(done);
    });
  });
}

module.exports = { hashPassword, verifyPassword, hashLegacyPasswords, isHashed };
