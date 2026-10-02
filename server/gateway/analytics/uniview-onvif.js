
/** รับ LineCrossing จาก ONVIF metadata และจับภาพสดเฉพาะเหตุใหม่ ณ เวลาที่รับ */
const crypto = require('node:crypto');
const url = require('node:url');
const soap = require('node-onvif/lib/modules/soap.js');
const { OnvifMetadataSession } = require('./onvif-metadata-session');
const { authedRequest } = require('./http-digest');
const { compactJpeg } = require('./tiandy-event-image');
const { toBangkokIso } = require('../../shared/time');
const { blocksOf, attrOf, textOf } = require('./onvif-capabilities');

function parseCrossing(message, cameraId, channel = 1) {
  if (!String(message.topic).endsWith(':RuleEngine/LineDetector/Crossed') ||
      message.propertyOperation === 'Initialized') return null;
  const ts = message.utcTime?.getTime();
  const objectId = message.data?.ObjectId;
  const lineIndex = message.data?.LineIndex;
  if (!Number.isFinite(ts) || objectId === undefined || lineIndex === undefined) throw new Error('UNV LineCrossing ไม่มีเวลา/วัตถุ/เส้น');
  return { origin: 'camera', type: 'line_cross', ts: toBangkokIso(ts),
    rule: message.source?.Rule || 'LineCrossing',
    eventId: 'unv-m:' + crypto.createHash('sha256').update(JSON.stringify([cameraId, channel, ts, objectId, lineIndex])).digest('hex').slice(0, 54),
    attrs: { provider: 'uniview', transport: 'onvif-metadata', channel, objectId, lineIndex,
      vendorTopic: message.topic, detectionSource: 'camera', deliverySource: 'camera' } };
}

/** วัดส่วนต่างนาฬิกาจาก UTC ของ ONVIF โดยไม่ตั้งเวลาอุปกรณ์ */
async function readClock(cam) {
  const before = Date.now();
  const xml = await soap._request(url.parse('http://' + cam.host + ':' + cam.port + '/onvif/device_service'),
    soap.createRequestSoap({ user: cam.user, pass: cam.pass, body: '<tds:GetSystemDateAndTime/>',
      xmlns: ['xmlns:tds="http://www.onvif.org/ver10/device/wsdl"'] }));
  const after = Date.now();
  const utc = blocksOf(xml, 'UTCDateTime')[0]?.body;
  const date = blocksOf(utc, 'Date')[0]?.body;
  const time = blocksOf(utc, 'Time')[0]?.body;
  const values = ['Year', 'Month', 'Day'].map((key) => Number(textOf(date, key))).concat(['Hour', 'Minute', 'Second'].map((key) => Number(textOf(time, key))));
  if (!utc || values.some((v) => !Number.isInteger(v)) || after - before > 2000) throw new Error('วัดเวลา UTC ของ UNV ไม่ได้อย่างแม่นยำ');
  const [year, month, day, hour, minute, second] = values;
  const deviceMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const clockOffsetMs = Math.round(deviceMs - (before + after) / 2);
  if (!Number.isFinite(deviceMs) || Math.abs(clockOffsetMs) > 24 * 60 * 60_000) throw new Error('เวลา UNV ต่างจากเครื่องรับเกินหนึ่งวัน');
  return { clockOffsetMs, clockCheckedAt: after };
}
/** ขอ URI จากอุปกรณ์จริง ไม่เดาชื่อ profile หรือ URL ภาพ */
async function discover(cam) {
  if (cam.channel !== 1) throw new Error('UNV receiver ที่ตรวจจริงรองรับกล้องเดี่ยวช่อง 1');
  const ns = 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"';
  const call = (body) => soap._request(url.parse('http://' + cam.host + ':' + cam.port + '/onvif/media'),
    soap.createRequestSoap({ user: cam.user, pass: cam.pass, body, xmlns: [ns] }));
  const profiles = await call('<trt:GetProfiles/>');
  const profile = blocksOf(profiles, 'Profiles').find((p) => p.body.includes('VideoSourceConfiguration'));
  const token = attrOf(profile?.attrs, 'token');
  if (!token || !/^[a-zA-Z0-9_.:-]+$/.test(token)) throw new Error('UNV ไม่มี media profile ที่ใช้ได้');
  const query = '<trt:ProfileToken>' + token + '</trt:ProfileToken>';
  const snapshot = new URL(textOf(await call('<trt:GetSnapshotUri>' + query + '</trt:GetSnapshotUri>'), 'Uri'));
  if (snapshot.protocol !== 'http:' || snapshot.hostname !== cam.host || Number(snapshot.port || 80) !== cam.port ||
      snapshot.username || snapshot.password) throw new Error('UNV SnapshotUri ชี้ออกนอกอุปกรณ์ต้นทาง');
  const stream = new URL(textOf(await call('<trt:GetStreamUri><trt:StreamSetup><tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream><tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>' + query + '</trt:GetStreamUri>'), 'Uri'));
  if (stream.protocol !== 'rtsp:' || stream.hostname !== cam.host) throw new Error('UNV StreamUri ชี้ออกนอกอุปกรณ์ต้นทาง');
  return { snapshotPath: snapshot.pathname + snapshot.search, path: stream.pathname + stream.search, rtspPort: Number(stream.port || 554), ...await readClock(cam) };
}

/** ไม่จับภาพปัจจุบันไปแทนเหตุเก่า; เวลารับและเวลาจบโหลดภาพต้องใกล้เวลาเหตุ */
async function captureEventImage(cam, event, path, { request = authedRequest, compress = compactJpeg, clock = Date.now } = {}) {
  const eventTime = Date.parse(event.ts);
  const receivedAt = clock();
  const offset = cam.clockOffsetMs || 0;
  if (cam.clockCheckedAt && receivedAt - cam.clockCheckedAt > 90000) throw new Error('ผลวัดเวลา UNV เก่าเกินกำหนด');
  if (receivedAt + offset - eventTime > 3000 || eventTime - receivedAt - offset > 2000) throw new Error('เวลาเหตุ UNV ไม่ใกล้เวลาปัจจุบัน จึงไม่ใช้ snapshot แทน');
  const res = await request(cam, path, { maxBytes: 8 * 1024 * 1024, timeoutMs: 2500 });
  const capturedAt = clock();
  if (res.status !== 200 || !/^image\/jpeg\b/i.test(res.headers?.['content-type'] || '')) throw new Error('UNV snapshot HTTP ' + res.status);
  if (capturedAt + offset - eventTime > 5000) throw new Error('ภาพ UNV มาช้าเกิน 5 วินาที จึงไม่ผูกกับเหตุ');
  const jpeg = await compress(res.body);
  return { snapshot: jpeg.toString('base64'), attrs: { imageSource: 'onvif-event-triggered-snapshot',
    receivedAt: toBangkokIso(receivedAt), capturedAt: toBangkokIso(capturedAt), captureDelayMs: capturedAt + offset - eventTime, cameraClockOffsetMs: offset } };
}

/** หนึ่งสาย metadata ต่อกล้อง; จำกัดภาพพร้อมกันและปิดงานทั้งหมดเมื่อปิด receiver */
function createUniviewReceiver(cam, hooks, { Session = OnvifMetadataSession, discoverUris = discover, capture = captureEventImage } = {}) {
  let stopped = false;
  let session;
  let clockTimer;
  let clockJob;
  const pending = new Set();
  const seen = new Set();
  function report(error) { if (!stopped) hooks.onError?.(error); }
  async function handle(event) {
    try {
      const image = await capture(cam, event, cam.snapshotPath);
      if (!stopped) await hooks.onEvent({ ...event, attrs: { ...event.attrs, ...image.attrs } }, image.snapshot);
    } catch (err) { report(err); }
  }
  async function start() {
    Object.assign(cam, await discoverUris(cam));
    if (stopped) return;
    session = new Session(cam, { onMessages: (messages) => {
      for (const message of messages) {
        if (stopped) break;
        let event;
        try { event = parseCrossing(message, cam.cameraId, cam.channel); } catch (err) { report(err); continue; }
        if (!event || seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        while (seen.size > 2048) seen.delete(seen.values().next().value);
        if (pending.size >= 2) { report(new Error('UNV รับเหตุถี่เกินช่องดึงภาพ ไม่ใช้ภาพอื่นแทน')); continue; }
        const job = handle(event);
        pending.add(job); job.finally(() => pending.delete(job));
      }
    } });
    await session.start();
    if (stopped) { session.stop(); return; }
    clockTimer = setInterval(() => {
      if (stopped || clockJob) return;
      clockJob = readClock(cam).then((sample) => { if (!stopped) Object.assign(cam, sample); })
        .catch(report).finally(() => { clockJob = null; });
    }, 60000);
    clockTimer.unref?.();
  }
  async function stop() { stopped = true; clearInterval(clockTimer); session?.stop(); await Promise.allSettled([...pending, clockJob].filter(Boolean)); }
  function alive() { return Boolean(session?.socket && !session.socket.destroyed); }
  return { start, stop, alive };
}
module.exports = { parseCrossing, readClock, discover, captureEventImage, createUniviewReceiver };
