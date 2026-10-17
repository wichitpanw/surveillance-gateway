const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const root = path.resolve(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-sse-check-'));
process.env.GATEWAY_STATE_DIR = base;
process.env.GATEWAY_KEY_SECRET_FILE = path.join(base, 'fixture-key-secret');
process.env.GATEWAY_ROLE = 'central';
const sqlite3 = require(path.join(root, 'server/node_modules/sqlite3'));
const express = require(path.join(root, 'server/node_modules/express'));
const { createApiKeyAuth, hashKey } = require(path.join(root, 'server/gateway/auth'));
const { createGatewayAdminRouter } = require(path.join(root, 'server/gateway/admin'));
const source = fs.readFileSync(path.join(root, 'server/gateway/index.js'), 'utf8');
const scopeModule = { exports: {} };
vm.runInNewContext(source.slice(source.indexOf('  const scopeClause ='), source.indexOf('  router.use(auth.requireApiKey)')) + '\nmodule.exports = scopeClause;', { module: scopeModule, PUBLIC_TYPE: 'public_hls' });
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(5); } throw new Error('Fixture wait timed out'); }
async function fixture() {
  const db = new sqlite3.Database(':memory:');
  const auth = createApiKeyAuth(db);
  await get(db, 'SELECT count(*) AS n FROM api_clients');
  await run(db, 'CREATE TABLE cameras (id TEXT, name TEXT, group_name TEXT, type TEXT)');
  await run(db, "INSERT INTO cameras VALUES ('A1','camera A','A','rtsp'),('B1','camera B','B','rtsp'),('P1','public camera','B','public_hls')");
  for (const id of ['k1', 'k2']) await run(db, 'INSERT INTO api_clients (id,name,key_hash,key_hint,scope_groups,enabled,allow_public,created_at) VALUES (?,?,?,?,?,1,1,?)', [id,id,hashKey('fixture-' + id),'fixture','["A"]','2026-10-11T15:00:00+07:00']);
  const timers = new Map(); let nextTimer = 0;
  const mod = { exports: {} };
  // จำลองเฉพาะเวลา: source ของ handler จริง, auth/SQLite/HTTP จริง, producer เป็น fixture
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/gateway/events.js'), 'utf8'), { module: mod, Map, Promise, JSON, console, Symbol, setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id) });
  const cameras = new EventEmitter(), ai = new EventEmitter(), edges = new EventEmitter();
  let lookup = async ids => new Map(ids.map(id => [id, {}]));
  const deps = { db, auth, scopeClause: scopeModule.exports,
    cameraState: { subscribe: ({ onChange, onRemove }) => { cameras.on('change', onChange); cameras.on('remove', onRemove); return () => { cameras.off('change', onChange); cameras.off('remove', onRemove); }; } },
    aiEvents: { subscribe: fn => { ai.on('event', fn); return () => ai.off('event', fn); } },
    edgeAlerts: { subscribe: fn => { edges.on('event', fn); return () => edges.off('event', fn); } },
    cameraInfo: ids => lookup(ids), withCamera: rows => rows, streamPathName: id => id, nowIso: () => '2026-10-11T15:00:00+07:00' };
  const app = express(); app.use(express.json());
  const handler = mod.exports.createEventStream(deps);
  app.get('/events', auth.requireApiKey, (req, res) => Promise.resolve(handler(req, res)));
  app.use('/admin', (req, res, next) => { req.user = { username: 'fixture-admin' }; req.perms = new Set(['menu.publiccam','device.ptz','playback.view']); next(); }, createGatewayAdminRouter({ db, requirePerm: () => (req,res,next) => next(), invalidateCache: auth.invalidate }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`; const streams = [];
  const open = async (id = 'k1') => {
    const stream = { text: '', ended: false }; streams.push(stream);
    await new Promise((resolve, reject) => {
      stream.request = http.get(url + '/events', { headers: { Authorization: 'Bearer fixture-' + id } }, response => {
        stream.response = response; response.on('data', bytes => { stream.text += bytes.toString(); });
        response.on('end', () => { stream.ended = true; }); response.on('error', () => { stream.ended = true; }); resolve();
      }); stream.request.on('error', reject);
    });
    await until(() => stream.text.includes('event: hello') || stream.ended); return stream;
  };
  const tick = async () => { for (const timer of [...timers.values()]) if (timer.ms === 30000) await timer.fn(); await delay(10); };
  const emit = id => cameras.emit('change', id, { enabled: true, reachable: true, streaming: false, at: 'fixture' }, null);
  return { db, auth, cameras, ai, edges, timers, open, tick, emit, url, setLookup: fn => { lookup = fn; }, async stop() {
    for (const stream of streams) stream.request.destroy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  } };
}
let passed = 0;
async function check(name, action) {
  const f = await fixture();
  try { await action(f); passed++; console.log('PASS ' + name); } finally { await f.stop(); }
}
async function patch(f, body) {
  const response = await fetch(f.url + '/admin/k1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
}
(async () => {
  await check('Authorized SSE preserves hello/camera/legacy/AI/edge protocol and excludes other group', async f => {
    const s = await f.open(); f.emit('A1'); f.emit('B1'); f.emit('P1'); f.ai.emit('event', { camera_id: 'A1', seq: 1 }); f.edges.emit('event', { node: 100 });
    await until(() => s.text.includes('ai_event'));
    for (const type of ['camera_state','camera_status','ai_event','edge_state']) assert(s.text.includes(type));
    assert(!s.text.includes('camera B')); assert(s.text.includes('public camera'));
  });
  await check('Actual admin DELETE immediately closes only revoked key streams', async f => {
    const a = await f.open(); const b = await f.open('k2');
    assert.equal((await fetch(f.url + '/admin/k1', { method: 'DELETE' })).status, 200);
    await until(() => a.ended); f.emit('A1'); await until(() => b.text.includes('camera_state'));
    assert(!a.text.includes('camera_state')); assert(!b.ended);
    assert.equal((await fetch(f.url + '/events', { headers: { Authorization: 'Bearer fixture-k1' } })).status, 401);
  });
  await check('Actual admin disable closes SSE and new connection returns 401', async f => {
    const s = await f.open(); await patch(f, { enabled: false }); await until(() => s.ended);
    f.emit('A1'); assert(!s.text.includes('camera_state'));
    assert.equal((await fetch(f.url + '/events', { headers: { Authorization: 'Bearer fixture-k1' } })).status, 401);
  });
  await check('Actual admin allow_public removal closes old SSE and reconnect excludes public', async f => {
    const s = await f.open(); await patch(f, { allowPublic: false }); await until(() => s.ended);
    const next = await f.open(); f.emit('P1'); f.emit('A1'); await until(() => next.text.includes('camera_state'));
    assert(!next.text.includes('public camera'));
  });
  await check('Periodic direct DB disable bypasses warm auth cache', async f => {
    const s = await f.open(); await run(f.db, "UPDATE api_clients SET enabled=0 WHERE id='k1'"); await f.tick(); assert(s.ended);
  });
  await check('Periodic direct DB delete closes stream', async f => {
    const s = await f.open(); await run(f.db, "DELETE FROM api_clients WHERE id='k1'"); await f.tick(); assert(s.ended);
  });
  await check('Periodic key hash replacement rejects old credential', async f => {
    const s = await f.open(); await run(f.db, "UPDATE api_clients SET key_hash='replacement' WHERE id='k1'"); await f.tick(); assert(s.ended);
  });
  await check('Periodic scope reload uses latest group and Public flag', async f => {
    const s = await f.open(); await run(f.db, "UPDATE api_clients SET scope_groups='[\"B\"]',allow_public=0 WHERE id='k1'"); await f.tick();
    f.emit('A1'); f.emit('B1'); f.emit('P1'); await until(() => s.text.includes('camera B'));
    assert(!s.text.includes('camera A')); assert(!s.text.includes('public camera'));
  });
  await check('Empty scope and malformed JSON fail closed for private cameras', async f => {
    const s = await f.open(); await run(f.db, "UPDATE api_clients SET scope_groups='[]',allow_public=0 WHERE id='k1'"); await f.tick(); f.emit('A1');
    await run(f.db, "UPDATE api_clients SET scope_groups='{invalid' WHERE id='k1'"); await f.tick(); f.emit('A1'); await delay(10); assert(!s.text.includes('camera_state'));
  });
  await check('Camera group changes are reflected at periodic scope refresh', async f => {
    const s = await f.open(); await run(f.db, "UPDATE cameras SET group_name='B' WHERE id='A1'"); await f.tick(); f.emit('A1'); await delay(10); assert(!s.text.includes('camera_state'));
  });
  await check('Key query failure closes stream and removes subscriptions/timers', async f => {
    const s = await f.open(); const original = f.db.get;
    f.db.get = (sql, params, callback) => callback(new Error('fixture DB unavailable'));
    try { await f.tick(); assert(s.ended); assert.equal(f.cameras.listenerCount('change'), 0); assert.equal(f.timers.size, 0); } finally { f.db.get = original; }
  });
  await check('Scope query failure closes stream rather than retaining old scope', async f => {
    const s = await f.open(); const original = f.db.all;
    f.db.all = (sql, params, callback) => callback(new Error('fixture DB unavailable'));
    try { await f.tick(); assert(s.ended); f.emit('A1'); assert(!s.text.includes('camera_state')); } finally { f.db.all = original; }
  });
  await check('Pending AI metadata does not leak after admin revocation', async f => {
    let release; f.setLookup(() => new Promise(resolve => { release = resolve; }));
    const s = await f.open(); f.ai.emit('event', { camera_id: 'A1', seq: 2 }); await patch(f, { enabled: false }); await until(() => s.ended);
    release(new Map()); await delay(10); assert(!s.text.includes('ai_event'));
  });
  await check('Pending AI from previous authorization generation is dropped after refresh', async f => {
    let release; f.setLookup(() => new Promise(resolve => { release = resolve; }));
    const s = await f.open(); f.ai.emit('event', { camera_id: 'A1', seq: 3 }); await f.tick(); release(new Map()); await delay(10); assert(!s.text.includes('ai_event'));
  });
  await check('Revocation during initial scope query cannot leave a subscription behind', async f => {
    const original = f.db.all; let release; let began;
    const started = new Promise(resolve => { began = resolve; });
    f.db.all = function(sql, params, callback) { release = () => original.call(this, sql, params, callback); began(); };
    const opening = f.open(); await started; f.auth.invalidate('k1'); release(); const s = await opening; await until(() => s.ended);
    f.db.all = original; assert.equal(f.cameras.listenerCount('change'), 0); assert.equal(f.ai.listenerCount('event'), 0); assert.equal(f.timers.size, 0);
  });
  await check('Viewer disconnect clears all listeners and timers', async f => {
    const s = await f.open(); s.request.destroy(); await until(() => f.cameras.listenerCount('change') === 0);
    assert.equal(f.ai.listenerCount('event'), 0); assert.equal(f.edges.listenerCount('event'), 0); assert.equal(f.timers.size, 0);
  });
  await check('Refresh pauses camera/AI/edge delivery and stale callback cannot reopen revoked SSE', async f => {
    const s = await f.open(); const original = f.db.all; let release; let began;
    const started = new Promise(resolve => { began = resolve; });
    f.db.all = function(sql, params, callback) { release = () => original.call(this, sql, params, callback); began(); };
    const refreshing = f.tick(); await started;
    f.emit('A1'); f.ai.emit('event', { camera_id: 'A1', seq: 4 }); f.edges.emit('event', { node: 100 });
    await delay(10); assert(!s.text.includes('camera_state')); assert(!s.text.includes('ai_event')); assert(!s.text.includes('edge_state'));
    f.auth.invalidate('k1'); release(); await refreshing; f.db.all = original; await until(() => s.ended);
    assert.equal(f.cameras.listenerCount('change'), 0); assert.equal(f.timers.size, 0);
  });
  console.log(JSON.stringify({ pass: passed, fail: 0, periodicRecheckMs: 30000 }));
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith('cctv-sse-check-')) throw new Error('Unsafe fixture path');
  fs.rmSync(base, { recursive: true, force: true });
});
