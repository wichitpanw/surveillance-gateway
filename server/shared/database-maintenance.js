const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ตรวจเฉพาะโครงสร้างฐานที่ระบบต้องใช้; คอลัมน์ใหม่ยังให้ migration ตอนเริ่มระบบเติมได้
const REQUIRED_COLUMNS = {
  users: ['id', 'username', 'password', 'role'],
  cameras: ['id', 'name', 'type', 'rtsp'],
  settings: ['setting_key', 'setting_value'],
  logs: ['id', 'username', 'action', 'details', 'timestamp'],
};
const run = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, err => err ? reject(err) : resolve());
});
const all = (db, sql) => new Promise((resolve, reject) => {
  db.all(sql, (err, rows) => err ? reject(err) : resolve(rows));
});
const close = db => new Promise((resolve, reject) => {
  db.close(err => err ? reject(err) : resolve());
});
function remove(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
const openReadOnly = (sqlite3, file) => new Promise((resolve, reject) => {
  const connection = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => {
    if (err) reject(err); else resolve(connection);
  });
});

// เปิด read-only และตรวจไฟล์ให้ครบก่อนแตะ connection หรือ DB ที่ใช้งานอยู่
async function validateDatabase(sqlite3, file) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (!header.equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid SQLite header');
  const candidate = await openReadOnly(sqlite3, file);
  try {
    const integrity = await all(candidate, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') {
      throw new Error('Database integrity check failed');
    }
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = await all(candidate, `PRAGMA table_info("${table}")`);
      const names = new Set(columns.map(column => column.name));
      if (required.some(name => !names.has(name))) throw new Error('Incompatible database schema');
      const tables = await all(candidate, `SELECT type FROM sqlite_master WHERE name = '${table}'`);
      if (tables.length !== 1 || tables[0].type !== 'table') throw new Error('Incompatible database schema');
    }
  } finally {
    await close(candidate);
  }
}

// แยก handler เพื่อทดสอบ backup/restore ด้วย SQLite และ HTTP fixture โดยไม่เปิด production
function createDatabaseMaintenance({ db, dbPath, sqlite3, saveLog, nowIso, scheduleRestart }) {
  let busy = false;
  let closed = false;
  const active = Symbol('databaseMaintenanceActive');
  const temporary = kind => path.join(path.dirname(dbPath), `vms-${kind}-${randomUUID()}.db`);
  const cleanup = file => {
    try { remove(file); } catch (_) { console.error('[Database maintenance] Temporary file cleanup failed'); }
  };
  // กัน backup/restore ซ้อนกัน รวมช่วงที่ multer กำลังรับไฟล์
  const exclusive = (req, res, next) => {
    if (busy || closed) return res.status(409).json({ error: 'Database maintenance is already in progress' });
    busy = true;
    const release = () => { if (!closed && !req[active]) busy = false; };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
  // VACUUM INTO สร้างสำเนา transaction ที่รวม WAL โดยไม่ต้องปิด DB
  const snapshot = file => run(db, 'VACUUM INTO ?', [file]);
  const backup = async (req, res) => {
    const file = temporary('backup');
    try {
      await snapshot(file);
      if (req.aborted || res.destroyed) { cleanup(file); return; }
      saveLog(req.user.username, 'Backup DB', 'สำรองข้อมูลระบบฐานข้อมูลสำเร็จ 💾');
      await new Promise(resolve => res.download(file, `vms-backup-${Date.now()}.db`, err => {
        cleanup(file);
        if (err && !res.headersSent && !res.destroyed) res.status(500).json({ error: 'Failed to download database backup' });
        resolve();
      }));
    } catch (_) {
      cleanup(file);
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'Failed to create database backup' });
    }
  };
  const restore = async (req, res) => {
    const upload = req.file?.path;
    if (!upload) return res.status(400).json({ error: 'Uploaded file not found' });
    try {
      await validateDatabase(sqlite3, upload);
    } catch (_) {
      cleanup(upload);
      return res.status(400).json({ error: 'Invalid or incompatible database backup' });
    }
    if (req.aborted || res.destroyed) { cleanup(upload); return; }
    const stamp = nowIso().replace(/[:.+]/g, '-');
    const snapshotPath = `${dbPath}.before-restore-${stamp}-${randomUUID()}`;
    try {
      // สำรองผ่าน SQLite ก่อนปิด connection; ห้ามเริ่ม restore หากสำรองไม่ได้
      await snapshot(snapshotPath);
      await close(db);
    } catch (_) {
      cleanup(upload);
      cleanup(snapshotPath);
      return res.status(500).json({ error: 'Failed to prepare database restore' });
    }
    closed = true;
    const finalSnapshot = temporary('recovery');
    let swapping = false;
    try {
      // เก็บ commit ที่อาจเข้ามาระหว่าง snapshot แรกกับ db.close ด้วย ก่อนลบ WAL
      const previous = await openReadOnly(sqlite3, dbPath);
      try { await run(previous, 'VACUUM INTO ?', [finalSnapshot]); } finally { await close(previous); }
      fs.renameSync(finalSnapshot, snapshotPath);
      swapping = true;
      // ไฟล์อัปโหลดอยู่ดิสก์เดียวกัน จึง rename แทน main file ได้แบบ atomic
      remove(dbPath + '-wal');
      remove(dbPath + '-shm');
      fs.renameSync(upload, dbPath);
      console.warn(`[Restore] Previous state saved to ${path.basename(snapshotPath)}`);
      res.json({ success: true, snapshot: path.basename(snapshotPath) });
      scheduleRestart(0);
    } catch (_) {
      // ใช้ snapshot ที่ตรวจว่าสร้างครบก่อนปิด DB กู้กลับก่อนให้ supervisor เริ่มระบบใหม่
      try {
        if (swapping) {
          remove(dbPath + '-wal');
          remove(dbPath + '-shm');
          // ไม่ copy ทับ main file โดยตรง เพราะ disk full อาจทำให้ไฟล์เดิมเสียตามไปด้วย
          fs.copyFileSync(snapshotPath, finalSnapshot);
          fs.renameSync(finalSnapshot, dbPath);
        }
      } catch (_) {
        console.error('[Restore] Recovery failed; use the before-restore snapshot');
      }
      cleanup(finalSnapshot);
      cleanup(upload);
      res.status(500).json({ error: 'Failed to restore database file — ระบบกำลังเริ่มใหม่', snapshot: path.basename(snapshotPath) });
      scheduleRestart(1);
    }
  };
  // ผู้ชมปิด HTTP ระหว่าง snapshot/validation ต้องไม่ปลด lock จนงาน SQLite จบ
  const operation = handler => async (req, res) => {
    req[active] = true;
    try { await handler(req, res); } finally {
      req[active] = false;
      if (!closed) busy = false;
    }
  };
  return { exclusive, backup: operation(backup), restore: operation(restore), uploadFilename: () => path.basename(temporary('restore')) };
}

module.exports = { createDatabaseMaintenance, validateDatabase };
