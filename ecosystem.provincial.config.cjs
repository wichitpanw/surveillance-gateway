// Edge จังหวัดตัวใหม่บนโฮสต์ Central: เปิดคู่กับ Edge เก่าได้ระหว่าง migration M1
const fs = require('fs');
const path = require('path');
const configFile = 'D:\\gateway-provincial\\edge.json';
if (!fs.existsSync(configFile)) throw new Error(`ยังไม่มี ${configFile} — ยังไม่เริ่ม Edge จังหวัดใหม่`);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const node = String(config.node || '');
if ((config.role && config.role !== 'edge') || !/^[1-6]\d\d$/.test(node) || Number(node) % 100 === 0 ||
    path.resolve(String(config.stateDir || '')).toLowerCase() !== 'd:\\gateway-provincial' || Number(config.port) !== 5373 ||
    Number(config.go2rtcApi) !== 2004 || Number(config.go2rtcRtsp) !== 8575) {
  throw new Error(`${configFile} ต้องเป็น Edge จังหวัด node ในบล็อกภาค, stateDir D:\\gateway-provincial, พอร์ต 5373/2004/8575`);
}
const previous = process.env.GW_EDGE_CONFIG;
process.env.GW_EDGE_CONFIG = configFile;
let apps;
try { apps = require('./ecosystem.edge.config.cjs').apps; } finally {
  if (previous === undefined) delete process.env.GW_EDGE_CONFIG;
  else process.env.GW_EDGE_CONFIG = previous;
}
module.exports = { apps: apps.map((app) => {
  const name = app.name === '1-go2rtc-edge' ? '1-go2rtc-provincial' :
    app.name === '3-edge-gateway' ? '3-provincial-gateway' : '4-provincial-ai';
  const logDir = app.out_file ? path.dirname(app.out_file) : null;
  return {
    ...app, name,
    ...(logDir ? { out_file: path.join(logDir, `${name}-out.log`), error_file: path.join(logDir, `${name}-error.log`) } : {}),
  };
}) };
