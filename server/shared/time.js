/**
 * เวลาของระบบทั้งหมด — Asia/Bangkok
 *
 * ตัดสินใจ 2026-08-22: ระบบนี้เก็บและส่งเวลาเป็นเวลากรุงเทพเสมอ ไม่ใช่ UTC
 *
 * เหตุผล: ทุกกล้อง ทุกผู้ใช้ และทุกหน่วยงานที่รับข้อมูลอยู่ในไทยทั้งหมด การเก็บเป็น UTC
 * แล้วแปลงตอนแสดงผลทำให้ทุกจุดที่อ่านข้อมูลต้องรู้และจำได้ว่าต้องแปลง ซึ่งพลาดมาแล้วจริง
 * (หน้า API Clients แสดงเวลาเพี้ยน 7 ชั่วโมงอยู่นานโดยไม่มีใครสังเกต เพราะลืมเรียกตัวแปลง)
 * เวลาที่อ่านแล้วตรงกับนาฬิกาบนผนังทันทีคือเวลาที่ไม่มีใครแปลงผิดได้
 *
 * รูปแบบที่ใช้: ISO-8601 พร้อม offset — `2026-08-22T08:11:54.351+07:00`
 *
 * มี offset ติดอยู่เสมอ ไม่ใช่เขียนเป็น `2026-08-22 08:11:54` เปล่า ๆ เพราะสตริงเปล่านั้น
 * คือรูปแบบเดียวกับที่ทำให้เกิดบั๊ก 7 ชั่วโมงมาแล้ว: `new Date()` ตีความตามเขตเวลาของ
 * เครื่องที่รัน ผลจึงต่างกันระหว่าง VM (UTC) กับเบราว์เซอร์ในไทย ส่วนรูปแบบที่มี offset
 * อ่านแล้วเห็นเวลากรุงเทพตรง ๆ และ parser ทุกตัวบนโลกตีความตรงกันหมด
 *
 * ไทยไม่มี DST และไม่เคยมีมาตั้งแต่ปี 2519 offset จึงตายตัวที่ +07:00 ได้อย่างปลอดภัย
 * การตั้งค่าคงที่ไว้ตรงนี้ยังแปลว่าผลลัพธ์ไม่ขึ้นกับ TZ ของ process — เครื่อง dev ที่ตั้ง
 * เขตเวลาต่างกันจะได้ค่าเดียวกันเสมอ ซึ่งเป็นคุณสมบัติที่ต้องรักษาไว้
 */

/** offset ของไทยเป็นนาที — ไม่มี DST จึงเป็นค่าคงที่ */
const BANGKOK_OFFSET_MINUTES = 7 * 60;
const BANGKOK_SUFFIX = '+07:00';

/** สตริงเวลาแบบ `YYYY-MM-DD HH:MM:SS` ที่ไม่มีตัวบอกเขตเวลา (ของเดิมจาก SQLite) */
const NAIVE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * แปลงค่าเวลาอะไรก็ได้ให้เป็น Date
 *
 * รับมือกับสามรูปแบบที่มีอยู่จริงในฐานข้อมูล ณ วันที่เปลี่ยนระบบ:
 *   1. `2026-08-21 16:02:02`              — SQLite CURRENT_TIMESTAMP ซึ่งเป็น UTC เสมอ
 *   2. `2026-08-22T01:11:54.351Z`         — toISOString() ของ JS
 *   3. `2026-07-02T01:07:58.539063+00:00` — isoformat ของ Python (ตกค้างจากยุค AI)
 *
 * รูปแบบที่ 1 ไม่มีตัวบอกเขตเวลา จึงต้องเติม Z เอง — ถ้าปล่อยให้ `new Date()` เดา มันจะ
 * ตีความเป็นเวลาท้องถิ่นของเครื่องที่รัน ซึ่งผิดไป 7 ชั่วโมงบนเครื่องในไทย
 */
function parseAny(value) {
  if (value instanceof Date) return value;
  if (value == null) return null;
  // ตัวเลขคือ epoch milliseconds — รองรับไว้เพราะ Date.now() เป็นสิ่งที่ผู้เรียกส่งมาโดย
  // ธรรมชาติที่สุด และถ้าไม่รองรับมันจะกลายเป็นสตริงตัวเลขที่ new Date() อ่านไม่ออก
  // แล้วคืน null เงียบ ๆ — ซึ่งเคยทำให้ /analytics/counts ตอบ 400 ทุกคำขอมาแล้ว
  if (typeof value === 'number') {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const text = String(value).trim();
  if (!text) return null;
  const d = NAIVE.test(text) ? new Date(`${text.replace(' ', 'T')}Z`) : new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * แปลงเป็น ISO-8601 เวลากรุงเทพ คืน null ถ้าอ่านค่าไม่ออก
 *
 * วิธี: เลื่อน timestamp ไปข้างหน้า 7 ชั่วโมงแล้วใช้ toISOString() เพื่อเอา "ตัวเลขหน้าปัด"
 * ของกรุงเทพ จากนั้นเปลี่ยนป้าย Z เป็น +07:00 ให้ตรงกับความจริง — ได้ตัวเลขที่อ่านแล้ว
 * เป็นเวลาไทยทันที โดยที่ค่ายังชี้ไปยังจุดเวลาเดิมไม่คลาดเคลื่อน
 */
function toBangkokIso(value) {
  const d = parseAny(value);
  if (!d) return null;
  const shifted = new Date(d.getTime() + BANGKOK_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().replace('Z', BANGKOK_SUFFIX);
}

/** เวลาปัจจุบันเป็น ISO-8601 กรุงเทพ — ใช้แทน new Date().toISOString() ทุกที่ */
function nowIso() {
  return toBangkokIso(new Date());
}

/**
 * วันที่ปัจจุบันตามปฏิทินกรุงเทพ (`YYYY-MM-DD`)
 *
 * ใช้ตัดสินว่า "วันนี้" คือวันไหน ซึ่งต้องเป็นวันตามปฏิทินไทย ไม่ใช่วัน UTC — ระหว่าง
 * 00:00 ถึง 07:00 ตามเวลาไทย สองอย่างนี้ให้คำตอบคนละวันกัน
 */
function todayKey() {
  return nowIso().slice(0, 10);
}

/**
 * ต้นวันตามปฏิทินกรุงเทพ เป็น ISO-8601 กรุงเทพ
 *
 * @param {string} [day] `YYYY-MM-DD` — ไม่ระบุคือวันนี้
 */
function startOfDayIso(day) {
  return `${day || todayKey()}T00:00:00.000${BANGKOK_SUFFIX}`;
}

/**
 * วันก่อนหน้าของ `YYYY-MM-DD` คืนเป็น `YYYY-MM-DD`
 *
 * คิดบนสตริงล้วน ไม่แวะผ่านเขตเวลาของ process — ผู้เรียกที่ทำงานกับ "วันตามปฏิทิน"
 * (เช่น poller ที่ต้องกลับไปเก็บของเมื่อวานให้จบหลังข้ามเที่ยงคืน) จะได้ไม่ต้องแปลง
 * ไป-กลับผ่าน Date ซึ่งเป็นจุดที่เคยพลาดมาแล้ว
 *
 * ใช้ UTC ข้างในโดยตั้งใจ: เป็นแค่การบวกลบวันบนปฏิทิน ไม่ได้แทนเวลาจริงสักจุดเดียว
 * การใช้ UTC จึงตัดเรื่อง DST และเขตเวลาของเครื่องออกไปทั้งหมด
 *
 * @param {string} [day] `YYYY-MM-DD` — ไม่ระบุคือวันนี้
 */
function previousDayKey(day) {
  const base = day || todayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) throw new Error(`previousDayKey: ${base} ไม่ใช่ YYYY-MM-DD`);
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * ตรวจว่าเป็นสตริงเวลาที่อ่านได้ไหม — ใช้ตรวจ query param ก่อนยิงเข้าฐานข้อมูล
 */
function isValidTime(value) {
  return parseAny(value) !== null;
}

module.exports = {
  BANGKOK_OFFSET_MINUTES,
  BANGKOK_SUFFIX,
  parseAny,
  toBangkokIso,
  nowIso,
  todayKey,
  startOfDayIso,
  previousDayKey,
  isValidTime,
};
