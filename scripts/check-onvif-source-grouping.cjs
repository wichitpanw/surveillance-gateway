/** ทดสอบ helper จริงใน sandbox โดยไม่เริ่ม server, เปิดพอร์ต หรืออ่าน DB/รหัสอุปกรณ์ */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
// ดึงเฉพาะชุด pure helper ด้วยขอบเขต declaration ตายตัว ไม่ execute ส่วนเริ่มระบบ
const start = source.indexOf('const injectRtspCredentials = ');
const end = source.indexOf('const parseVideoSources = ', start);
assert.ok(start >= 0 && end > start, 'ONVIF helper boundaries must exist');
const sandbox = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.group = groupOnvifProfiles; this.identity = rtspIdentity;`, sandbox, { timeout: 1000 });
const group = (profiles, sources = [], milestone = false) =>
  sandbox.group(profiles, 'fixture', 'fixture', sources, milestone);
const profile = (token, config, physical, width = 1920, uri = `rtsp://fixture/${token}`) => ({
  token, name: token,
  video: {
    source: config || physical ? { token: config, sourceToken: physical, name: 'Camera' } : undefined,
    encoder: { resolution: { width, height: width / 2 }, encoding: 'H264' },
  },
  stream: { rtsp: uri },
});
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };

test('same physical source combines distinct configurations into main/sub', () => {
  const rows = group([profile('main', 'cfg-main', 'cam0'), profile('sub', 'cfg-sub', 'cam0', 640)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'cam0');
  assert.equal(rows[0].main.token, 'main');
  assert.equal(rows[0].sub.token, 'sub');
  assert.equal(rows[0].sourceToken, 'cfg-main');
  assert.equal(rows[0].videoSourceToken, 'cam0');
  assert.equal(rows[0].profiles.length, 2);
});
test('different physical sources stay separate even with shared configuration token', () => {
  const rows = group([profile('a', 'shared', 'cam0'), profile('b', 'shared', 'cam1')]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].videoSourceToken, 'cam0');
  assert.equal(rows[1].videoSourceToken, 'cam1');
});
test('legacy profiles fall back to configuration token', () => {
  const rows = group([profile('main', 'legacy', undefined), profile('sub', 'legacy', undefined, 640)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'legacy');
  assert.equal(rows[0].sub.token, 'sub');
});
test('offline physical source appears once with multiple configurations and GetVideoSources', () => {
  const rows = group([
    profile('main', 'cfg-main', 'cam0', 1920, ''),
    profile('sub', 'cfg-sub', 'cam0', 640, ''),
  ], [{ token: 'cam0', framerate: 0 }, { token: 'cam1', framerate: 0 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'cam0');
  assert.equal(rows[0].isOnline, false);
  assert.equal(rows[0].main, null);
  assert.equal(rows[1].id, 'cam1');
  assert.equal(rows[1].offlineReason, 'no-signal');
});
test('Milestone profiles without a source remain separate usable channels', () => {
  const rows = group([profile('guid-a'), profile('guid-b')], [], true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'profile_guid-a');
  assert.equal(rows[1].id, 'profile_guid-b');
  assert.equal(rows[0].noVideoSource, false);
  assert.equal(rows[1].noVideoSource, false);
});
// ดึงเฉพาะบล็อกคำนวณจาก route จริง ไม่เรียก handler ที่มี DB หรือ side effect
const extract = (from, until) => {
  const a = source.indexOf(from);
  const b = source.indexOf(until, a);
  assert.ok(a >= 0 && b > a, `route block must exist: ${from}`);
  return source.slice(a, b);
};
test('rescan recognizes an existing sub-only camera without rewriting its row', () => {
  const existing = [{ id: 'stable-id', name: 'Old camera', rtsp: 'rtsp://old:password@fixture/sub' }];
  const before = JSON.stringify(existing);
  const groups = group([profile('main', 'cfg-main', 'cam0'), profile('sub', 'cfg-sub', 'cam0', 640)]);
  const context = { existing, groups, rtspIdentity: sandbox.identity };
  const match = extract('const byRtsp = new Map(existing.map((r) => [rtspIdentity(r.rtsp), r]));',
    'const subsUpdated = await refreshExistingNvrSubs');
  vm.runInNewContext(`${match}\nthis.hits = hits;`, context, { timeout: 1000 });
  assert.equal(context.hits[0].row.id, 'stable-id');
  assert.equal(context.hits[0].row, existing[0]);
  const replyStart = source.indexOf('res.json(hits.map(({ channel: g, row: hit }) =>');
  const replyEnd = source.indexOf(';', replyStart);
  assert.ok(replyStart >= 0 && replyEnd > replyStart);
  context.res = { json: (value) => { context.reply = value; } };
  vm.runInNewContext(source.slice(replyStart, replyEnd + 1), context, { timeout: 1000 });
  assert.equal(context.reply[0].existingId, 'stable-id');
  assert.equal(JSON.stringify(existing), before);
});
test('bulk re-import skips channels matching an old sub or alternate profile URI', () => {
  const block = extract('const existingRtsp = new Set(existingRows.filter((r) => r.rtsp)',
    'const skipped = requested.length - channels.length;');
  const merged = group([profile('main', 'cfg-main', 'cam0'), profile('sub', 'cfg-sub', 'cam0', 640)])[0];
  for (const oldUri of ['rtsp://old:pass@fixture/sub', 'rtsp://fixture/alternate']) {
    const requested = [{ ...merged, profiles: [...merged.profiles, { rtsp: 'rtsp://fixture/alternate' }] }];
    const context = {
      existingRows: [{ rtsp: oldUri }], requested,
      rtspIdentity: sandbox.identity, univiewImport: false,
    };
    vm.runInNewContext(`${block}\nthis.result = channels;`, context, { timeout: 1000 });
    assert.equal(context.result.length, 0);
  }
});
console.log(`ONVIF source grouping: ${passed} cases passed`);
