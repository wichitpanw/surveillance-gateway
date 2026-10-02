/**
 * หน้าจัดการ API key ของ Gateway — ฝั่งผู้ดูแลระบบ
 *
 * แยกจาก index.js เพราะเป็นคนละผู้ใช้และคนละวิธียืนยันตัวตน: ไฟล์นี้ให้ "คน" เรียก
 * ผ่านหน้าเว็บด้วย checkAuth เดิม ส่วน index.js ให้ "โปรแกรม" เรียกด้วย API key
 * การเอามารวมไฟล์เดียวกันแล้วแยกด้วย if คือวิธีที่ทำให้วันหนึ่งมีคนต่อ middleware
 * ผิดเส้นแล้วเปิดหน้าออก key ให้ทุกคนที่มี key เรียกได้
 *
 * สิทธิ์ที่ใช้คุม: device.manage + menu.apiclients (ต้องมีทั้งคู่ — แก้ 2026-09-29)
 * เดิมใช้ device.manage ตัวเดียว ทำให้ operator ที่ role ไม่ได้เห็นเมนู API Clients ออก key ผ่าน API ตรงได้
 * และ key ที่ออกไม่ถูกจำกัดตามขอบเขตกล้องของคนออก — operator ที่ดูแลกล้อง 5 ตัวออก key "ทุกกลุ่ม" ได้
 * ตอนนี้ key ที่ผู้เรียกออก/แก้/เปิดดู/ลบได้ต้องมีขอบเขตไม่กว้างกว่าผู้เรียก และติ๊กสิทธิ์พิเศษได้เฉพาะที่ตัวเองถืออยู่
 */
const express = require('express');
const crypto = require('crypto');
const { generateKey, hashKey } = require('./auth');
const { seal, unseal } = require('./key-vault');
const { nowIso } = require('../shared/time');

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {function} deps.checkAuth        middleware ยืนยันตัวตนผู้ใช้ของ server.js
 * @param {function} deps.requirePerm      ตัวสร้าง middleware ตรวจสิทธิ์ของ server.js
 * @param {function} deps.invalidateCache  ล้าง cache ของ requireApiKey หลังแก้ข้อมูล
 * @param {function} [deps.listActiveInstances] คืนรายการ client ที่ยังทำงานอยู่ของ key ใบหนึ่ง
 * @param {function} [deps.logAction]      บันทึก log การกระทำ ถ้ามี
 */
function createGatewayAdminRouter({
  db,
  checkAuth,
  requirePerm,
  invalidateCache,
  listActiveInstances,
  logAction,
}) {
  const router = express.Router();

  router.use(checkAuth, requirePerm('device.manage'), requirePerm('menu.apiclients'));

  /**
   * scope ของ key (รายชื่อกลุ่ม หรือ null = ทุกกลุ่ม) อยู่ในขอบเขตกล้องของผู้เรียกไหม
   * ผู้เรียกที่เห็นทุกกล้อง (req.deviceIds = null) ผ่านเสมอ · ผู้เรียกที่ถูกจำกัด: key ทุกกลุ่มไม่ได้ และทุกกลุ่มที่ขอ
   * ต้องมีกล้องอยู่จริงและกล้องทุกตัวในกลุ่มต้องอยู่ในขอบเขต (กลุ่มว่างไม่ได้ — กล้องที่เพิ่มทีหลังจะหลุดขอบเขต)
   * cb(null) = ผ่าน, cb({ status, error }) = ไม่ผ่าน
   */
  const checkScopeWithinCaller = (req, scopeGroups, cb) => {
    if (!(req.deviceIds instanceof Set)) return cb(null);
    if (scopeGroups === null) return cb({ status: 403, error: 'key แบบทุกกลุ่มกว้างกว่าขอบเขตกล้องของคุณ — ออก/จัดการได้เฉพาะ key ที่เลือกกลุ่มในขอบเขตตัวเอง' });
    if (!scopeGroups.length) return cb(null);
    db.all(
      `SELECT id, group_name FROM cameras WHERE group_name IN (${scopeGroups.map(() => '?').join(',')})`,
      scopeGroups,
      (err, rows) => {
        if (err) return cb({ status: 500, error: err.message });
        const present = new Set((rows || []).map((r) => r.group_name));
        const outside = scopeGroups.filter((g) => !present.has(g)
          || (rows || []).some((r) => r.group_name === g && !req.deviceIds.has(r.id)));
        if (outside.length) return cb({ status: 403, error: `กลุ่มนอกขอบเขตกล้องของคุณ: ${outside.join(', ')}` });
        cb(null);
      },
    );
  };

  /** โหลด key หนึ่งใบแล้วตรวจว่าผู้เรียกจัดการใบนี้ได้ไหม — ใช้กับเปิดดู/แก้/ลบ · ไม่พบหรือไม่ผ่าน ตอบแทนให้แล้ว */
  const loadManageableKey = (req, res, cb, { checkPrivileges = false, effectiveFlags = null } = {}) => {
    db.get('SELECT id, name, key_hint, key_cipher, scope_groups, allow_ptz, allow_playback, allow_event_write FROM api_clients WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'ไม่พบ key นี้' });
      checkScopeWithinCaller(req, parseScope(row.scope_groups), (scopeErr) => {
        if (scopeErr) return res.status(scopeErr.status).json({ error: scopeErr.error });
        if (checkPrivileges) {
          const flags = effectiveFlags ? effectiveFlags(row) : {
            allowPtz: Boolean(row.allow_ptz), allowPlayback: Boolean(row.allow_playback), allowEventWrite: Boolean(row.allow_event_write),
          };
          const denied = flagsCallerCannotGrant(req, flags);
          if (denied.length) return res.status(403).json({ error: 'ให้หรือเปิดดูสิทธิ์ที่ตัวเองไม่มีไม่ได้: ' + denied.join(', ') });
        }
        cb(row);
      });
    });
  };

  /*
    สิทธิ์พิเศษของ key ที่ต้องถืออยู่เองก่อนจะติ๊กให้ระบบอื่น — มอบสิ่งที่ตัวเองไม่มีไม่ได้ (กฎเดียวกับ role)
    allowEventWrite ไม่มีสิทธิ์ของคนที่ตรงกัน ให้เฉพาะผู้เรียกที่เห็นทุกกล้อง (event ปลอมกระทบทุกกล้อง)
  */
  const FLAG_PERMS = { allowPtz: 'device.ptz', allowPlayback: 'playback.view' };
  const flagsCallerCannotGrant = (req, body) => Object.keys(FLAG_PERMS)
    .filter((f) => body && body[f] && !(req.perms && req.perms.has(FLAG_PERMS[f])))
    .concat(body && body.allowEventWrite && req.deviceIds instanceof Set ? ['allowEventWrite'] : []);

  /** รายการ key ทั้งหมด — ไม่มีตัว key ติดมาด้วย ต้องขอทีละใบที่ /:id/key */
  router.get('/', (req, res) => {
    db.all(
      `SELECT id, name, key_hint, scope_groups, enabled, allow_ptz, allow_playback, allow_event_write, created_at, created_by, last_seen_at
       , (key_cipher IS NOT NULL) AS recoverable
       FROM api_clients ORDER BY created_at DESC`,
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(
          (rows || []).map((row) => ({
            id: row.id,
            name: row.name,
            keyHint: row.key_hint,
            scopeGroups: parseScope(row.scope_groups),
            enabled: Boolean(row.enabled),
            allowPtz: Boolean(row.allow_ptz),
            allowPlayback: Boolean(row.allow_playback),
            allowEventWrite: Boolean(row.allow_event_write),
            createdAt: row.created_at,
            createdBy: row.created_by,
            lastSeenAt: row.last_seen_at,
            /*
              มีกี่ตัวที่กำลังใช้ key ใบนี้อยู่ตอนนี้

              ต่างจาก lastSeenAt คนละเรื่อง: lastSeenAt บอกว่า "ใบนี้เคยถูกใช้ล่าสุดเมื่อไร"
              ซึ่งใบที่ถูกแจกไปสิบเครื่องกับใบที่ใช้เครื่องเดียวให้ค่าเท่ากันหมด ส่วนตัวเลขนี้
              บอกจำนวนเครื่องที่ยังทำงานอยู่จริง ซึ่งเป็นสิ่งที่ต้องรู้ก่อนจะเพิกถอนใบไหน

              เก็บในหน่วยความจำ จึงเริ่มนับใหม่ทุกครั้งที่รีสตาร์ต backend — ถูกต้องตาม
              ความหมาย เพราะตอนนั้นไม่มีใครเชื่อมต่ออยู่จริง
            */
            activeInstances: listActiveInstances ? listActiveInstances(row.id).length : null,
            // เปิดดูตัว key ซ้ำได้ไหม — ใบที่ออกก่อนมีระบบเก็บคีย์จะเป็น false ตลอดไป
            recoverable: Boolean(row.recoverable),
          })),
        );
      },
    );
  });

  /**
   * ออก key ใหม่
   *
   * ตัว key เต็มถูกส่งกลับตรงนี้ครั้งหนึ่ง และถูกเก็บไว้แบบเข้ารหัสด้วย จึงเปิดดูซ้ำได้
   * ภายหลังผ่าน GET /:id/key — ต่างจากเดิมที่พลาดคัดลอกครั้งเดียวแล้วต้องออกใบใหม่
   */
  router.post('/', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อ client' });

    const rawScope = req.body?.scopeGroups;
    let scopeGroups = null;
    if (Array.isArray(rawScope)) {
      scopeGroups = rawScope.map((g) => String(g)).filter(Boolean);
      // array ว่างจากหน้าเว็บแปลว่า "ยังไม่ได้เลือกกลุ่ม" ซึ่งไม่ใช่ "ทุกกลุ่ม" —
      // ถ้าจะให้ทุกกลุ่มต้องไม่ส่ง field นี้มาเลย ให้เจตนาชัดกว่าเดาแทนผู้ใช้
      if (scopeGroups.length === 0) {
        return res.status(400).json({ error: 'เลือกอย่างน้อยหนึ่งกลุ่ม หรือไม่ต้องส่ง scopeGroups หากต้องการทุกกลุ่ม' });
      }
    }

    checkScopeWithinCaller(req, scopeGroups, (scopeErr) => {
      if (scopeErr) return res.status(scopeErr.status).json({ error: scopeErr.error });
      issueKey(req, res, name, scopeGroups);
    });
  });

  /** ออก key หลังผ่านการตรวจขอบเขตแล้ว */
  const issueKey = (req, res, name, scopeGroups) => {
    const key = generateKey();
    const id = `apic_${crypto.randomBytes(8).toString('hex')}`;
    // เก็บ 6 ตัวท้ายไว้ให้ผู้ดูแลจับคู่ key ในมือกับแถวในตารางได้ โดยที่ 6 ตัวท้าย
    // เดาย้อนกลับไม่ได้
    const hint = `${key.slice(0, 9)}…${key.slice(-6)}`;

    /*
      เก็บตัว key ที่เข้ารหัสไว้ด้วย เพื่อให้เปิดดูซ้ำได้ภายหลัง

      key_hash ยังเป็นตัวเดียวที่ใช้ตรวจตอนยืนยันตัวตน ไม่เปลี่ยน — ช่องนี้เป็นของแยกที่มี
      ไว้ให้ "คน" เท่านั้น กุญแจถอดรหัสอยู่ในไฟล์นอกฐานข้อมูล (ดู key-vault.js) ฉะนั้น
      ไฟล์ vms.db ที่หลุดออกไปยังถอด key ไม่ได้ ต้องได้ไฟล์กุญแจไปด้วยอีกใบ

      ที่ต้องมีเพราะทางเลือกเดิมคือ "คัดลอกให้ทันในครั้งเดียว ไม่งั้นออกใบใหม่" ซึ่งแปลว่า
      พลาดทีเดียวต้องไล่แก้ config ของทุกเครื่องที่ใช้ใบเก่า — งานที่เสี่ยงกว่าความเสี่ยง
      ที่การเก็บแต่ hash ป้องกันไว้

      seal() คืน null เมื่ออ่านหรือสร้างไฟล์กุญแจไม่ได้ ซึ่งไม่ควรทำให้การออก key ล้ม:
      ใบนั้นใช้งานได้ตามปกติ แค่เปิดดูซ้ำไม่ได้ และหน้าเว็บจะบอกตรง ๆ ว่าใบไหนเปิดดูได้
    */
    let sealed = null;
    try {
      sealed = seal(key);
    } catch (vaultErr) {
      console.warn(`[Gateway Admin] เก็บ key แบบเปิดดูซ้ำได้ไม่สำเร็จ: ${vaultErr.message}`);
    }

    db.run(
      `INSERT INTO api_clients (id, name, key_hash, key_hint, key_cipher, scope_groups, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        name,
        hashKey(key),
        hint,
        sealed,
        scopeGroups ? JSON.stringify(scopeGroups) : null,
        req.user?.username || null,
        nowIso(),
      ],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        invalidateCache();
        logAction?.(req, 'API_KEY_CREATE', `ออก API key "${name}" (${hint})`);
        res.status(201).json({
          id,
          name,
          key,
          keyHint: hint,
          scopeGroups,
          recoverable: Boolean(sealed),
          warning: sealed
            ? 'เก็บ key นี้ไว้ให้ดี — เปิดดูซ้ำได้จากหน้านี้ แต่ไม่ควรพึ่งการเปิดดูเป็นวิธีปกติ'
            : 'เก็บ key นี้ไว้ทันที — ระบบเปิดดูซ้ำให้ไม่ได้',
        });
      },
    );
  };

  /**
   * เปิดดูตัว key ซ้ำ
   *
   * แยกเป็นเส้นของตัวเองและไม่เคยติดไปกับรายการ key ทั้งหน้า — ตัว key ต้องออกจากระบบ
   * เฉพาะตอนที่มีคนขอดูมันจริง ๆ เท่านั้น ไม่ใช่ทุกครั้งที่เปิดหน้าจอ
   *
   * บันทึก log ทุกครั้งที่มีคนเปิดดู เพราะนี่คือการหยิบความลับออกมา ต่างจากการอ่านรายการ
   * เฉย ๆ และเป็นสิ่งเดียวที่ทำให้ตอบได้ภายหลังว่าใครเคยเห็น key ใบไหน
   *
   * ใบที่ออกก่อนมีระบบนี้ไม่มี key_cipher จึงเปิดดูไม่ได้ตลอดไป — ตอบ 404 พร้อมเหตุผล
   * ไม่ใช่ 500 เพราะไม่ใช่ความผิดพลาด
   */
  router.get('/:id/key', (req, res) => {
    loadManageableKey(req, res, (row) => {
      const key = unseal(row.key_cipher);
      if (!key) {
        return res.status(404).json({
          error: 'key ใบนี้เปิดดูซ้ำไม่ได้ — ออกก่อนระบบเก็บคีย์ หรือไฟล์กุญแจไม่ตรง',
          recoverable: false,
        });
      }

      logAction?.(req, 'API_KEY_REVEAL', `เปิดดู API key "${row.name}" (${row.key_hint})`);
      res.json({ id: row.id, name: row.name, keyHint: row.key_hint, key });
    }, { checkPrivileges: true });
  });

  /**
   * ใครกำลังใช้ key ใบนี้อยู่บ้าง
   *
   * แยกเป็นอีกเส้นเพราะรายการเต็มมีที่อยู่ IP ของแต่ละเครื่องอยู่ด้วย ซึ่งไม่ควรติดไป
   * กับรายการ key ทั้งหน้าโดยที่ไม่มีใครขอ — หน้าแรกได้แค่จำนวน
   *
   * ตอบจากหน่วยความจำล้วน ไม่แตะฐานข้อมูล
   */
  router.get('/:id/instances', (req, res) => {
    if (!listActiveInstances) {
      return res.json({ id: req.params.id, instances: [], available: false });
    }

    const instances = listActiveInstances(req.params.id).map((entry) => ({
      instanceId: entry.instanceId,
      label: entry.label,
      address: entry.address,
      userAgent: entry.userAgent,
      firstSeenAt: new Date(entry.firstSeen).toISOString(),
      lastSeenAt: new Date(entry.lastSeen).toISOString(),
    }));

    res.json({ id: req.params.id, instances, available: true });
  });

  /**
   * เปิด/ปิดใช้งาน key โดยไม่ลบทิ้ง (ใช้ตอนสงสัยว่ารั่วแต่ยังไม่อยากตัดถาวร)
   * และเปิด/ปิดสิทธิ์ควบคุม PTZ
   *
   * แก้เฉพาะ field ที่ส่งมา — หน้าเว็บที่ติ๊กแค่ PTZ ต้องไม่ไปปิดใช้งาน key ทั้งใบ
   * เพราะ body ไม่มี enabled ติดมา
   */
  router.patch('/:id', (req, res) => {
    const denied = flagsCallerCannotGrant(req, req.body);
    if (denied.length) return res.status(403).json({ error: `ให้สิทธิ์ที่ตัวเองไม่มีไม่ได้: ${denied.join(', ')}` });
    // เปิด key เดิมต้องตรวจสิทธิ์ที่ยังติดกับ key ด้วย ไม่ใช่ตรวจแค่ flag ที่ส่งมา
    loadManageableKey(req, res, () => applyPatch(req, res), {
      checkPrivileges: Boolean(req.body?.enabled),
      effectiveFlags: (row) => ({
        allowPtz: req.body && 'allowPtz' in req.body ? req.body.allowPtz : Boolean(row.allow_ptz),
        allowPlayback: req.body && 'allowPlayback' in req.body ? req.body.allowPlayback : Boolean(row.allow_playback),
        allowEventWrite: req.body && 'allowEventWrite' in req.body ? req.body.allowEventWrite : Boolean(row.allow_event_write),
      }),
    });
  });

  /** แก้ field ที่ส่งมาหลังผ่านการตรวจสิทธิ์และขอบเขตแล้ว */
  const applyPatch = (req, res) => {
    const sets = [];
    const params = [];
    const notes = [];
    if (req.body && 'enabled' in req.body) {
      const enabled = req.body.enabled ? 1 : 0;
      sets.push('enabled = ?');
      params.push(enabled);
      notes.push(`${enabled ? 'เปิด' : 'ปิด'}ใช้งาน`);
    }
    if (req.body && 'allowPtz' in req.body) {
      const allowPtz = req.body.allowPtz ? 1 : 0;
      sets.push('allow_ptz = ?');
      params.push(allowPtz);
      notes.push(`${allowPtz ? 'อนุญาต' : 'ห้าม'}ควบคุม PTZ`);
    }
    if (req.body && 'allowPlayback' in req.body) {
      const allowPlayback = req.body.allowPlayback ? 1 : 0;
      sets.push('allow_playback = ?');
      params.push(allowPlayback);
      notes.push(`${allowPlayback ? 'อนุญาต' : 'ห้าม'}ดูภาพย้อนหลัง`);
    }
    if (req.body && 'allowEventWrite' in req.body) {
      const allowEventWrite = req.body.allowEventWrite ? 1 : 0;
      sets.push('allow_event_write = ?');
      params.push(allowEventWrite);
      notes.push(`${allowEventWrite ? 'อนุญาต' : 'ห้าม'}ส่ง event ของ AI`);
    }
    if (!sets.length) return res.status(400).json({ error: 'ไม่มีอะไรให้แก้ — ส่ง enabled, allowPtz, allowPlayback หรือ allowEventWrite' });

    db.run(`UPDATE api_clients SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) return res.status(404).json({ error: 'ไม่พบ key นี้' });
      invalidateCache();
      logAction?.(req, 'API_KEY_UPDATE', `${notes.join(', ')} API key ${req.params.id}`);
      res.json({ success: true });
    });
  };

  router.delete('/:id', (req, res) => {
    loadManageableKey(req, res, () => {
      db.run('DELETE FROM api_clients WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (!this.changes) return res.status(404).json({ error: 'ไม่พบ key นี้' });
        invalidateCache();
        logAction?.(req, 'API_KEY_DELETE', `เพิกถอน API key ${req.params.id}`);
        res.json({ success: true });
      });
    });
  });

  return router;
}

function parseScope(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return [];
  }
}

module.exports = { createGatewayAdminRouter };
