/** ตรวจ discovery ของ DSS ด้วย HTTP fixture บน loopback/พอร์ตสุ่ม — ไม่แตะ DB หรืออุปกรณ์จริง */
const assert = require('node:assert/strict');
const http = require('node:http');
const { DssClient, DssAuthError, DssUnavailable } = require('../server/vms/dss');

async function main() {
  let tree;
  let detailReply;
  let requests = [];
  let treeStatus = 200;
  let treeCode = 1000;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: req.url, method: req.method, body });
    assert.equal(req.headers['x-subject-token'], 'fixture-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/brms/api/v1.0/tree/devices') {
      res.writeHead(treeStatus);
      res.end(JSON.stringify({ code: treeCode, desc: 'fixture', data: tree }));
    } else if (req.url === '/brms/api/v1.1/device/channel/list') {
      const results = detailReply ? detailReply(body.ids) : body.ids.map((id) => ({
        channelId: id, channelName: `Camera ${id}`, orgName: 'Fixture', status: id === 'remote-id' ? '0' : '1',
      }));
      res.end(JSON.stringify({ code: 1000, data: { results } }));
    } else {
      res.writeHead(500);
      res.end(JSON.stringify({ code: -1 }));
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const client = new DssClient({ host: '127.0.0.1', port: server.address().port, secure: false, user: 'fixture' });
  client.token = 'fixture-only';
  let passed = 0;
  const test = async (name, fn) => {
    requests = [];
    detailReply = null;
    treeStatus = 200;
    treeCode = 1000;
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  };
  const device = (ids) => ({ code: 'nvr', name: 'NVR', password: 'must-not-escape', sipPwd: 'must-not-escape', units: [
    { unitType: '1', channels: ids.map((channelCode) => ({ channelCode })) },
  ] });
  try {
    await test('actual IDs, multiple NVR channels, offline, duplicate IDs, and non-video units', async () => {
      tree = { devices: [device(['nvr$1$0$3', 'remote-id']), {
        ...device(['remote-id', 'nvr$1$2$48']),
        units: [...device(['remote-id', 'nvr$1$2$48']).units, { unitType: '3', channels: [{ channelCode: 'alarm-only' }] }],
      }] };
      const rows = await client.listAllChannels();
      assert.deepEqual(rows.map((c) => c.channelId), ['nvr$1$0$3', 'remote-id', 'nvr$1$2$48']);
      assert.equal(rows[1].status, '0');
      assert.equal(rows[0].orgName, 'Fixture');
      assert(!JSON.stringify(rows).includes('must-not-escape'));
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0], { path: '/brms/api/v1.0/tree/devices', method: 'POST', body: {
        categories: ['1'], containVirtualDevice: '1', resourceTypes: [],
      } });
      assert.deepEqual(requests[1].body.ids, rows.map((c) => c.channelId));
    });
    await test('more than 400 channels are batched without guessing IDs', async () => {
      const ids = Array.from({ length: 805 }, (_, i) => `actual-camera-${i}`);
      tree = { devices: [device(ids)] };
      assert.equal((await client.listAllChannels()).length, 805);
      assert.deepEqual(requests.slice(1).map((r) => r.body.ids.length), [400, 400, 5]);
      assert.deepEqual(requests.slice(1).flatMap((r) => r.body.ids), ids);
    });
    await test('valid empty tree makes no detail requests', async () => {
      tree = { devices: [] };
      assert.deepEqual(await client.listAllChannels(), []);
      assert.equal(requests.length, 1);
    });
    await test('malformed tree is an error, not an empty camera list', async () => {
      for (const value of [{}, { devices: [{}] }, { devices: [{ units: [{ unitType: '1' }] }] }, { devices: [device([''])] }]) {
        tree = value;
        await assert.rejects(client.listAllChannels(), DssUnavailable);
      }
      assert(requests.every((r) => r.path.endsWith('/tree/devices')));
    });
    await test('partial details cannot silently hide a camera during resync', async () => {
      tree = { devices: [device(['a', 'b'])] };
      detailReply = () => [{ channelId: 'a' }];
      await assert.rejects(client.listAllChannels(), /1\/2/);
    });
    await test('extra detail IDs cannot introduce cameras outside the tree', async () => {
      tree = { devices: [device(['a'])] };
      detailReply = () => [{ channelId: 'outside' }];
      await assert.rejects(client.listAllChannels(), DssUnavailable);
    });
    await test('permission denial stops without legacy ID scan or another login', async () => {
      tree = {};
      treeCode = 1104;
      await assert.rejects(client.listAllChannels(), DssAuthError);
      assert.equal(requests.length, 1);
    });
    await test('unsupported tree API stops without guessed IDs', async () => {
      tree = {};
      treeStatus = 404;
      treeCode = 1001;
      await assert.rejects(client.listAllChannels(), DssUnavailable);
      assert.equal(requests.length, 1);
    });
    console.log(`DSS discovery: ${passed} checks passed`);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });