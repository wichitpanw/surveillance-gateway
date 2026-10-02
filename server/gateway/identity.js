/**
 * Global ID ของกล้อง: `TH-<จังหวัด 2 หลัก>-<เลขเครื่อง 3 หลัก>-<ลำดับ 5 หลัก>`
 *
 * เป็นชื่อที่กล้องหนึ่งตัวใช้ร่วมกันทุกชั้น (edge → central → client) ต่างจาก `cameras.id` ซึ่งเป็น
 * ของภายในเครื่อง — go2rtc path, client และ log อ้าง id เดิมอยู่ จึงไม่แตะมัน
 *
 * กติกาที่ห้ามหลุด (docs/EDGE-PLAN.md):
 *   - ออกให้ครั้งเดียว แล้ว **ไม่เปลี่ยนตลอดอายุกล้อง** แม้จะแก้จังหวัดทีหลัง ถ้าเปลี่ยนได้ central
 *     จะเห็นกล้องตัวเดิมเป็นตัวใหม่ แล้วผัง wall กับสิทธิ์ที่ผูกไว้หลุดหมด
 *   - ลำดับไม่ถูกใช้ซ้ำแม้กล้องถูกลบ — ตัวนับเก็บใน settings ไม่ได้นับจากแถวที่เหลืออยู่
 *   - กล้องที่ยังไม่ได้เลือกจังหวัดได้จังหวัดของเครื่อง (DEFAULT_PROVINCE — central = 10, edge ตั้งเอง,
 *     ไม่ตั้ง = 00) ซึ่งจะอยู่อย่างนั้นตลอดไปแม้ตั้งจังหวัดทีหลัง (ผลของข้อแรก)
 *   - กล้องที่ import มาจาก edge ใช้ global ID ของ edge ตามเดิม ไม่ออกใหม่ที่นี่
 */
const { NODE_NUMBER, DEFAULT_PROVINCE } = require('../shared/instance');

const SEQ_KEY = 'global_id_seq';

const formatGlobalId = (provinceCode, seq) =>
  `TH-${String(provinceCode || DEFAULT_PROVINCE).padStart(2, '0').slice(0, 2)}-${NODE_NUMBER}-${String(seq).padStart(5, '0')}`;

function createIdentity(db) {
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  /*
    ALTER แบบเดียวกับคอลัมน์อื่นของ cameras — CREATE TABLE IF NOT EXISTS ไม่เพิ่มคอลัมน์ให้ตาราง
    ที่มีอยู่แล้ว error "duplicate column" ของเครื่องที่เคยรันแล้วจึงถูกกลืนโดยตั้งใจ
  */
  const ensureSchema = async () => {
    for (const col of ['global_id TEXT', 'province_code TEXT', 'district_code TEXT']) {
      await run(`ALTER TABLE cameras ADD COLUMN ${col}`).catch(() => {});
    }
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_global_id ON cameras(global_id)');
  };

  let chain = Promise.resolve();

  /**
   * ออก global ID ให้กล้องทุกตัวที่ยังไม่มี
   *
   * ถูกเรียกตอน start และทุกครั้งที่กล้องเปลี่ยน (ผ่าน syncCamerasToStreamCore) แทนที่จะไปแทรก
   * ในทุกเส้นทางที่เพิ่มกล้อง — ระบบมีเส้นทางเพิ่มกล้องอยู่สี่ห้าเส้น และเส้นใหม่ที่ลืมเรียก
   * จะได้กล้องที่ไม่มี ID โดยไม่มีอะไรเตือน เรียงคิวไว้กันสองรอบชนกันแล้วได้เลขซ้ำ
   */
  const assignMissing = () => {
    chain = chain.catch(() => {}).then(async () => {
      /*
        กล้องจาก edge (edge_relay) ข้าม: global ID เป็นของ edge และ central รับตามรอบ sync (COALESCE)
        ถ้า central ออกเองตอนที่ edge ยังไม่ทันออก (กล้องเพิ่งแอด) เลขของ central จะติดถาวร
        แล้วกล้องตัวเดียวกันมีสอง ID — เจอตอนทดสอบสาย link 2026-09-23
      */
      const rows = await all(
        `SELECT id, province_code FROM cameras
          WHERE (global_id IS NULL OR global_id = '') AND COALESCE(type, '') != 'edge_relay' ORDER BY rowid`,
      );
      if (!rows.length) return 0;

      const stored = await get('SELECT setting_value FROM settings WHERE setting_key = ?', [SEQ_KEY]);
      let seq = Number(stored?.setting_value) || 0;

      for (const row of rows) {
        seq += 1;
        // ชนกับ ID ที่มีอยู่ (เช่น settings ถูกล้าง) ก็ขยับไปเลขถัดไป ไม่เขียนทับ
        for (;;) {
          const id = formatGlobalId(row.province_code, seq);
          const taken = await get('SELECT 1 FROM cameras WHERE global_id = ?', [id]);
          if (!taken) {
            await run("UPDATE cameras SET global_id = ? WHERE id = ? AND (global_id IS NULL OR global_id = '')", [id, row.id]);
            break;
          }
          seq += 1;
        }
      }

      await run(
        `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
        [SEQ_KEY, String(seq)],
      );
      console.log(`[Identity] ออก global ID ให้กล้อง ${rows.length} ตัว (ลำดับล่าสุด ${seq})`);
      return rows.length;
    });
    return chain;
  };

  return { ensureSchema, assignMissing };
}

module.exports = { createIdentity, formatGlobalId };
