/**
 * ที่เก็บ event ของ AI — ทั้ง edge และ central ใช้ตารางเดียวกัน (docs/EDGE-PLAN.md เฟส 5 ข้อ B)
 *
 * edge: รับผลจากกล้อง/NVR/VMS/API ภายนอก เก็บ origin จริง ไม่มี inference
 * regional/central: รับและส่งต่อ event ด้วยเคอร์เซอร์ของแต่ละสาย
 * central: รับสำเนาจาก edge (`ingest`) — `source_id` + `remote_seq` บอกว่ามาจาก edge ไหนลำดับที่เท่าไร
 *       ดัชนี unique ทำให้รับซ้ำได้โดยไม่เกิดแถวซ้ำ จึงไล่ตามทีหลังได้เสมอเมื่อ edge หลุดแล้วกลับมา
 *
 * ภาพประกอบ (JPEG ≤ 300 KB) เก็บเป็นไฟล์ `<stateDir>/ai-snapshots/<YYYYMMDD>/<ชื่อ>.jpg` ไม่ใส่ในฐานข้อมูล
 *   (edge: ชื่อสุ่ม เขียนก่อน INSERT ทั้งชุด · central: `<id>.jpg`) — คอลัมน์ `snapshot` เก็บ path สัมพัทธ์
 * เวลาเป็น ISO-8601 +07:00 (shared/time.js) · ลบแถวและภาพที่เก่ากว่า AI_EVENT_DAYS (ค่าเริ่ม 90 วัน)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stateFile } = require('./instance');
const { nowIso, toBangkokIso } = require('./time');

const SNAPSHOT_DIR = stateFile('ai-snapshots');
const MAX_SNAPSHOT_BYTES = 300 * 1024;
const MAX_ATTRS_BYTES = 8 * 1024;
const KEEP_DAYS = Math.max(1, Number(process.env.AI_EVENT_DAYS || 90));
const ORIGINS = new Set(['camera', 'nvr', 'vms', 'api', 'edge-ai']);
const TOKEN = /^[a-z0-9_.-]{1,40}$/;

const EVENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const PRUNE_CHUNK = 5000;

class AiEventError extends Error {
  constructor(status, message, index) {
    super(message);
    this.status = status;
    if (index !== undefined) this.index = index;
  }
}

/**
 * ตรวจ event ที่รับเข้ามา — คืนแถวที่พร้อมบันทึก หรือโยน AiEventError(400)
 *
 * type   ชนิด เช่น line_cross, intrusion, count, object, loitering (a-z 0-9 _ . -)
 * label  สิ่งที่ตรวจเจอ เช่น person, car (ไม่บังคับ)
 * rule   ชื่อกฎ/เส้น/โซนที่ทำให้เกิด (ไม่บังคับ)
 * ts     เวลาที่เกิด (ไม่ส่ง = ตอนนี้) · trackId ไอดีของวัตถุที่ tracker ให้ · attrs ข้อมูลอื่นเป็น object
 * eventId ไอดีที่ผู้ส่งออกเอง (uuid, ≤ 64 ตัว, ไม่บังคับ) — ส่งซ้ำด้วยไอดีเดิมไม่เกิดแถวซ้ำ
 */
function normalizeEvent(input = {}) {
  let eventId = null;
  if (input.eventId !== undefined && input.eventId !== null && input.eventId !== '') {
    eventId = String(input.eventId);
    if (!EVENT_ID.test(eventId)) throw new AiEventError(400, 'eventId ต้องเป็น A-Z a-z 0-9 _ . : - ยาวไม่เกิน 64 ตัว');
  }
  const type = String(input.type || '').trim().toLowerCase();
  if (!TOKEN.test(type)) throw new AiEventError(400, 'type ต้องเป็น a-z 0-9 _ . - ยาวไม่เกิน 40 ตัว');
  const origin = input.origin ? String(input.origin) : 'api';
  if (!ORIGINS.has(origin)) throw new AiEventError(400, 'origin ต้องเป็น camera, nvr, vms, api หรือ edge-ai');
  const ts = input.ts ? toBangkokIso(input.ts) : nowIso();
  if (!ts) throw new AiEventError(400, 'ts ต้องเป็นเวลา ISO-8601');
  let attrs = null;
  if (input.attrs !== undefined && input.attrs !== null) {
    if (typeof input.attrs !== 'object' || Array.isArray(input.attrs)) throw new AiEventError(400, 'attrs ต้องเป็น object');
    attrs = JSON.stringify(input.attrs);
    if (Buffer.byteLength(attrs) > MAX_ATTRS_BYTES) throw new AiEventError(400, 'attrs ใหญ่เกิน 8 KB');
  }
  const text = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).replaceAll('\u0000', '').slice(0, n));
  return { type, origin, ts, label: text(input.label, 60), rule: text(input.rule, 120), trackId: text(input.trackId, 60), attrs, eventId };
}

/** base64 → Buffer ของ JPEG ที่ขนาดไม่เกินกำหนด (null = ไม่มีภาพ) */
function decodeSnapshot(b64) {
  if (!b64) return null;
  const buf = Buffer.from(String(b64).replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new AiEventError(400, 'snapshot ต้องเป็น JPEG (base64)');
  if (buf.length > MAX_SNAPSHOT_BYTES) throw new AiEventError(400, 'snapshot ใหญ่เกิน 300 KB');
  return buf;
}

/** ค่า → literal ของ SQLite (ใช้กับ db.exec ที่ bind พารามิเตอร์ไม่ได้) — ข้อความ: ' เป็น '' และตัด NUL */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replaceAll('\u0000', '').replaceAll("'", "''")}'`;
}

/**
 * รันคำสั่งหลายบรรทัด (BEGIN; … COMMIT;) เป็น transaction ด้วย db.exec
 *
 * server ใช้ connection เดียวของ node-sqlite3 ร่วมกันทุกส่วน — ถ้าใช้ db.run ทีละคำสั่ง คำสั่งของส่วนอื่นแทรกเข้า
 * transaction ได้ (และโดนย้อนทิ้งไปด้วยเมื่อ ROLLBACK) · exec ถือ mutex ของ connection ตลอดก้อน ไม่มีอะไรแทรก
 * ล้ม = ROLLBACK ในคอลแบ็กเลย ก่อนที่ node-sqlite3 จะปล่อยคำสั่งอื่นที่รอคิวอยู่ (รอไปทำใน .catch ช้าเกินไป)
 */
function execTransaction(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => {
    if (!err) return resolve();
    return db.exec('ROLLBACK', () => reject(err));
  }));
}

function createAiEvents(db) {
  const listeners = new Set();
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
        db.run(`CREATE TABLE IF NOT EXISTS ai_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT,
          remote_seq INTEGER,
          camera_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          type TEXT NOT NULL,
          label TEXT,
          rule TEXT,
          ts TEXT NOT NULL,
          track_id TEXT,
          attrs TEXT,
          snapshot TEXT,
          received_at TEXT
        )`, () => {});
        // event_id (2026-09-29): ไอดีที่ ai-worker ออกเอง — กันแถวซ้ำเมื่อ worker ส่งชุดเดิมอีกครั้ง
        // ADD COLUMN ทั้ง DB ใหม่และเก่า (ตารางข้างบนไม่มีคอลัมน์นี้) · มีแล้ว = error ที่ตั้งใจเมิน · NULL ซ้ำกันได้ใน unique index
        db.run('ALTER TABLE ai_events ADD COLUMN event_id TEXT', () => {});
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_events_event_id ON ai_events (event_id)', (err) => {
          if (err) console.warn(`[AI events] สร้างดัชนี event_id ไม่สำเร็จ (event ที่ส่งซ้ำอาจเกิดแถวซ้ำ): ${err.message}`);
        });
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_events_source_seq ON ai_events (source_id, remote_seq)', () => {});
        db.run('CREATE INDEX IF NOT EXISTS idx_ai_events_cam_ts ON ai_events (camera_id, ts)', () => {});
        db.run('CREATE INDEX IF NOT EXISTS idx_ai_events_ts ON ai_events (ts)', () => {
          resolve();
        });
      });
    });
  }

  function saveSnapshot(id, ts, buf) {
    if (!buf) return null;
    const rel = path.join(String(ts).slice(0, 10).replace(/-/g, ''), `${id}.jpg`);
    fs.mkdirSync(path.join(SNAPSHOT_DIR, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(SNAPSHOT_DIR, rel), buf);
    return rel;
  }

  const emit = (row) => {
    for (const fn of listeners) {
      try { fn(row); } catch (err) { console.warn(`[AI events] listener: ${err.message}`); }
    }
  };

  /** แถว → รูปที่ส่งออกทาง API */
  function publicEvent(row) {
    let attrs = null;
    try { attrs = row.attrs ? JSON.parse(row.attrs) : null; } catch { /* เสียก็ส่ง null */ }
    return {
      seq: row.id,
      cameraId: row.camera_id,
      origin: row.origin,
      type: row.type,
      label: row.label,
      rule: row.rule,
      ts: row.ts,
      trackId: row.track_id,
      attrs,
      hasSnapshot: Boolean(row.snapshot),
      source: row.source_id ? { id: row.source_id, seq: row.remote_seq } : null,
      receivedAt: row.received_at,
    };
  }

  const lit = sqlLiteral;
  const execTx = (sql) => execTransaction(db, sql);
  const unlinkQuiet = (rel) => { try { fs.unlinkSync(path.join(SNAPSHOT_DIR, rel)); } catch { /* หายไปแล้ว */ } };

  // บันทึกทีละชุด — ตาราง temp.ai_batch_ids ใช้ร่วมกัน ชุดถัดไปต้องรอชุดก่อนอ่านผลเสร็จ
  let batchChain = Promise.resolve();
  const oneAtATime = (fn) => {
    const p = batchChain.then(() => fn());
    batchChain = p.catch(() => {});
    return p;
  };

  /**
   * event ที่เกิดที่เครื่องนี้ (edge) ทั้งชุด — ทั้งหมดหรือไม่มีเลย
   *
   * 1. ตรวจ/แปลงทุกตัวก่อน (ตัวไหนเสีย = AiEventError 400 พร้อม index ยังไม่มีอะไรถูกบันทึก)
   * 2. เขียนไฟล์ภาพ (ชื่อสุ่ม) → INSERT ทุกแถวใน BEGIN…COMMIT ของ db.exec คำสั่งเดียว
   *    — node-sqlite3 ใช้ connection เดียวทั้ง server: exec ถือ mutex ของ connection ตลอด ไม่มีคำสั่งอื่นแทรกกลาง transaction
   *    ล้ม = ROLLBACK แล้วลบไฟล์ภาพที่เพิ่งเขียน
   * 3. eventId ซ้ำ (worker ส่งชุดเดิมหลัง timeout) = INSERT OR IGNORE ข้ามไป ตอบ seq ของแถวเดิม ลบไฟล์ภาพที่ไม่ได้ใช้
   *
   * @param {Array<{cameraId: string, input: object, snapshot?: string|null}>} items
   * @returns {Promise<{ seqs: number[], rows: object[], duplicates: number }>} seqs ตามลำดับที่ส่งมา · rows เฉพาะแถวใหม่
   */
  async function recordBatch(items) {
    const prepared = items.map((it, index) => {
      try {
        const ev = normalizeEvent(it.input || {});
        const snap = decodeSnapshot(it.snapshot || null);
        return { cameraId: String(it.cameraId), ev, snap, rel: null };
      } catch (err) {
        if (err instanceof AiEventError) throw new AiEventError(err.status, `event ที่ ${index + 1}: ${err.message}`, index);
        throw err;
      }
    });
    return oneAtATime(async () => {
      const written = [];
      try {
        for (const p of prepared) {
          if (!p.snap) continue;
          p.rel = saveSnapshot(crypto.randomBytes(12).toString('hex'), p.ev.ts, p.snap);
          written.push(p.rel);
        }
        const at = nowIso();
        const sql = ['BEGIN;',
          'CREATE TEMP TABLE IF NOT EXISTS ai_batch_ids (idx INTEGER, id INTEGER);',
          'DELETE FROM temp.ai_batch_ids;'];
        prepared.forEach((p, i) => {
          const { ev } = p;
          sql.push(`INSERT OR IGNORE INTO ai_events (camera_id, origin, type, label, rule, ts, track_id, attrs, snapshot, received_at, event_id)
            VALUES (${[p.cameraId, ev.origin, ev.type, ev.label, ev.rule, ev.ts, ev.trackId, ev.attrs, p.rel, at, ev.eventId].map(lit).join(', ')});`);
          sql.push(`INSERT INTO temp.ai_batch_ids (idx, id) SELECT ${i}, last_insert_rowid() WHERE changes() = 1;`);
        });
        sql.push('COMMIT;');
        await execTx(sql.join('\n'));
      } catch (err) {
        written.forEach(unlinkQuiet);
        throw err;
      }
      const rows = await all('SELECT b.idx AS batch_idx, a.* FROM temp.ai_batch_ids b JOIN ai_events a ON a.id = b.id ORDER BY b.idx');
      const seqs = new Array(prepared.length).fill(null);
      for (const r of rows) seqs[r.batch_idx] = r.id;
      // แถวที่ไม่ได้ใหม่ = eventId ซ้ำ — หา seq เดิม และลบภาพที่เขียนเผื่อไว้
      const dupIds = [...new Set(prepared.filter((p, i) => seqs[i] === null && p.ev.eventId).map((p) => p.ev.eventId))];
      const existing = new Map();
      if (dupIds.length) {
        const found = await all(`SELECT id, event_id FROM ai_events WHERE event_id IN (${dupIds.map(() => '?').join(',')})`, dupIds);
        for (const f of found) existing.set(f.event_id, f.id);
      }
      prepared.forEach((p, i) => {
        if (seqs[i] !== null) return;
        seqs[i] = existing.get(p.ev.eventId) ?? null;
        if (p.rel) unlinkQuiet(p.rel);
      });
      const fresh = rows.map((r) => { const row = { ...r }; delete row.batch_idx; return row; });
      fresh.forEach(emit);
      return { seqs, rows: fresh, duplicates: prepared.length - rows.length };
    });
  }

  /** event เดียว (ใช้ทางเดียวกับ recordBatch) — คืนแถวที่บันทึก หรือแถวเดิมถ้า eventId ซ้ำ */
  async function record(cameraId, input, snapshotB64 = null) {
    const { seqs } = await recordBatch([{ cameraId, input, snapshot: snapshotB64 }]);
    return seqs[0] === null ? null : get('SELECT * FROM ai_events WHERE id = ?', [seqs[0]]);
  }

  /**
   * สำเนาจาก edge (central) — คืนแถวใหม่ หรือ null ถ้าเคยรับแล้ว
   * @param {string} sourceId  แถว camera_sources ของ edge
   * @param {string} cameraId  id กล้องของ central (แปลงจาก id ที่ edge แล้ว)
   * @param {object} ev        event ตามรูป publicEvent ของ edge
   * @param {Buffer|null} snapshot
   */
  async function ingest(sourceId, cameraId, ev, snapshot = null) {
    const n = normalizeEvent(ev);
    // เขียนภาพก่อน INSERT เพื่อให้สายชั้นถัดไปไม่เห็น event ที่ภาพยังไม่พร้อม
    const rel = snapshot && snapshot.length <= MAX_SNAPSHOT_BYTES
      ? saveSnapshot(crypto.randomBytes(12).toString('hex'), n.ts, snapshot) : null;
    let r;
    try {
      r = await run(
        'INSERT OR IGNORE INTO ai_events (source_id, remote_seq, camera_id, origin, type, label, rule, ts, track_id, attrs, snapshot, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [sourceId, Number(ev.seq), cameraId, n.origin, n.type, n.label, n.rule, n.ts, n.trackId, n.attrs, rel, nowIso()],
      );
    } catch (err) { if (rel) unlinkQuiet(rel); throw err; }
    if (!r.changes) { if (rel) unlinkQuiet(rel); return null; }
    const row = await get('SELECT * FROM ai_events WHERE id = ?', [r.lastID]);
    emit(row);
    return row;
  }

  /** ลำดับล่าสุดที่รับจาก edge แล้ว — เคอร์เซอร์สำหรับไล่ตาม */
  async function lastRemoteSeq(sourceId) {
    const row = await get('SELECT MAX(remote_seq) AS s FROM ai_events WHERE source_id = ?', [sourceId]);
    return Number(row?.s || 0);
  }

  /**
   * ค้น event
   * @param {object} q  since (seq > since, เรียงเก่า→ใหม่ สำหรับไล่ตาม) หรือ from/to (เรียงใหม่→เก่า สำหรับหน้าจอ)
   *                    cameraIds: Set | null (ขอบเขตของผู้ขอ) · cameraId, type, label, origin · limit ≤ 1000
   */
  async function list(q = {}) {
    const where = [];
    const params = [];
    const since = q.since !== undefined && q.since !== null && q.since !== '' ? Number(q.since) : null;
    if (since !== null) {
      if (!Number.isFinite(since)) throw new AiEventError(400, 'since ต้องเป็นตัวเลข');
      where.push('id > ?');
      params.push(since);
    }
    if (q.from) { where.push('ts >= ?'); params.push(toBangkokIso(q.from)); }
    if (q.to) { where.push('ts < ?'); params.push(toBangkokIso(q.to)); }
    for (const [col, v] of [['camera_id', q.cameraId], ['type', q.type], ['label', q.label], ['origin', q.origin]]) {
      if (v) { where.push(`${col} = ?`); params.push(String(v)); }
    }
    if (q.cameraIds instanceof Set) {
      if (!q.cameraIds.size) return [];
      where.push(`camera_id IN (${[...q.cameraIds].map(() => '?').join(',')})`);
      params.push(...q.cameraIds);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const order = since !== null ? 'id ASC' : 'ts DESC, id DESC';
    const rows = await all(`SELECT * FROM ai_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, [...params, limit]);
    return rows;
  }

  const getRow = (id) => get('SELECT * FROM ai_events WHERE id = ?', [Number(id)]);

  /** ไฟล์ภาพของ event (null = ไม่มี) */
  function snapshotFile(row) {
    if (!row?.snapshot) return null;
    const full = path.join(SNAPSHOT_DIR, row.snapshot);
    return fs.existsSync(full) ? full : null;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * ลบ event และภาพที่เก่ากว่า KEEP_DAYS — ทีละ PRUNE_CHUNK แถว วนจนหมด (พักให้ event loop ระหว่างรอบ)
   * แล้วลบโฟลเดอร์วันที่ว่าง (ยกเว้นวันนี้) · คืนจำนวนแถวที่ลบ
   */
  async function prune({ chunk = PRUNE_CHUNK, keepDays = KEEP_DAYS } = {}) {
    const cutoff = toBangkokIso(Date.now() - keepDays * 86_400_000);
    let total = 0;
    for (;;) {
      const rows = await all('SELECT id, snapshot FROM ai_events WHERE ts < ? ORDER BY id LIMIT ?', [cutoff, chunk]);
      for (const r of rows) if (r.snapshot) unlinkQuiet(r.snapshot);
      if (rows.length) await run(`DELETE FROM ai_events WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
      total += rows.length;
      if (rows.length < chunk) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const today = nowIso().slice(0, 10).replace(/-/g, '');
    let dirs = [];
    try { dirs = fs.readdirSync(SNAPSHOT_DIR); } catch { /* ยังไม่มีโฟลเดอร์ภาพ */ }
    for (const d of dirs) {
      if (!/^\d{8}$/.test(d) || d === today) continue;
      try { fs.rmdirSync(path.join(SNAPSHOT_DIR, d)); } catch { /* ยังมีไฟล์อยู่ */ }
    }
    if (total) console.log(`[AI events] ลบ event ที่เก่ากว่า ${keepDays} วัน ${total} แถว`);
    return total;
  }

  function start() {
    const safePrune = () => prune().catch((err) => console.warn(`[AI events] prune: ${err.message}`));
    const timer = setInterval(safePrune, 3600_000);
    timer.unref?.();
    // รอบแรกทันทีหลังเตรียมตาราง — เครื่องที่รีสตาร์ตบ่อยกว่าชั่วโมงละครั้งก็ยังได้ลบของเก่า
    return ensureSchema().then(() => { safePrune(); });
  }

  return { ensureSchema, start, record, recordBatch, ingest, lastRemoteSeq, list, getRow, snapshotFile, subscribe, publicEvent, prune };
}

module.exports = { createAiEvents, AiEventError, normalizeEvent, sqlLiteral, execTransaction };
