/**
 * เพิ่มกล้องจาก VMS เข้าระบบ — รอบนี้รองรับ Digifort อย่างเดียว
 *
 * ต่างจากการแอดกล้องแบบ ONVIF ตรงที่เราไม่มีทางถึงตัวหัวกล้องเลย Digifort ไม่บอก IP
 * และไม่บอกรหัสของกล้อง (/Interface/Configuration/* ตอบ 404 ทั้งหมด) สิ่งเดียวที่ได้คือ
 * เส้น relay ของ Digifort เอง กล้องที่เพิ่มด้วยเส้นทางนี้จึงมี "ต้นทาง" เป็นเครื่อง VMS
 * ไม่ใช่ตัวกล้อง และผูกกับแถวใน camera_sources ตัวหนึ่งเสมอ
 *
 * ชื่อกล้องฝั่ง Digifort (source_ref) คือกุญแจเดียวที่ API ของ Digifort ใช้อ้างถึงกล้อง
 * ทั้งใน GetStatus และใน URL ของเส้น relay ผลตามมาที่ต้องยอมรับ: ถ้ามีคนเปลี่ยนชื่อกล้อง
 * ใน Digifort เราแยกไม่ออกระหว่าง "เปลี่ยนชื่อ" กับ "ลบตัวเก่าแล้วเพิ่มตัวใหม่" — Re-sync
 * จึงรายงานว่าตัวเก่าหายและมีตัวใหม่ให้ import แทนที่จะเดาแล้วแก้ชื่อให้เอง
 */
const express = require('express');
const {
  DigifortClient,
  DigifortAuthError,
  DigifortUnavailable,
  relayRtspUrl,
} = require('./digifort');
const { seal, unseal } = require('../gateway/key-vault');
const { nowIso } = require('../shared/time');

/** ชนิดของแถวกล้องที่มาจาก Digifort — ใช้เป็นสวิตช์ปิดเส้นทาง ONVIF ทั้งหมดใน server.js */
const DIGIFORT_TYPE = 'digifort_relay';

/** id ของ source ตายตัวตามที่อยู่ ไม่สุ่ม — แอดเครื่องเดิมซ้ำต้องได้แถวเดิม ไม่ใช่แถวที่สอง */
const sourceIdFor = (kind, host, port) =>
  `vms_${kind}_${String(host).replace(/[^\w]/g, '_')}_${port}`;

/** รวมข้อมูลสามคำสั่งของ Digifort ให้เป็นรายการเดียวที่หน้าจอใช้ได้ทันที */
async function listVmsCameras(client) {
  const [cameras, status, groups] = await Promise.all([
    client.getCameras(),
    client.getStatus(),
    client.getGroups(),
  ]);
  const statusByName = new Map(status.map((s) => [s.name, s]));
  const groupById = new Map(groups.map((g) => [g.id, g.name]));
  return cameras.map((c) => {
    const st = statusByName.get(c.name);
    return {
      ref: c.name,
      name: c.name,
      description: c.description,
      model: c.model,
      groupName: groupById.get(c.groupId) || '',
      active: st ? st.active : false,
      working: st ? st.working : false,
      fps: st ? st.fps : 0,
    };
  });
}

/** แปลง error ของ client เป็น HTTP ที่บอกได้ว่าลองใหม่ได้ไหม */
const sendVmsError = (res, err) => {
  if (err instanceof DigifortAuthError) return res.status(401).json({ error: err.message });
  if (err instanceof DigifortUnavailable) return res.status(502).json({ error: err.message });
  console.error('[VMS]', err.message);
  return res.status(500).json({ error: err.message || 'VMS request failed' });
};

/**
 * @param {object} deps
 * @param {object} deps.db                   sqlite3 connection ของ server.js
 * @param {function} deps.requirePerm        ตัวสร้าง middleware ตรวจสิทธิ์ของ server.js
 * @param {function} deps.saveLog            บันทึก log การกระทำ
 * @param {function} deps.resyncStreamCore   สั่ง sync กล้องเข้า streaming core
 */
function createVmsRouter({ db, requirePerm, saveLog, resyncStreamCore, edgeSources, dssRoutes = null }) {
  const router = express.Router();
  router.use(requirePerm('device.manage'));

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
  const get = (sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); }));

  /** สร้าง client จาก body ของคำขอ — ใช้ทั้งตอน probe และตอน import */
  const clientFromBody = (body) =>
    new DigifortClient({
      host: body.host,
      port: Number(body.port) || 8601,
      user: body.user,
      pass: body.pass,
    });

  /**
   * ถามรายชื่อกล้องจาก VMS
   *
   * ยิงครั้งเดียวเสมอ ไม่มี retry แม้แต่ชั้นเดียว — คำขอนี้มีรหัสผ่านที่คนเพิ่งพิมพ์มา
   * ซึ่งเป็นกรณีที่รหัสผิดบ่อยที่สุด และ Digifort บล็อกบัญชีที่ใส่ผิดครบสามครั้ง
   */
  router.post('/probe', async (req, res) => {
    const { kind = 'digifort', host } = req.body || {};
    if (kind === 'edge' && edgeSources) return edgeSources.probe(req, res);
    if (kind === 'dss' && dssRoutes) return dssRoutes.probe(req, res);
    if (kind !== 'digifort') return res.status(400).json({ error: `ยังไม่รองรับ VMS ชนิด "${kind}"` });
    if (!host) return res.status(400).json({ error: 'host required' });

    try {
      const client = clientFromBody(req.body);
      const [cameras, serverInfo] = await Promise.all([
        listVmsCameras(client),
        client.getServerInfo().catch(() => ({})),
      ]);
      res.json({
        cameras,
        serverInfo: {
          edition: serverInfo.Edition || '',
          version: serverInfo.Version || '',
          serverType: serverInfo.ServerType || '',
        },
      });
    } catch (err) {
      sendVmsError(res, err);
    }
  });

  /** เครื่อง VMS ที่เคย import ไว้ — ไม่คืนรหัสผ่านออกไปไม่ว่ารูปแบบไหน */
  router.get('/sources', async (req, res) => {
    try {
      const rows = await all(
        `SELECT s.id, s.kind, s.label, s.host, s.port, s.rtsp_port, s.username, s.created_at, s.last_sync_at, s.status, s.status_at, s.status_error, s.remote_node, s.remote_build,
                (SELECT COUNT(*) FROM cameras c WHERE c.source_id = s.id) AS cameraCount
         FROM camera_sources s ORDER BY s.created_at`,
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * เพิ่มกล้องที่เลือกเข้าระบบ
   *
   * ค่าที่ตั้งตายตัวสามอย่าง แต่ละอย่างมีเหตุผลที่ห้ามเปลี่ยนโดยไม่อ่านก่อน:
   *   rtsp_sub = NULL      Digifort ไม่มี substream (ทดสอบแล้ว &Stream=1 คืนเส้นเดิม) การใส่
   *                        ค่าเท่ากับ main แบบที่ bulk-add ของ ONVIF ทำ จะทำให้ go2rtc สร้าง
   *                        path _sub อีกเส้นแล้ว transcode ภาพเดียวกันสองรอบต่อกล้องหนึ่งตัว
   *   stream_type = 'main' เพราะไม่มี sub ให้เลือก
   *   brand = 'digifort'   กันไม่ให้ตรรกะเฉพาะยี่ห้อ (เช่น ISAPI ของ tiandy) ไปจับกล้องกลุ่มนี้
   */
  router.post('/import', async (req, res) => {
    const {
      kind = 'digifort', host, port, rtspPort, user, pass,
      group, refs, lat, lng, label,
    } = req.body || {};
    if (kind === 'edge' && edgeSources) return edgeSources.importCameras(req, res);
    if (kind === 'dss' && dssRoutes) return dssRoutes.importCameras(req, res);
    if (kind !== 'digifort') return res.status(400).json({ error: `ยังไม่รองรับ VMS ชนิด "${kind}"` });
    if (!host || !user) return res.status(400).json({ error: 'host และ user จำเป็น' });
    if (!Array.isArray(refs) || refs.length === 0) return res.status(400).json({ error: 'เลือกกล้องอย่างน้อย 1 ตัว' });
    let area;
    try { area = require('../shared/regions').validateRequiredRegion(req.body.province_code, req.body.district_code); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    const apiPort = String(Number(port) || 8601);
    const mediaPort = String(Number(rtspPort) || 554);
    const sourceId = sourceIdFor(kind, host, apiPort);
    /*
      ไม่มีพิกัดต้องเป็น NULL ไม่ใช่ค่าที่เดาให้

      กล้องจาก VMS เข้ามาทีละหลายสิบตัวและอยู่คนละที่กัน ฟอร์มมีช่องพิกัดชุดเดียวจึงไม่มี
      ค่าที่ถูกต้องจะใส่ให้ตั้งแต่แรก การปล่อยให้ค่า default ของฟอร์มไหลลงมาแปลว่ากล้องทุกตัว
      ไปกองอยู่จุดเดียวกันบนแผนที่โดยที่ไม่มีใครรู้ว่าอันไหนคือหมุดจริง — ปักทีหลังในหน้าปักหมุด
    */
    const latValue = Number.isFinite(Number(lat)) && lat !== null && lat !== '' ? Number(lat) : null;
    const lngValue = Number.isFinite(Number(lng)) && lng !== null && lng !== '' ? Number(lng) : null;

    try {
      // ยืนยันว่ารหัสใช้ได้จริงก่อนเขียนอะไรลงฐานข้อมูล — ไม่งั้นจะได้กล้องเป็นร้อยแถวที่ดูไม่ได้
      const client = clientFromBody({ host, port: apiPort, user, pass });
      const available = await listVmsCameras(client);
      const byRef = new Map(available.map((c) => [c.ref, c]));
      const unknown = refs.filter((r) => !byRef.has(r));
      if (unknown.length) {
        return res.status(400).json({ error: `ไม่พบกล้องชื่อนี้ใน Digifort: ${unknown.slice(0, 3).join(', ')}` });
      }

      await run(
        `INSERT INTO camera_sources (id, kind, label, host, port, rtsp_port, username, password_sealed, created_at, last_sync_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, rtsp_port=excluded.rtsp_port,
           username=excluded.username, password_sealed=excluded.password_sealed, last_sync_at=excluded.last_sync_at`,
        [sourceId, kind, label || `Digifort ${host}`, host, apiPort, mediaPort, user, seal(pass), nowIso(), nowIso()],
      );

      const baseTs = Date.now();
      let added = 0;
      let skipped = 0;
      for (const [i, ref] of refs.entries()) {
        const camId = `cam_vms_${baseTs}_${i}`;
        const rtsp = relayRtspUrl({ host, rtspPort: mediaPort, user, pass, cameraName: ref });
        // INSERT OR IGNORE คู่กับ unique index (source_id, source_ref) = import ซ้ำไม่สร้างแถวซ้ำ
        const result = await run(
          `INSERT OR IGNORE INTO cameras
             (id, name, group_name, brand, type, rtsp, rtsp_sub, ip, onvifPort, rtspPort,
              onvifUser, onvifPass, lat, lng, stream_type, source_id, source_ref, province_code, district_code)
           VALUES (?,?,?,?,?,?,NULL,?,NULL,?,NULL,NULL,?,?,'main',?,?,?,?)`,
          [camId, byRef.get(ref).name, group || 'Default', 'digifort', DIGIFORT_TYPE,
            rtsp, host, mediaPort, latValue, lngValue, sourceId, ref, area.province, area.district],
        );
        if (result.changes > 0) added += 1; else skipped += 1;
      }

      saveLog(req.user?.username || 'unknown', 'Add Camera',
        `เพิ่มกล้องจาก Digifort ${host} จำนวน ${added} ตัว (ข้ามตัวที่มีอยู่แล้ว ${skipped} ตัว) 📹`);
      resyncStreamCore();
      res.json({ success: true, added, skipped, sourceId });
    } catch (err) {
      sendVmsError(res, err);
    }
  });

  /**
   * ทบทวนความต่างระหว่างระบบเรากับ Digifort แล้วเขียน URL ใหม่ให้ทุกแถวของ source นี้
   *
   * ไม่ลบกล้องเองแม้แต่ตัวเดียว: Digifort ที่ตอบไม่ครบชั่วคราวจะกลายเป็นการลบกล้องทิ้ง
   * ทั้งชุดพร้อมหมุดแผนที่และสิทธิ์ที่ผูกไว้ ซึ่งกู้คืนด้วยการ import ใหม่ไม่ได้
   *
   * การเขียน URL ใหม่ทุกรอบคือทางเดียวที่การเปลี่ยนรหัสผ่านฝั่ง Digifort จะมีผล เพราะรหัส
   * ฝังอยู่ในคอลัมน์ rtsp ของทุกแถว (เหมือนกล้อง ONVIF ทุกตัวในระบบนี้)
   */
  router.post('/sources/:id/resync', async (req, res) => {
    try {
      const source = await get('SELECT * FROM camera_sources WHERE id = ?', [req.params.id]);
      if (!source) return res.status(404).json({ error: 'ไม่พบต้นทาง VMS นี้' });
      if (source.kind === 'edge' && edgeSources) return edgeSources.resync(req, res, source);
      if (source.kind === 'dss' && dssRoutes) return dssRoutes.resync(req, res, source);

      // รหัสใหม่จากฟอร์มมาก่อน ถ้าไม่ส่งมาก็ใช้ของที่เก็บไว้
      const pass = req.body?.pass || unseal(source.password_sealed);
      if (!pass) return res.status(400).json({ error: 'ถอดรหัสผ่านที่เก็บไว้ไม่ได้ — กรอกรหัสใหม่อีกครั้ง' });

      const client = new DigifortClient({
        host: source.host, port: Number(source.port), user: source.username, pass,
      });
      const available = await listVmsCameras(client);
      const byRef = new Map(available.map((c) => [c.ref, c]));

      const rows = await all('SELECT id, name, source_ref FROM cameras WHERE source_id = ?', [req.params.id]);
      const importedRefs = new Set(rows.map((r) => r.source_ref));

      const missing = rows.filter((r) => !byRef.has(r.source_ref)).map((r) => ({ id: r.id, name: r.name }));
      const newCameras = available.filter((c) => !importedRefs.has(c.ref));

      let rewritten = 0;
      for (const row of rows) {
        if (!byRef.has(row.source_ref)) continue;
        const rtsp = relayRtspUrl({
          host: source.host, rtspPort: source.rtsp_port, user: source.username, pass, cameraName: row.source_ref,
        });
        const result = await run('UPDATE cameras SET rtsp = ? WHERE id = ? AND rtsp IS NOT ?', [rtsp, row.id, rtsp]);
        rewritten += result.changes;
      }

      if (req.body?.pass) {
        await run('UPDATE camera_sources SET password_sealed = ? WHERE id = ?', [seal(pass), req.params.id]);
      }
      await run('UPDATE camera_sources SET last_sync_at = ? WHERE id = ?', [nowIso(), req.params.id]);

      saveLog(req.user?.username || 'unknown', 'VMS Re-sync',
        `ทบทวน ${source.host}: ในระบบ ${rows.length} ตัว, หายจาก VMS ${missing.length} ตัว, ยังไม่ได้ import ${newCameras.length} ตัว`);
      if (rewritten) resyncStreamCore();

      res.json({ vmsTotal: available.length, imported: rows.length, missing, newCameras, rewritten });
    } catch (err) {
      sendVmsError(res, err);
    }
  });

  return router;
}

module.exports = { createVmsRouter, DIGIFORT_TYPE };
