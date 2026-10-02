const assert = require('node:assert/strict');
const { parseCrossing, captureEventImage, createUniviewReceiver } = require('../server/gateway/analytics/uniview-onvif');
(async () => {
  const ts = new Date('2026-10-02T06:17:22Z');
  const message = { topic: 'tns1:RuleEngine/LineDetector/Crossed', utcTime: ts,
    source: { Rule: 'MyLineDetectorRule' }, data: { ObjectId: '3634', LineIndex: '0' } };
  const event = parseCrossing(message, 'cam', 1);
  assert.equal(event.type, 'line_cross');
  assert.equal(event.ts, '2026-10-02T13:17:22.000+07:00');
  assert.equal(event.eventId, parseCrossing(message, 'cam', 1).eventId);
  assert.notEqual(event.eventId, parseCrossing({ ...message, data: { ...message.data, ObjectId: '3637' } }, 'cam', 1).eventId);
  assert.equal(parseCrossing({ ...message, topic: 'tns1:RuleEngine/CellMotionDetector/Motion' }, 'cam', 1), null);
  assert.equal(parseCrossing({ ...message, propertyOperation: 'Initialized' }, 'cam', 1), null);
  console.log('PASS LineCrossing identity, UTC time, motion and initialized exclusion');
  let requests = 0;
  const jpeg = Buffer.from([255, 216, 255, 217]);
  const options = { request: async () => { requests++; return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: jpeg }; },
    compress: async (b) => b, clock: () => ts.getTime() + 500 };
  const image = await captureEventImage({}, event, '/snapshot', options);
  assert.equal(image.attrs.captureDelayMs, 500);
  await assert.rejects(captureEventImage({}, event, '/snapshot', { ...options, clock: () => ts.getTime() + 6000 }));
  assert.equal(requests, 1);
  await assert.rejects(captureEventImage({}, event, '/snapshot', { ...options, request: async () => ({ status: 401 }) }));
  let ticks = 0;
  await assert.rejects(captureEventImage({}, event, '/snapshot', { ...options, clock: () => ts.getTime() + (ticks++ ? 6000 : 500) }));
  console.log('PASS Fresh snapshot only, no capture for old alarm, late image and authentication rejected');
  const drifted = await captureEventImage({ clockOffsetMs: -16000, clockCheckedAt: ts.getTime() + 16000 }, event, '/snapshot',
    { ...options, clock: () => ts.getTime() + 16500 });
  assert.equal(drifted.attrs.captureDelayMs, 500); assert.equal(drifted.attrs.cameraClockOffsetMs, -16000);
  await assert.rejects(captureEventImage({ clockOffsetMs: -16000, clockCheckedAt: ts.getTime() - 100000 }, event, '/snapshot',
    { ...options, clock: () => ts.getTime() + 16500 }));
  await assert.rejects(captureEventImage({}, { ...event, ts: new Date(ts.getTime() + 5000).toISOString() }, '/snapshot', options));
  console.log('PASS Measured camera clock offset, expired clock sample and future event rejection');
  let hooks, recorded = 0, stopped = 0;
  class Session {
    constructor(cam, h) { hooks = h; this.socket = { destroyed: false }; }
    async start() {}
    stop() { this.socket.destroyed = true; stopped++; }
  }
  const receiver = createUniviewReceiver({ cameraId: 'cam', channel: 1 },
    { onEvent: async () => { recorded++; }, onError: (e) => { throw e; } },
    { Session, discoverUris: async () => ({ snapshotPath: '/snapshot' }), capture: async () => image });
  await receiver.start(); hooks.onMessages([message, message]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(recorded, 1); assert(receiver.alive());
  await receiver.stop(); assert(!receiver.alive()); assert.equal(stopped, 1);
  hooks.onMessages([message]); assert.equal(recorded, 1);
  console.log('PASS Receiver deduplication, bounded lifetime and shutdown');
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
