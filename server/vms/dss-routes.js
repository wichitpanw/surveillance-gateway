/**
 * ถาม/นำเข้า/ทบทวนกล้องจาก Dahua DSS Pro — ต่อจาก vms/routes.js (kind = 'dss') แบบเดียวกับ edge-source
 *
 * กล้องจาก DSS: type 'dss_relay', brand 'dss', source_ref = channelId ของ DSS (เช่น 1000008$1$0$0)
 * rtsp / rtsp_sub = ตัวกลาง RTSP ในเครื่อง (dss-rtsp-relay.js) ที่ขอ URL ใหม่จาก DSS ทุกครั้งที่ต่อ — ไม่มี token/รหัสใน DB
 * ไม่มีพิกัด (NULL) — ไปปักที่หน้า Map Pins
 *
 * login ผิด = หยุดทันที ไม่ลองซ้ำ (DSS ล็อกบัญชี) · ยิงครั้งเดียวต่อการกดหนึ่งครั้งเหมือน Digifort
 */
const { DssClient, DssAuthError, DssUnavailable } = require('./dss');
const { DSS_TYPE } = require('./dss-sessions');
const { seal, unseal } = require('../gateway/key-vault');
const { nowIso } = require('../shared/time');
const { DSS_RELAY_PORT } = require('../shared/instance');

const sourceIdFor = (host, port) => `vms_dss_${String(host).replace(/[^\w]/g, '_')}_${port}`;
const relayUrl = (cameraId, stream) => `rtsp://127.0.0.1:${DSS_RELAY_PORT}/dss/${encodeURIComponent(cameraId)}/${stream}`;

/** ช่องของ DSS → แถวที่หน้าจอนำเข้าใช้ (รูปเดียวกับของ Digifort) */
const toCamera = (c) => ({
  ref: c.channelId,
  name: c.channelName || c.deviceName || c.channelId,
  description: c.deviceName || '',
  model: c.deviceType || '',
  groupName: c.orgName || '',
  ip: c.deviceIp || '',
  active: true,
  working: String(c.status) === '1',
  fps: 0,
});

function sendDssError(res, err) {
  if (err instanceof DssAuthError) return res.status(401).json({ error: err.message });
  if (err instanceof DssUnavailable) return res.status(502).json({ error: err.message });
  console.error('[DSS]', err.message);
  return res.status(500).json({ error: err.message || 'DSS request failed' });
}

/**
 * @param {{ db, saveLog, resyncStreamCore, sessions }} deps  sessions = createDssSessions()
 */
function createDssRoutes({ db, saveLog, resyncStreamCore, sessions }) {
  const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => (e ? no(e) : ok(r || []))));
  const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function cb(e) { return e ? no(e) : ok(this); }));

  const clientFrom = ({ host, port, user, pass }) => new DssClient({ host, port: Number(port) || 443, user, pass });

  /** ถามรายชื่อกล้องครั้งเดียวแล้ว logout */
  async function listCameras(opts) {
    const client = clientFrom(opts);
    try {
      return (await client.listAllChannels()).map(toCamera);
    } finally {
      client.close();
    }
  }

  async function probe(req, res) {
    const { host, port, user, pass } = req.body || {};
    if (!host || !user) return res.status(400).json({ error: 'host และ user จำเป็น' });
    try {
      const cameras = await listCameras({ host, port, user, pass });
      return res.json({ cameras, serverInfo: { edition: 'Dahua DSS Pro', version: '', serverType: 'dss' } });
    } catch (err) {
      return sendDssError(res, err);
    }
  }

  async function importCameras(req, res) {
    const { host, user, pass, group, refs, label } = req.body || {};
    const port = String(Number(req.body?.port) || 443);
    if (!host || !user) return res.status(400).json({ error: 'host และ user จำเป็น' });
    if (!Array.isArray(refs) || refs.length === 0) return res.status(400).json({ error: 'เลือกอย่างน้อย 1 กล้อง' });
    let area;
    try { area = require('../shared/regions').validateRequiredRegion(req.body.province_code, req.body.district_code); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    const sourceId = sourceIdFor(host, port);
    try {
      // ยืนยันรหัสและรายชื่อก่อนเขียนอะไรลง DB
      const available = await listCameras({ host, port, user, pass });
      const byRef = new Map(available.map((c) => [c.ref, c]));
      const unknown = refs.filter((r) => !byRef.has(r));
      if (unknown.length) return res.status(400).json({ error: `ไม่พบช่องนี้ใน DSS: ${unknown.slice(0, 3).join(', ')}` });

      await run(
        `INSERT INTO camera_sources (id, kind, label, host, port, rtsp_port, username, password_sealed, created_at, last_sync_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, username=excluded.username,
           password_sealed=excluded.password_sealed, last_sync_at=excluded.last_sync_at`,
        [sourceId, 'dss', label || `DSS ${host}`, host, port, null, user, seal(pass), nowIso(), nowIso()],
      );
      sessions?.invalidate(sourceId);

      const baseTs = Date.now();
      let added = 0;
      let skipped = 0;
      for (const [i, ref] of refs.entries()) {
        const camId = `cam_dss_${baseTs}_${i}`;
        // INSERT OR IGNORE คู่กับ unique index (source_id, source_ref) = import ซ้ำไม่สร้างแถวซ้ำ · ไม่มีพิกัด
        const result = await run(
          `INSERT OR IGNORE INTO cameras
             (id, name, group_name, brand, type, rtsp, rtsp_sub, ip, onvifPort, rtspPort,
              onvifUser, onvifPass, lat, lng, stream_type, source_id, source_ref, province_code, district_code)
           VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,'main',?,?,?,?)`,
          [camId, byRef.get(ref).name, group || byRef.get(ref).groupName || 'Default', 'dss', DSS_TYPE,
            relayUrl(camId, 'main'), relayUrl(camId, 'sub'), host, sourceId, ref, area.province, area.district],
        );
        if (result.changes > 0) added += 1; else skipped += 1;
      }
      saveLog(req.user?.username || 'unknown', 'Add Camera', `เพิ่มกล้องจาก DSS ${host} จำนวน ${added} ตัว (ข้ามตัวที่มีอยู่แล้ว ${skipped} ตัว) 📹`);
      resyncStreamCore();
      sessions?.pollStatus().catch(() => {});
      return res.json({ success: true, added, skipped, sourceId });
    } catch (err) {
      return sendDssError(res, err);
    }
  }

  /** ทบทวนกับ DSS — ไม่ลบกล้องเอง (DSS ที่ตอบไม่ครบชั่วคราวต้องไม่ลบกล้องทั้งชุด) · รหัสใหม่จากฟอร์มมาก่อน */
  async function resync(req, res, source) {
    const pass = req.body?.pass || unseal(source.password_sealed);
    if (!pass) return res.status(400).json({ error: 'ถอดรหัสผ่านที่เก็บไว้ไม่ได้ — กรอกรหัสใหม่อีกครั้ง' });
    try {
      const available = await listCameras({ host: source.host, port: source.port, user: source.username, pass });
      const byRef = new Map(available.map((c) => [c.ref, c]));
      const rows = await all('SELECT id, name, source_ref, rtsp, rtsp_sub FROM cameras WHERE source_id = ?', [source.id]);
      const imported = new Set(rows.map((r) => r.source_ref));
      const missing = rows.filter((r) => !byRef.has(r.source_ref)).map((r) => ({ id: r.id, name: r.name }));
      const newCameras = available.filter((c) => !imported.has(c.ref));

      // URL ตัวกลางผูกกับ id ของกล้องและพอร์ตของเครื่อง — ซ่อมเผื่อย้ายพอร์ต/กู้จาก backup ของเครื่องอื่น
      let rewritten = 0;
      for (const row of rows) {
        const main = relayUrl(row.id, 'main');
        const sub = relayUrl(row.id, 'sub');
        if (row.rtsp === main && row.rtsp_sub === sub) continue;
        rewritten += (await run('UPDATE cameras SET rtsp = ?, rtsp_sub = ? WHERE id = ?', [main, sub, row.id])).changes;
      }
      if (req.body?.pass) {
        await run('UPDATE camera_sources SET password_sealed = ? WHERE id = ?', [seal(pass), source.id]);
        sessions?.invalidate(source.id);
      }
      await run('UPDATE camera_sources SET last_sync_at = ? WHERE id = ?', [nowIso(), source.id]);
      saveLog(req.user?.username || 'unknown', 'VMS Re-sync',
        `ทบทวน DSS ${source.host}: ในระบบ ${rows.length} ตัว, หายจาก DSS ${missing.length} ตัว, ยังไม่ได้ import ${newCameras.length} ตัว`);
      if (rewritten) resyncStreamCore();
      return res.json({ vmsTotal: available.length, imported: rows.length, missing, newCameras, rewritten });
    } catch (err) {
      return sendDssError(res, err);
    }
  }

  return { probe, importCameras, resync };
}

module.exports = { createDssRoutes, relayUrl, toCamera };
