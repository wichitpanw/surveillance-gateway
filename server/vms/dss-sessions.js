/**
 * session ของ DSS ต่อแหล่ง (แถว camera_sources kind = 'dss') + ตัวเฝ้าสถานะกล้อง
 *
 * login ครั้งเดียวต่อแหล่งแล้วต่ออายุเอง (dss.js) · รหัสผิดครั้งเดียว = client ค้างสถานะ authFailed ไม่ลองซ้ำ
 * จนกว่าคนกรอกรหัสใหม่ (resync พร้อม pass → invalidate) — กันบัญชี DSS ถูกล็อกแล้วกล้องทั้งชุดดับ
 *
 * สถานะกล้อง: DSS รู้ว่ากล้องต่อได้ไหม (ฟิลด์ status ของ channel) ส่วน TCP ของเราไปถึงแค่ตัวกลาง RTSP ในเครื่อง
 * (ตอบเสมอ) จึงถาม DSS ทุก 60 วิ แล้วเขียน reachable ลง cameraState เอง — แบบเดียวกับกล้องจาก edge
 */
const { DssClient, DssAuthError } = require('./dss');
const { unseal } = require('../gateway/key-vault');
const { nowIso } = require('../shared/time');

const DSS_TYPE = 'dss_relay';
const STATUS_EVERY_MS = 60_000;

function createDssSessions({ db, cameraState }) {
  const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => (e ? no(e) : ok(r || []))));
  const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function cb(e) { return e ? no(e) : ok(this); }));

  const clients = new Map(); // sourceId → { client, sealed }

  /** client ของแหล่ง — สร้างใหม่เมื่อรหัสที่เก็บไว้เปลี่ยน (ล้างสถานะ authFailed ไปด้วย) */
  async function clientFor(sourceId) {
    const source = await get("SELECT id, host, port, username, password_sealed FROM camera_sources WHERE id = ? AND kind = 'dss'", [sourceId]);
    if (!source) return null;
    const hit = clients.get(sourceId);
    if (hit && hit.sealed === source.password_sealed) return hit.client;
    hit?.client.close();
    const client = new DssClient({ host: source.host, port: Number(source.port) || 443, user: source.username, pass: unseal(source.password_sealed) || '' });
    clients.set(sourceId, { client, sealed: source.password_sealed });
    return client;
  }

  /** client + channelId ของกล้องหนึ่งตัว (id ของเราในตาราง cameras) */
  async function forCamera(cameraId) {
    const cam = await get('SELECT id, type, source_id, source_ref FROM cameras WHERE id = ?', [cameraId]);
    if (!cam || cam.type !== DSS_TYPE) return null;
    const client = await clientFor(cam.source_id);
    return client ? { client, channelId: cam.source_ref, camera: cam } : null;
  }

  /** ทิ้ง client เดิม (เปลี่ยนรหัส / ลบแหล่ง) */
  function invalidate(sourceId) {
    clients.get(sourceId)?.client.close();
    clients.delete(sourceId);
  }

  const setSourceStatus = (id, status, error = null) => run(
    'UPDATE camera_sources SET status = ?, status_at = ?, status_error = ? WHERE id = ?', [status, nowIso(), error, id],
  ).catch(() => {});

  /** ถามสถานะช่องทั้งหมดของทุกแหล่งหนึ่งรอบ */
  async function pollStatus() {
    const sources = await all("SELECT id FROM camera_sources WHERE kind = 'dss'").catch(() => []);
    for (const { id } of sources) {
      const cams = await all('SELECT id, source_ref, enabled FROM cameras WHERE source_id = ? AND type = ?', [id, DSS_TYPE]).catch(() => []);
      if (!cams.length) continue;
      const markUnknown = () => { for (const c of cams) if (Number(c.enabled) !== 0) cameraState?.set(c.id, { reachable: null }); };
      let client;
      try {
        client = await clientFor(id);
        const channels = await client.channels(cams.map((c) => c.source_ref));
        const byRef = new Map(channels.map((c) => [c.channelId, c]));
        for (const c of cams) {
          if (Number(c.enabled) === 0) continue;
          const ch = byRef.get(c.source_ref);
          cameraState?.set(c.id, { reachable: ch ? String(ch.status) === '1' : false });
        }
        await setSourceStatus(id, 'ok');
      } catch (err) {
        markUnknown();
        await setSourceStatus(id, err instanceof DssAuthError ? 'auth_failed' : 'unreachable', String(err.message || err).slice(0, 300));
      }
    }
  }

  let timer = null;
  let running = false;
  function start() {
    if (timer) return;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await pollStatus(); } catch (err) { console.warn('[DSS] ถามสถานะไม่สำเร็จ:', err.message); } finally { running = false; }
    };
    setTimeout(tick, 5_000).unref?.();
    timer = setInterval(tick, STATUS_EVERY_MS);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    for (const { client } of clients.values()) client.close();
    clients.clear();
  }

  return { clientFor, forCamera, invalidate, pollStatus, start, stop, DSS_TYPE };
}

module.exports = { createDssSessions, DSS_TYPE };
