/** ตรวจ scanner จริงด้วยพอร์ต/ONVIF จำลอง ไม่ส่ง packet หรือเปิด server */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../server/server.js'), 'utf8');
const start = source.indexOf('const scanSubnet = async ');
const end = source.indexOf("app.get('/api/scan'", start);
assert.ok(start >= 0 && end > start);
async function scan(ports) {
  const tcp = [], soap = [];
  let active = 0, maximum = 0;
  const context = {
    checkPort: async (ip, port) => { tcp.push([ip, port]); return Boolean(ports[ip]?.[port]); },
    probeOnvifUnauthenticated: async (ip, port) => {
      soap.push([ip, Number(port)]); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve)); active--;
      return ports[ip]?.[port] === 'onvif';
    },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.scan = scanSubnet;', context);
  return { rows: await context.scan('192.0.2.'), tcp, soap, maximum };
}
(async () => {
  const later = await scan({ '192.0.2.8': { 80: 'web', 8080: 'onvif' } });
  assert.equal(later.rows[0]?.port, '8080', 'an open web port must not hide later ONVIF');
  assert.equal(later.rows.length, 1);
  const first = await scan({ '192.0.2.8': { 80: 'onvif', 8080: 'onvif' } });
  assert.equal(first.rows[0].port, '80');
  assert.equal(first.tcp.some(([ip,p]) => ip === '192.0.2.8' && p === 8080), false);
  assert.equal(first.rows[0].ip, '192.0.2.8');
  assert.equal((await scan({})).rows.length, 0);
  assert.equal((await scan({ '192.0.2.8': { 80: 'web', 8080: 'web' } })).rows.length, 0);
  const last = await scan({ '192.0.2.8': { 8880: 'onvif' } });
  assert.equal(last.rows[0].port, '8880');
  const all = Object.fromEntries(Array.from({ length: 254 }, (_,i) => [`192.0.2.${i+1}`, { 80: 'onvif' }]));
  const bounded = await scan(all);
  assert.equal(bounded.rows.length, 254);
  assert.ok(bounded.maximum <= 30 && bounded.maximum > 1, `SOAP concurrency ${bounded.maximum}`);
  assert.equal(new Set(bounded.rows.map(r => r.ip)).size, 254);
  console.log('PASS subnet scan: later ONVIF port, first valid port, closed/non-ONVIF hosts, final port, no duplicates, concurrency <= 30');
})().catch(error => { console.error(error); process.exitCode = 1; });
