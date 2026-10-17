/** ตรวจ patch ของ Express dependencies ด้วย mock HTTP ที่ loopback และข้อมูลทดสอบ */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const deps = '../server/node_modules/';
const express = require(deps + 'express');
const proxyaddr = require(deps + 'proxy-addr');
const qs = require(deps + 'qs');
const bodyParser = require(deps + 'body-parser');
const { match } = require(deps + 'path-to-regexp');
const repo = path.join(__dirname, '..');
let count = 0;
const pass = name => { count++; console.log('PASS ' + name); };
(async () => {
  for (const [name, version] of Object.entries({ express: '5.2.1', 'proxy-addr': '2.0.8', 'path-to-regexp': '8.4.2', qs: '6.16.0', 'body-parser': '2.3.0' })) {
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/package-lock.json')));
    assert.equal(lock.packages['node_modules/' + name].version, version);
  }
  pass('Patched transitive versions preserve Express 5.2.1');
  assert.equal(proxyaddr.compile('::ffff:203.0.113.0/8')('203.0.113.10'), false);
  assert.equal(proxyaddr.compile('::/1')('203.0.113.10'), false);
  pass('IPv6 trust subnets cannot incorrectly trust arbitrary IPv4 clients');
  const trusted = proxyaddr.compile('::ffff:203.0.113.0/104');
  assert.equal(trusted('203.0.113.4'), true); assert.equal(trusted('203.0.113.10'), false);
  assert.equal(proxyaddr.compile('203.0.113.0/8')('203.0.113.4'), true);
  pass('Correct IPv4 and mapped IPv6 trusted subnets remain compatible');
  assert.doesNotThrow(() => qs.stringify({ a: [null, undefined, 'x'] }, { arrayFormat: 'comma', encodeValuesOnly: true }));
  assert.deepEqual(qs.parse('camera=TH-10-101-1&time=2026-10-11T12%3A00%3A00%2B07%3A00'), { camera: 'TH-10-101-1', time: '2026-10-11T12:00:00+07:00' });
  assert.doesNotThrow(() => qs.stringify({ constructor: { isBuffer: 'untrusted', value: 'fixture' } }));
  pass('qs malformed object inputs and camera/time query contract remain usable');
  assert.throws(() => bodyParser.json({ limit: 'invalid-limit' }), /invalid/);
  assert.throws(() => bodyParser.json({ limit: NaN }), /invalid/);
  pass('Invalid body limit fails at middleware construction');
  let routeCount = 0;
  function scan(dir) {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (file.name === 'node_modules' || file.name === 'map_data') continue;
      const full = path.join(dir, file.name);
      if (file.isDirectory()) scan(full);
      else if (file.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const entry of source.matchAll(/\b(?:app|router)\.(?:get|post|put|patch|delete|all|use)\(\s*(['"])([^'"\r\n]+)\1/g)) {
          match(entry[2]); routeCount++;
        }
      }
    }
  }
  scan(path.join(repo, 'server'));
  assert.ok(routeCount > 100);
  pass('Literal app/router route patterns compile: ' + routeCount + ' (dynamic/RegExp routes excluded)');
  const app = express();
  assert.equal(app.get('trust proxy'), false);
  app.use(express.json());
  app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  app.post('/json', (req, res) => res.json(req.body));
  app.get('/stream/:name.mp4', (req, res) => res.json(req.params));
  app.get('/api/cameras/:id', (req, res) => res.json(req.params));
  app.get('/api/vector-tiles/:z/:x/:y.pbf', (req, res) => res.json(req.params));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type || 'error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const ip = await (await fetch(base + '/ip', { headers: { 'X-Forwarded-For': '203.0.113.88' } })).json();
    assert.equal(ip.ip, '127.0.0.1'); assert.deepEqual(ip.ips, []);
    pass('Default Express request identity ignores spoofed X-Forwarded-For');
    for (const [url, params] of [['/stream/TH-10-101-1_raw.mp4', { name: 'TH-10-101-1_raw' }], ['/api/cameras/TH-10-101-1', { id: 'TH-10-101-1' }], ['/api/vector-tiles/12/34/56.pbf', { z: '12', x: '34', y: '56' }]]) {
      const response = await fetch(base + url); assert.equal(response.status, 200); assert.deepEqual(await response.json(), params);
    }
    pass('Stream, camera and vector tile parameter routing preserved');
    assert.equal((await fetch(base + '/api/cameras/TH-10%ZZ')).status, 400);
    assert.equal((await fetch(base + '/missing')).status, 404);
    pass('Invalid encoding and unmatched paths return controlled 400/404');
    const valid = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera: 'TH-10-101-1', timestamp: '2026-10-11T12:00:00+07:00' }) });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).camera, 'TH-10-101-1');
    pass('Default JSON parser preserves camera and timestamp payload');
    const broken = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    assert.equal(broken.status, 400);
    pass('Malformed JSON fails with 400');
    const oversized = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(110 * 1024) }) });
    assert.equal(oversized.status, 413); assert.equal((await fetch(base + '/ip')).status, 200);
    pass('Default body size limit rejects oversize payload and server remains responsive');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log(JSON.stringify({ pass: count, fail: 0, literalRoutePatterns: routeCount, node: process.version }));
})().catch(err => { console.error(err); process.exitCode = 1; });
