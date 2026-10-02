/**
 * ค้นหาว่ากล้องแต่ละตัวเปิด AI อะไรไว้ แล้วบันทึกไว้ให้ระบบตอบได้ทันที
 *
 * ### ปัญหาที่แก้
 *
 * เดิมการตัดสินว่ากล้องมี AI ไหมอยู่ที่บรรทัดเดียว: `ADAPTERS[camera.brand]` ซึ่งมีแค่ tiandy
 * กล้องยี่ห้ออื่น **ไม่เคยถูกติดต่อเลยสักครั้ง** และจบลงที่ analytics_kind = NULL ถาวรโดยไม่มี
 * error ที่ไหน ผู้ใช้เห็นแค่ "ไม่มี AI" ซึ่งแยกไม่ออกจาก "ระบบไม่เคยลองถาม"
 *
 * ที่นี่กลับด้าน: ถาม ONVIF ก่อนเสมอเพราะเป็นภาษากลางที่ทุกยี่ห้อพูด แล้วค่อยเสริมด้วย
 * adapter เฉพาะยี่ห้อ — `brand` กลายเป็นตัวช่วย ไม่ใช่ประตูที่ล็อกอยู่
 *
 * ### สองตารางแยกหน้าที่กัน
 *
 * `camera_ai` เก็บ "รายการ AI" ที่พบ หนึ่งแถวต่อหนึ่งกฎ — เป็นของที่หน้าจอกับ API แสดง
 * `camera_ai_probe` เก็บ "บันทึกการตรวจครั้งล่าสุด" หนึ่งแถวต่อกล้อง รวมทั้งตอนที่ตรวจไม่สำเร็จ
 *
 * ต้องแยกกัน เพราะกล้องที่ตรวจไม่ได้ไม่มีแถวใน camera_ai เลย ซึ่งหน้าตาเหมือนกล้องที่ตรวจ
 * แล้วไม่มี AI ทุกประการ — และนั่นคือความกำกวมที่ทำให้เรื่องนี้ถูกมองข้ามมาตลอด
 */
const { probeCapabilities } = require('./onvif-capabilities');
const { adapterFor, credsFor } = require('./index');
const { nowIso } = require('../../shared/time');

/**
 * ชนิดกฎของ ONVIF → หัวข้อ event ที่มันออก และชื่อที่คนอ่านรู้เรื่อง
 *
 * หัวข้อมาจาก ONVIF Analytics Service Specification โดยตรง ไม่ได้ตั้งเอง — ปลายทางที่รับ
 * event จริงจะเห็นสตริงพวกนี้เป๊ะ ๆ การเดาชื่อเองจะทำให้หน้าจอกับสายข้อมูลจริงพูดคนละเรื่อง
 */
const RULE_TYPES = {
  linecounting: { topic: 'tns1:RuleEngine/CountAggregation/Counter', label: 'นับผ่านเส้น', counting: true },
  countaggregation: { topic: 'tns1:RuleEngine/CountAggregation/Counter', label: 'นับผ่านเส้น', counting: true },
  occupancycounting: { topic: 'tns1:RuleEngine/CountAggregation/OccupancyCounter', label: 'นับคนในพื้นที่', counting: true },
  linedetector: { topic: 'tns1:RuleEngine/LineDetector/Crossed', label: 'ข้ามเส้น' },
  fielddetector: { topic: 'tns1:RuleEngine/FieldDetector/ObjectsInside', label: 'ล้ำพื้นที่' },
  loiteringdetector: { topic: 'tns1:RuleEngine/LoiteringDetector/ObjectIsLoitering', label: 'ยืนวนเวียน' },
  objectdetection: { topic: 'tns1:RuleEngine/ObjectDetection/Object', label: 'จำแนกวัตถุ' },
  cellmotiondetector: { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', label: 'ตรวจจับความเคลื่อนไหว' },
  motiondetector: { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', label: 'ตรวจจับความเคลื่อนไหว' },
  tamperdetector: { topic: 'tns1:RuleEngine/TamperDetector/Tamper', label: 'กล้องถูกบังหรือย้าย' },
  facedetector: { topic: 'tns1:RuleEngine/ObjectDetector/Face', label: 'ตรวจจับใบหน้า' },
  facedetect: { topic: 'tns1:RuleEngine/ObjectDetector/Face', label: 'ตรวจจับใบหน้า' },
  facerecognitiondetector: { topic: 'tns1:RuleEngine/FaceRecognitionDetector/ObjectIsRecognized', label: 'จดจำใบหน้า' },
  declarativemotiondetector: { topic: 'tns1:RuleEngine/DeclarativeMotionDetector/MotionMatched', label: 'ตรวจจับความเคลื่อนไหว' },
};

/**
 * หัวข้อที่กล้อง "ประกาศว่าส่งได้" → ชื่อที่คนอ่านรู้เรื่อง คืน null แปลว่าไม่ใช่เรื่อง AI
 *
 * GetEventProperties เป็นทางเดียวที่ได้ผลกับกล้องบางรุ่น — Uniview MODEL-B ตอบ
 * GetProfiles สำเร็จโดยไม่มี AnalyticsConfiguration ติดมาเลย จึงอ่านกฎไม่ได้ แต่ประกาศ
 * หัวข้อไว้ครบ 28 หัวข้อรวมทั้ง LineDetector/Crossed และ CountAggregation/Counter
 *
 * กล้องยังประกาศหัวข้อที่ไม่เกี่ยวกับ AI มาด้วย (การบันทึก, การเปลี่ยน config, ล็อกอินผิด)
 * ซึ่งต้องกรองทิ้ง ไม่งั้นหน้าจอจะเต็มไปด้วยของที่ไม่ใช่คำตอบของคำถาม
 *
 * ชื่อยี่ห้อเฉพาะก็ต้องรู้จัก: Uniview ห่อ AI ของตัวเองไว้ใต้ `UserAlarm/SmartHttpReport/*`
 * และ `UserAlarm/IVA/*` ซึ่งไม่มีในมาตรฐาน ONVIF การรู้จักแค่ `RuleEngine/*` จะมองไม่เห็น
 * ครึ่งหนึ่งของสิ่งที่กล้องตัวนั้นทำได้
 */
const TOPIC_LABELS = [
  [/CountAggregation\/OccupancyCounter/i, 'นับคนในพื้นที่'],
  [/CountAggregation/i, 'นับผ่านเส้น'],
  [/LineDetector/i, 'ข้ามเส้น'],
  [/FieldDetector\/ObjectsAbandoned/i, 'วัตถุต้องสงสัย'],
  [/FieldDetector\/ObjectsMissing/i, 'วัตถุหายไป'],
  [/FieldDetector/i, 'ล้ำพื้นที่'],
  [/LoiteringDetector/i, 'ยืนวนเวียน'],
  [/FaceRecognitionDetector/i, 'จดจำใบหน้า'],
  [/FaceDetector|ObjectDetector\/Face/i, 'ตรวจจับใบหน้า'],
  [/ObjectDetection|ObjectDetector/i, 'จำแนกวัตถุ'],
  [/TamperDetector/i, 'กล้องถูกบังหรือย้าย'],
  [/IVA\/LeaveZone/i, 'ออกนอกพื้นที่'],
  [/IVA\/AccessZone/i, 'เข้าพื้นที่'],
  [/FireAlarm/i, 'ตรวจจับไฟ'],
  [/SceneTemperature/i, 'อุณหภูมิในภาพ'],
  [/AudioAnalytics|DetectedSound/i, 'ตรวจจับเสียง'],
  [/CellMotionDetector|MotionAlarm|DeclarativeMotionDetector/i, 'ตรวจจับความเคลื่อนไหว'],
  [/GlobalSceneChange/i, 'ภาพเปลี่ยนทั้งฉาก'],
];

/** หัวข้อที่ไม่ใช่ AI — เป็นเรื่องการบันทึก อุปกรณ์ หรือการตั้งค่า */
const NOT_AI = /RecordingConfig|Media\/|Monitoring\/|Configuration\/|IllegalLogin|BandwidthChange|Device\/Trigger/i;

function topicLabel(topic) {
  const t = String(topic || '');
  if (!t || NOT_AI.test(t)) return null;
  for (const [re, label] of TOPIC_LABELS) if (re.test(t)) return label;
  return null;
}

/** `tt:LineDetector` / `LineDetectorRule` → คีย์ในตารางข้างบน */
function ruleKind(type) {
  const bare = String(type || '')
    .split(':').pop()
    .replace(/^My/, '')      // ผู้ผลิตหลายรายตั้งชื่อชนิดว่า MyLineDetector
    .replace(/Rule$/i, '')
    .toLowerCase();
  return RULE_TYPES[bare] || null;
}

/** ชื่อที่เอาไปโชว์ได้แม้เป็นชนิดที่เรายังไม่รู้จัก — ดีกว่าเว้นว่างให้คนเดาเอง */
function labelFor(type) {
  return ruleKind(type)?.label || String(type || '').split(':').pop() || 'ไม่ทราบชนิด';
}

/**
 * กฎตัวนี้ "เปิดอยู่จริง" หรือแค่เป็นช่องว่างที่กล้องสร้างรอไว้
 *
 * เจอกับกล้องจริงแล้วว่า GetRules คืนช่องกฎที่กล้องเตรียมไว้ล่วงหน้ามาทั้งหมด ไม่ใช่เฉพาะ
 * ที่เปิด — Uniview ตอบ MyLineDetector1..4 และ MyFieldDetector1..4 มาครบทุกตัวเสมอ ทั้งที่
 * หน้าเว็บของกล้องแสดงกฎเดียว ถ้านับว่าเปิดหมด หน้าจอจะบอกว่ากล้องมี AI 12 อย่างทำงานอยู่
 * ซึ่งไม่จริงและจะทำให้คนตัดสินใจออกคีย์ผิด
 *
 * ตัวบอกอยู่ในพารามิเตอร์ของกฎเอง: `LineEnable` สำหรับกฎตระกูลเส้น `FieldEnable` สำหรับ
 * ตระกูลพื้นที่ ตรวจแล้วตรงกับหน้าเว็บกล้องเป๊ะ (LineEnable=true ตัวเดียวคือ Rule1 ที่ตั้งไว้)
 *
 * **ห้ามเหมาว่าอะไรที่ลงท้ายด้วย Enable คือสวิตช์หลัก** — `MyCountAggregation` มี
 * `ShoulderEnable` ซึ่งเป็นตัวเลือกย่อยเรื่องการตรวจจับไหล่ ไม่ใช่การเปิดปิดการนับ
 * การเหมารวมจะปิดการนับคนทิ้งทั้งที่มันทำงานอยู่ จึงจับคู่ธงกับตระกูลของกฎเท่านั้น
 *
 * กฎที่ไม่มีธงของตัวเองถือว่าเปิด — การมีอยู่คือสิ่งเดียวที่กล้องบอกเรา และการเดาว่าปิด
 * จะซ่อน AI ที่ทำงานอยู่จริง ซึ่งแย่กว่าการรายงานเกิน
 */
function ruleEnabled(rule) {
  const params = rule?.params || {};
  const asBool = (v) => String(v).toLowerCase() !== 'false';

  if (params.Enabled !== undefined) return asBool(params.Enabled);

  const family = String(rule?.type || '').split(':').pop().replace(/^My/, '').replace(/Rule$/i, '');
  const prefix = /LineDetector/i.test(family) ? 'Line'
    : /FieldDetector/i.test(family) ? 'Field'
    : null;
  if (prefix && params[`${prefix}Enable`] !== undefined) return asBool(params[`${prefix}Enable`]);

  return true;
}

function createDiscovery(db) {
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  async function ensureSchema() {
    await run(`CREATE TABLE IF NOT EXISTS camera_ai (
      camera_id TEXT NOT NULL,
      source TEXT NOT NULL,
      topic TEXT NOT NULL,
      rule TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      detail TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      PRIMARY KEY (camera_id, source, topic, rule)
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_camera_ai_camera ON camera_ai(camera_id)');
    await run(`CREATE TABLE IF NOT EXISTS camera_ai_probe (
      camera_id TEXT PRIMARY KEY,
      ok INTEGER NOT NULL DEFAULT 0,
      probed_at TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      firmware TEXT,
      services TEXT,
      event_topics TEXT,
      errors TEXT
    )`);
  }

  /**
   * แปลงผลดิบจาก ONVIF + vendor เป็นแถวของ camera_ai
   *
   * กฎที่เปิดอยู่จริงมาก่อนเสมอ แล้วค่อยเติม "ชนิดที่ทำได้แต่ยังไม่ได้เปิด" โดยไม่ทับของเดิม
   * — กล้องที่เปิด LineDetector ไว้แล้วต้องไม่ถูกลดสถานะกลับเป็นแค่ "ทำได้"
   */
  function rowsFrom(caps, vendorFound) {
    const rows = new Map();
    const put = (r) => {
      const key = `${r.source}|${r.topic}|${r.rule}`;
      const prev = rows.get(key);
      if (prev && prev.enabled >= r.enabled) return;
      rows.set(key, r);
    };

    for (const rule of caps.activeRules || []) {
      const kind = ruleKind(rule.type);
      put({
        source: 'onvif',
        topic: kind?.topic || `rule:${String(rule.type || 'unknown')}`,
        rule: rule.name || '',
        enabled: ruleEnabled(rule) ? 1 : 0,
        label: labelFor(rule.type),
        detail: JSON.stringify({ type: rule.type, token: rule.token, params: rule.params || {} }),
      });
    }

    for (const sup of caps.supportedRules || []) {
      const kind = ruleKind(sup.type);
      put({
        source: 'onvif',
        topic: kind?.topic || `rule:${String(sup.type || 'unknown')}`,
        rule: '',
        enabled: 0,
        label: labelFor(sup.type),
        detail: JSON.stringify({ type: sup.type, token: sup.token, supportedOnly: true }),
      });
    }

    /*
      หัวข้อที่กล้องประกาศว่าส่งได้ ก็คือความสามารถของมันเช่นกัน

      เติมท้ายสุดและไม่ทับของเดิม — กฎที่อ่านได้จริงจาก GetRules ให้ข้อมูลมากกว่า (รู้ชื่อกฎ
      รู้ว่าเปิดอยู่ รู้ว่าจับวัตถุชนิดไหน) การประกาศหัวข้อบอกได้แค่ว่า "ทำเป็น" เท่านั้น
      แต่สำหรับกล้องที่อ่านกฎไม่ได้เลย นี่คือคำตอบเดียวที่มี และดีกว่าหน้าจอว่าง
    */
    for (const topic of caps.eventTopics || []) {
      const label = topicLabel(topic);
      if (!label) continue;
      put({
        source: 'onvif',
        topic,
        rule: '',
        enabled: 0,
        label,
        detail: JSON.stringify({ declaredOnly: true }),
      });
    }

    if (vendorFound) {
      put({
        source: vendorFound.source,
        topic: 'tns1:RuleEngine/CountAggregation/Counter',
        rule: vendorFound.rule || '',
        enabled: 1,
        label: 'นับผ่านเส้น',
        detail: JSON.stringify(vendorFound.detail || {}),
      });
    }

    return [...rows.values()];
  }

  /**
   * ตรวจกล้องหนึ่งตัวแล้วบันทึกผล
   *
   * ไม่โยน error ออกไป — ผู้เรียกคือ route แอดกล้องกับ poller ซึ่งทั้งคู่ต้องทำงานต่อได้
   * แม้กล้องตัวนี้จะติดต่อไม่ได้ ความล้มเหลวถูกบันทึกลง camera_ai_probe แทน
   */
  async function discover(row) {
    const at = nowIso();
    let caps = { ok: false, activeRules: [], supportedRules: [], eventTopics: [], services: {}, errors: {}, device: null };

    if (row.ip) {
      try {
        caps = await probeCapabilities({
          ip: row.ip,
          port: Number(row.onvifPort) || 80,
          user: row.onvifUser || '',
          pass: row.onvifPass || '',
        });
      } catch (err) {
        caps.errors.probe = String(err?.message || err);
      }
    } else {
      caps.errors.probe = 'กล้องตัวนี้ไม่มี IP ให้ถาม (เพิ่มแบบ manual)';
    }

    /*
      adapter เฉพาะยี่ห้อเป็นทางเสริม ไม่ใช่ทางเดียวอีกต่อไป

      Tiandy ให้ยอดนับผ่าน CGI ของตัวเองซึ่ง ONVIF ไม่มีทางรู้ การถอดออกจะทำให้กล้องที่
      ใช้งานได้ดีอยู่แล้วหยุดทำงาน จึงถามทั้งสองทางแล้วรวมผล
    */
    let vendorFound = null;
    const adapter = adapterFor(row);
    if (adapter) {
      try {
        const found = await adapter.probe(credsFor(row));
        if (found) {
          vendorFound = {
            source: String(row.brand).toLowerCase(),
            rule: found.mode || '',
            detail: { kind: found.kind, mode: found.mode, clearAt: found.clearAt },
          };
        }
      } catch (err) {
        caps.errors.vendor = String(err?.message || err);
      }
    }

    const rows = rowsFrom(caps, vendorFound);

    // เขียนทับชุดเดิมทั้งก้อน ไม่ใช่เติมเข้าไป — กฎที่ถูกลบออกจากกล้องต้องหายจากหน้าจอด้วย
    await run('DELETE FROM camera_ai WHERE camera_id = ?', [row.id]);
    for (const r of rows) {
      await run(
        `INSERT INTO camera_ai (camera_id, source, topic, rule, enabled, label, detail, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(camera_id, source, topic, rule) DO UPDATE SET
           enabled = excluded.enabled, label = excluded.label,
           detail = excluded.detail, last_seen_at = excluded.last_seen_at`,
        [row.id, r.source, r.topic, r.rule, r.enabled, r.label, r.detail, at, at],
      );
    }

    await run(
      `INSERT INTO camera_ai_probe (camera_id, ok, probed_at, manufacturer, model, firmware, services, event_topics, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(camera_id) DO UPDATE SET
         ok = excluded.ok, probed_at = excluded.probed_at, manufacturer = excluded.manufacturer,
         model = excluded.model, firmware = excluded.firmware, services = excluded.services,
         event_topics = excluded.event_topics, errors = excluded.errors`,
      [
        row.id,
        caps.ok || vendorFound ? 1 : 0,
        at,
        caps.device?.manufacturer || null,
        caps.device?.model || null,
        caps.device?.firmware || null,
        JSON.stringify(caps.services || {}),
        JSON.stringify(caps.eventTopics || []),
        JSON.stringify(caps.errors || {}),
      ],
    );

    /*
      analytics_kind ยังหมายถึง "นับคนได้" เหมือนเดิมเป๊ะ เพื่อไม่ให้สัญญา /api/v1 เปลี่ยน
      ต่างกันแค่ที่มา: เดิมเดาจาก brand ตอนนี้มาจากสิ่งที่กล้องตอบจริง
    */
    const countable = rows.some((r) => r.enabled === 1 && /CountAggregation/.test(r.topic));
    await run('UPDATE cameras SET analytics_kind = ?, analytics_probed_at = ? WHERE id = ?', [
      countable ? 'people_counting' : null,
      at,
      row.id,
    ]);

    return { cameraId: row.id, ok: caps.ok || Boolean(vendorFound), rules: rows.length, countable };
  }

  /** ภาพรวมสำหรับหน้าจอผู้ดูแล — กล้องทุกตัวพร้อมชุด AI ที่ค้นพบ */
  async function overview(cameraIds) {
    const scope = Array.isArray(cameraIds) ? cameraIds : null;
    if (scope && scope.length === 0) return [];
    const where = scope ? `WHERE c.id IN (${scope.map(() => '?').join(',')})` : '';
    const params = scope || [];

    const cams = await all(
      `SELECT c.id, c.name, c.group_name AS groupName, c.brand, c.ip, c.analytics_kind AS analyticsKind,
              p.ok AS probeOk, p.probed_at AS probedAt, p.manufacturer, p.model, p.firmware,
              p.services, p.event_topics AS eventTopics, p.errors
         FROM cameras c LEFT JOIN camera_ai_probe p ON p.camera_id = c.id
         ${where} ORDER BY c.group_name, c.name`,
      params,
    );

    const aiRows = await all(
      `SELECT camera_id AS cameraId, source, topic, rule, enabled, label, detail
         FROM camera_ai ${scope ? `WHERE camera_id IN (${scope.map(() => '?').join(',')})` : ''}`,
      params,
    );

    const byCamera = new Map();
    for (const r of aiRows) {
      if (!byCamera.has(r.cameraId)) byCamera.set(r.cameraId, []);
      byCamera.get(r.cameraId).push({ ...r, enabled: Boolean(r.enabled), detail: safeJson(r.detail) });
    }

    return cams.map((c) => {
      const items = byCamera.get(c.id) || [];
      const errors = safeJson(c.errors) || {};
      return {
        id: c.id,
        name: c.name,
        group: c.groupName,
        brand: c.brand,
        device: { manufacturer: c.manufacturer, model: c.model, firmware: c.firmware },
        probedAt: c.probedAt || null,
        // ยังไม่เคยตรวจ กับ ตรวจแล้วไม่สำเร็จ คนละสถานะกัน และคนละอย่างกับ "ไม่มี AI"
        status: !c.probedAt ? 'never' : c.probeOk ? 'ok' : 'failed',
        errors,
        services: safeJson(c.services) || {},
        eventTopics: safeJson(c.eventTopics) || [],
        active: items.filter((i) => i.enabled),
        supported: items.filter((i) => !i.enabled),
        countable: c.analyticsKind === 'people_counting',
      };
    });
  }

  return { ensureSchema, discover, overview };
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

module.exports = { createDiscovery, ruleKind, labelFor, topicLabel, ruleEnabled, RULE_TYPES };
