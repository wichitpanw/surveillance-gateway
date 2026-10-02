/**
 * รหัสจังหวัด / อำเภอ / ตำบลของไทย (รหัสกรมการปกครอง, จังหวัดตาม มอก. 1099)
 *
 * อ่านจาก server/data/thai-regions.csv ซึ่งสร้างด้วย scripts/gen-thai-regions.cjs — ที่นั่นมีบันทึก
 * ว่าทำไมไม่ใช้ชุดข้อมูลเดียวกับโปรเจกต์ reference edge project (เลขของบึงกาฬผิดทั้งจังหวัด ฯลฯ)
 *
 * โหลดครั้งเดียวตอนมีคนเรียกครั้งแรก ไฟล์ ~8,400 แถวใช้หน่วยความจำไม่ถึง 2 MB
 */
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'thai-regions.csv');

let byCode = null;
let children = null;

/** แยกหนึ่งบรรทัด CSV — รองรับช่องที่มี "..." ตามที่ scripts/gen-thai-regions.cjs เขียน */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function load() {
  if (byCode) return;
  byCode = new Map();
  children = new Map();
  const lines = fs.readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [code, nameTh, nameEn, parent] = splitCsvLine(line);
    const entry = { code, nameTh, nameEn, parent: parent || null };
    byCode.set(code, entry);
    const key = parent || '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(entry);
  }
}

/** รายการลูกของรหัสหนึ่ง — ไม่ส่ง parent = รายชื่อ 77 จังหวัด */
function childrenOf(parent = '') {
  load();
  return children.get(String(parent || '')) || [];
}

function lookup(code) {
  if (code === null || code === undefined || code === '') return null;
  load();
  return byCode.get(String(code)) || null;
}

/**
 * ตรวจคู่ จังหวัด/อำเภอ ที่ส่งมาจากฟอร์ม
 *
 * คืน `{ province, district }` ที่ผ่านการตรวจแล้ว (null ได้ทั้งคู่) หรือโยน Error ถ้าไม่ถูก —
 * อำเภอที่ไม่อยู่ในจังหวัดที่เลือกต้องถูกปฏิเสธ ไม่ใช่เก็บไว้แล้วแสดงผลผิดทีหลัง
 */
function validateRegion(provinceCode, districtCode) {
  const province = provinceCode ? lookup(provinceCode) : null;
  if (provinceCode && (!province || province.parent)) throw new Error(`ไม่รู้จักรหัสจังหวัด ${provinceCode}`);
  const district = districtCode ? lookup(districtCode) : null;
  if (districtCode) {
    if (!district || !province || district.parent !== province.code) {
      throw new Error(`อำเภอ ${districtCode} ไม่อยู่ในจังหวัด ${provinceCode || '(ไม่ได้เลือก)'}`);
    }
  }
  return { province: province ? province.code : null, district: district ? district.code : null };
}

/** รูปที่ส่งออกไปทาง API — ชื่อไทยและอังกฤษ */
const publicRegion = (code) => {
  const r = lookup(code);
  return r ? { code: r.code, name: r.nameTh, nameEn: r.nameEn } : null;
};
/** กล้องใหม่และการแก้พื้นที่ต้องระบุจังหวัดและอำเภอที่สัมพันธ์กันเสมอ */
function validateRequiredRegion(provinceCode, districtCode) {
  if (!provinceCode || !districtCode) throw new Error('ต้องเลือกจังหวัดและอำเภอ/เขต');
  return validateRegion(provinceCode, districtCode);
}

module.exports = { childrenOf, lookup, validateRegion, validateRequiredRegion, publicRegion, CSV_PATH };
