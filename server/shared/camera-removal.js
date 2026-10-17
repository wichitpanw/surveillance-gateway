const { nowIso, toBangkokIso } = require('./time');

/** ลบกล้องและจด tombstone ให้สำเร็จพร้อมกัน โดยแยก connection ไม่ให้ transaction ครอบงานอื่นของ server */
async function removeCameras({ dbPath, sqlite3, ids, username, recordDeletions = false }) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return [];
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, err => err ? reject(err) : resolve(connection));
  });
  db.configure('busyTimeout', 5000);
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
  const all = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  let transaction = false;
  try {
    await run('BEGIN IMMEDIATE');
    transaction = true;
    const slots = list.map(() => '?').join(',');
    const rows = await all('SELECT id FROM cameras WHERE id IN (' + slots + ')', list);
    if (recordDeletions) {
      await run("INSERT OR REPLACE INTO camera_deletions (camera_id, global_id, name, deleted_at, deleted_by) SELECT id, global_id, name, ?, ? FROM cameras WHERE id IN (" + slots + ") AND COALESCE(type, '') != 'edge_relay'", [nowIso(), username || null, ...list]);
      await run('DELETE FROM camera_deletions WHERE deleted_at < ?', [toBangkokIso(new Date(Date.now() - 90 * 86400000))]);
    }
    await run('DELETE FROM cameras WHERE id IN (' + slots + ')', list);
    await run('COMMIT');
    transaction = false;
    return rows.map(row => String(row.id));
  } catch (err) {
    if (transaction) await run('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  }
}

module.exports = { removeCameras };
