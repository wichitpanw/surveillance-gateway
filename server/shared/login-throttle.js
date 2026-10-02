/**
 * กันเดารหัสผ่านที่ /api/login — นับครั้งที่ผิดต่อ IP และต่อ username ในหน่วยความจำ
 *
 * ผิดครบ MAX_FAILURES ภายใน WINDOW_MS → ปฏิเสธ (429) ต่อไปอีก LOCK_MS แม้รหัสจะถูก
 * นับแยกสองทาง: ต่อ IP กันคนเดียวไล่หลายบัญชี, ต่อ username กันหลายเครื่องรุมบัญชีเดียว
 * รีสตาร์ต backend แล้วตัวนับหาย — ยอมรับได้ เพราะรีสตาร์ตไม่ใช่สิ่งที่ผู้โจมตีสั่งได้
 * login สำเร็จล้างตัวนับของทั้งคู่
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 10_000;

/** key -> { fails: number[] (เวลาที่ผิด), lockedUntil: number } */
const entries = new Map();

const keyOf = (kind, value) => `${kind}:${String(value || '').toLowerCase()}`;

/** ทิ้งรายการที่หมดอายุ — เรียกเมื่อ Map ใหญ่เกิน กันหน่วยความจำโตจากการยิง username สุ่ม */
function sweep(now) {
  for (const [k, e] of entries) {
    if (e.lockedUntil < now && !e.fails.some((t) => now - t < WINDOW_MS)) entries.delete(k);
  }
  if (entries.size > MAX_ENTRIES) entries.clear();
}

/** ยังถูกล็อกอยู่ไหม คืนจำนวนวินาทีที่เหลือ (0 = ไม่ล็อก) */
function lockedFor(ip, username) {
  const now = Date.now();
  let left = 0;
  for (const k of [keyOf('ip', ip), keyOf('user', username)]) {
    const e = entries.get(k);
    if (e && e.lockedUntil > now) left = Math.max(left, Math.ceil((e.lockedUntil - now) / 1000));
  }
  return left;
}

/** จดครั้งที่ผิด — คืน true ถ้าครั้งนี้ทำให้ถูกล็อก */
function recordFailure(ip, username) {
  const now = Date.now();
  if (entries.size > MAX_ENTRIES) sweep(now);
  let locked = false;
  for (const k of [keyOf('ip', ip), keyOf('user', username)]) {
    const e = entries.get(k) || { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
    e.fails.push(now);
    if (e.fails.length >= MAX_FAILURES) {
      e.lockedUntil = now + LOCK_MS;
      e.fails = [];
      locked = true;
    }
    entries.set(k, e);
  }
  return locked;
}

/** login สำเร็จ — ล้างตัวนับของ IP และ username นั้น */
function recordSuccess(ip, username) {
  entries.delete(keyOf('ip', ip));
  entries.delete(keyOf('user', username));
}

module.exports = { lockedFor, recordFailure, recordSuccess, MAX_FAILURES, WINDOW_MS, LOCK_MS };
