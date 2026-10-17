/**
 * การยืนยันตัวตนแบบเครื่องต่อเครื่องสำหรับ API Gateway (/api/v1)
 *
 * แยกออกจาก checkAuth เดิมโดยสิ้นเชิง และตั้งใจให้เป็นคนละเส้นทางกัน:
 * checkAuth มีไว้ให้เบราว์เซอร์ของคนใช้งาน ส่วนไฟล์นี้มีไว้ให้ "โปรแกรมอื่น"
 * เช่น Edge AI ที่รันคนละเครื่อง เอาไว้ดึง stream กับ metadata
 *
 * ทำไมไม่ให้ Edge AI ใช้บัญชีผู้ใช้: หน้าเว็บใช้ session token ที่ผูกกับคน (หมดอายุ 12 ชม.,
 * shared/session-token.js) การเอาบัญชีไปแปะไว้ในเครื่อง Edge หมายถึง
 * รหัสผ่านของ "คน" คนหนึ่งไปนอนอยู่ในไฟล์ config ของเครื่องที่เราไม่ได้คุมทั้งหมด
 * และเพิกถอนทีก็กระทบคนนั้นทั้งบัญชี API key ถอนได้ทีละใบโดยไม่กระทบใคร
 *
 * เก็บเฉพาะ hash ของ key ไม่เก็บตัว key: ถ้าฐานข้อมูลหลุด คนที่ได้ไปยังเอาไป
 * เรียก API ไม่ได้ ราคาที่จ่ายคือกู้ key คืนไม่ได้ ต้องออกใบใหม่ ซึ่งถูกต้องแล้ว
 */
const crypto = require('crypto');
const { nowIso } = require('../shared/time');

/** อายุของ cache สิทธิ์ต่อ key — เทียบเท่า roleAccessCache ของฝั่งผู้ใช้ */
const CLIENT_CACHE_MS = 30_000;

/**
 * เพดานจำนวนแถวใน cache — ผลลบ (key มั่ว) ก็ถูกแคช เดิมไม่เคยถูกลบออกจาก Map เลย
 * คนที่ยิง key สุ่มไม่ซ้ำกันรัว ๆ จึงทำให้หน่วยความจำโตไม่มีที่สิ้นสุด ถึงเพดานแล้วกวาดแถวหมดอายุ ยังเกินก็ล้างทั้งก้อน
 */
const CLIENT_CACHE_MAX = 5_000;

/**
 * เขียน last_seen_at ถี่แค่ไหน
 *
 * ไม่เขียนทุก request เพราะ Edge AI ยิงถี่มาก และการเขียน SQLite ทุก request
 * แลกมาด้วยความแม่นยำระดับวินาทีที่ไม่มีใครต้องการ รู้แค่ว่า "ยังมีชีวิตอยู่ไหม"
 * ก็พอ
 */
const TOUCH_THROTTLE_MS = 60_000;

/**
 * นานแค่ไหนที่ยังนับว่า client ตัวหนึ่ง "ยังอยู่"
 *
 * client ที่ดูวิดีโออยู่จะขอ URL ใหม่ทุกครั้งที่ต่อใหม่ และ token ของ mp4 มีอายุ 5 นาที
 * อยู่แล้ว ตัวที่ยังทำงานปกติจึงแตะ Gateway บ่อยกว่านี้มาก ส่วนตัวที่ปิดไปแล้วจะเงียบ
 * ทันที การตั้งไว้ที่ 5 นาทีจึงหมายถึง "ยังทำงานอยู่จริง" ไม่ใช่ "เคยเปิดวันนี้"
 */
const PRESENCE_TTL_MS = 5 * 60_000;

/** เก็บได้สูงสุดกี่ instance ต่อหนึ่ง key — กัน client ที่สร้าง id ใหม่ทุกครั้งที่เปิดจนบวม */
const PRESENCE_MAX_PER_CLIENT = 200;

/** นำหน้าทุก key เพื่อให้เห็นแล้วรู้ทันทีว่าคืออะไรเวลาไปโผล่ใน log หรือไฟล์ config */
const KEY_PREFIX = 'sgw_';

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

/** สร้าง API key ใหม่ — ผู้เรียกต้องแสดงให้ผู้ใช้เห็นครั้งเดียวแล้วทิ้ง */
const generateKey = () => `${KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;

/**
 * สร้างตาราง api_clients
 *
 * scope_groups เก็บเป็น JSON array ของ group_name ส่วน NULL แปลว่า "ทุกกลุ่ม"
 * ใช้ความหมายเดียวกับ roles.all_devices = 1 คือรวมกล้องที่เพิ่มเข้ามาในอนาคตด้วย
 * ซึ่งต่างจากการไล่ใส่ชื่อกลุ่มทั้งหมดในตอนสร้าง (นั่นเป็น snapshot ณ วันนั้น)
 */
function ensureSchema(db) {
  // serialize: node-sqlite3 ยิงคำสั่งขนานกันได้ — บนฐานข้อมูลใหม่ CREATE INDEX เคยวิ่งก่อน CREATE TABLE
  // แล้วทั้ง process ล้มด้วย "no such table: main.api_clients" (พบตอนติดตั้ง edge จำลองสด 2026-09-23)
  db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS api_clients (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    key_hint     TEXT NOT NULL,
    scope_groups TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT,
    created_by   TEXT,
    last_seen_at TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_api_clients_hash ON api_clients(key_hash)');

  /*
    key_cipher — ตัว key ที่เข้ารหัสไว้ให้ผู้ดูแลเปิดดูซ้ำได้ (ดู key-vault.js)

    เพิ่มทีหลังจึงต้องเป็น ALTER ไม่ใช่แก้ CREATE ข้างบน เพราะ CREATE TABLE IF NOT
    EXISTS ไม่ทำอะไรเลยกับตารางที่มีอยู่แล้ว การแก้แต่ข้างบนจึงได้ผลเฉพาะเครื่องที่
    ติดตั้งใหม่ ส่วนเครื่องจริงที่มีตารางอยู่แล้วจะพังตอน INSERT โดยไม่มีอะไรเตือน

    NULL แปลว่า key ใบนั้นออกก่อนมีระบบนี้ — เปิดดูไม่ได้ตลอดไป ไม่ใช่ข้อผิดพลาด
  */
  db.run('ALTER TABLE api_clients ADD COLUMN key_cipher TEXT', () => {});

  /*
    allow_ptz — key ใบนี้สั่งหมุน/ซูม/preset กล้องได้หรือไม่

    ทุก endpoint อื่นของ /api/v1 แค่อ่าน PTZ เป็นการสั่งการครั้งแรกที่เปลี่ยนสภาพของ
    กล้องจริง และกล้องหนึ่งตัวถูกหลายคนดูพร้อมกัน — ใครหมุนก็หมุนให้ทุกคน จึงต้องเป็น
    สิทธิ์ที่ผู้ดูแลเปิดให้ทีละใบ ค่าเริ่มต้น 0 ให้ key ที่ออกไปแล้วยังอ่านได้อย่างเดียวเหมือนเดิม
  */
  db.run('ALTER TABLE api_clients ADD COLUMN allow_ptz INTEGER NOT NULL DEFAULT 0', () => {});

  /*
    allow_playback — key ใบนี้ดูภาพย้อนหลังได้หรือไม่ (gateway/playback.js)

    ภาพย้อนหลังคือหลักฐาน และดึงได้ครั้งละเป็นชั่วโมง จึงแยกจากสิทธิ์ดูสด ค่าเริ่มต้น 0
    · key ที่ central ถือไว้กับ edge ต้องติ๊กที่ edge ด้วย ไม่งั้น central ขอภาพย้อนหลังไม่ได้
  */
  db.run('ALTER TABLE api_clients ADD COLUMN allow_playback INTEGER NOT NULL DEFAULT 0', () => {});

  /*
    allow_event_write — key ใบนี้ส่ง event ของ AI เข้ามาได้ (POST /api/v1/ai/events ที่ edge)
    ให้เฉพาะแหล่งส่ง AI ที่เชื่อถือได้และจำกัดกลุ่มกล้อง · key ของผู้ดู/parent ไม่ต้องมีสิทธิ์ส่ง
  */
  db.run('ALTER TABLE api_clients ADD COLUMN allow_event_write INTEGER NOT NULL DEFAULT 0', () => {});
  /*
    allow_public — key ใบนี้เห็นกล้องสาธารณะที่ Central ดึงมาเอง (vms/public-cams.js) ได้ไหม
    แยกจาก scope_groups: กลุ่มคุมกล้องของเรา ส่วนกล้อง public เปิดทั้งชุดด้วยธงนี้ · ค่าเริ่มต้น 0
    key ที่ออกไปแล้ว (รวมใบที่เห็นทุกกลุ่ม) จึงไม่เห็นกล้อง public จนกว่าผู้ดูแลจะติ๊ก
  */
  db.run('ALTER TABLE api_clients ADD COLUMN allow_public INTEGER NOT NULL DEFAULT 0', () => {});
  // เพิกถอน key ของ inference ที่เลิกใช้ โดยไม่แตะ key ของแหล่งรับภายนอก
  db.run("UPDATE api_clients SET enabled = 0, allow_event_write = 0 WHERE id = 'apic_ai_worker_local'");
  });
}

/**
 * ตัวคุม middleware และ cache ของ Gateway
 *
 * รับ db เข้ามาแทนที่จะ require เอง เพื่อให้ใช้ connection เดียวกับ server.js
 * (SQLite เปิดซ้อนกันหลาย connection บนไฟล์เดียวใน WAL ทำได้ก็จริง แต่ไม่มีเหตุผล
 * ให้ทำ และจะทำให้ PRAGMA ที่ตั้งไว้ฝั่งโน้นไม่มีผลกับฝั่งนี้)
 */
// คืนรูปสิทธิ์เดียวกันทั้งตอน login และตรวจ SSE ซ้ำ
function clientFromRow(row) {
  let scopeGroups = null;
  if (row.scope_groups) {
    try {
      const parsed = JSON.parse(row.scope_groups);
      if (Array.isArray(parsed)) scopeGroups = parsed;
    } catch {
      // ค่าที่อ่านไม่ออกต้องแปลว่า "ไม่ให้เห็นอะไรเลย" ไม่ใช่ "ให้เห็นทุกอย่าง"
      // การเดาผิดด้านหลวมคือการเปิดกล้องที่ไม่ควรเปิดให้คนนอกเห็น
      scopeGroups = [];
    }
  }

  return { id: row.id, name: row.name, scopeGroups, allowPtz: Boolean(row.allow_ptz), allowPlayback: Boolean(row.allow_playback), allowEventWrite: Boolean(row.allow_event_write), allowPublic: Boolean(row.allow_public) };
}

function createApiKeyAuth(db) {
  ensureSchema(db);

  /** key_hash -> { client, at } */
  const cache = new Map();
  const lastTouch = new Map();

  /**
   * ใครกำลังใช้ key ใบไหนอยู่บ้าง — clientId -> Map(instanceId -> { lastSeen, address, label })
   *
   * เก็บในหน่วยความจำโดยตั้งใจ ไม่ลงฐานข้อมูล คำถามที่ตอบคือ "ตอนนี้มีกี่ตัวที่ยังทำงาน"
   * ซึ่งเป็นสถานะชั่วคราวตามธรรมชาติ การเขียนลง SQLite ทุกครั้งที่ Edge AI ยิงเข้ามา
   * แลกมาด้วย I/O ที่ไม่มีใครได้ประโยชน์ และผลที่ได้ก็ยังต้องกรองด้วยเวลาอยู่ดี
   *
   * ผลข้างเคียงที่ต้องรู้: รีสตาร์ต backend แล้วตัวเลขนี้เริ่มนับใหม่ ซึ่งถูกต้องตาม
   * ความหมาย — ไม่มีใครเชื่อมต่ออยู่จริงในวินาทีนั้น
   *
   * instanceId มาจาก client เอง (header X-Client-Instance) ไม่ใช่ IP เพราะหลายตัวอยู่
   * หลัง NAT เดียวกันได้ และเครื่องเดียวกันก็เปลี่ยน IP ได้ ตัวที่ไม่ส่ง id มาจะถูกนับ
   * รวมกันเป็นก้อนเดียวตาม IP ซึ่งเป็นการเดาที่ดีที่สุดเท่าที่มีข้อมูล
   */
  const presence = new Map();

  const notePresence = (clientId, req) => {
    const instanceId = String(req.headers['x-client-instance'] || '').trim()
      || `addr:${req.ip || req.socket?.remoteAddress || 'unknown'}`;

    let instances = presence.get(clientId);
    if (!instances) {
      instances = new Map();
      presence.set(clientId, instances);
    }

    const existing = instances.get(instanceId);
    instances.set(instanceId, {
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
      address: req.ip || req.socket?.remoteAddress || null,
      label: String(req.headers['x-client-name'] || '').trim() || existing?.label || null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 120) || null,
    });

    if (instances.size > PRESENCE_MAX_PER_CLIENT) {
      // ทิ้งตัวที่เงียบนานที่สุดก่อน — ของที่ยังทำงานอยู่ต้องไม่หายไปเพราะมีขยะเข้ามาเยอะ
      const oldest = [...instances.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) instances.delete(oldest[0]);
    }
  };

  /**
   * instance ที่ยังไม่หมดอายุของ key ใบหนึ่ง
   *
   * กรองตอนอ่านแทนที่จะตั้ง timer ไล่ลบ เพราะรายการนี้ถูกอ่านนาน ๆ ครั้ง (เฉพาะตอนคน
   * เปิดหน้า API Clients) แต่ถูกเขียนตลอดเวลา
   */
  const listActiveInstances = (clientId) => {
    const instances = presence.get(clientId);
    if (!instances) return [];

    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const alive = [];
    for (const [instanceId, info] of instances) {
      if (info.lastSeen < cutoff) {
        instances.delete(instanceId);
        continue;
      }
      alive.push({ instanceId, ...info });
    }

    return alive.sort((a, b) => b.lastSeen - a.lastSeen);
  };

  const countActiveInstances = (clientId) => listActiveInstances(clientId).length;

  const invalidationListeners = new Set();
  // admin แจ้งหลัง commit แล้ว; ปิด SSE ของ key ที่เปลี่ยนสิทธิ์ก่อนส่ง HTTP success
  const invalidate = (clientId) => {
    cache.clear();
    for (const listener of [...invalidationListeners]) listener(clientId);
  };
  const subscribeInvalidation = listener => {
    invalidationListeners.add(listener);
    return () => invalidationListeners.delete(listener);
  };
  // ตรวจ id และ hash เดิมจาก DB โดยตรง ไม่ให้ cache ยืดอายุสิทธิ์ของ SSE
  const revalidate = (clientId, keyHash) => new Promise((resolve, reject) => {
    db.get('SELECT id, name, scope_groups, enabled, allow_ptz, allow_playback, allow_event_write, allow_public FROM api_clients WHERE id = ? AND key_hash = ?', [clientId, keyHash], (err, row) => {
      if (err) return reject(err);
      resolve(row && row.enabled && row.id !== 'apic_ai_worker_local' ? clientFromRow(row) : null);
    });
  });

  /** ใส่ผลลง cache โดยไม่ให้เกินเพดาน — กวาดของหมดอายุก่อน ยังเต็มก็ล้าง (ของจริงโหลดกลับได้ด้วย query เดียว) */
  const remember = (keyHash, client) => {
    if (cache.size >= CLIENT_CACHE_MAX) {
      const cutoff = Date.now() - CLIENT_CACHE_MS;
      for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
      if (cache.size >= CLIENT_CACHE_MAX) cache.clear();
    }
    cache.set(keyHash, { client, at: Date.now() });
  };

  const touch = (id) => {
    const now = Date.now();
    if (now - (lastTouch.get(id) || 0) < TOUCH_THROTTLE_MS) return;
    lastTouch.set(id, now);
    db.run('UPDATE api_clients SET last_seen_at = ? WHERE id = ?', [nowIso(), id], () => {});
  };

  /**
   * ตรวจ Authorization: Bearer <key>
   *
   * รับเฉพาะ header มาตรฐาน ไม่รับ key ทาง query string เด็ดขาด เพราะ query string
   * ไปโผล่ใน access log ของทุก proxy ที่คั่นกลาง ซึ่งเท่ากับ key รั่วโดยไม่มีใครรู้ตัว
   */
  const requireApiKey = (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      return res.status(401).json({ error: 'ต้องมี Authorization: Bearer <api-key>' });
    }

    const keyHash = hashKey(match[1]);
    req.apiKeyHash = keyHash;
    const hit = cache.get(keyHash);
    if (hit && Date.now() - hit.at < CLIENT_CACHE_MS) {
      if (!hit.client) return res.status(401).json({ error: 'API key ไม่ถูกต้องหรือถูกปิดใช้งาน' });
      req.apiClient = hit.client;
      touch(hit.client.id);
      notePresence(hit.client.id, req);
      return next();
    }

    db.get(
      'SELECT id, name, scope_groups, enabled, allow_ptz, allow_playback, allow_event_write, allow_public FROM api_clients WHERE key_hash = ?',
      [keyHash],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row || !row.enabled || row.id === 'apic_ai_worker_local') {
          // แคชผลลบด้วย เพื่อไม่ให้การยิง key มั่วรัวๆ กลายเป็นการยิง query รัวๆ
          remember(keyHash, null);
          return res.status(401).json({ error: 'API key ไม่ถูกต้องหรือถูกปิดใช้งาน' });
        }

        const client = clientFromRow(row);
        remember(keyHash, client);
        req.apiClient = client;
        touch(client.id);
        notePresence(client.id, req);
        next();
      },
    );
  };

  return {
    requireApiKey,
    invalidate,
    subscribeInvalidation,
    revalidate,
    listActiveInstances,
    countActiveInstances,
    generateKey,
    hashKey,
    KEY_PREFIX,
  };
}

module.exports = { createApiKeyAuth, generateKey, hashKey, ensureSchema, KEY_PREFIX };
