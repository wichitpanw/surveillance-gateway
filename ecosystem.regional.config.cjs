// Regional บนเครื่อง Central หลังย้ายระบบ: state แยกจาก Edge จังหวัดและ Central
// ไฟล์ D:\gateway-regional\regional.json สร้างหลังสำรองและตรวจ M0 เท่านั้น
const fs = require('fs');
const path = require('path');
const configFile = 'D:\\gateway-regional\\regional.json';
if (!fs.existsSync(configFile)) throw new Error(`ยังไม่มี ${configFile} — ห้ามเริ่ม Regional ก่อนย้ายข้อมูล M0`);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (config.role !== 'regional' || !/^[1-6]00$/.test(String(config.node || '')) || !config.region) {
  throw new Error(`${configFile} ต้องมี role regional, region และ node ต้นบล็อก`);
}
if (path.resolve(String(config.stateDir || '')).toLowerCase() !== 'd:\\gateway-regional' || Number(config.port) !== 5273 ||
    Number(config.go2rtcApi) !== 1994 || Number(config.go2rtcRtsp) !== 8565) {
  throw new Error(`${configFile} ต้องใช้ stateDir D:\\gateway-regional และพอร์ต 5273/1994/8565`);
}
const provincialConfigFile = 'D:\\gateway-provincial\\edge.json';
// Edge เดิมถูกถอดจาก PM2 ตอนย้าย M2; config ที่เก็บสำรองไว้ไม่ใช่ instance ที่ยังรัน
const edgeConfigFile = provincialConfigFile;
if (fs.existsSync(edgeConfigFile)) {
  const edge = JSON.parse(fs.readFileSync(edgeConfigFile, 'utf8'));
  if (Number(edge.port || 5273) === Number(config.port || 5273)) {
    throw new Error(`Regional และ Edge ใช้พอร์ต ${config.port || 5273} ซ้ำกัน`);
  }
  if (Number(edge.go2rtcApi || 1994) === Number(config.go2rtcApi) || Number(edge.go2rtcRtsp || 8565) === Number(config.go2rtcRtsp)) {
    throw new Error('Regional และ Edge ใช้พอร์ต go2rtc ซ้ำกัน');
  }
}
const previous = process.env.GW_EDGE_CONFIG;
process.env.GW_EDGE_CONFIG = configFile;
let apps;
try { apps = require('./ecosystem.edge.config.cjs').apps; } finally {
  if (previous === undefined) delete process.env.GW_EDGE_CONFIG;
  else process.env.GW_EDGE_CONFIG = previous;
}
module.exports = { apps: apps.filter((app) => app.name !== '4-edge-ai').map((app) => {
  const name = app.name === '1-go2rtc-edge' ? '1-go2rtc-regional' : '3-regional-gateway';
  const logDir = app.out_file ? path.dirname(app.out_file) : null;
  return {
    ...app, name,
    ...(logDir ? { out_file: path.join(logDir, `${name}-out.log`), error_file: path.join(logDir, `${name}-error.log`) } : {}),
  };
}) };
