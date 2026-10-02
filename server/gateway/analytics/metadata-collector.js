/**
 * เปิด ONVIF metadata track ของกล้องค้างไว้ตลอด แล้วเก็บยอดที่ไหลมาลงฐานข้อมูลกลาง
 *
 * ### ทำไม Gateway ต้องเป็นคนเฝ้า ไม่ใช่ client
 *
 * กล้องอย่าง Uniview ไม่มีรายงานให้ถามย้อนหลังเลย ยอดออกมาเป็นเหตุการณ์บนสายที่ต้องเปิด
 * ค้างไว้เท่านั้น — **การเชื่อมต่อนี้คือการเก็บข้อมูลเอง** ช่วงที่ไม่มีใครฟังคือช่วงที่หายถาวร
 *
 * ถ้าปล่อยให้ client เป็นคนเฝ้า จะเกิดสามอย่างที่ยอมรับไม่ได้: หน่วยงานที่ปิดแอปไปคืนหนึ่ง
 * เสียข้อมูลคืนนั้นไปตลอดกาล, หน่วยงานสองรายที่ดูกล้องตัวเดียวกันจะเปิดสายซ้อนกันสองเส้น
 * ไปที่กล้องตัวเดียว, และ client ต้องได้รหัสผ่านกล้องไปถือไว้ ซึ่งขัดกับเหตุผลทั้งหมดที่มี
 * Gateway อยู่ตรงกลาง
 *
 * Gateway จึงเปิดสายเดียวต่อกล้อง เก็บลงตารางกลาง แล้ว client ทุกรายดึงตัวเลขเดียวกันไป
 * ผ่าน /api/v1/analytics/counts เหมือนกล้องยี่ห้ออื่นทุกประการ
 *
 * ### เขียนแบบบวกสะสม ไม่ใช่ทับ
 *
 * ตรงข้ามกับ Tiandy โดยสิ้นเชิง: Tiandy รายงานยอดสะสมของทั้งวันใหม่ทุกครั้งที่ถาม เราจึง
 * ทับของเดิม ส่วนที่นี่แต่ละข้อความคือ "คนที่เพิ่งเดินผ่าน" การทับจะเหลือแค่กลุ่มสุดท้าย
 * และการบวกฝั่ง Tiandy จะทบขึ้นทุกนาที — ใส่ผิดข้างทำลายข้อมูลเงียบ ๆ ทั้งสองทาง
 * จึงมีตัวกันไว้ที่ assertAccumulating() และทั้งสองทางเขียนคนละ `rule` เสมอ
 */
const { OnvifMetadataSession } = require('./onvif-metadata-session');
const { ruleNameOf, isCountingTopic, countsFrom, maxDeltaFor } = require('./onvif-metadata');
const { toBangkokIso, nowIso } = require('../../shared/time');

/** เงียบไว้ก่อนหลัง PLAY — กล้อง replay สถานะปัจจุบันทุกครั้งที่เริ่มเล่น */
const QUARANTINE_MS = 1500;

/** ต่อใหม่แบบถอยห่างขึ้นเรื่อย ๆ กันการรุมกล้องที่กำลังมีปัญหา */
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/** ต่อติดนานเกินนี้ถือว่าหายดี รีเซ็ตการนับความพยายาม */
const STABLE_MS = 60_000;

/** รอบตรวจว่ารายชื่อกล้องที่ต้องเฝ้าเปลี่ยนไปหรือยัง */
const RECONCILE_MS = 60_000;

/**
 * กล้องที่ไม่มี metadata track เลย ให้ถอยห่างยาว ๆ ไม่ใช่ทุกนาที
 *
 * Tiandy กับ Dahua ที่ทดสอบมี AI ทำงานอยู่จริง แต่ไม่ได้เปิด metadata track บนสตรีมที่เราต่อ
 * — สภาพนี้ไม่เปลี่ยนจนกว่าจะมีคนไปตั้งค่าที่หัวกล้อง การลองใหม่ทุกนาทีจึงเป็นการรบกวน
 * กล้องเปล่า ๆ และทำให้บันทึกเต็มไปด้วยคำเตือนที่ไม่มีใครทำอะไรได้
 *
 * ยังลองต่อเป็นระยะอยู่ ไม่เลิกถาวร เพราะวันที่มีคนไปเปิดให้ ระบบควรเก็บได้เองโดยไม่ต้อง
 * รอใครมารีสตาร์ต
 */
const NO_METADATA_RETRY_MS = 15 * 60_000;

/** ข้อความที่บอกว่ากล้องไม่มี metadata track — คนละเรื่องกับสายหลุด */
const NO_METADATA = /ไม่มี metadata track/;

/** `PT60S` / `PT1M30S` → วินาที คืน null เมื่ออ่านไม่ออก */
function durationToSeconds(text) {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** ต้นชั่วโมงตามปฏิทินไทยของเวลาหนึ่ง — รูปแบบเดียวกับที่ Tiandy เขียนลงตาราง */
function hourBucket(date) {
  const iso = toBangkokIso(date);
  return iso ? `${iso.slice(0, 13)}:00:00.000+07:00` : null;
}

/**
 * กันการเขียนผิดข้าง
 *
 * ตัวนี้เขียนแบบบวกสะสมเท่านั้น และต้องไม่แตะแถวของ Tiandy ซึ่งใช้ rule ว่าง
 * ถ้าวันหนึ่งมีคนต่อสายผิดจนตัวเก็บนี้ไปเขียนทับแถวของอีกฝั่ง ตัวเลขจะเพี้ยนโดยไม่มี error
 * — ยอมให้ทิ้ง event หนึ่งใบ ดีกว่าปล่อยให้ประวัติทั้งเดือนผิดเงียบ ๆ
 */
function assertAccumulating(rule) {
  if (!rule) {
    throw new Error('ตัวเก็บ metadata ต้องมีชื่อกฎเสมอ — rule ว่างเป็นของฝั่งที่เขียนทับ (Tiandy)');
  }
}

function createMetadataCollector(db) {
  /** cameraId -> { session, state, timer, attempt, ... } */
  const watched = new Map();
  let reconcileTimer = null;
  let stopped = false;

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())));

  /**
   * กล้องที่ต้องเฝ้า: มี AI ชนิดใดก็ได้เปิดอยู่ ไม่ใช่เฉพาะการนับ
   *
   * เดิมที่นี่คัดเฉพาะกล้องที่นับคนได้ ซึ่งทำให้กล้องที่เปิดแค่ข้ามเส้นหรือล้ำพื้นที่ไม่ถูก
   * เฝ้าเลยสักตัว ทั้งที่เหตุการณ์ของมันวิ่งมาบนสายเดียวกันและได้มาฟรีอยู่แล้ว — Gateway
   * เป็นตัวกลางที่เก็บทุกอย่าง ไม่ใช่เครื่องนับคนที่บังเอิญต่อ ONVIF
   *
   * `hasVendorCounting` ติดมาด้วยเพื่อกันการนับซ้ำ ดูที่จุดใช้งาน
   */
  async function eligibleCameras() {
    return all(
      `SELECT c.id, c.name, c.ip, c.rtsp, c.rtspPort, c.onvifUser, c.onvifPass,
              (SELECT detail FROM camera_ai d
                WHERE d.camera_id = c.id AND d.enabled = 1 AND d.topic LIKE '%CountAggregation%'
                  AND d.source = 'onvif' LIMIT 1) AS detail,
              EXISTS (
                SELECT 1 FROM camera_ai v
                 WHERE v.camera_id = c.id AND v.enabled = 1
                   AND v.source <> 'onvif' AND v.topic LIKE '%CountAggregation%'
              ) AS hasVendorCounting
         FROM cameras c
        WHERE c.ip IS NOT NULL AND c.ip <> ''
          AND EXISTS (
            SELECT 1 FROM camera_ai a
             WHERE a.camera_id = c.id AND a.enabled = 1 AND a.source = 'onvif'
          )`,
    );
  }

  /**
   * ที่อยู่ RTSP ของกล้องสำหรับ DESCRIBE
   *
   * ใช้ path จาก `cameras.rtsp` ที่ระบบหามาได้ตอนแอดกล้อง ไม่เดาว่าเป็น `/media/video1`
   * — path ต่างกันไปตามยี่ห้อ และค่าที่เก็บไว้คือค่าที่พิสูจน์แล้วว่าเล่นได้จริง
   */
  function targetOf(row) {
    let path = '/media/video1';
    let port = Number(row.rtspPort) || 554;
    try {
      const u = new URL(String(row.rtsp || '').replace(/^rtsp:/, 'http:'));
      if (u.pathname && u.pathname !== '/') path = u.pathname + (u.search || '');
      if (u.port) port = Number(u.port);
    } catch {
      // rtsp ที่เก็บไว้อ่านไม่ออก — ใช้ค่าเริ่มต้นซึ่งถูกกับ Uniview ที่ทดสอบไว้
    }
    return { host: row.ip, rtspPort: port, user: row.onvifUser || '', pass: row.onvifPass || '', path };
  }

  /**
   * ตารางสถิติของ AI ทุกชนิด ไม่ใช่เฉพาะการนับ
   *
   * `camera_analytics` เป็นตารางของ "ยอดนับ" ซึ่งมีสัญญากับ /api/v1 ผูกอยู่ จะยัดเหตุการณ์
   * ชนิดอื่นลงไปไม่ได้ — ข้ามเส้น ล้ำพื้นที่ ใบหน้า ไม่มี count_in/count_out ให้กรอก
   *
   * ที่นี่จึงเก็บสิ่งที่ตอบได้กับทุกชนิดเหมือนกันหมด: **เกิดขึ้นกี่ครั้งในชั่วโมงนั้น** และ
   * ถ้าเป็นชนิดที่มีตัวเลขติดมาด้วย (การนับ) ก็เก็บเพิ่มในคอลัมน์ของมัน
   *
   * รวมเป็นรายชั่วโมงตั้งแต่ตอนเขียน ไม่เก็บดิบทีละ event — กล้องที่เปิดตรวจจับความ
   * เคลื่อนไหวยิงได้ทั้งวัน การเก็บดิบจะโตไม่มีเพดานเพื่อข้อมูลที่ไม่มีใครอ่านรายใบ
   */
  async function ensureStatsSchema() {
    await run(`CREATE TABLE IF NOT EXISTS camera_ai_stats (
      camera_id  TEXT NOT NULL,
      topic      TEXT NOT NULL,
      rule       TEXT NOT NULL DEFAULT '',
      ts         TEXT NOT NULL,
      events     INTEGER NOT NULL DEFAULT 0,
      count_in   INTEGER NOT NULL DEFAULT 0,
      count_out  INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (camera_id, topic, rule, ts)
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_camera_ai_stats_ts ON camera_ai_stats(ts)');
  }

  /** บวกสถิติของเหตุการณ์หนึ่งใบ ไม่ว่าจะเป็น AI ชนิดไหน */
  async function recordStat(cameraId, topic, rule, bucket, counts) {
    const at = nowIso();
    await run(
      `INSERT INTO camera_ai_stats (camera_id, topic, rule, ts, events, count_in, count_out, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(camera_id, topic, rule, ts) DO UPDATE SET
         events    = events + 1,
         count_in  = count_in  + excluded.count_in,
         count_out = count_out + excluded.count_out,
         updated_at = excluded.updated_at`,
      [cameraId, topic, rule, bucket, counts?.in || 0, counts?.out || 0, at],
    );
  }

  /** บวกยอดเข้าไปในช่วงเวลาเดิม ไม่ทับ */
  async function accumulate(cameraId, rule, bucket, counts) {
    assertAccumulating(rule);
    const at = nowIso();
    await run(
      `INSERT INTO camera_analytics (camera_id, rule, ts, count_in, count_out, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(camera_id, rule, ts) DO UPDATE SET
         count_in  = count_in  + excluded.count_in,
         count_out = count_out + excluded.count_out,
         updated_at = excluded.updated_at`,
      [cameraId, rule, bucket, counts.in, counts.out, at],
    );
  }

  function watcherFor(row) {
    const reportInterval = (() => {
      try {
        const params = JSON.parse(row.detail || '{}')?.params || {};
        return durationToSeconds(params.ReportTimeInterval || params.ReportInterval);
      } catch {
        return null;
      }
    })();

    return {
      id: row.id,
      name: row.name,
      target: targetOf(row),
      hasVendorCounting: Boolean(row.hasVendorCounting),
      maxDelta: maxDeltaFor(reportInterval),
      reportInterval,
      session: null,
      timer: null,
      attempt: 0,
      state: 'idle',
      playingSince: 0,
      connectedSince: null,
      lastEventAt: null,
      stats: { events: 0, stored: 0, rejected: 0, unknownShape: 0, replays: 0, reconnects: 0 },
      lastError: null,
    };
  }

  function handleMessages(w, messages) {
    for (const msg of messages) {
      if (!msg.topic) continue;
      w.stats.events += 1;

      /*
        ข้อความที่อันตรายที่สุดบนสาย

        ทุกครั้งที่ PLAY กล้อง replay สถานะปัจจุบันมาเป็น Initialized ซึ่งถือ **ยอดสะสม**
        ตั้งแต่ reset ล่าสุด ไม่ใช่ delta การเผลอบวกคือการเพิ่มคนที่ไม่เคยเดินผ่านเข้าไป
        หลักพันในชั่วโมงที่บังเอิญต่อใหม่ กันไว้สองชั้น: ตัวนี้ กับช่วงเงียบหลัง PLAY
      */
      if (msg.propertyOperation === 'Initialized') {
        w.stats.replays += 1;
        continue;
      }
      if (Date.now() - w.playingSince < QUARANTINE_MS) {
        w.stats.replays += 1;
        continue;
      }

      const rule = ruleNameOf(msg) || 'default';
      const bucket = hourBucket(msg.utcTime || new Date());
      if (!bucket) {
        w.stats.rejected += 1;
        continue;
      }

      const counting = isCountingTopic(msg.topic);
      const counts = counting ? countsFrom(msg, { max: w.maxDelta }) : null;
      if (counting && !counts) {
        // รูปร่างที่ไม่รู้จักของชนิดที่ควรมีตัวเลข — นับไว้ให้เห็น ไม่เดาค่าแทน
        w.stats.unknownShape += 1;
      }

      w.lastEventAt = nowIso();

      /*
        สถิติเก็บทุกชนิด แม้เป็นรายงานสถานะที่ยอดเป็นศูนย์

        "เกิดขึ้นกี่ครั้ง" ตอบได้กับทุกชนิดเหมือนกันหมด และเป็นสิ่งเดียวที่บอกได้ว่ากล้อง
        ตัวนั้นยังส่งอะไรออกมาอยู่จริงหรือเงียบไปแล้ว
      */
      recordStat(w.id, msg.topic, rule, bucket, counts)
        .then(() => { w.stats.stored += 1; })
        .catch((e) => {
          w.stats.rejected += 1;
          console.warn(`[Metadata] ${w.name}: เขียนสถิติไม่สำเร็จ — ${e.message}`);
        });

      /*
        ยอดนับยังลง camera_analytics ต่างหากเหมือนเดิม

        ตารางนั้นมีสัญญากับ /api/v1/analytics/counts ผูกอยู่และมีข้อมูลของ Tiandy ปนอยู่ด้วย
        การย้ายไปรวมกับตารางสถิติจะทำให้ client ที่ใช้อยู่พัง — สองตารางตอบคนละคำถาม
      */
      /*
        กล้องที่มี adapter ของยี่ห้อรายงานยอดอยู่แล้ว ต้องไม่เขียนยอดจากสายนี้ซ้ำ

        Tiandy ส่งยอดผ่าน CGI ลงแถว rule ว่าง ส่วนสายนี้จะลงแถวชื่อกฎ — แล้ว
        /api/v1/analytics/counts รวมทุก rule ด้วย SUM() ผลคือยอดของกล้องตัวนั้นจะเป็น
        สองเท่าโดยไม่มีอะไรฟ้อง สถิติยังเก็บครบทุกชนิดตามปกติ เพราะอยู่คนละตาราง
      */
      if (counts && !w.hasVendorCounting && (counts.in > 0 || counts.out > 0)) {
        accumulate(w.id, rule, bucket, counts).catch((e) => {
          console.warn(`[Metadata] ${w.name}: เขียนยอดนับไม่สำเร็จ — ${e.message}`);
        });
      }
    }
  }

  function scheduleReconnect(w, reason) {
    if (stopped || !watched.has(w.id)) return;
    w.connectedSince = null;
    w.lastError = reason;

    /*
      แยก "กล้องไม่มี metadata track" ออกจาก "สายหลุด"

      อย่างแรกคือกล้องที่ตั้งค่าไม่ครบ ต้องมีคนไปเปิดให้ อย่างหลังคือเครือข่ายหรือกล้องมีปัญหา
      ชั่วคราว — รวมสองอย่างเป็นสถานะเดียวทำให้คนดูไล่แก้ผิดจุด และเป็นความกำกวมแบบเดียวกับ
      "ไม่มี AI" กับ "ถามกล้องไม่ได้" ที่แก้ไปแล้วในหน้า AI Cameras
    */
    const noMetadata = NO_METADATA.test(reason || '');
    w.state = noMetadata ? 'no-metadata' : 'backoff';
    const wait = noMetadata
      ? NO_METADATA_RETRY_MS
      : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(w.attempt, 5));
    w.attempt += 1;
    w.timer = setTimeout(() => connect(w), wait);

    const every = `${Math.round(wait / 1000)} วิ`;
    if (noMetadata) console.log(`[Metadata] ${w.name}: ไม่มี metadata track — ลองใหม่ใน ${every}`);
    else console.warn(`[Metadata] ${w.name}: ${reason} — ต่อใหม่ใน ${every}`);
  }

  async function connect(w) {
    if (stopped || !watched.has(w.id)) return;
    w.state = 'connecting';
    const session = new OnvifMetadataSession(w.target, {
      onLog: (m) => console.log(`[Metadata] ${w.name}: ${m}`),
      onMessages: (messages) => handleMessages(w, messages),
    });
    w.session = session;

    try {
      await session.start();
      w.state = 'playing';
      w.playingSince = Date.now();
      w.connectedSince = nowIso();
      w.lastError = null;
      w.stats.reconnects += 1;
      console.log(`[Metadata] ${w.name}: เริ่มเก็บแล้ว (เพดานต่อ event ${w.maxDelta})`);

      // ต่อติดนานพอแล้วถือว่าหายดี ครั้งหน้าจึงเริ่มถอยจากศูนย์ใหม่
      setTimeout(() => { if (w.state === 'playing') w.attempt = 0; }, STABLE_MS);

      /*
        สายที่ปิดไปแล้วต้องถูกจับได้ ไม่ใช่ปล่อยให้เงียบไปเฉย ๆ

        session ไม่ต่อใหม่เอง (ตั้งใจ) การเฝ้าจึงเป็นหน้าที่ของที่นี่ — ตรวจว่า socket
        ยังอยู่ไหมเป็นระยะ ดีกว่ารอ error ที่อาจไม่มีวันมาเมื่อสายถูกตัดแบบเงียบ
      */
      w.timer = setInterval(() => {
        if (w.state !== 'playing') return;
        if (!session.socket || session.socket.destroyed) {
          clearInterval(w.timer);
          try { session.stop(); } catch { /* ปิดไปแล้ว */ }
          scheduleReconnect(w, 'สายหลุด');
        }
      }, 10_000);
    } catch (err) {
      try { session.stop(); } catch { /* ยังไม่ทันเปิด */ }
      scheduleReconnect(w, err.message);
    }
  }

  function stopWatcher(w) {
    if (w.timer) { clearTimeout(w.timer); clearInterval(w.timer); w.timer = null; }
    try { w.session?.stop(); } catch { /* ปิดไปแล้ว */ }
    w.session = null;
    w.state = 'stopped';
  }

  /** ปรับรายชื่อกล้องที่เฝ้าให้ตรงกับสิ่งที่ discovery ค้นเจอล่าสุด */
  async function reconcile() {
    if (stopped) return;
    let rows;
    try {
      rows = await eligibleCameras();
    } catch (err) {
      console.warn(`[Metadata] อ่านรายชื่อกล้องไม่ได้: ${err.message}`);
      return;
    }

    const wanted = new Map(rows.map((r) => [r.id, r]));

    for (const [id, w] of watched) {
      if (!wanted.has(id)) {
        stopWatcher(w);
        watched.delete(id);
        console.log(`[Metadata] ${w.name}: เลิกเฝ้า (ไม่อยู่ในเงื่อนไขแล้ว)`);
      }
    }

    for (const [id, row] of wanted) {
      if (watched.has(id)) continue;
      const w = watcherFor(row);
      watched.set(id, w);
      console.log(`[Metadata] ${w.name}: เริ่มเฝ้า rtsp://${w.target.host}:${w.target.rtspPort}${w.target.path}`);
      connect(w);
    }
  }

  return {
    async start() {
      stopped = false;
      await ensureStatsSchema();
      await reconcile();
      reconcileTimer = setInterval(() => reconcile().catch(() => {}), RECONCILE_MS);
    },
    stop() {
      stopped = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      for (const [, w] of watched) stopWatcher(w);
      watched.clear();
    },
    /** สถานะสำหรับหน้าจอผู้ดูแล — ช่วงที่ไม่ได้ต่อคือช่วงที่ข้อมูลหายถาวร จึงต้องเห็นได้ */
    status() {
      return [...watched.values()].map((w) => ({
        cameraId: w.id,
        name: w.name,
        state: w.state,
        connectedSince: w.connectedSince,
        lastEventAt: w.lastEventAt,
        reportIntervalSec: w.reportInterval,
        maxDelta: w.maxDelta,
        lastError: w.lastError,
        ...w.stats,
      }));
    },
    reconcile,
  };
}

module.exports = { createMetadataCollector, durationToSeconds, hourBucket, assertAccumulating };
