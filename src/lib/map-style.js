/*
  ที่อยู่ของสไตล์แผนที่ — ขอจากเครื่องที่เปิดหน้านี้อยู่เสมอ (window.location.origin)

  เดิมฝัง :5173 ไว้ ซึ่งบน edge (5273) แปลว่าแผนที่ไปขอจาก central แทน ทำงานได้เพราะบังเอิญอยู่
  เครื่องเดียวกัน แต่บนเครื่อง edge จริงจะได้แผนที่ว่าง

  base = 'satellite' | 'openstreetmap' — ปุ่มสลับบนแผนที่ จำไว้ต่อเครื่องใน localStorage
  ไม่เคยเลือก = ใช้ค่าที่ตั้งไว้ของระบบ (ค่าเริ่มต้นดาวเทียม)
*/
const KEY = 'map_base';

export function getMapBase() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setMapBase(base) {
  try {
    localStorage.setItem(KEY, base);
  } catch {
    /* storage ปิดอยู่ — ใช้ได้แค่รอบนี้ */
  }
}

export function mapStyleUrl(theme, base = getMapBase()) {
  const q = new URLSearchParams({ theme: theme || 'light' });
  if (base) q.set('base', base);
  return `${window.location.origin}/api/map-style.json?${q}`;
}
