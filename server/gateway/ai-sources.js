/**
 * ตั้งค่าและรับผล AI ภายนอกที่ Edge — ไม่มี inference และไม่มีการเปิด RTSP วิเคราะห์ภาพ
 * driver device อ่าน AlarmInfo และภาพ Alarm ที่เก็บในอุปกรณ์; driver api รับผ่าน API key ที่มีสิทธิ์ส่ง event
 */
const { ROLE } = require('../shared/instance');
const { nowIso, toBangkokIso } = require('../shared/time');
const { redactUrls } = require('../shared/redact');
const { readPerimeter } = require('./analytics/tiandy-perimeter');
const { readEventImage } = require('./analytics/tiandy-event-image');
const { createUniviewReceiver } = require('./analytics/uniview-onvif');

function createAiSources(db, aiEvents, { role = ROLE, reader = readPerimeter, imageReader = readEventImage, univiewFactory = createUniviewReceiver } = {}) {
  const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => e ? reject(e) : resolve(rows || [])));
  const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function done(e) { e ? reject(e) : resolve(this); }));
  const states = new Map();
  const receivers = new Map();
  const deviceSupported = (brand) => ['tiandy', 'uniview'].includes(String(brand).toLowerCase());
  const seen = new Map();
  const running = new Set();
  const due = new Map();
  let timer = null;
  let stopped = false;

  async function ensureSchema() {
    await run('CREATE TABLE IF NOT EXISTS ai_event_sources (camera_id TEXT PRIMARY KEY, driver TEXT NOT NULL DEFAULT \'api\', enabled INTEGER NOT NULL DEFAULT 0, channel INTEGER NOT NULL DEFAULT 1, time_mode TEXT NOT NULL DEFAULT \'bangkok-wall\', updated_at TEXT)');
    await run('CREATE TABLE IF NOT EXISTS ai_image_pending (camera_id TEXT NOT NULL,event_id TEXT NOT NULL,event_json TEXT NOT NULL,next_retry INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(camera_id,event_id))');
  }

  /** หน้าเว็บเห็นเฉพาะข้อมูลตั้งค่าและสุขภาพของตัวรับ */
  async function list(scope = null) {
    const rows = await all('SELECT c.id, c.name, c.global_id, c.group_name, c.brand, c.enabled AS camera_enabled, s.driver, s.enabled, s.channel, s.time_mode FROM cameras c LEFT JOIN ai_event_sources s ON s.camera_id = c.id WHERE c.type != ? OR c.type IS NULL', ['edge_relay']);
    return rows.filter((r) => !scope || scope.has(r.id)).map((r) => {
      const status = states.get(r.id) || {};
      const enabled = Boolean(r.enabled);
      return { id: r.id, name: r.name, globalId: r.global_id, group: r.group_name || 'Default', brand: r.brand,
        cameraEnabled: Boolean(r.camera_enabled), driver: r.driver === 'tiandy' ? 'device' : r.driver || 'api', deviceSupported: deviceSupported(r.brand), enabled,
        channel: r.channel || 1, timeMode: String(r.brand).toLowerCase() === 'uniview' ? 'utc' : r.time_mode || 'bangkok-wall',
        status: !enabled ? 'disabled' : !r.camera_enabled ? 'camera_disabled' : r.driver === 'api' ? 'api' :
          status.status === 'connected' && Date.now() - Date.parse(status.lastSuccessAt) > 15000 ? 'disconnected' : status.status || 'waiting',
        lastSuccessAt: status.lastSuccessAt || null, lastEventAt: status.lastEventAt || null,
        error: status.error || null, retryAt: status.retryAt || null };
    });
  }

  /** บันทึกแหล่งรับหลักหนึ่งทางต่อกล้อง — credential ใช้ของกล้องเดิมและไม่รับจาก browser */
  async function save(id, input) {
    if (role !== 'edge') throw Object.assign(new Error('ตั้งแหล่งรับ AI ที่ Edge เท่านั้น'), { status: 403 });
    const [cam] = await all('SELECT id, brand, type, ip, onvifUser, onvifPass FROM cameras WHERE id = ?', [id]);
    if (!cam || cam.type === 'edge_relay') throw Object.assign(new Error('ไม่พบกล้องต้นทาง'), { status: 404 });
    const driver = input.driver === 'tiandy' ? 'device' : input.driver;
    const channel = Number(input.channel ?? 1);
    const timeMode = String(cam.brand).toLowerCase() === 'uniview' ? 'utc' : input.timeMode || 'bangkok-wall';
    if (!['api', 'device'].includes(driver) || typeof input.enabled !== 'boolean' ||
        !Number.isInteger(channel) || channel < 1 || channel > 1024 ||
        !['bangkok-wall', 'utc'].includes(timeMode)) throw Object.assign(new Error('ค่าแหล่งรับ AI ไม่ถูกต้อง'), { status: 400 });
    if (driver === 'device' && (!cam.ip || !cam.onvifUser || !cam.onvifPass || !deviceSupported(cam.brand))) {
      throw Object.assign(new Error('อุปกรณ์นี้ยังไม่รองรับการรับโดยตรง หรือข้อมูลเชื่อมต่อไม่ครบ'), { status: 400 });
    }
    if (driver === 'device' && String(cam.brand).toLowerCase() === 'uniview' && channel !== 1) throw Object.assign(new Error('UNV receiver ที่ตรวจจริงรองรับกล้องเดี่ยวช่อง 1'), { status: 400 });
    if (running.has(id)) throw Object.assign(new Error('ตัวรับกำลังอ่าน event กรุณาบันทึกอีกครั้ง'), { status: 409 });
    await run('INSERT INTO ai_event_sources (camera_id, driver, enabled, channel, time_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(camera_id) DO UPDATE SET driver=excluded.driver, enabled=excluded.enabled, channel=excluded.channel, time_mode=excluded.time_mode, updated_at=excluded.updated_at',
      [id, driver, input.enabled ? 1 : 0, channel, timeMode, nowIso()]);
    const receiver = receivers.get(id);
    if (receiver) { receivers.delete(id); await receiver.stop(); }
    states.delete(id); due.delete(id); seen.delete(id);
    return (await list(new Set([id])))[0];
  }

  /** ต่อกล้องไม่ซ้อนกัน; auth ผิดพัก 15 นาที และส่ง error ที่ตัด credential แล้ว */
  async function poll(cam) {
    running.add(cam.id);
    try {
      const connection = { host: cam.ip, port: Number(cam.onvifPort) || 80, user: cam.onvifUser, pass: cam.onvifPass };
      const events = await reader(connection,
        { cameraId: cam.global_id || cam.id, channel: cam.channel, timeMode: cam.time_mode });
      if (stopped) return;
      const cache = seen.get(cam.id) || new Set();
      for (const event of events) {
        if (cache.has(event.eventId)) continue;
        // คิวคงอยู่หลัง restart; เหตุที่เคยส่งแล้วไม่ค้น/ดาวน์โหลดภาพซ้ำ
        await run('INSERT OR IGNORE INTO ai_image_pending (camera_id,event_id,event_json,next_retry,attempts) SELECT ?,?,?,0,0 WHERE NOT EXISTS (SELECT 1 FROM ai_events WHERE camera_id=? AND event_id=?)',
          [cam.id, event.eventId, JSON.stringify(event), cam.id, event.eventId]);
        cache.add(event.eventId);
      }
      while (cache.size > 2048) cache.delete(cache.values().next().value);
      seen.set(cam.id, cache);
      const pending = await all("SELECT event_id,event_json,attempts FROM ai_image_pending WHERE camera_id=? AND next_retry<=? ORDER BY json_extract(event_json,'$.ts') DESC LIMIT 4", [cam.id, Date.now()]);
      const images = new Map();
      let imageError = null;
      for (const item of pending) {
        if (stopped) return;
        const event = JSON.parse(item.event_json);
        try {
          const imageKey = event.ts + ':' + event.attrs.channel;
          if (!images.has(imageKey)) images.set(imageKey, await imageReader(connection, event));
          const image = images.get(imageKey);
          if (stopped) return;
          if (!image) throw new Error('ยังไม่พบภาพ Alarm ที่ตรงเวลาเหตุ');
          await aiEvents.recordBatch([{ cameraId: cam.id, input: { ...event,
            attrs: { ...event.attrs, imageSource: 'device-alarm-storage', imageFile: image.file } }, snapshot: image.snapshot }]);
          await run('DELETE FROM ai_image_pending WHERE camera_id=? AND event_id=?', [cam.id, item.event_id]);
        } catch (err) {
          if (/\b(?:401|403)\b/.test(err.message)) throw err;
          imageError = redactUrls(err.message);
          const retry = Math.min(15 * 60_000, 5000 * (2 ** Math.min(item.attempts, 8)));
          await run('UPDATE ai_image_pending SET attempts=attempts+1,next_retry=? WHERE camera_id=? AND event_id=?', [Date.now() + retry, cam.id, item.event_id]);
        }
      }
      const [waiting] = await all('SELECT COUNT(*) AS count FROM ai_image_pending WHERE camera_id=?', [cam.id]);
      const prior = states.get(cam.id) || {};
      const newest = events.map((e) => e.ts).sort().at(-1);
      states.set(cam.id, { status: 'connected', lastSuccessAt: nowIso(),
        error: waiting.count ? ('รอภาพเหตุ ' + waiting.count + ' รายการ' + (imageError ? ': ' + imageError : '')) : null,
        lastEventAt: newest && (!prior.lastEventAt || newest > prior.lastEventAt) ? newest : prior.lastEventAt || null });
      due.set(cam.id, Date.now() + 3000);
    } catch (err) {
      const error = redactUrls(err.message);
      const auth = /\b(?:401|403)\b/.test(error);
      const retry = Date.now() + (auth ? 15 * 60_000 : 15000);
      states.set(cam.id, { ...states.get(cam.id), status: auth ? 'auth_error' : 'disconnected', error, retryAt: toBangkokIso(retry) });
      due.set(cam.id, retry);
    } finally { running.delete(cam.id); }
  }

  /** UNV เปิด metadata ค้างไว้และดึง snapshot ทันทีเมื่อรับเหตุใหม่ */
  async function connectUniview(cam) {
    running.add(cam.id);
    let receiver;
    const fail = (err) => {
      const error = redactUrls(err.message);
      const auth = /\b(?:401|403)\b/.test(error);
      const retry = Date.now() + (auth ? 15 * 60_000 : 15000);
      states.set(cam.id, { ...states.get(cam.id), status: auth ? 'auth_error' : 'connected', error,
        retryAt: auth ? toBangkokIso(retry) : null });
      if (auth) {
        due.set(cam.id, retry);
        if (receivers.get(cam.id) === receiver) { receivers.delete(cam.id); void receiver.stop(); }
      }
    };
    try {
      receiver = univiewFactory({ host: cam.ip, port: Number(cam.onvifPort) || 80,
        user: cam.onvifUser, pass: cam.onvifPass, channel: cam.channel, cameraId: cam.global_id || cam.id }, {
        onError: fail,
        onEvent: async (event, snapshot) => {
          if (stopped || receivers.get(cam.id) !== receiver) return;
          await aiEvents.recordBatch([{ cameraId: cam.id, input: event, snapshot }]);
          states.set(cam.id, { status: 'connected', lastSuccessAt: nowIso(), lastEventAt: event.ts, error: null });
        },
      });
      receivers.set(cam.id, receiver);
      await receiver.start();
      if (stopped || receivers.get(cam.id) !== receiver) { await receiver.stop(); return; }
      states.set(cam.id, { ...states.get(cam.id), status: 'connected', lastSuccessAt: nowIso() });
    } catch (err) {
      if (receivers.get(cam.id) === receiver) receivers.delete(cam.id);
      await receiver?.stop();
      fail(err);
      const auth = /\b(?:401|403)\b/.test(err.message);
      const retry = Date.now() + (auth ? 15 * 60_000 : 15000);
      due.set(cam.id, retry);
      states.set(cam.id, { ...states.get(cam.id), status: auth ? 'auth_error' : 'disconnected', retryAt: toBangkokIso(retry) });
    } finally { running.delete(cam.id); }
  }

  /** จำกัดการอ่านพร้อมกัน 4 กล้อง ไม่ให้ต้นทางช้ากระทบ gateway */
  async function tick() {
    if (stopped || role !== 'edge') return;
    const cams = await all('SELECT c.id,c.global_id,c.brand,c.ip,c.onvifPort,c.onvifUser,c.onvifPass,s.channel,s.time_mode FROM ai_event_sources s JOIN cameras c ON c.id=s.camera_id WHERE s.enabled=1 AND s.driver IN (?,?) AND c.enabled=1 AND (c.type IS NULL OR c.type != ?)', ['device', 'tiandy', 'edge_relay']);
    if (stopped) return;
    const active = new Set(cams.filter((cam) => String(cam.brand).toLowerCase() === 'uniview').map((cam) => cam.id));
    for (const [id, receiver] of receivers) {
      if (!active.has(id) || !running.has(id) && !receiver.alive()) {
        receivers.delete(id); await receiver.stop();
        if (active.has(id)) {
          const retry = Date.now() + 15000; due.set(id, retry);
          states.set(id, { ...states.get(id), status: 'disconnected', error: 'สาย ONVIF metadata หลุด', retryAt: toBangkokIso(retry) });
        }
      } else if (!running.has(id)) {
        states.set(id, { ...states.get(id), lastSuccessAt: nowIso() });
      }
    }
    for (const cam of cams) {
      if (running.size >= 4) break;
      if (!running.has(cam.id) && !receivers.has(cam.id) && (due.get(cam.id) || 0) <= Date.now()) {
        if (String(cam.brand).toLowerCase() === 'uniview') void connectUniview(cam);
        else void poll(cam);
      }
    }
  }
  async function start() {
    await ensureSchema();
    if (role !== 'edge') return;
    stopped = false;
    timer = setInterval(() => tick().catch((e) => console.warn('[AI sources] ' + redactUrls(e.message))), 1000);
    timer.unref?.();
  }
  async function stop() {
    stopped = true; clearInterval(timer); timer = null;
    const closing = [...receivers.values()]; receivers.clear();
    await Promise.allSettled(closing.map((receiver) => receiver.stop()));
    while (running.size) await new Promise((r) => setTimeout(r, 20));
  }
  return { ensureSchema, list, save, start, stop, tick };
}
module.exports = { createAiSources };
