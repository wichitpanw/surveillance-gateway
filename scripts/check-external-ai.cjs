/**
 * ตรวจ event store และตัวรับ AI ภายนอกด้วย DB ใหม่ โดยไม่ติดต่อ production หรือกล้องจริง
 * เรียก node scripts/check-external-ai.cjs — state ทดสอบอยู่ใน temporary directory
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.GATEWAY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-external-ai-'));
const sqlite = require('../server/node_modules/sqlite3');
const { createAiEvents } = require('../server/shared/ai-events');
const { createAiSources } = require('../server/gateway/ai-sources');
const { parseAlarmInfo, cameraTime } = require('../server/gateway/analytics/tiandy-perimeter');
const db = new sqlite.Database(':memory:');
const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, (e) => e ? reject(e) : resolve()));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stores = [];
const xml = '<AlarmItemList><AlarmItem><dateTime>Fri, 02 Oct 2026 10:33:18 GMT</dateTime><channelID>1</channelID><SceneID>1</SceneID><ruleID>1</ruleID><eventType>fielddetection</eventType></AlarmItem></AlarmItemList>';
let checks = 0;
function pass(text) { checks += 1; console.log('PASS ' + text); }

/** รอผลอ่านหนึ่งครั้ง โดยไม่พึ่ง timer ของตัวรับ */
async function pollOnce(source, cameraId, status = 'connected') {
  await source.tick();
  for (let i = 0; i < 100; i += 1) {
    if ((await source.list()).find((c) => c.id === cameraId)?.status === status) return;
    await delay(10);
  }
  throw new Error('receiver did not reach ' + status);
}

(async () => {
  assert.equal(cameraTime('Fri, 02 Oct 2026 10:33:18 GMT'), '2026-10-02T10:33:18.000+07:00');
  assert.equal(cameraTime('2026-10-02T10:33:18Z'), '2026-10-02T10:33:18.000+07:00');
  assert.equal(cameraTime('2026-10-02T03:33:18Z', 'utc'), '2026-10-02T10:33:18.000+07:00');
  assert.throws(() => cameraTime('bad time'));
  const parsed = parseAlarmInfo(xml, { cameraId: 'TH-10-101-00001' });
  assert.equal(parsed[0].type, 'intrusion');
  assert.equal(parsed[0].origin, 'camera');
  assert.equal(parseAlarmInfo(xml, { cameraId: 'other', channel: 2 }).length, 0);
  assert.equal(parseAlarmInfo(xml.replace('fielddetection', 'VMD'), { cameraId: 'x' }).length, 0);
  assert.throws(() => parseAlarmInfo('<error>failed</error>', { cameraId: 'x' }));
  pass('Time modes, malformed replies, channel mapping and motion exclusion');

  await run('CREATE TABLE cameras (id TEXT PRIMARY KEY, name TEXT, global_id TEXT, group_name TEXT, brand TEXT, enabled INTEGER, type TEXT, ip TEXT, onvifPort INTEGER, onvifUser TEXT, onvifPass TEXT)');
  await run('INSERT INTO cameras (id,name,global_id,brand,enabled,type,ip,onvifPort,onvifUser,onvifPass) VALUES (?, ?, ?, ?, 1, ?, ?, 80, ?, ?)', ['cam', 'Fixture', 'TH-10-101-00001', 'tiandy', 'onvif_cam', '127.0.0.1', 'fixture', 'fixture']);
  const events = createAiEvents(db);
  await events.ensureSchema();
  let readerCalls = 0;
  const reader = async () => { readerCalls += 1; return parsed; };
  const source = createAiSources(db, events, { role: 'edge', reader, imageReader: async () => ({ snapshot: Buffer.from([255,216,255,217]).toString('base64'), file: 'fixture.jpg' }) }); stores.push(source);
  await source.start();
  await source.save('cam', { driver: 'tiandy', enabled: true, channel: 1 });
  await pollOnce(source, 'cam');
  assert.equal((await events.list()).length, 1);
  await source.stop();

  const restarted = createAiSources(db, events, { role: 'edge', reader, imageReader: async () => ({ snapshot: Buffer.from([255,216,255,217]).toString('base64'), file: 'fixture.jpg' }) }); stores.push(restarted);
  await restarted.start();
  await events.ensureSchema();
  await pollOnce(restarted, 'cam');
  assert.equal((await events.list()).length, 1);
  assert.equal((await restarted.list(new Set())).length, 0);
  assert(!JSON.stringify(await restarted.list()).includes('onvifPass'));
  await restarted.stop();
  pass('Fresh schema, persisted configuration, camera history preserved and restart deduplication');

  let authCalls = 0;
  const auth = createAiSources(db, events, { role: 'edge', reader: async () => { authCalls += 1; throw new Error('Camera -> HTTP 401'); } }); stores.push(auth);
  await auth.start(); await pollOnce(auth, 'cam', 'auth_error'); await auth.tick(); await delay(30);
  assert.equal(authCalls, 1);
  assert((await auth.list())[0].retryAt.endsWith('+07:00'));
  await auth.stop();
  pass('Authentication backoff prevents repeated camera login attempts');

  const central = createAiSources(db, events, { role: 'central', reader }); stores.push(central);
  await central.start(); const calls = readerCalls; await central.tick(); await delay(30);
  assert.equal(readerCalls, calls); await central.stop();
  pass('Collector instances never contact cameras for AI');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await events.ingest('edge-link', 'cam', { ...parsed[0], seq: 1 }, jpeg);
  const forwarded = (await events.list()).find((e) => e.source_id === 'edge-link');
  assert(forwarded.snapshot);
  assert.deepEqual(fs.readFileSync(events.snapshotFile(forwarded)), jpeg);
  assert.equal(await events.ingest('edge-link', 'cam', { ...parsed[0], seq: 1 }, jpeg), null);
  await events.ensureSchema();
  assert.equal((await events.list()).filter((e) => e.origin === 'camera').length, 2);
  pass('Atomic image publication, relay deduplication and camera event retention');

  const { ownerEdge, filterCameraIds } = require('../server/shared/ai-camera-filters');
  const catalog = [
    { id: 'cam_edge_100_reg', type: 'edge_relay', source_role: 'regional', source_node: '100', source_ref: 'cam_edge_101_original', global_id: 'TH-10-001-00001', group_name: 'Pilot' },
    { id: 'cam_edge_102_other', type: 'edge_relay', source_role: 'edge', source_node: '102', group_name: 'Pilot' },
    { id: 'cam_edge_101_second', type: 'edge_relay', source_role: 'edge', source_node: '101', group_name: 'Other' }
  ];
  assert.equal(ownerEdge(catalog[0]), '101');
  assert.deepEqual([...filterCameraIds(catalog, { edgeNode: '101', group: 'Pilot' })], ['cam_edge_100_reg']);
  assert.equal(filterCameraIds(catalog, { edgeNode: '101' }, new Set(['cam_edge_102_other'])).size, 0);
  assert.equal(filterCameraIds(catalog, { group: 'missing' }).size, 0);
  pass('Owner Edge through Regional ignores legacy Global ID and intersects group with permissions');
  const config = await restarted.save('cam', { driver: 'device', enabled: true, channel: 1 });
  assert.equal(config.driver, 'device');
  assert.equal(config.deviceSupported, true);
  pass('General device configuration remains compatible with existing native receiver');

  const { searchTime, matchPictures, readEventImage, compactJpeg } = require('../server/gateway/analytics/tiandy-event-image');
  const picture = (name, type = 'Alarm', time = '2026-10-02T10:33:18Z', channel = 0) =>
    '<matchElement><chanNo>' + channel + '</chanNo><type>' + type + '</type><fileName>' + name + '</fileName><timeSpan><startTime>' + time + '</startTime></timeSpan></matchElement>';
  const result = (items, count = 1) => '<CMSearchResult><numOfMatches>' + count + '</numOfMatches><matchList>' + items + '</matchList></CMSearchResult>';
  assert.equal(searchTime(parsed[0].ts, 'bangkok-wall', -5000), '2026-10-02T10:33:13Z');
  assert.equal(searchTime(parsed[0].ts, 'utc'), '2026-10-02T03:33:18Z');
  assert.equal(matchPictures(result(picture('Manual.jpg', 'Manual')), parsed[0]).file, null);
  assert.equal(matchPictures(result(picture('wrong.jpg', 'Alarm', '2026-10-02T10:33:19Z')), parsed[0]).file, null);
  assert.equal(matchPictures(result(picture('wrong.jpg', 'Alarm', undefined, 1)), parsed[0]).file, null);
  assert.throws(() => matchPictures(result(picture('../bad.jpg')), parsed[0]));
  assert.throws(() => matchPictures(result(picture('one.jpg') + picture('two.jpg'), 2), parsed[0]));
  const callsImage = [];
  const downloaded = await readEventImage({}, parsed[0], { request: async (_, route, opts) => {
    callsImage.push({ route, opts });
    return route.includes('search') ? { text: result(picture('exact.jpg')) } : { body: jpeg };
  }, compress: async (buf) => buf });
  assert.equal(downloaded.file, 'exact.jpg');
  assert.equal(callsImage[1].route, '/ISAPI/Record/DownLoad/exact.jpg');
  assert(callsImage[0].opts.body.includes('<channelID>0</channelID>'));
  await assert.rejects(readEventImage({}, parsed[0], { request: async () => ({ text: result(picture('exact.jpg'), 40) }) }));
  await assert.rejects(compactJpeg(Buffer.from('not a jpeg')));
  pass('Exact Alarm image matching, zero-based channel, time mode, unsafe names and ambiguous search rejected');

  // ภาพยังไม่ลง SD: ห้าม publish เหตุเปล่า และกู้คิวได้หลัง restart
  const pendingEvent = { ...parsed[0], eventId: 'tiandy:pending-image', ts: '2026-10-02T10:34:00.000+07:00' };
  const waitingSource = createAiSources(db, events, { role: 'edge', reader: async () => [pendingEvent], imageReader: async () => null });
  stores.push(waitingSource); await waitingSource.start(); await pollOnce(waitingSource, 'cam');
  assert.equal((await events.list()).some((e) => e.event_id === pendingEvent.eventId), false);
  assert((await waitingSource.list())[0].error.includes('รอภาพเหตุ'));
  await waitingSource.stop();
  await run('UPDATE ai_image_pending SET next_retry=0');
  let imageFetches = 0;
  const recovered = createAiSources(db, events, { role: 'edge', reader: async () => [pendingEvent], imageReader: async () => {
    imageFetches += 1; return { snapshot: jpeg.toString('base64'), file: 'exact.jpg' };
  } }); stores.push(recovered);
  await recovered.start(); await pollOnce(recovered, 'cam'); await recovered.stop();
  const recoveredRow = (await events.list()).find((e) => e.event_id === pendingEvent.eventId);
  assert(recoveredRow.snapshot);
  assert.equal(JSON.parse(recoveredRow.attrs).imageSource, 'device-alarm-storage');
  const finalSource = createAiSources(db, events, { role: 'edge', reader: async () => [pendingEvent], imageReader: async () => { imageFetches += 1; throw Error('must not redownload'); } });
  stores.push(finalSource); await finalSource.start(); await pollOnce(finalSource, 'cam'); await finalSource.stop();
  assert.equal(imageFetches, 1);
  assert.equal((await events.list()).filter((e) => e.event_id === pendingEvent.eventId).length, 1);
  pass('Missing image held durably, restart resumes with image, completed event never downloads or inserts twice');

  let imageAuthCalls = 0;
  const deniedImage = createAiSources(db, events, { role: 'edge', reader: async () => [{ ...parsed[0], eventId: 'tiandy:image-auth' }],
    imageReader: async () => { imageAuthCalls += 1; throw Error('Camera -> HTTP 401'); } });
  stores.push(deniedImage); await deniedImage.start(); await pollOnce(deniedImage, 'cam', 'auth_error');
  await deniedImage.tick(); await delay(30); await deniedImage.stop();
  assert.equal(imageAuthCalls, 1);
  pass('Image authentication failure uses the same 15 minute camera backoff');


  // ตัวรับ UNV ใช้ session ค้าง ไม่เรียก polling ของ Tiandy และหยุดเมื่อปิด source
  await run('UPDATE ai_event_sources SET enabled=0');
  await run('INSERT INTO cameras (id,name,brand,ip,onvifUser,onvifPass,enabled) VALUES (?,?,?,?,?,?,1)',
    ['unv', 'UNV', 'uniview', '192.0.2.75', 'admin', 'test-only']);
  let nativeHooks, nativeStarts = 0, nativeStops = 0, nativeAlive = true;
  const nativeSource = createAiSources(db, events, { role: 'edge',
    reader: async () => { throw Error('UNV must not use Tiandy reader'); },
    univiewFactory: (cam, hooks) => {
      nativeHooks = hooks; assert.equal(cam.channel, 1);
      return { start: async () => { nativeStarts++; nativeAlive = true; },
        stop: async () => { nativeStops++; nativeAlive = false; }, alive: () => nativeAlive };
    } });
  stores.push(nativeSource);
  await nativeSource.save('unv', { driver: 'device', enabled: true, channel: 1 });
  await nativeSource.start(); await pollOnce(nativeSource, 'unv');
  assert.equal(nativeStarts, 1);
  assert.equal((await nativeSource.list()).find((c) => c.id === 'unv').timeMode, 'utc');
  await assert.rejects(nativeSource.save('unv', { driver: 'device', enabled: true, channel: 2 }));
  await nativeHooks.onEvent({ origin: 'camera', type: 'line_cross', ts: '2026-10-02T13:34:35.000+07:00',
    eventId: 'unv-m:test', attrs: { imageSource: 'onvif-event-triggered-snapshot', captureDelayMs: 521 } }, jpeg.toString('base64'));
  const nativeEvent = (await events.list()).find((e) => e.event_id === 'unv-m:test');
  assert(nativeEvent.snapshot); assert.equal(nativeEvent.origin, 'camera');
  nativeAlive = false; await nativeSource.tick();
  assert.equal((await nativeSource.list()).find((c) => c.id === 'unv').status, 'disconnected');
  await nativeSource.tick(); assert.equal(nativeStarts, 1); assert.equal(nativeStops, 1);
  await nativeSource.save('unv', { driver: 'api', enabled: true, channel: 1 });
  await nativeSource.stop();
  pass('UNV device uses persistent session, UTC, image publication, channel guard, disconnect backoff and API switch');

  let nativeAuthStarts = 0;
  const nativeAuth = createAiSources(db, events, { role: 'edge', univiewFactory: () => ({
    start: async () => { nativeAuthStarts++; throw Error('RTSP -> 401'); }, stop: async () => {}, alive: () => false,
  }) });
  stores.push(nativeAuth);
  await nativeAuth.save('unv', { driver: 'device', enabled: true, channel: 1 });
  await nativeAuth.start(); await pollOnce(nativeAuth, 'unv', 'auth_error');
  await nativeAuth.tick(); assert.equal(nativeAuthStarts, 1); await nativeAuth.stop();
  pass('UNV failed authentication backs off without repeated connection attempts');

  console.log('DONE ' + checks + ' checks');
})().catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(async () => {
    for (const source of stores) await source.stop();
    await new Promise((resolve) => db.close(resolve));
  });
