/**
 * ตัวกลาง RTSP สำหรับ ONVIF Profile G replay ที่ให้ ffmpeg เล่นได้
 *
 * ONVIF replay ต้องส่ง `Require: onvif-replay` และเลือกเวลาด้วย `Range: clock=<UTC>-<UTC>` ในคำขอ PLAY
 * ffmpeg ส่ง header เองไม่ได้ (ส่งแค่ `Range: npt=0.000-`) จึงเปิด socket ฟังที่ 127.0.0.1 ให้ ffmpeg ต่อเข้ามา
 * แล้วส่งต่อไปอุปกรณ์ โดยแก้คำขอระหว่างทาง:
 * · URI ในบรรทัดคำขอ → ที่อยู่จริงของอุปกรณ์ (ffmpeg เห็นแค่ 127.0.0.1)
 * · ใส่ Authorization เอง (Digest หรือ Basic) — ffmpeg ไม่ได้รหัสผ่าน รหัสจึงไม่อยู่ใน command line
 * · DESCRIBE / SETUP / PLAY ได้ `Require: onvif-replay` · PLAY ได้ `Range: clock=...` แทน npt
 * ข้อมูลภาพ (interleaved `$`) และคำตอบส่งกลับตามเดิม · รับ ffmpeg ได้ตัวเดียว ปิดเมื่อฝั่งใดฝั่งหนึ่งปิด
 */
const net = require('node:net');
const { buildDigestHeader, parseDigestChallenge } = require('../gateway/analytics/http-digest');

const MAX_HEADER = 64 * 1024;
/** body ของข้อความ RTSP (SDP, GET_PARAMETER) ใหญ่สุดที่รับ */
const MAX_BODY = 1024 * 1024;

/** epoch ms → `20260928T031500.000Z` ตามรูปแบบ clock ของ RFC 2326 */
const clockOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '');

/**
 * ตัดสตรีม RTSP (TCP) เป็นก้อน: interleaved `$` + ช่อง + ความยาว 2 ไบต์ หรือข้อความ header + body ตาม Content-Length
 * onFrame({ raw }) สำหรับข้อมูลภาพ · onMessage({ raw, startLine, headers:[[name,value]], body })
 */
class RtspSplitter {
  constructor({ onFrame, onMessage, onError }) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk) {
    if (this.failed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.failed || !this.buf.length) return;
      if (this.buf[0] === 0x24) {
        if (this.buf.length < 4) return;
        const size = 4 + this.buf.readUInt16BE(2);
        if (this.buf.length < size) return;
        this.onFrame({ raw: this.buf.subarray(0, size) });
        this.buf = this.buf.subarray(size);
        continue;
      }
      const term = headerEnd(this.buf);
      if (!term) {
        if (this.buf.length > MAX_HEADER) this.fail('RTSP header ยาวเกิน');
        return;
      }
      const { end, sep } = term;
      if (end > MAX_HEADER) { this.fail('RTSP header ยาวเกิน'); return; }
      const head = this.buf.subarray(0, end).toString('latin1');
      const lines = head.split(/\r?\n/);
      const headers = [];
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
      }
      // Content-Length ต้องเป็นเลขล้วนและไม่เกิน MAX_BODY — ค่าลบ/NaN เคยทำให้วนไม่รู้จบ
      const lengthText = headerOf(headers, 'content-length');
      if (lengthText !== null && (!/^\d+$/.test(lengthText) || Number(lengthText) > MAX_BODY)) {
        this.fail('RTSP Content-Length ไม่ถูกต้อง');
        return;
      }
      const length = lengthText === null ? 0 : Number(lengthText);
      const total = end + sep + length;
      if (this.buf.length < total) return;
      const raw = this.buf.subarray(0, total);
      this.onMessage({ raw, startLine: lines[0], headers, body: raw.subarray(end + sep) });
      this.buf = this.buf.subarray(total);
    }
  }

  /** ข้อมูลเสีย: แจ้งครั้งเดียว ทิ้ง buffer และไม่รับอะไรต่อ (ผู้เรียกปิดสาย) */
  fail(message) {
    this.failed = true;
    this.buf = Buffer.alloc(0);
    this.onError(new Error(message));
  }
}

/** ตำแหน่งจบ header: `\r\n\r\n` หรือ `\n\n` (อุปกรณ์บางตัวใช้ LF เปล่า) ตัวที่มาก่อน · ไม่เจอ = null */
function headerEnd(buf) {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf < 0 && lf < 0) return null;
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { end: lf, sep: 2 };
  return { end: crlf, sep: 4 };
}

function headerOf(headers, name) {
  const found = headers.find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
}

/** เลือก challenge จาก WWW-Authenticate ทุกบรรทัด — Digest ก่อน Basic */
function challengeFrom(headers) {
  const values = headers.filter(([key]) => key.toLowerCase() === 'www-authenticate').map(([, value]) => value);
  const digest = values.find((value) => /^Digest\s/i.test(value));
  if (digest) return { scheme: 'digest', params: parseDigestChallenge(digest) };
  if (values.some((value) => /^Basic\b/i.test(value))) return { scheme: 'basic' };
  return null;
}

/**
 * เปิดตัวกลางหนึ่งรอบ
 * @param {{ url: string, user: string, pass: string, startMs: number, endMs?: number, timeoutMs?: number, rateControl?: boolean }} opts
 *   url = replay URI จาก GetReplayUri (ไม่มีรหัส)
 * @returns {Promise<{ url: string, close: () => void }>} url = ที่ให้ ffmpeg เปิด
 */
function openReplayProxy({ url, user, pass, startMs, endMs, timeoutMs = 15000, rateControl = null }) {
  const target = new URL(url);
  if (target.protocol !== 'rtsp:') return Promise.reject(new Error('replay URI ต้องเป็น rtsp://'));
  const host = target.hostname;
  const port = Number(target.port) || 554;
  const upstreamOrigin = `rtsp://${target.host.includes(':') ? target.host : `${host}:${port}`}`;
  const range = `clock=${clockOf(startMs)}-${endMs ? clockOf(endMs) : ''}`;

  const server = net.createServer();
  let client = null;
  let upstream = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    try { server.close(); } catch { /* ปิดแล้ว */ }
    if (client) client.destroy();
    if (upstream) upstream.destroy();
  };
  const idle = setTimeout(close, timeoutMs);

  server.on('connection', (socket) => {
    if (client) { socket.destroy(); return; }
    client = socket;
    clearTimeout(idle);
    server.close();
    upstream = net.connect({ host, port });
    upstream.setNoDelay(true);
    client.setNoDelay(true);

    let auth = null;
    const pending = new Map();

    const authorization = (method, uri) => {
      if (!auth) return null;
      if (auth.scheme === 'basic') return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      return buildDigestHeader(auth.params, { method, uri, user, pass });
    };

    /**
     * เขียนลงปลายทางแบบมี backpressure: ปลายทางรับไม่ทัน (write คืน false) → หยุดอ่านต้นทางจนกว่าจะ 'drain'
     * ไม่งั้นอุปกรณ์ที่ส่งเร็วกว่า ffmpeg อ่านจะกองข้อมูลไว้ในหน่วยความจำของ process ไม่มีขีด
     */
    const relay = (dst, src, data) => {
      if (closed || dst.destroyed) return;
      if (!dst.write(data) && !src.isPaused()) {
        src.pause();
        dst.once('drain', () => { if (!closed) src.resume(); });
      }
    };

    const send = (req) => {
      const lines = [`${req.method} ${req.uri} RTSP/1.0`];
      for (const [name, value] of req.headers) lines.push(`${name}: ${value}`);
      const header = authorization(req.method, req.uri);
      if (header) lines.push(`Authorization: ${header}`);
      relay(upstream, client,Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), req.body]));
    };

    const fromClient = new RtspSplitter({
      onError: close,
      onFrame: ({ raw }) => relay(upstream, client, raw), // RTCP ของ ffmpeg
      onMessage: ({ startLine, headers, body }) => {
        const [method, rawUri] = startLine.split(' ');
        const uri = /^rtsp:\/\//i.test(rawUri || '') ? rawUri.replace(/^rtsp:\/\/[^/?]+/i, upstreamOrigin) : rawUri;
        const upper = String(method || '').toUpperCase();
        const kept = headers.filter(([name]) => {
          const key = name.toLowerCase();
          if (key === 'authorization' || key === 'require') return false;
          if (upper === 'PLAY' && rateControl === false && key === 'rate-control') return false;
          return !(upper === 'PLAY' && key === 'range');
        });
        if (['DESCRIBE', 'SETUP', 'PLAY'].includes(upper)) kept.push(['Require', 'onvif-replay']);
        if (upper === 'PLAY') {
          kept.push(['Range', range]);
          if (rateControl === false) kept.push(['Rate-Control', 'no']);
        }
        const req = { method: upper, uri, headers: kept, body, retried: false };
        const cseq = headerOf(headers, 'cseq');
        if (cseq) pending.set(cseq, req);
        send(req);
      },
    });

    const fromUpstream = new RtspSplitter({
      onError: close,
      onFrame: ({ raw }) => relay(client, upstream, raw),
      onMessage: ({ raw, startLine, headers }) => {
        const status = Number(startLine.split(' ')[1]);
        const cseq = headerOf(headers, 'cseq');
        const req = cseq ? pending.get(cseq) : null;
        if (status === 401 && req && !req.retried) {
          // ลองใหม่ครั้งเดียวด้วย challenge ใหม่ (nonce หมดอายุระหว่างเล่นก็ผ่านทางนี้) · ผิดซ้ำ = ส่ง 401 ให้ ffmpeg
          const challenge = challengeFrom(headers);
          if (challenge) {
            auth = challenge;
            req.retried = true;
            send(req);
            return;
          }
        }
        if (cseq) pending.delete(cseq);
        relay(client, upstream, raw);
      },
    });

    client.on('data', (chunk) => fromClient.push(chunk));
    upstream.on('data', (chunk) => fromUpstream.push(chunk));
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => { close(); reject(err); });
    server.listen(0, '127.0.0.1', () => {
      const local = `rtsp://127.0.0.1:${server.address().port}${target.pathname}${target.search}`;
      resolve({ url: local, close });
    });
  });
}

module.exports = { openReplayProxy, RtspSplitter, clockOf };
