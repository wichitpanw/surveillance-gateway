/**
 * ค่าของ AI บน GPU ที่ edge (docs/EDGE-PLAN.md เฟส 5 ข้อ D) — กล้องไหนเปิด AI และกฎเส้น/โซนของแต่ละกล้อง
 *
 * ai-worker (โฟลเดอร์ ai-worker/, process แยก) อ่านค่าชุดนี้ทาง GET /api/v1/ai/config ด้วย key ของตัวเอง
 * แล้วส่ง event กลับทาง POST /api/v1/ai/events · ตัว gateway ไม่รัน inference เอง (เหตุผลใน context.md)
 *
 * key ของ worker ออกให้อัตโนมัติ (แถว `apic_ai_worker_local`, สิทธิ์ส่ง event) แล้วเขียนลงไฟล์
 * `<stateDir>/.ai-worker-key` ให้ worker บนเครื่องเดียวกันอ่าน — ไม่มีขั้นตอนที่คนต้องจำไปทำเอง
 *
 * กฎ (ตาราง ai_rules) พิกัดเป็นสัดส่วนของภาพ 0–1 จึงใช้ได้ทุกความละเอียด
 *   line  เส้น 2 จุด — นับเมื่อจุดล่างกลางกรอบของวัตถุข้ามเส้น · direction any | ab | ba (ab = ข้ามจากซ้ายไปขวาเมื่อมองจาก A ไป B)
 *   zone  รูปหลายเหลี่ยม 3–20 จุด — intrusion เมื่อวัตถุเข้าโซน · dwellSec > 0 = loitering เมื่ออยู่นานเกิน
 */
const fs = require('fs');
const crypto = require('crypto');
const { stateFile } = require('../shared/instance');
const { nowIso } = require('../shared/time');
const { generateKey, hashKey } = require('./auth');
const { sqlLiteral, execTransaction } = require('../shared/ai-events');

const WORKER_KEY_FILE = stateFile('.ai-worker-key');
const WORKER_CLIENT_ID = 'apic_ai_worker_local';
const MAX_RULES = 20;
/** คลาสของ COCO ที่ YOLOX รู้จัก — กฎเลือกได้จากชุดนี้เท่านั้น */
const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear',
  'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
  'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza',
  'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
  'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush'];
const DEFAULT_CLASSES = ['person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck'];

class AiConfigError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** ตรวจกฎหนึ่งข้อ — คืนรูปที่พร้อมเก็บ หรือโยน AiConfigError(400) */
function normalizeRule(r, i) {
  const where = `กฎที่ ${i + 1}`;
  const type = r?.type === 'line' ? 'line' : r?.type === 'zone' ? 'zone' : null;
  if (!type) throw new AiConfigError(400, `${where}: type ต้องเป็น line หรือ zone`);
  const pts = Array.isArray(r.points) ? r.points : [];
  if (type === 'line' && pts.length !== 2) throw new AiConfigError(400, `${where}: เส้นต้องมี 2 จุด`);
  if (type === 'zone' && (pts.length < 3 || pts.length > 20)) throw new AiConfigError(400, `${where}: โซนต้องมี 3–20 จุด`);
  const points = pts.map((p) => {
    const x = Number(p?.[0]);
    const y = Number(p?.[1]);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new AiConfigError(400, `${where}: พิกัดต้องอยู่ในช่วง 0–1`);
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  });
  const classes = [...new Set((Array.isArray(r.classes) && r.classes.length ? r.classes : DEFAULT_CLASSES).map(String))];
  const bad = classes.find((c) => !COCO.includes(c));
  if (bad) throw new AiConfigError(400, `${where}: ไม่รู้จักคลาส ${bad}`);
  const direction = type === 'line' ? (['any', 'ab', 'ba'].includes(r.direction) ? r.direction : 'any') : null;
  const dwell = type === 'zone' ? Number(r.dwellSec || 0) : 0;
  if (!(dwell >= 0 && dwell <= 3600)) throw new AiConfigError(400, `${where}: เวลาอยู่ในโซนต้องเป็น 0–3600 วินาที`);
  const name = String(r.name || `${type === 'line' ? 'เส้น' : 'โซน'} ${i + 1}`).trim().slice(0, 60);
  return {
    id: /^[\w-]{1,40}$/.test(String(r.id || '')) ? String(r.id) : `r_${crypto.randomBytes(5).toString('hex')}`,
    type, name, points, classes, direction, dwellSec: dwell, enabled: r.enabled !== false,
  };
}

function createAiConfig(db) {
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function done(err) { return err ? reject(err) : resolve(this); });
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });

  function ensureSchema() {
    return new Promise((resolve) => {
      db.serialize(() => {
        // ai_enabled: ส่งภาพกล้องนี้ให้ ai-worker · ai_objects: บันทึกทุกวัตถุที่เจอ (ค้นย้อนหลัง) นอกจาก event ตามกฎ
        db.run('ALTER TABLE cameras ADD COLUMN ai_enabled INTEGER DEFAULT 0', () => {});
        db.run('ALTER TABLE cameras ADD COLUMN ai_objects INTEGER DEFAULT 1', () => {});
        db.run(`CREATE TABLE IF NOT EXISTS ai_rules (
          id TEXT NOT NULL,
          camera_id TEXT NOT NULL,
          type TEXT NOT NULL,
          name TEXT,
          points TEXT NOT NULL,
          classes TEXT,
          direction TEXT,
          dwell_sec INTEGER DEFAULT 0,
          enabled INTEGER DEFAULT 1,
          updated_at TEXT,
          PRIMARY KEY (camera_id, id)
        )`, () => resolve());
      });
    });
  }

  /**
   * key ของ ai-worker บนเครื่องนี้ — ออกครั้งแรกแล้วใช้ต่อ · ไฟล์หายหรือไม่ตรงกับแถว = ออกใหม่
   * สิทธิ์: ส่ง event ได้, ไม่จำกัดกลุ่ม (worker ต้องเห็นกล้องที่เปิด AI ทุกตัว)
   */
  async function ensureWorkerKey() {
    let key = null;
    try { key = fs.readFileSync(WORKER_KEY_FILE, 'utf8').trim(); } catch { /* ยังไม่มี */ }
    const row = await get('SELECT key_hash FROM api_clients WHERE id = ?', [WORKER_CLIENT_ID]);
    if (key && row && row.key_hash === hashKey(key)) {
      await run('UPDATE api_clients SET enabled = 1, allow_event_write = 1 WHERE id = ?', [WORKER_CLIENT_ID]);
      return key;
    }
    key = generateKey();
    const hint = `${key.slice(0, 9)}…${key.slice(-6)}`;
    await run(
      `INSERT INTO api_clients (id, name, key_hash, key_hint, scope_groups, enabled, allow_event_write, created_by, created_at)
       VALUES (?, ?, ?, ?, NULL, 1, 1, 'system', ?)
       ON CONFLICT(id) DO UPDATE SET key_hash = excluded.key_hash, key_hint = excluded.key_hint, enabled = 1, allow_event_write = 1`,
      [WORKER_CLIENT_ID, 'ai-worker (เครื่องนี้)', hashKey(key), hint, nowIso()],
    );
    fs.writeFileSync(WORKER_KEY_FILE, key, { mode: 0o600 });
    console.log(`[AI] ออก key ให้ ai-worker ที่ ${WORKER_KEY_FILE}`);
    return key;
  }

  const ruleFromRow = (r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    points: JSON.parse(r.points),
    classes: r.classes ? JSON.parse(r.classes) : DEFAULT_CLASSES,
    direction: r.direction,
    dwellSec: r.dwell_sec || 0,
    enabled: Boolean(r.enabled),
  });

  /** ค่า AI ของทุกกล้อง (หน้า AI Rules ของ edge) */
  async function listCameras() {
    const cams = await all(
      `SELECT id, name, group_name, COALESCE(enabled, 1) AS enabled, COALESCE(ai_enabled, 0) AS ai_enabled,
              COALESCE(ai_objects, 1) AS ai_objects
         FROM cameras ORDER BY group_name, name`,
    );
    const rules = await all('SELECT * FROM ai_rules ORDER BY camera_id, rowid');
    const byCam = new Map();
    for (const r of rules) {
      if (!byCam.has(r.camera_id)) byCam.set(r.camera_id, []);
      byCam.get(r.camera_id).push(ruleFromRow(r));
    }
    return cams.map((c) => ({
      id: c.id, name: c.name, group: c.group_name || null, cameraEnabled: Number(c.enabled) !== 0,
      aiEnabled: Boolean(c.ai_enabled), objects: Boolean(c.ai_objects), rules: byCam.get(c.id) || [],
    }));
  }

  /** ตั้งค่ากล้องหนึ่งตัว — rules ที่ส่งมาแทนชุดเดิมทั้งชุด (ไม่ส่ง = ไม่แตะกฎ) */
  async function saveCamera(cameraId, { aiEnabled, objects, rules }) {
    const cam = await get('SELECT id FROM cameras WHERE id = ?', [cameraId]);
    if (!cam) throw new AiConfigError(404, 'ไม่พบกล้องนี้');
    let list = null;
    if (rules !== undefined) {
      if (!Array.isArray(rules)) throw new AiConfigError(400, 'rules ต้องเป็นรายการ');
      if (rules.length > MAX_RULES) throw new AiConfigError(400, `กฎได้ไม่เกิน ${MAX_RULES} ข้อต่อกล้อง`);
      list = rules.map(normalizeRule);
      const seen = new Set();
      for (const r of list) {
        if (seen.has(r.id)) throw new AiConfigError(400, `id ของกฎซ้ำกัน: ${r.id}`);
        seen.add(r.id);
      }
    }
    // ทั้งสวิตช์และกฎชุดใหม่อยู่ใน transaction เดียว — ล้มกลางทาง = กฎชุดเดิมยังอยู่ครบ ไม่เหลือครึ่งชุด
    const L = sqlLiteral;
    const sets = [];
    if (aiEnabled !== undefined) sets.push(`ai_enabled = ${aiEnabled ? 1 : 0}`);
    if (objects !== undefined) sets.push(`ai_objects = ${objects ? 1 : 0}`);
    const sql = [];
    if (sets.length) sql.push(`UPDATE cameras SET ${sets.join(', ')} WHERE id = ${L(cameraId)};`);
    if (list) {
      const at = nowIso();
      sql.push(`DELETE FROM ai_rules WHERE camera_id = ${L(cameraId)};`);
      for (const r of list) {
        sql.push(`INSERT INTO ai_rules (id, camera_id, type, name, points, classes, direction, dwell_sec, enabled, updated_at)
          VALUES (${[r.id, cameraId, r.type, r.name, JSON.stringify(r.points), JSON.stringify(r.classes), r.direction, r.dwellSec, r.enabled ? 1 : 0, at].map(L).join(', ')});`);
      }
    }
    if (sql.length) await execTransaction(db, ['BEGIN;', ...sql, 'COMMIT;'].join('\n'));
    return (await listCameras()).find((c) => c.id === cameraId);
  }

  /** ค่าที่ ai-worker ใช้: เฉพาะกล้องที่เปิด AI และเปิดใช้งานอยู่ พร้อมกฎที่เปิด */
  async function workerConfig() {
    const cams = (await listCameras()).filter((c) => c.aiEnabled && c.cameraEnabled);
    return {
      cameras: cams.map((c) => ({ id: c.id, name: c.name, objects: c.objects, rules: c.rules.filter((r) => r.enabled) })),
      updatedAt: nowIso(),
    };
  }

  return { ensureSchema, ensureWorkerKey, listCameras, saveCamera, workerConfig };
}

module.exports = { createAiConfig, AiConfigError, COCO, DEFAULT_CLASSES, WORKER_KEY_FILE };
