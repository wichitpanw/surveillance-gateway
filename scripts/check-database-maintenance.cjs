const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const http = require('http');
const dependencies = path.join(__dirname, '../server/node_modules/');
const sqlite3 = require(path.join(dependencies, 'sqlite3'));
const express = require(path.join(dependencies, 'express'));
const multer = require(path.join(dependencies, 'multer'));
const { createDatabaseMaintenance } = require('../server/shared/database-maintenance');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-maintenance-check-'));
const results = [];
const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, err => err ? reject(err) : resolve()));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
async function createDb(file, marker) {
  const db = new sqlite3.Database(file);
  await run(db, `CREATE TABLE users (id TEXT, username TEXT, password TEXT, role TEXT);
  `);
  await run(db, 'CREATE TABLE cameras (id TEXT, name TEXT, type TEXT, rtsp TEXT)');
  await run(db, 'CREATE TABLE settings (setting_key TEXT, setting_value TEXT)');
  await run(db, 'CREATE TABLE logs (id INTEGER, username TEXT, action TEXT, details TEXT, timestamp TEXT)');
  await run(db, 'CREATE TABLE fixture (marker TEXT)');
  await run(db, `INSERT INTO fixture VALUES ('${marker}')`);
  return db;
}
async function inspect(file, sql) {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  try { return await get(db, sql); } finally { await close(db); }
}
async function fixture(name) {
  const dir = path.join(base, name); fs.mkdirSync(dir);
  const dbPath = path.join(dir, 'vms.db');
  const db = await createDb(dbPath, 'original');
  await run(db, 'PRAGMA journal_mode=WAL');
  await run(db, 'PRAGMA wal_autocheckpoint=0');
  await get(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
  await run(db, "INSERT INTO fixture VALUES ('latest-wal')");
  const restart = [];
  const maintenance = createDatabaseMaintenance({ db, dbPath, sqlite3, saveLog() {}, nowIso: () => '2026-10-11T15:00:00+07:00', scheduleRestart: code => restart.push(code) });
  const app = express();
  app.use((req, res, next) => { req.user = { username: 'fixture' }; next(); });
  const upload = multer({ storage: multer.diskStorage({ destination: dir, filename: (req, file, callback) => callback(null, maintenance.uploadFilename()) }), limits: { files: 1 } });
  app.get('/backup', maintenance.exclusive, maintenance.backup);
  app.post('/restore', maintenance.exclusive, upload.single('backup'), maintenance.restore);
  app.use((err, req, res, next) => res.status(400).json({ error: 'upload rejected' }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { db, dbPath, dir, restart, url, async stop() {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (!restart.length) await close(db);
  } };
}
async function upload(f, bytes) {
  const body = new FormData(); body.append('backup', new Blob([bytes]), 'fixture.db');
  return fetch(f.url + '/restore', { method: 'POST', body });
}
async function check(name, test) {
  await test(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name);
}
async function invalid(name, bytes) {
  const f = await fixture(name);
  try {
    const response = await upload(f, bytes);
    assert.equal(response.status, 400);
    assert.equal((await get(f.db, 'SELECT count(*) AS n FROM fixture')).n, 2);
    assert.equal(f.restart.length, 0);
    assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('vms-restore-') || name.includes('before-restore')).length, 0);
  } finally { await f.stop(); }
}
(async () => {
  await check('WAL snapshot contains latest committed row and is standalone', async () => {
    const f = await fixture('backup');
    try {
      const response = await fetch(f.url + '/backup'); assert.equal(response.status, 200);
      const copy = path.join(base, 'download.db'); fs.writeFileSync(copy, Buffer.from(await response.arrayBuffer()));
      assert.equal((await inspect(copy, 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert.equal(Object.values(await inspect(copy, 'PRAGMA integrity_check'))[0], 'ok');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('vms-backup-')).length, 0);
    } finally { await f.stop(); }
  });
  const candidatePath = path.join(base, 'candidate.db'); const candidate = await createDb(candidatePath, 'restored'); await close(candidate);
  const valid = fs.readFileSync(candidatePath);
  await check('Malformed upload rejected; current DB remains usable', () => invalid('malformed', Buffer.from('NOT_SQLITE')));
  await check('Truncated SQLite rejected; current DB remains usable', () => invalid('truncated', valid.subarray(0, 128)));
  const wrong = path.join(base, 'wrong.db'); const wrongDb = new sqlite3.Database(wrong); await run(wrongDb, 'CREATE TABLE unrelated (id INTEGER)'); await close(wrongDb);
  await check('Unrelated valid SQLite rejected before close', () => invalid('wrong-schema', fs.readFileSync(wrong)));
  await check('Corrupted database rejected by integrity check', async () => {
    const corrupt = Buffer.from(valid); corrupt.fill(0xff, 100, 120); await invalid('corrupt', corrupt);
  });
  await check('Valid restore replaces DB and retains WAL-inclusive recovery snapshot', async () => {
    const f = await fixture('valid');
    try {
      const response = await upload(f, valid); assert.equal(response.status, 200);
      const body = await response.json(); assert(body.success); assert.deepEqual(f.restart, [0]);
      assert.equal((await inspect(f.dbPath, 'SELECT marker FROM fixture')).marker, 'restored');
      assert.equal((await inspect(path.join(f.dir, body.snapshot), 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert(!fs.existsSync(f.dbPath + '-wal')); assert(!fs.existsSync(f.dbPath + '-shm'));
      assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('vms-restore-')).length, 0);
    } finally { await f.stop(); }
  });
  await check('Atomic swap failure recovers original DB before restart', async () => {
    const f = await fixture('rename-failure'); const rename = fs.renameSync;
    let failed = false;
    try {
      fs.renameSync = (from, to) => { if (to === f.dbPath && !failed) { failed = true; throw new Error('fixture EACCES'); } return rename(from, to); };
      const response = await upload(f, valid); assert.equal(response.status, 500); assert.deepEqual(f.restart, [1]);
      assert.equal((await inspect(f.dbPath, 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert.equal(Object.values(await inspect(f.dbPath, 'PRAGMA integrity_check'))[0], 'ok');
    } finally { fs.renameSync = rename; await f.stop(); }
  });
  await check('Failed recovery staging preserves original file and recovery snapshot', async () => {
    const f = await fixture('recovery-failure'); const rename = fs.renameSync; const copy = fs.copyFileSync;
    try {
      fs.renameSync = (from, to) => { if (to === f.dbPath) throw new Error('fixture EACCES'); return rename(from, to); };
      fs.copyFileSync = (from, to) => { if (from.startsWith(f.dbPath + '.before-restore-')) throw new Error('fixture disk full'); return copy(from, to); };
      const response = await upload(f, valid); assert.equal(response.status, 500); const body = await response.json();
      assert.equal((await inspect(f.dbPath, 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert.equal((await inspect(path.join(f.dir, body.snapshot), 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert.deepEqual(f.restart, [1]);
    } finally { fs.renameSync = rename; fs.copyFileSync = copy; await f.stop(); }
  });
  await check('Final snapshot failure after close does not overwrite original DB', async () => {
    const f = await fixture('final-snapshot-failure'); const original = sqlite3.Database.prototype.run;
    try {
      sqlite3.Database.prototype.run = function(sql, params, callback) {
        if (sql === 'VACUUM INTO ?' && path.basename(params[0]).startsWith('vms-recovery-')) { callback(new Error('fixture disk full')); return this; }
        return original.apply(this, arguments);
      };
      const response = await upload(f, valid); assert.equal(response.status, 500); assert.deepEqual(f.restart, [1]);
      assert.equal((await inspect(f.dbPath, 'SELECT count(*) AS n FROM fixture')).n, 2);
    } finally { sqlite3.Database.prototype.run = original; await f.stop(); }
  });
  await check('Recovery snapshot retains commit arriving just before close', async () => {
    const f = await fixture('late-write'); const original = f.db.close;
    try {
      f.db.close = callback => f.db.run("INSERT INTO fixture VALUES ('late-write')", err => err ? callback(err) : original.call(f.db, callback));
      const response = await upload(f, valid); assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal((await inspect(path.join(f.dir, body.snapshot), 'SELECT count(*) AS n FROM fixture')).n, 3);
    } finally { f.db.close = original; await f.stop(); }
  });
  await check('Snapshot failure rejects restore without closing current DB', async () => {
    const f = await fixture('snapshot-failure'); const original = f.db.run;
    try {
      f.db.run = function(sql, params, callback) { if (sql === 'VACUUM INTO ?') { callback(new Error('fixture disk full')); return this; } return original.apply(this, arguments); };
      const response = await upload(f, valid); assert.equal(response.status, 500); assert.equal(f.restart.length, 0);
      assert.equal((await get(f.db, 'SELECT count(*) AS n FROM fixture')).n, 2);
    } finally { f.db.run = original; await f.stop(); }
  });
  await check('Close failure leaves original DB usable and cleans staging files', async () => {
    const f = await fixture('close-failure'); const original = f.db.close;
    try {
      f.db.close = callback => callback(new Error('fixture busy'));
      const response = await upload(f, valid); assert.equal(response.status, 500); assert.equal(f.restart.length, 0);
      assert.equal((await get(f.db, 'SELECT count(*) AS n FROM fixture')).n, 2);
      assert.equal(fs.readdirSync(f.dir).filter(name => name.includes('before-restore') || name.startsWith('vms-restore-')).length, 0);
    } finally { f.db.close = original; await f.stop(); }
  });
  await check('Concurrent restore rejected during snapshot even after viewer abort', async () => {
    const f = await fixture('concurrency'); const original = f.db.run;
    let resume; let started; const began = new Promise(resolve => { started = resolve; });
    try {
      f.db.run = function(sql, params, callback) {
        if (sql === 'VACUUM INTO ?') { resume = () => original.call(this, sql, params, callback); started(); return this; }
        return original.apply(this, arguments);
      };
      const request = http.get(f.url + '/backup'); request.on('error', () => {});
      await began; request.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
      const response = await upload(f, valid); assert.equal(response.status, 409);
      resume(); await new Promise(resolve => setTimeout(resolve, 100)); f.db.run = original;
      const response2 = await fetch(f.url + '/backup'); assert.equal(response2.status, 200); await response2.arrayBuffer();
      assert.equal(f.restart.length, 0);
    } finally { f.db.run = original; await f.stop(); }
  });
  console.log(JSON.stringify({ pass: results.length, fail: 0, fixture: base }));
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  // ลบเฉพาะ directory ที่ mkdtemp สร้างสำหรับ fixture นี้
  if (path.dirname(base) !== os.tmpdir() || !path.basename(base).startsWith('cctv-maintenance-check-')) throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(base, { recursive: true, force: true });
});
