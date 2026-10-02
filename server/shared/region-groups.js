/** หกภาคสำหรับการรวมข้อมูล: รวม กทม./ปริมณฑลเข้ากับภาคกลางตามการใช้งานระบบ */
const fs = require('fs');
const path = require('path');

const CODES = ['central', 'east', 'northeast', 'north', 'west', 'south'];
const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'thai-region-groups.csv'), 'utf8').trim();
const byProvince = new Map();
for (const line of csv.split(/\r?\n/).slice(1)) {
  const [province, region] = line.split(',');
  if (!/^\d{2}$/.test(province) || !CODES.includes(region) || byProvince.has(province)) {
    throw new Error(`thai-region-groups.csv มีแถวที่ไม่ถูกต้อง: ${line}`);
  }
  byProvince.set(province, region);
}
if (byProvince.size !== 77) throw new Error('thai-region-groups.csv ต้องมี 77 จังหวัด');

const regionForProvince = (provinceCode) => byProvince.get(String(provinceCode || '')) || null;

module.exports = { CODES, byProvince, regionForProvince };
