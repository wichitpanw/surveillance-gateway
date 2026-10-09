/**
 * ค่าที่ทำให้ Gateway ตัวหนึ่งต่างจากอีกตัว — central กับ edge คือโค้ดชุดเดียวกัน ต่างกันแค่ตรงนี้
 *
 * ทุกค่ามี default เท่ากับที่เครื่องจริง (HOST, central) ใช้อยู่ก่อนมีไฟล์นี้ ฉะนั้น
 * production ที่ไม่ได้ตั้ง env อะไรเลยทำงานเหมือนเดิมทุกประการ
 *
 * ที่ต้องมีเพราะแผน edge (docs/EDGE-PLAN.md เฟส 0) จำลอง edge เป็น instance ที่สองบนเครื่องเดียวกัน
 * ถ้าไฟล์สถานะอย่าง vms.db หรือ .rtsp-credentials.json ยังชี้ไปที่ server/ ตายตัว instance ที่สอง
 * จะเปิดฐานข้อมูลของ production แล้วเขียนทับกล้องจริงโดยไม่มีอะไรเตือน
 */
const fs = require('fs');
const path = require('path');

/** โฟลเดอร์ของไฟล์สถานะทั้งหมด — ฐานข้อมูล, secret, ไฟล์ที่จำค่าของเครื่อง */
const STATE_DIR = process.env.GATEWAY_STATE_DIR
  ? path.resolve(process.env.GATEWAY_STATE_DIR)
  : path.join(__dirname, '..');

const stateFile = (name) => path.join(STATE_DIR, name);

/** บทบาทของ instance — regional รับ edge ด้านล่างและต่อขึ้น central ด้านบน */
const requestedRole = String(process.env.GATEWAY_ROLE || 'central').toLowerCase();
if (!['central', 'regional', 'edge'].includes(requestedRole)) {
  throw new Error(`GATEWAY_ROLE ไม่ถูกต้อง: ${requestedRole}`);
}
const ROLE = requestedRole;
if (ROLE === 'regional' && !process.env.GATEWAY_STATE_DIR) {
  throw new Error('Regional ต้องตั้ง GATEWAY_STATE_DIR แยกจาก Central');
}
const REGION = String(process.env.GATEWAY_REGION || '').toLowerCase();
if (ROLE === 'regional' && !require('./region-groups').CODES.includes(REGION)) {
  throw new Error('Regional ต้องตั้ง GATEWAY_REGION เป็นหนึ่งใน central/east/northeast/north/west/south');
}

/**
 * เลขประจำเครื่อง 3 หลัก ใช้ใน global ID ของกล้อง (TH-<จังหวัด>-<เลขนี้>-<ลำดับ>)
 * central = 000 · ต้องไม่ซ้ำกันทั้งประเทศ — แจกจากตารางข้อตกลงใน docs/EDGE-PLAN.md
 */
const NODE_NUMBER = String(process.env.GATEWAY_NODE_NUMBER || '000').replace(/\D/g, '').padStart(3, '0').slice(-3);
if (ROLE === 'regional' && !/^[1-6]00$/.test(NODE_NUMBER)) {
  throw new Error('Regional ต้องใช้ GATEWAY_NODE_NUMBER เป็น 100/200/300/400/500/600');
}

/**
 * จังหวัดที่ใช้ใน global ID ของกล้องที่ยังไม่ได้ตั้งจังหวัด — ใช้ตอนออก ID เท่านั้น ไม่เขียนลงคอลัมน์
 * province_code ของกล้อง (ป้ายจังหวัดยังว่างจนกว่าคนจะตั้ง)
 *
 * central ไม่ต้องตั้ง: ได้ 10 (กรุงเทพฯ) ตาม concept ที่ central อยู่ กทม. ค่านี้ฝังไว้ในโค้ด ไม่ได้
 * พึ่ง env ของ pm2 เพราะ autorestart หลัง crash ใช้ env ชุดเดิม ไม่อ่าน ecosystem ใหม่ — ถ้าค่าหาย
 * แม้รอบเดียว กล้องที่ถูกออก ID รอบนั้นจะได้ 00 ไปตลอด (ตัดสินใจ 2026-09-23 สำหรับกล้องเดิม 91 ตัว)
 * edge ต้องตั้ง GATEWAY_DEFAULT_PROVINCE เป็นจังหวัดของตัวเอง ไม่ตั้ง = 00 (ไม่รู้จังหวัด)
 */
const DEFAULT_PROVINCE = (() => {
  const raw = String(process.env.GATEWAY_DEFAULT_PROVINCE || '').replace(/\D/g, '');
  if (raw) return raw.slice(0, 2).padStart(2, '0');
  return ROLE === 'central' ? '10' : '00';
})();

/** สวิตช์ analytics เดิมยังปิดอยู่; การรับ event จากต้นทางใช้ AI Sources */
const AI_ENABLED = String(process.env.GATEWAY_AI || '') === '1';

/**
 * รายการ path ที่นับเป็น "build" — ที่เดียวที่เป็นต้นฉบับ (canonical) ของนิยามนี้
 *
 * คือทุกอย่างที่แพ็กเกจอัปเดตของ edge พกไป (scripts/build-edge-kit.ps1: server, scripts,
 * ecosystem.edge.config.cjs, package.json + dist ที่ build จาก src/) — เดิมนับแค่ server/ ทำให้แก้ src/ scripts/
 * แล้วเลข build ไม่ขยับ central จึงไม่ส่งข้อเสนออัปเดตให้ edge (audit 2026-09-29)
 * ไม่รวม client-windows/ และ docs/ — commit ที่แก้แค่สองอย่างนั้นไม่ต้องทำให้ edge ขึ้น "ไม่ตรง central"
 *
 * ต้องตรงกันทุกที่ (แก้ตรงนี้แล้วแก้ที่อื่นด้วย): scripts/deploy.ps1, scripts/build-edge-kit.ps1, scripts/deploy-edge.sh
 */
const BUILD_PATHS = ['server', 'src', 'scripts', 'package.json', 'ecosystem.edge.config.cjs'];

/**
 * build ของโค้ดที่เครื่องนี้รันอยู่ — หน้า Edge Nodes และ client เทียบค่านี้ระหว่าง central กับ edge
 *
 * คือ commit ล่าสุดที่แก้ path ใน BUILD_PATHS ไม่ใช่ HEAD ของทั้ง repo: commit ที่แก้แค่ client หรือเอกสาร
 * เคยทำให้ขึ้น "ไม่ตรง central" จนกว่าจะ deploy edge ใหม่ ทั้งที่ของที่ edge รันไม่เปลี่ยนเลย (2026-09-23)
 */
const BUILD = (() => {
  try {
    return require('child_process')
      .execSync(`git log -1 --format=%h -- ${BUILD_PATHS.join(' ')}`, { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim() || null;
  } catch {
    /*
      เครื่องที่ได้โค้ดเป็น git archive (edge บน Linux — scripts/deploy-edge.sh) ไม่มี .git
      ตัว deploy เขียน commit ลงไฟล์ BUILD ที่รากของโค้ดไว้ให้ ไม่มีไฟล์ = ไม่รู้ (null)
    */
    try {
      return fs.readFileSync(path.join(__dirname, '..', '..', 'BUILD'), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
})();

const HTTP_PORT = Number(process.env.GATEWAY_PORT || 5173);
const GO2RTC_API_PORT = Number(process.env.GO2RTC_API_PORT || 1984);
const GO2RTC_RTSP_PORT = Number(process.env.GO2RTC_RTSP_PORT || 8555);
/**
 * ตัวกลาง RTSP ของกล้องจาก Dahua DSS (vms/dss-rtsp-relay.js) ฟังที่ 127.0.0.1 เท่านั้น — go2rtc ของเครื่องนี้ต่อเข้ามา
 * ค่าเริ่ม = พอร์ต gateway + 26 (central 5199 · edge ร่วมเครื่อง 5299) จะได้ไม่ชนกันเมื่อหลาย instance อยู่เครื่องเดียว
 */
const DSS_RELAY_PORT = Number(process.env.DSS_RELAY_PORT || HTTP_PORT + 26);

module.exports = {
  STATE_DIR, stateFile, ROLE, REGION, NODE_NUMBER, DEFAULT_PROVINCE, AI_ENABLED, BUILD_PATHS, BUILD,
  HTTP_PORT, GO2RTC_API_PORT, GO2RTC_RTSP_PORT, DSS_RELAY_PORT,
};
