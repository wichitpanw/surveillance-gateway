/**
 * ดึง metadata ของ AI จากหัวกล้องมาเก็บไว้ที่ Gateway
 *
 * เหตุผลที่ Gateway เก็บเองแทนที่จะส่งต่อสดๆ ทุกครั้ง: หน่วยงานที่มาเรียกใช้ต้องการข้อมูล
 * ย้อนหลัง ซึ่งกล้องเก็บได้จำกัด และถ้าหลายหน่วยงานยิงถามกล้องพร้อมกัน กล้องตัวเล็กๆ
 * รับไม่ไหว การมีสำเนาที่นี่ทำให้กล้องถูกถามแค่จากเราเจ้าเดียวในจังหวะที่เราคุม
 */
const { adapterFor, camTimeToBangkokIso, cameraToday, credsFor } = require('./index');
const { previousDayKey } = require('../../shared/time');
const { createDiscovery } = require('./discovery');
const { nowIso } = require('../../shared/time');

/** ถามกล้องถี่แค่ไหน — รายงานเปลี่ยนระดับชั่วโมง ไม่ต้องถี่กว่านี้ */
const POLL_MS = 60_000;

/** ตรวจความสามารถซ้ำทุกกี่ชั่วโมง — เผื่อมีคนไปเปิดระบบนับคนที่กล้องทีหลัง */
const PROBE_EVERY_HOURS = 24;

/** เว้นระยะระหว่างกล้อง กันยิงรัวใส่สวิตช์เดียวกันพร้อมกัน */
const STAGGER_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * กล้องที่ auth ล้มเหลว จะถูกพักไว้ก่อน ไม่ retry รัว
 *
 * Tiandy ล็อกตัวเองเมื่อรหัสผ่านผิดซ้ำๆ (บันทึกไว้ในโปรเจค People Counting) การ retry
 * ทุกนาทีด้วยรหัสที่ผิดจึงไม่ใช่แค่เปล่าประโยชน์ แต่ทำให้กล้องปิดประตูใส่เราเอง
 */
const AUTH_BACKOFF_MS = 15 * 60_000;
const authBackoff = new Map(); // cameraId -> timestamp ที่กลับมาลองได้

function createAnalyticsPoller(db) {
  /*
    ตัวค้นหา AI ใช้ตัวเดียวกับที่ route แอดกล้องใช้ — ทั้งสองทางต้องให้ผลเหมือนกันเป๊ะ
    ไม่งั้นกล้องที่ถูกตรวจตอนแอดกับตอนวนรอบจะได้คำตอบต่างกันโดยไม่มีใครอธิบายได้
  */
  const discovery = createDiscovery(db);
  let timer = null;
  let lastCameraDate = null;
  /** cameraId -> วันที่ (ตามกล้อง) ที่ยังค้างต้องเก็บให้จบ */
  const rolloverPending = new Set();

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function cb(err) {
        return err ? reject(err) : resolve(this);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });

  /**
   * สร้างตารางถ้ายังไม่มี — idempotent เรียกซ้ำได้
   *
   * ต้อง await ให้เสร็จก่อน tick แรก ไม่ใช่หน่วงเวลาเอาเอง: คำสั่งเหล่านี้ต่อคิวอยู่หลัง
   * schema ชุดใหญ่ของ server.js ทั้งก้อน การเดาว่า "5 วินาทีน่าจะพอ" ทำให้ tick แรก
   * ล้มด้วย "no such table" ทุกครั้งที่บูต แล้วเงียบไปเองในรอบถัดไป — บั๊กที่ดูเหมือน
   * หายเองแต่ทำข้อมูลนาทีแรกหลังรีสตาร์ตหายไปจริงๆ
   */
  async function ensureSchema() {
    // ALTER ที่คอลัมน์มีอยู่แล้วจะ error เป็นปกติ — กลืนไว้ ไม่ใช่ความผิดพลาด
    const optional = (sql) => new Promise((resolve) => db.run(sql, () => resolve()));
    await optional('ALTER TABLE cameras ADD COLUMN analytics_kind TEXT');
    await optional('ALTER TABLE cameras ADD COLUMN analytics_probed_at DATETIME');
    // DB ใหม่ได้ PK (camera_id, rule, ts) ทันที — เดิมสร้าง (camera_id, ts) แล้วพึ่งสคริปต์ migration ที่ต้องรันเอง
    // ผลคือทุกเครื่องที่ติดตั้งสด (รวม edge 001) เขียนยอดไม่ได้เลย: ON CONFLICT ไม่ตรงกับ PK (พบ 2026-09-28)
    await run(`CREATE TABLE IF NOT EXISTS camera_analytics (
      camera_id  TEXT NOT NULL,
      rule       TEXT NOT NULL DEFAULT '',
      ts         TEXT NOT NULL,
      count_in   INTEGER NOT NULL,
      count_out  INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (camera_id, rule, ts)
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_camera_analytics_ts ON camera_analytics(ts)');
    /*
      มิติ "กฎ" ของกล้องหนึ่งตัว — เพิ่มคอลัมน์อย่างเดียว ยังไม่แตะ primary key

      กล้องหนึ่งตัวตั้งได้หลายเส้นหลายพื้นที่ ยอดของแต่ละเส้นจึงเป็นคนละชุด และวันที่เริ่ม
      เก็บของ Uniview (ยอดมาทาง ONVIF metadata พร้อมชื่อกฎใน Source) จะต้องแยกให้ออก

      **ยังไม่เปลี่ยน PK เป็น (camera_id, rule, ts) ตอนนี้โดยตั้งใจ** — SQLite เปลี่ยน PK
      ไม่ได้ ต้องสร้างตารางใหม่แล้วคัดลอกข้อมูลทั้งหมด ซึ่งเป็นการเสี่ยงกับประวัติที่มีอยู่จริง
      เพื่อแลกกับความสามารถที่ยังไม่มีใครใช้ (ยังไม่มีตัวเขียนหลายกฎสักตัว) ฝั่งอ่านถูกทำให้
      รวมด้วย SUM() ไว้แล้ว จึงรองรับได้ทันทีที่ตัวเขียนพร้อม แล้วค่อยย้าย PK พร้อมกัน
    */
    await new Promise((resolve) => {
      db.run("ALTER TABLE camera_analytics ADD COLUMN rule TEXT NOT NULL DEFAULT ''", () => resolve());
    });
    await migrateRulePk();
  }

  /**
   * ตารางเก่าที่ PK ยังเป็น (camera_id, ts) → สร้างใหม่เป็น (camera_id, rule, ts) แล้วคัดลอกทุกแถว (rule ว่าง)
   *
   * แทนสคริปต์ migrations/2026-08-24-analytics-rule-pk.js เดิม (ลบแล้ว) ที่ต้องมีคนรันเอง
   * จึงตกหล่นกับเครื่องที่ติดตั้งทีหลัง · db.exec เป็นคำสั่งเดียวในคิวของ node-sqlite3 ไม่มีคำสั่งอื่นแทรกกลางทาง
   * ยอดไม่เปลี่ยนแม้แต่แถวเดียว: แถวเดิมทั้งหมดมี rule = '' อยู่แล้ว
   */
  async function migrateRulePk() {
    const table = await new Promise((resolve) => db.get(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'camera_analytics'", (err, row) => resolve(err ? null : row),
    ));
    if (!table || /PRIMARY KEY\s*\(\s*camera_id\s*,\s*rule\s*,\s*ts\s*\)/i.test(table.sql)) return;
    await new Promise((resolve, reject) => db.exec(`
      BEGIN;
      CREATE TABLE camera_analytics_pk (
        camera_id  TEXT NOT NULL,
        rule       TEXT NOT NULL DEFAULT '',
        ts         TEXT NOT NULL,
        count_in   INTEGER NOT NULL,
        count_out  INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (camera_id, rule, ts)
      );
      INSERT OR REPLACE INTO camera_analytics_pk (camera_id, rule, ts, count_in, count_out, updated_at)
        SELECT camera_id, COALESCE(rule, ''), ts, count_in, count_out, updated_at FROM camera_analytics;
      DROP TABLE camera_analytics;
      ALTER TABLE camera_analytics_pk RENAME TO camera_analytics;
      CREATE INDEX IF NOT EXISTS idx_camera_analytics_ts ON camera_analytics(ts);
      COMMIT;
    `, (err) => {
      if (!err) return resolve();
      db.exec('ROLLBACK', () => reject(err));
    }));
    console.log('[Analytics] ย้าย primary key ของ camera_analytics เป็น (camera_id, rule, ts) แล้ว');
  }

  /**
   * เขียนผลนับลงฐานข้อมูลแบบทับของเดิม
   *
   * ทับ ไม่ใช่บวกเพิ่ม — กล้องรายงานยอดสะสมของทั้งวันใหม่ทุกครั้งที่ถาม เราเป็นกระจก
   * สะท้อนกล้องเท่านั้น ถ้าบวกเพิ่ม ตัวเลขจะทบขึ้นทุกนาทีที่ poll โดยไม่มีอะไรฟ้อง
   * (บทเรียนนี้เขียนกำกับไว้ใน schema.js ของโปรเจค People Counting)
   */
  async function saveBuckets(cameraId, rows) {
    const now = nowIso();
    let written = 0;
    for (const r of rows) {
      const ts = camTimeToBangkokIso(r.camTime);
      if (!ts) continue;
      /*
        เขียน rule เป็นค่าว่างอย่างชัดเจน ไม่ปล่อยให้เป็นค่าเริ่มต้นของคอลัมน์

        ตอนนี้มีสองฝั่งเขียนตารางนี้ด้วยกติกาตรงข้ามกัน: ฝั่งนี้ทับ ส่วนตัวเก็บ ONVIF
        metadata บวกสะสม (ดู metadata-collector.js) การแยกกันอยู่ได้อาศัย `rule` ล้วน ๆ
        — ฝั่งนี้ใช้ค่าว่างเสมอ ฝั่งโน้นบังคับว่าต้องมีชื่อกฎเสมอ ถ้าวันหนึ่งทั้งสองฝั่ง
        ไปลงแถวเดียวกัน ตัวเลขจะทบหรือหายโดยไม่มี error ให้เห็น
      */
      await run(
        `INSERT INTO camera_analytics (camera_id, rule, ts, count_in, count_out, updated_at)
         VALUES (?, '', ?, ?, ?, ?)
         ON CONFLICT(camera_id, rule, ts) DO UPDATE SET
           count_in = excluded.count_in,
           count_out = excluded.count_out,
           updated_at = excluded.updated_at`,
        [cameraId, ts, r.in, r.out, now],
      );
      written += 1;
    }
    return written;
  }

  /**
   * ตรวจว่ากล้องตัวนี้มี AI อะไรอยู่ แล้วจดผลไว้
   *
   * เดิมที่นี่ดูแค่ว่า `brand` อยู่ในทะเบียน adapter ไหม ยี่ห้ออื่นจึงถูกตัดทิ้งโดยไม่เคย
   * ถูกติดต่อเลยสักครั้ง ตอนนี้ยกงานไปให้ discovery ซึ่งถาม ONVIF ก่อนแล้วค่อยเสริมด้วย
   * adapter เฉพาะยี่ห้อ — และเป็นคนอัปเดต analytics_kind ให้เองด้วย
   *
   * ผลพลอยได้ที่ตั้งใจ: กล้องที่เพิ่งเปิด AI ที่หน้าเว็บของกล้องเองจะถูกจับได้ในรอบถัดไป
   * โดยไม่ต้องมีใครมาสั่งตรวจ
   */
  async function probeCamera(row) {
    const result = await discovery.discover(row);
    return result.countable ? { kind: 'people_counting' } : null;
  }

  /** ดึงข้อมูลของกล้องหนึ่งตัวสำหรับวันที่กำหนด (ตามนาฬิกากล้อง) */
  async function pollCamera(row, day) {
    const adapter = adapterFor(row);
    if (!adapter) return 0;
    const rows = await adapter.queryDay(credsFor(row), day);
    return saveBuckets(row.id, rows);
  }

  async function tick() {
    let cameras;
    try {
      /*
        ดึงมาพร้อมธงว่า "เคยถูกตรวจด้วยกลไกปัจจุบันหรือยัง"

        รอบการตรวจซ้ำ 24 ชม. ตัดสินจาก analytics_probed_at ซึ่งใช้ได้ตราบใดที่วิธีตรวจ
        ไม่เปลี่ยน — แต่วันที่เปลี่ยนวิธี (จากเดาตาม brand มาเป็นถาม ONVIF จริง) เวลาเดิม
        กลายเป็นคำตอบของคำถามคนละข้อ กล้องทุกตัวจะต้องรออีก 24 ชม.กว่าจะถูกตรวจด้วยวิธีใหม่
        ทั้งที่ผลของเก่าใช้ไม่ได้แล้ว

        การเช็คว่ามีบันทึกใน camera_ai_probe ไหมจึงเป็นตัวจับ "ยังไม่เคยตรวจด้วยกลไกนี้"
        ที่ซ่อมตัวเองได้ ไม่ต้องมีใครไปล้างคอลัมน์ด้วยมือหลัง deploy
      */
      cameras = await all(
        `SELECT c.id, c.name, c.brand, c.ip, c.onvifPort, c.onvifUser, c.onvifPass,
                c.analytics_kind, c.analytics_probed_at,
                (p.camera_id IS NULL) AS neverDiscovered
           FROM cameras c LEFT JOIN camera_ai_probe p ON p.camera_id = c.id
          WHERE c.ip IS NOT NULL AND c.ip <> ''`,
      );
    } catch (err) {
      console.warn(`[Analytics] อ่านรายชื่อกล้องไม่ได้: ${err.message}`);
      return;
    }

    // ข้ามเที่ยงคืนตามนาฬิกากล้อง: ต้องกลับไปเก็บของเมื่อวานให้จบอีกรอบ ไม่งั้นชั่วโมง
    // สุดท้ายของวันจะขาดถาวร เพราะรอบ poll สุดท้ายของวันเกิดก่อนชั่วโมงนั้นจบ
    const todayKey = cameraToday();
    if (lastCameraDate && lastCameraDate !== todayKey) {
      for (const cam of cameras) if (cam.analytics_kind) rolloverPending.add(cam.id);
    }
    lastCameraDate = todayKey;

    const probeCutoff = Date.now() - PROBE_EVERY_HOURS * 3600_000;

    for (const row of cameras) {
      const backoffUntil = authBackoff.get(row.id) || 0;
      if (Date.now() < backoffUntil) continue;

      try {
        const probedAt = row.analytics_probed_at ? Date.parse(row.analytics_probed_at) : 0;
        if (row.neverDiscovered || !probedAt || probedAt < probeCutoff) {
          const found = await probeCamera(row);
          row.analytics_kind = found ? found.kind : null;
          if (found) console.log(`[Analytics] ${row.name}: พบ ${found.kind}`);
        }

        if (!row.analytics_kind) continue;

        /*
          นับได้ ไม่ได้แปลว่าดึงย้อนหลังได้

          ตั้งแต่ discovery ถาม ONVIF เป็น กล้องอย่าง Uniview จะถูกจับได้ว่านับคนเป็น
          ทั้งที่ยังไม่มีทางดึงยอดของมัน — ยอดของกล้องกลุ่มนั้นออกมาทาง ONVIF metadata
          บน RTSP เท่านั้น ต้องเปิดสายค้างไว้ ไม่มีรายงานให้ถามย้อน (ยังไม่ได้ทำ)

          ข้ามไปเงียบ ๆ ดีกว่าเตือนทุกนาทีว่า "กล้องไม่คืนข้อมูล" ซึ่งไม่จริงและจะกลบ
          คำเตือนของกล้องที่มีปัญหาจริงจนหมด
        */
        if (!adapterFor(row)) continue;

        if (rolloverPending.has(row.id)) {
          const saved = await pollCamera(row, previousDayKey(todayKey));
          rolloverPending.delete(row.id);
          console.log(`[Analytics] ${row.name}: เก็บของเมื่อวานเพิ่ม ${saved} ช่วง`);
        }

        /*
          บอกด้วยว่าเก็บได้กี่ช่วง ไม่ใช่เงียบเมื่อสำเร็จ

          ก่อนหน้านี้เส้นทางที่สำเร็จไม่พิมพ์อะไรเลย ทำให้ "ไม่มีข้อมูล" กับ "พังเงียบ"
          หน้าตาเหมือนกันหมดในบันทึก และเป็นเหตุผลตรง ๆ ที่ ReferenceError ของตัวแปร
          `today` อยู่ได้หลายวันโดยไม่มีใครเห็น กว่าจะรู้ก็ตอนเปิดกราฟแล้วมันว่าง
        */
        const saved = await pollCamera(row, todayKey);
        if (saved > 0) console.log(`[Analytics] ${row.name}: เก็บ ${saved} ช่วงของ ${todayKey}`);
        else console.warn(`[Analytics] ${row.name}: กล้องไม่คืนข้อมูลของ ${todayKey} สักช่วง`);
      } catch (err) {
        // กล้องตัวเดียวพังต้องไม่ทำให้ตัวอื่นหยุด
        const msg = String(err.message || err);
        if (/401|auth|Digest/i.test(msg)) {
          authBackoff.set(row.id, Date.now() + AUTH_BACKOFF_MS);
          console.warn(`[Analytics] ${row.name}: ยืนยันตัวตนไม่ผ่าน — พัก 15 นาที (${msg})`);
        } else {
          console.warn(`[Analytics] ${row.name}: ${msg}`);
        }
      }
      await sleep(STAGGER_MS);
    }
  }

  return {
    /**
     * ตารางและคอลัมน์ของ AI โดยไม่เริ่มดึงข้อมูล — /api/v1/cameras อ่าน analytics_kind อยู่เสมอ
     * ตอนปิด AI (GATEWAY_AI) ฐานข้อมูลใหม่จึงต้องมีคอลัมน์นี้ แม้จะไม่มีใครเขียนมันก็ตาม
     */
    ensureSchema: async () => { await ensureSchema(); await discovery.ensureSchema(); },
    async start() {
      try {
        await ensureSchema();
        await discovery.ensureSchema();
      } catch (err) {
        console.error(`[Analytics] สร้างตารางไม่สำเร็จ — ไม่เริ่มดึงข้อมูล: ${err.message}`);
        return;
      }
      await tick().catch((err) => console.warn(`[Analytics] tick แรก: ${err.message}`));
      timer = setInterval(() => {
        tick().catch((err) => console.warn(`[Analytics] tick: ${err.message}`));
      }, POLL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** ให้ route เรียกดึงทันทีได้ ไม่ต้องรอรอบถัดไป */
    tick,
  };
}

module.exports = { createAnalyticsPoller };
