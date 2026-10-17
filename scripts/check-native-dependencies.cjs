/** ตรวจ native SQLite และ tar ด้วย fixture ขนาดเล็ก ไม่เปิด DB production */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sqlite = require('../server/node_modules/sqlite3');
if (!process.env.CHECK_NATIVE_BASELINE_MODULE) throw Error('Set CHECK_NATIVE_BASELINE_MODULE to an absolute sqlite3 5.1.7 package path');
const oldSqlite = require(process.env.CHECK_NATIVE_BASELINE_MODULE);
assert.equal(require(path.join(process.env.CHECK_NATIVE_BASELINE_MODULE, 'package.json')).version, '5.1.7');
const tar = require('../server/node_modules/tar');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-native-check-'));
let checks = 0;
const pass = name => { checks++; console.log('PASS ' + name); };
const open = (driver, file, flags = driver.OPEN_READWRITE | driver.OPEN_CREATE) => new Promise((resolve, reject) => { const db = new driver.Database(file, flags, err => err ? reject(err) : resolve(db)); });
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve()));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
function archive(file, entries) {
  const chunks = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.content || '');
    const header = new tar.Header({ path: entry.path, type: entry.type || 'File', linkpath: entry.linkpath, mode: 0o600, size: bytes.length, mtime: new Date(0) });
    const block = Buffer.alloc(512); header.encode(block); chunks.push(block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(chunks)));
}
(async () => {
  assert.equal(require('../server/node_modules/sqlite3/package.json').version, '6.0.1');
  const lock = require('../server/package-lock.json'); assert.equal(lock.packages['node_modules/tar'].version, '7.5.22');
  pass('Fresh SQLite 6.0.1 binary and patched tar 7.5.22 loaded');
  const file = path.join(base, 'compat.db');
  let db = await open(oldSqlite, file); await exec(db, "CREATE TABLE fixture(id INTEGER PRIMARY KEY, camera TEXT, enabled INTEGER); INSERT INTO fixture VALUES(1,'TH-10-101-1',1)"); await close(db);
  db = await open(sqlite, file, sqlite.OPEN_READONLY); assert.equal((await get(db, 'SELECT camera FROM fixture')).camera, 'TH-10-101-1'); await assert.rejects(exec(db, 'DELETE FROM fixture'), /readonly/i); await close(db);
  pass('New driver reads old fixture and enforces readonly access');
  db = await open(sqlite, file); await exec(db, 'PRAGMA journal_mode=WAL; INSERT INTO fixture VALUES(2,\'TH-10-101-2\',1)');
  const reader = await open(oldSqlite, file, oldSqlite.OPEN_READONLY); assert.equal((await get(reader, 'SELECT COUNT(*) AS n FROM fixture')).n, 2); await close(reader);
  pass('Old driver reads WAL committed by new driver');
  await exec(db, 'BEGIN; UPDATE fixture SET enabled=0; ROLLBACK;'); assert.equal((await get(db, 'SELECT enabled FROM fixture WHERE id=1')).enabled, 1);
  assert.equal((await get(db, 'PRAGMA integrity_check')).integrity_check, 'ok'); await exec(db, 'PRAGMA wal_checkpoint(TRUNCATE)'); await close(db);
  pass('Transaction rollback, integrity and WAL checkpoint preserved');
  db = await open(oldSqlite, file); assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM fixture')).n, 2); await close(db);
  pass('Old driver reopens database after new-driver writes and close');
  const dest = path.join(base, 'extract'); fs.mkdirSync(dest);
  const fileTar = path.join(base, 'fixture.tar.gz'); archive(fileTar, [{ path: 'build/Release/fixture.node', content: 'fixture' }]);
  await tar.x({ file: fileTar, cwd: dest }); assert.equal(fs.readFileSync(path.join(dest, 'build/Release/fixture.node'), 'utf8'), 'fixture');
  pass('Patched tar extracts native-like archive entry');
  const unsafe = path.join(base, 'unsafe.tar.gz'); const warnings = [];
  archive(unsafe, [{ path: '../escape.txt', content: 'must-not-escape' }, { path: 'escape-link', type: 'Link', linkpath: '../sentinel.txt' }]);
  fs.writeFileSync(path.join(base, 'sentinel.txt'), 'original');
  await tar.x({ file: unsafe, cwd: dest, onwarn: code => warnings.push(code) });
  assert.equal(fs.existsSync(path.join(base, 'escape.txt')), false); assert.equal(fs.readFileSync(path.join(base, 'sentinel.txt'), 'utf8'), 'original'); assert.equal(fs.existsSync(path.join(dest, 'escape-link')), false); assert.ok(warnings.length);
  pass('Traversal and escaping hardlink rejected inside bounded fixture');
  console.log(JSON.stringify({ pass: checks, fail: 0, sqliteVersion: '6.0.1', sqliteEngine: '3.52.0', fixture: base }));
})().catch(err => { console.error(err); process.exitCode = 1; });
