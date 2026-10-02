/**
 * Clear every camera and everything that hangs off cameras, keeping accounts and API keys.
 *
 * Written for the 2026-09-23 restart as "edge adds cameras, central adds edges": the central's
 * own 91 cameras (direct ONVIF + Digifort) and all AI data went, users / roles / API keys stayed
 * so client-windows keeps working.
 *
 * Always copies the database first (backups/vms-before-reset-<time>.db, with its -wal) and prints
 * the path. The running gateway keeps going; restart it afterwards so go2rtc drops the old streams
 * and nothing is held in memory.
 *
 * Usage:
 *   node scripts/reset-cameras.cjs                       server/vms.db (production central)
 *   node scripts/reset-cameras.cjs D:\gateway-edge\vms.db   another instance's database
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'server', 'node_modules', 'sqlite3'));

const dbPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'server', 'vms.db'));

// Cameras, their sources, and every table keyed by camera id (grep "camera_id" in CREATE TABLE
// under server/ when adding a table). ai_events / ai_rules = edge ai-worker (2026-09-27),
// camera_deletions = tombstones of deleted cameras. Snapshot files in <state>/ai-snapshots are
// not touched - delete that folder by hand if the events are meant to go too.
const TABLES = [
  'cameras', 'camera_sources', 'role_devices', 'camera_deletions',
  'ai_events', 'ai_rules',
  'camera_ai', 'camera_ai_probe', 'camera_ai_stats', 'camera_analytics', 'analytics_config', 'person_attributes',
  'floor_plans', 'plan_markers',
  'logs',
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `vms-before-reset-${stamp}.db`);

const db = new sqlite3.Database(dbPath);
// VACUUM INTO gives a consistent single-file copy that includes whatever is still in the WAL
db.run(`VACUUM INTO ?`, [backup], (err) => {
  if (err) {
    console.error(`Backup failed, nothing deleted: ${err.message}`);
    process.exit(1);
  }
  console.log(`Backup: ${backup}`);
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, rows) => {
    const existing = new Set((rows || []).map((r) => r.name));
    db.serialize(() => {
      db.run('BEGIN');
      for (const t of TABLES) {
        if (!existing.has(t)) continue;
        db.run(`DELETE FROM ${t}`, function done(delErr) {
          console.log(delErr ? `${t}: ${delErr.message}` : `${t}: deleted ${this.changes}`);
        });
      }
      db.run('COMMIT', (cErr) => {
        if (cErr) console.error(`Commit failed: ${cErr.message}`);
        db.close();
      });
    });
  });
});
