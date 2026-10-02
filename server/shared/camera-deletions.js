/**
 * บันทึกการลบกล้องที่ edge (tombstone) — ให้ central ลบตามเฉพาะกล้องที่คนลบจริง
 *
 * central ไม่ลบกล้องที่ "หายจาก edge" เอง เพราะแยกไม่ออกว่าคนลบหรือ edge ตอบไม่ครบ/ถูกล้าง DB
 * (docs/EDGE-PLAN.md) · edge จึงจดการลบของคนไว้ที่นี่ แล้วส่งให้ central ทางสาย link (catalog.deleted)
 * และทาง pull (GET /api/v1/cameras/deleted) · กล้องที่หายโดยไม่มีบันทึกยังเป็นแบบเดิม: ติดป้าย ไม่ลบ
 *
 * เก็บ 90 วัน — central ที่ติดต่อ edge ไม่ได้นานกว่านั้นจะเห็นกล้องพวกนั้นเป็น "หายจาก edge" ให้คนกดลบเอง
 */
const { nowIso, toBangkokIso } = require('./time');

const KEEP_DAYS = 90;

function createCameraDeletions(db) {
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); }));
  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  const ready = run(`CREATE TABLE IF NOT EXISTS camera_deletions (
      camera_id TEXT PRIMARY KEY,
      global_id TEXT,
      name TEXT,
      deleted_at TEXT NOT NULL,
      deleted_by TEXT
    )`).catch((err) => console.error(`[Camera deletions] สร้างตารางไม่สำเร็จ: ${err.message}`));

  /**
   * จดกล้องที่กำลังจะลบ — เรียกก่อน DELETE (ต้องอ่านชื่อ/global ID จากแถวที่ยังอยู่)
   * ข้ามกล้อง relay ตามปกติ; includeRelay ใช้เฉพาะ Regional ส่งการลบที่ยืนยันจาก Edge ต่อขึ้น Central
   */
  async function record(ids, username, { includeRelay = false } = {}) {
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return;
    await ready;
    const rows = await all(
      `SELECT id, global_id, name FROM cameras WHERE id IN (${list.map(() => '?').join(',')})${includeRelay ? '' : " AND COALESCE(type, '') != 'edge_relay'"}`,
      list,
    );
    const at = nowIso();
    for (const r of rows) {
      await run(
        'INSERT OR REPLACE INTO camera_deletions (camera_id, global_id, name, deleted_at, deleted_by) VALUES (?,?,?,?,?)',
        [r.id, r.global_id || null, r.name || null, at, username || null],
      );
    }
    // ตัดของเก่าตอนจดครั้งถัดไป ไม่ต้องมี timer แยก — เทียบเป็นข้อความได้เพราะเวลาทุกตัวเป็น ISO +07:00 รูปเดียวกัน
    const cutoffIso = toBangkokIso(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    await run('DELETE FROM camera_deletions WHERE deleted_at < ?', [cutoffIso]).catch(() => {});
  }

  /** id ของกล้องที่ถูกลบ (ใหม่สุดก่อน) — ส่งให้ central */
  async function list() {
    await ready;
    return all('SELECT camera_id AS id, deleted_at AS deletedAt FROM camera_deletions ORDER BY deleted_at DESC LIMIT 5000');
  }

  /** กล้อง id เดิมถูกแอดกลับ — ลบบันทึกทิ้ง ไม่งั้น central ลบตัวใหม่ทันทีที่รับเข้าไป */
  async function forget(ids) {
    const list = (ids || []).map(String).filter(Boolean);
    if (!list.length) return;
    await ready;
    await run(`DELETE FROM camera_deletions WHERE camera_id IN (${list.map(() => '?').join(',')})`, list).catch(() => {});
  }

  return { record, list, forget };
}

module.exports = { createCameraDeletions };
