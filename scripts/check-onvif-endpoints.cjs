/** fixture ONVIF endpoints/schema — loopback พอร์ตสุ่มและ DB ในหน่วยความจำ ไม่แตะอุปกรณ์จริง */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const url = require('node:url');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('../server/node_modules/sqlite3');
const helper = require('../server/shared/onvif-endpoints');
const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`PASS ${name}`); }
const run = (db, sql, params = []) => new Promise((ok, no) => db.run(sql, params, (err) => err ? no(err) : ok()));
const get = (db, sql, params = []) => new Promise((ok, no) => db.get(sql, params, (err, row) => err ? no(err) : ok(row)));
async function main() {
  await test('discovery preserves HTTPS default port, path/query and all usable endpoints', () => {
    const urls = ['https://camera.example/custom/device?site=one', 'http://camera.example:8080/other'];
    const d = helper.discoveredOnvifDevice({ xaddrs: ['bad', ...urls], hardware: 'Camera' }, 0);
    assert.equal(d.ip, 'camera.example'); assert.equal(d.onvifPort, '443'); assert.deepEqual(d.onvif_xaddrs, urls);
    assert.equal(helper.discoveredOnvifDevice({ xaddrs: ['ftp://camera/'] }, 0), null);
  });
  await test('IPv6 and legacy HTTP/HTTPS candidates remain valid', () => {
    const d = helper.discoveredOnvifDevice({ xaddrs: ['https://[::1]:8443/device?x=1'] }, 1);
    assert.equal(d.ip, '::1'); assert.equal(d.onvifPort, '8443');
    assert.equal(helper.onvifEndpointCandidates({ ip: '::1', onvifPort: '8443', onvifXaddrs: d.onvif_xaddrs })[0], d.onvif_xaddrs[0]);
    assert.deepEqual(helper.onvifEndpointCandidates({ ip: 'camera.example', onvifPort: 80 }), ['http://camera.example/onvif/device_service', 'https://camera.example:80/onvif/device_service']);
  });
  await test('edited host/port replace stale discovery address while retaining custom path', () => {
    const c = helper.onvifEndpointCandidates({ ip: 'new.example', onvifPort: 9443, onvifXaddrs: ['https://old.example:8443/custom?x=1'] });
    assert.equal(c[0], 'https://new.example:9443/custom?x=1');
    assert(!c.some((u) => u.includes('old.example')));
  });
  await test('reject credential URLs, non-HTTP protocols, fragments and malformed lists', () => {
    for (const value of [['http://u:p@camera/x'], ['file:///x'], ['https://camera/#secret'], 'bad', {}, ['http://camera/x\n']]) {
      assert.throws(() => helper.parseOnvifXaddrs(value));
    }
    assert.deepEqual(helper.parseOnvifXaddrs(helper.storedOnvifXaddrs(['https://camera/a?x=1'])), ['https://camera/a?x=1']);
  });
  await test('actual initializer tries announced endpoints before legacy fallback', async () => {
    const attempts = [];
    const context = { onvifEndpointCandidates: helper.onvifEndpointCandidates, onvif: { OnvifDevice: class {
      constructor(options) { this.options = options; }
      async init() { attempts.push(this.options.xaddr); if (!this.options.xaddr.includes('/working')) throw Error('fixture unavailable'); }
    } } };
    const a = source.indexOf('const initOnvifDeviceWithFallback =');
    const b = source.indexOf('/** Probe ONVIF device', a);
    vm.createContext(context); vm.runInContext(source.slice(a, b) + '\nglobalThis.init = initOnvifDeviceWithFallback;', context);
    await context.init({ ip: 'camera', onvifPort: 443, onvifXaddrs: ['https://camera/missing', 'https://camera/working?device=1'], user: 'fixture', pass: 'fixture' });
    assert.deepEqual(attempts, ['https://camera/missing', 'https://camera/working?device=1']);
  });
  await test('actual SOAP transport retains custom path/query over HTTP and self-signed HTTPS', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onvif-endpoint-check-'));
    const key = path.join(temp, 'key.pem'); const cert = path.join(temp, 'cert.pem');
    const openssl = process.env.OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
    try {
      execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', windowsHide: true });
      const { patchNodeOnvif } = require('../server/onvif_patch'); patchNodeOnvif(require('../server/node_modules/node-onvif'));
      const soap = require('../server/node_modules/node-onvif/lib/modules/soap');
      for (const secure of [false, true]) {
        const seen = [];
        const handler = (req, res) => { seen.push(req.url); req.resume(); res.writeHead(200); res.end('<Envelope/>'); };
        const server = secure ? https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler) : http.createServer(handler);
        await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
        try {
          await soap._request(url.parse(`${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}/custom/onvif?device=7&mode=one`), '<fixture/>');
          assert.deepEqual(seen, ['/custom/onvif?device=7&mode=one']);
        } finally { await new Promise((ok) => server.close(ok)); }
      }
    } finally {
      if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('onvif-endpoint-check-')) throw Error('Unexpected fixture directory');
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  await test('fresh and existing SQLite schemas persist endpoints without changing identity', async () => {
    const create = source.match(/db\.run\(`(CREATE TABLE IF NOT EXISTS cameras \([^`]+)`\)/)[1];
    const alter = source.match(/db\.run\("(ALTER TABLE cameras ADD COLUMN onvif_xaddrs TEXT)"/)[1];
    for (const legacy of [false, true]) {
      const db = new sqlite3.Database(':memory:');
      try {
        await run(db, create);
        if (legacy) await run(db, 'INSERT INTO cameras (id,name) VALUES (?,?)', ['stable-id', 'Existing']);
        await run(db, alter);
        if (!legacy) await run(db, 'INSERT INTO cameras (id,name) VALUES (?,?)', ['stable-id', 'New']);
        const saved = helper.storedOnvifXaddrs(['https://camera/custom?x=1']);
        await run(db, 'UPDATE cameras SET onvif_xaddrs=? WHERE id=?', [saved, 'stable-id']);
        assert.deepEqual(await get(db, 'SELECT id,onvif_xaddrs FROM cameras'), { id: 'stable-id', onvif_xaddrs: saved });
        await assert.rejects(run(db, alter), /duplicate column/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM cameras')).n, 1);
      } finally { await new Promise((ok) => db.close(ok)); }
    }
  });
  await test('actual camera insert/update SQL accepts the persisted endpoint column', async () => {
    const create = source.match(/db\.run\(`(CREATE TABLE IF NOT EXISTS cameras \([^`]+)`\)/)[1];
    const db = new sqlite3.Database(':memory:');
    try {
      await run(db, create);
      for (const name of ['rtsp_sub', 'stream_type', 'onvif_main_token', 'onvif_sub_token', 'nvr_channel', 'onvif_xaddrs', 'province_code', 'district_code']) {
        await run(db, `ALTER TABLE cameras ADD COLUMN ${name} TEXT`);
      }
      const statements = [...source.matchAll(/"(INSERT INTO cameras \([^"\r\n]+ VALUES \([^"\r\n]+)"/g)]
        .map((m) => m[1]).filter((sql) => sql.includes('onvif_xaddrs'));
      assert.equal(statements.length, 2);
      const saved = helper.storedOnvifXaddrs(['https://camera/custom?x=1']);
      for (const [i, sql] of statements.entries()) {
        const fields = sql.match(/\(([^)]+)\)/)[1].split(',').map((x) => x.trim());
        const values = fields.map((name) => name === 'id' ? `camera-${i}` : name === 'onvif_xaddrs' ? saved : null);
        await run(db, sql, values);
        assert.equal((await get(db, 'SELECT onvif_xaddrs FROM cameras WHERE id=?', [`camera-${i}`])).onvif_xaddrs, saved);
      }
      const update = source.match(/"(UPDATE cameras SET name=\?[^"\r\n]+onvif_xaddrs=\?[^"\r\n]* WHERE id=\?)"/)[1];
      const fields = update.match(/SET (.+) WHERE/)[1].split(',').map((x) => x.trim().split('=')[0]);
      await run(db, update, [...fields.map((name) => name === 'onvif_xaddrs' ? saved : null), 'camera-0']);
      assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM cameras')).n, 2);
      assert.equal((await get(db, 'SELECT id FROM cameras WHERE id=?', ['camera-0'])).id, 'camera-0');
    } finally { await new Promise((ok) => db.close(ok)); }
  });
  await test('actual camera-list route hides endpoint queries from roles without secrets', () => {
    const secretDeclaration = source.match(/const CAMERA_SECRET_FIELDS = \[[^;]+;/)[0];
    const start = source.indexOf("app.get('/api/cameras', (req, res) => {");
    const end = source.indexOf('// ค่าหน้า', start);
    const row = { id: 'stable-id', rtsp: 'rtsp://fixture', rtsp_sub: 'rtsp://fixture/sub', onvifUser: 'fixture', onvifPass: 'secret', onvif_xaddrs: '["https://camera/service?token=fixture-secret"]' };
    let handler;
    const context = { app: { get: (route, callback) => { handler = callback; } }, db: { all: (sql, callback) => callback(null, [row]) }, codecCache: {}, resolveCameraSubRtsp: (c) => c.rtsp_sub };
    vm.createContext(context); vm.runInContext(secretDeclaration + source.slice(start, end), context);
    let result;
    handler({ perms: new Set(), deviceIds: null }, { json: (value) => { result = value; } });
    assert.equal(result.length, 1); assert(!JSON.stringify(result).includes('fixture-secret')); assert.equal(result[0].onvif_xaddrs, undefined);
    handler({ perms: new Set(['device.secrets']), deviceIds: null }, { json: (value) => { result = value; } });
    assert.equal(result[0].onvif_xaddrs, row.onvif_xaddrs);
    assert.equal(row.id, 'stable-id');
  });
  await test('status pre-check accepts a reachable alternate endpoint port', async () => {
    const calls = [];
    const context = { URL, Set, onvifEndpointCandidates: helper.onvifEndpointCandidates,
      checkTcpPort: async (host, port) => { calls.push([host, port]); return port === 8443; },
      withTimeout: async (promise) => promise, ONVIF_STATUS_PROBE_TIMEOUT_MS: 4000,
      initOnvifDeviceWithFallback: async (options) => { assert(options.onvifXaddrs); },
    };
    const start = source.indexOf('const checkCameraDeviceReachable =');
    const end = source.indexOf('const fetchCoreCamPathCount', start);
    vm.createContext(context); vm.runInContext(source.slice(start, end) + '\nglobalThis.reachable = checkCameraDeviceReachable;', context);
    assert.equal(await context.reachable({ ip: 'camera', onvifPort: 80, onvif_xaddrs: ['http://camera/device', 'https://camera:8443/service'] }), true);
    assert(calls.some(([host, port]) => host === 'camera' && port === 8443));
  });
  console.log(`ONVIF endpoints: ${count} checks passed`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });