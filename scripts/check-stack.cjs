/** ตรวจ dependency ด้วย HTTP และ SQLite fixture ที่ฟังเฉพาะ loopback */
const assert = require('node:assert/strict');
const express = require('../server/node_modules/express');
const multer = require('../server/node_modules/multer');
const axios = require('../server/node_modules/axios');
const { supported } = require('./check-build-runtime.cjs');
const results = [];
const pass = name => { results.push(name); console.log('PASS ' + name); };
(async () => {
  for (const [version, expected] of [['20.18.9', false], ['20.19.0', true], ['21.9.0', false], ['22.6.0', false], ['22.11.9', false], ['22.12.0', true], ['22.23.3', true], ['24.0.0', true], ['garbage', false]]) assert.equal(supported(version), expected, version);
  pass('Build runtime rejects unsupported versions and accepts supported boundaries');
  assert.equal(require('../server/node_modules/axios/package.json').version, '1.20.0');
  assert.equal(require('../server/node_modules/multer/package.json').version, '2.4.0');
  pass('Isolated runtime loads exact patched dependency versions');
  const app = express();
  app.post('/upload', multer({ storage: multer.memoryStorage(), limits: { files: 1 } }).single('backup'), (req, res) => res.json({ bytes: req.file.buffer.toString('hex') }));
  app.get('/redirect', (req, res) => res.redirect('/binary'));
  app.get('/binary', (req, res) => res.end(Buffer.from([0, 255, 42])));
  app.get('/slow', (req, res) => { const timer = setTimeout(() => res.end('late'), 500); res.on('close', () => clearTimeout(timer)); });
  app.use((err, req, res, next) => res.status(400).json({ error: err.code || err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = axios.create({ baseURL: base, proxy: false });
  try {
    const body = new FormData(); body.append('backup', new Blob([new Uint8Array([0, 255, 42])]), 'fixture.db');
    const valid = await fetch(base + '/upload', { method: 'POST', body });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).bytes, '00ff2a');
    pass('Multipart binary upload preserves bytes');
    const index = new FormData(); index.append('field[999999999]', 'value');
    const rejected = await fetch(base + '/upload', { method: 'POST', body: index });
    assert.equal(rejected.status, 400);
    pass('Oversized multipart field array index is rejected');
    const malformed = await fetch(base + '/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' }, body: 'broken' });
    assert.equal(malformed.status, 400);
    assert.equal((await client.get('/binary')).status, 200);
    pass('Malformed multipart rejected and server remains responsive');
    const data = await client.get('/redirect', { responseType: 'arraybuffer' });
    assert.deepEqual(Buffer.from(data.data), Buffer.from([0, 255, 42]));
    pass('Axios redirect and binary response remain compatible');
    await assert.rejects(client.get('/slow', { timeout: 20 }), err => err.code === 'ECONNABORTED');
    pass('Axios timeout terminates delayed response');
    const controller = new AbortController(); const request = client.get('/slow', { signal: controller.signal }); controller.abort();
    await assert.rejects(request, err => err.code === 'ERR_CANCELED');
    pass('Axios cancellation remains compatible');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log(JSON.stringify({ pass: results.length, fail: 0, node: process.version }));
})().catch(err => { console.error(err); process.exitCode = 1; });
