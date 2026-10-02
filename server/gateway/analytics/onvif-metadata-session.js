/**
 * เปิด metadata track ของกล้องค้างไว้หนึ่งเส้น แล้วส่งข้อความที่แกะได้ออกไปให้ผู้เรียก
 *
 * โมดูลนี้คือ socket กับ state machine เท่านั้น การแกะ XML อยู่ที่ onvif-metadata.js
 *
 * ### ทำไมต้องเป็น RTSP ไม่ใช่การ poll
 *
 * กล้องหลายยี่ห้อ (ยืนยันแล้วกับ Uniview) ไม่มี HTTP endpoint ไหนคืนผลของ AI เลย ไม่ว่าจะ
 * เป็นยอดนับหรือเหตุการณ์ ทั้งหมดออกมาทางเดียวคือ ONVIF metadata track ที่พ่วงมากับ RTSP
 * — และ ONVIF event แบบ PullPoint ของ Uniview ก็รับ subscriber แล้วไม่ push อะไรกลับมาจริง
 *
 * ผลที่ตามมาซึ่งต้องรู้ก่อนใช้: **การเชื่อมต่อนี้คือการเก็บข้อมูลเอง** ไม่มีประวัติให้ย้อนไป
 * ดึงคืน ช่วงที่หลุดคือช่วงที่หายถาวร ต่างจาก Tiandy ที่ถามย้อนทั้งวันได้ทุกเมื่อ
 *
 * ### สิ่งที่โมดูลนี้ตั้งใจไม่ทำ
 *
 * ไม่ต่อใหม่เอง — ผู้เรียกเป็นคนคุมวงจรชีวิต เพราะคนที่รู้ว่าควรต่อใหม่ไหมคือชั้นที่รู้ว่า
 * กล้องยังอยู่ในระบบหรือถูกลบไปแล้ว และการซ่อนการต่อใหม่ไว้ในนี้จะทำให้สคริปต์ probe ที่
 * ตั้งใจฟังแค่ 30 วินาทีกลายเป็นวนไม่รู้จบ
 */
const net = require('node:net');
const crypto = require('node:crypto');
const { frameInterleaved, rtpPayload, rtpMarker, parseMessages } = require('./onvif-metadata');

/** ช่องที่ขอไว้ตอน SETUP: 2 คือ RTP ส่วน 3 คือ RTCP ซึ่งต้องข้าม */
const RTP_CHANNEL = 2;

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** กันข้อความที่ประกอบไม่จบโตไม่รู้จบเมื่อ marker bit หาย */
const MAX_ASSEMBLED = 256 * 1024;
const MAX_SOCKET_BUFFER = 1024 * 1024;

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** อ่าน challenge ของ Digest ออกมาเป็นคู่คีย์-ค่า */
function parseDigestChallenge(header) {
  const out = {};
  for (const part of String(header).replace(/^Digest\s+/i, '').split(/,\s*(?=[A-Za-z]+=)/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[part.slice(0, eq).trim()] = value;
  }
  return out;
}

function buildDigestHeader(challenge, { method, uri, user, pass, nc }) {
  const { realm, nonce, qop, opaque } = challenge;
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const fields = [`username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
  let response;
  if (qop) {
    const ncHex = String(nc).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    response = md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`);
    fields.push('qop=auth', `nc=${ncHex}`, `cnonce="${cnonce}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  fields.push(`response="${response}"`);
  if (opaque) fields.push(`opaque="${opaque}"`);
  return `Digest ${fields.join(', ')}`;
}

const statusOf = (head) => Number(/^RTSP\/\d\.\d\s+(\d{3})/.exec(String(head).trimStart())?.[1]) || 0;

function sessionHeaderOf(head) {
  const m = /^Session:[ \t]*([^;\r\n]+?)[ \t]*(?:;[ \t]*timeout[ \t]*=[ \t]*(\d+))?[ \t]*$/im.exec(String(head));
  return m ? { id: m[1], timeoutSec: m[2] ? Number(m[2]) : null } : null;
}

/**
 * หา URI ของ track จาก `a=control:` ใน SDP
 *
 * ค่าที่ได้อาจเป็น URL เต็ม หรือเป็นเส้นทางสัมพัทธ์กับ `Content-Base` หรือกับ URI ที่ขอไป
 * — ถูกต้องทั้งสามแบบตามสเปค การเดาว่าเป็นแบบใดแบบหนึ่งจะได้ URL มั่วแล้ว SETUP ไม่ผ่าน
 */
function resolveTrackUri(requestUri, contentBase, control) {
  if (!control) return null;
  if (/^rtsp:\/\//i.test(control)) return control;
  const base = (contentBase || requestUri).replace(/\/+$/, '');
  return `${base}/${control.replace(/^\/+/, '')}`;
}

class OnvifMetadataSession {
  /**
   * @param {{host:string, rtspPort?:number, user:string, pass:string, path?:string}} cam
   * @param {{onMessages?:Function, onLog?:Function}} hooks
   */
  constructor(cam, hooks = {}) {
    this.cam = cam;
    this.hooks = hooks;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.assembled = [];
    this.pending = [];
    this.cseq = 0;
    this.nc = 0;
    this.challenge = null;
    this.session = null;
    this.keepaliveTimer = null;
    this.keepaliveMethod = 'GET_PARAMETER';
    this.stopped = false;
    this.stats = { frames: 0, documents: 0, messages: 0, parseErrors: 0 };
  }

  get baseUri() {
    const path = this.cam.path || '/media/video1';
    return `rtsp://${this.cam.host}:${this.cam.rtspPort ?? 554}${path}`;
  }

  log(msg) {
    this.hooks.onLog?.(msg);
  }

  async start() {
    await this.connect();
    const sdp = await this.describe();
    const control = /a=control:(\S*metadata\S*)/i.exec(sdp.body)?.[1];
    if (!control) {
      throw new Error('กล้องไม่มี metadata track ใน SDP — เปิดฟังก์ชัน AI ที่หัวกล้องแล้วหรือยัง');
    }
    const contentBase = /^Content-Base:[ \t]*(\S+)/im.exec(sdp.head)?.[1];
    const track = resolveTrackUri(this.baseUri, contentBase, control);
    this.log(`metadata track: ${track}`);

    const setup = await this.request('SETUP', track, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${RTP_CHANNEL}-${RTP_CHANNEL + 1}`,
    });
    if (statusOf(setup.head) !== 200) throw new Error(`SETUP -> ${statusOf(setup.head)}`);
    this.session = sessionHeaderOf(setup.head);
    if (!this.session) throw new Error('SETUP ไม่ได้คืน Session มา');

    const play = await this.request('PLAY', this.baseUri, { Session: this.session.id, Range: 'npt=0.000-' });
    if (statusOf(play.head) !== 200) throw new Error(`PLAY -> ${statusOf(play.head)}`);

    this.startKeepalive();
    this.log(`PLAY สำเร็จ (session ${this.session.id}, timeout ${this.session.timeoutSec ?? '-'}s)`);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.cam.host,
        port: this.cam.rtspPort ?? 554,
        timeout: CONNECT_TIMEOUT_MS,
      });
      socket.once('connect', () => {
        socket.setTimeout(0);
        this.socket = socket;
        socket.on('data', (c) => this.onData(c));
        socket.on('error', (e) => this.log(`socket error: ${e.message}`));
        socket.on('close', () => this.rejectAllPending(new Error('สายหลุด')));
        resolve();
      });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('ต่อไม่ทันเวลา')); });
      socket.once('error', (e) => reject(e));
    });
  }

  /** DESCRIBE พร้อมรับมือ 401 รอบแรกตามธรรมเนียมของ Digest */
  async describe() {
    let res = await this.request('DESCRIBE', this.baseUri, { Accept: 'application/sdp' });
    if (statusOf(res.head) === 401) {
      const wwwAuth = /^WWW-Authenticate:[ \t]*(Digest[^\r\n]*)/im.exec(res.head)?.[1];
      if (!wwwAuth) throw new Error('กล้องขอ auth แต่ไม่ได้ส่ง Digest challenge มา');
      this.challenge = parseDigestChallenge(wwwAuth);
      res = await this.request('DESCRIBE', this.baseUri, { Accept: 'application/sdp' });
    }
    if (statusOf(res.head) !== 200) throw new Error(`DESCRIBE -> ${statusOf(res.head)}`);
    return res;
  }

  request(method, uri, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('ไม่มีการเชื่อมต่อ'));
      const all = { CSeq: ++this.cseq, 'User-Agent': 'gw-cctv-gateway', ...headers };
      if (this.challenge) {
        all.Authorization = buildDigestHeader(this.challenge, {
          method, uri, user: this.cam.user, pass: this.cam.pass, nc: ++this.nc,
        });
      }
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`${method} ไม่ตอบภายในเวลา`));
      }, timeoutMs);
      this.pending.push(entry);

      this.socket.write(
        `${method} ${uri} RTSP/1.0\r\n` +
          Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
          '\r\n\r\n',
      );
    });
  }

  /*
    กล้องบอก `timeout=60` มาแล้วจะตัดสายที่เงียบเกินนั้นทิ้ง แม้จะปกติดีทุกอย่าง จึงต้องส่ง
    keepalive ทุกครึ่งของค่านั้น และคำตอบของมันคือสัญญาณเดียวที่บอกว่าสายยังดีอยู่ —
    ใช้ RTCP เป็นสัญญาณไม่ได้ เพราะวัดกับกล้องจริงแล้วช่อง 3 ไม่มี packet มาเลยใน 2 นาที
  */
  startKeepalive() {
    const half = Math.floor((this.session?.timeoutSec ?? 60) / 2);
    const every = Math.min(30, Math.max(15, half)) * 1000;
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped) return;
      this.request(this.keepaliveMethod, this.baseUri, { Session: this.session.id })
        .then((res) => {
          const st = statusOf(res.head);
          // กล้องที่ไม่รู้จัก GET_PARAMETER ตอบ 405/501 — OPTIONS ใช้ได้เสมอ
          if ((st === 405 || st === 501) && this.keepaliveMethod !== 'OPTIONS') this.keepaliveMethod = 'OPTIONS';
          else if (st !== 200) throw new Error('RTSP keepalive -> ' + st);
        })
        .catch((e) => { this.log('keepalive ล้มเหลว: ' + e.message); this.stop(); });
    }, every);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_SOCKET_BUFFER) {
      this.log('buffer โตเกินกำหนด — ทิ้งของเก่า');
      this.buffer = Buffer.alloc(0);
      return;
    }

    for (;;) {
      if (this.buffer.length === 0) return;

      // ข้อมูล interleaved กับคำตอบ RTSP วิ่งบนสายเดียวกัน แยกกันที่ไบต์แรก
      if (this.buffer[0] === 0x24) {
        const { frames, rest } = frameInterleaved(this.buffer);
        this.buffer = rest;
        for (const f of frames) {
          this.stats.frames += 1;
          if (f.channel !== RTP_CHANNEL) continue; // ข้าม RTCP — ปนเข้ามาแล้ว XML จะเสีย
          this.onRtp(f.payload);
        }
        if (frames.length === 0) return;
        continue;
      }

      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = this.buffer.subarray(0, end + 4).toString('utf8');
      const len = Number(/^Content-Length:[ \t]*(\d+)/im.exec(head)?.[1] || 0);
      if (this.buffer.length < end + 4 + len) return;
      const body = this.buffer.subarray(end + 4, end + 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + len);

      const entry = this.pending.shift();
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve({ head, body });
      }
    }
  }

  onRtp(packet) {
    const payload = rtpPayload(packet);
    if (payload.length === 0) return;
    this.assembled.push(payload);

    const total = this.assembled.reduce((n, b) => n + b.length, 0);
    if (total > MAX_ASSEMBLED) {
      this.log('เอกสาร metadata ใหญ่เกินกำหนด — ทิ้ง');
      this.assembled = [];
      return;
    }
    if (!rtpMarker(packet)) return; // ยังไม่จบหน่วย รอชิ้นถัดไป

    const xml = Buffer.concat(this.assembled).toString('utf8');
    this.assembled = [];
    this.stats.documents += 1;
    try {
      const messages = parseMessages(xml);
      this.stats.messages += messages.length;
      if (messages.length > 0) this.hooks.onMessages?.(messages, xml);
    } catch (e) {
      this.stats.parseErrors += 1;
      this.log(`แกะเอกสารไม่ได้: ${e.message}`);
    }
  }

  rejectAllPending(err) {
    for (const p of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending = [];
  }

  stop() {
    this.stopped = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.socket && !this.socket.destroyed) {
      try {
        if (this.session) {
          this.socket.write(
            `TEARDOWN ${this.baseUri} RTSP/1.0\r\nCSeq: ${++this.cseq}\r\nSession: ${this.session.id}\r\n\r\n`,
          );
        }
      } catch { /* ปิดอยู่แล้ว ไม่ต้องทำอะไร */ }
      this.socket.destroy();
    }
    this.rejectAllPending(new Error('ปิดการเชื่อมต่อ'));
  }
}

module.exports = { OnvifMetadataSession, resolveTrackUri, parseDigestChallenge, buildDigestHeader };
