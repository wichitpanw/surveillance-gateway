import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * แปลง timestamp ที่ได้จาก API ให้เป็น Date ที่ถูกต้อง
 *
 * ตั้งแต่ 2026-08-22 backend เก็บและส่งเวลาเป็น ISO-8601 เวลากรุงเทพพร้อม offset
 * (`2026-08-22T08:11:54.351+07:00`) ซึ่ง new Date() อ่านได้ถูกต้องอยู่แล้ว ดู
 * server/shared/time.js สำหรับเหตุผลของรูปแบบนี้
 *
 * ที่ยังต้องมีฟังก์ชันนี้อยู่คือแถวเก่าที่ยังไม่ถูก migrate: SQLite เคยคืนค่ามาเป็น
 * "YYYY-MM-DD HH:MM:SS" ที่ไม่มีตัวบอกเขตเวลา ทั้งที่ค่านั้นเป็น UTC ถ้าโยนเข้า
 * new Date() ตรง ๆ เบราว์เซอร์จะตีความว่าเป็นเวลาท้องถิ่น ทำให้เพี้ยนไป 7 ชม.
 * สำหรับผู้ใช้ในไทย — ต้องเติม Z ก่อน (ค่าที่มี T หรือ Z หรือ offset อยู่แล้วไม่ต้องแตะ)
 */
function parseServerTimestamp(timestamp) {
  if (typeof timestamp === 'string' && !timestamp.includes('T') && !timestamp.endsWith('Z')) {
    return new Date(timestamp.replace(' ', 'T') + 'Z');
  }
  return new Date(timestamp);
}

/** แปลง timestamp จาก SQLite/API เป็นเวลาไทย (Asia/Bangkok) */
export function formatThaiDateTime(timestamp) {
  if (!timestamp) return '';
  const date = parseServerTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** วันที่ en-CA ตาม timezone ไทย สำหรับ filter */
export function getThaiDateKey(timestamp) {
  if (!timestamp) return '';
  const date = parseServerTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/** เวลาอย่างเดียว (HH:mm:ss) ตามเวลาไทย — สำหรับตารางที่แยกบรรทัดเวลา/วันที่ */
export function formatThaiTime(timestamp, fallback = '00:00:00') {
  if (!timestamp) return fallback;
  const date = parseServerTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** วันที่อย่างเดียวแบบไทย — คู่กับ formatThaiTime */
export function formatThaiDate(timestamp, fallback = '') {
  if (!timestamp) return fallback;
  const date = parseServerTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
}
