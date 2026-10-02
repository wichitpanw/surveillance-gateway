/**
 * Client ที่ central ใช้คุยกับ edge ตัวหนึ่ง — edge คือ Gateway ชุดเดียวกับเรา จึงคุยกันด้วย /api/v1
 * ด้วย API key ที่ edge ออกให้ central เหมือน client ภายนอกรายอื่นทุกประการ (docs/EDGE-PLAN.md เฟส 2)
 *
 * ข้อที่ต่างจาก Digifort: edge ให้ทุกอย่างที่ต้องใช้ผ่าน API ของมันเอง ทั้งรายชื่อกล้อง, global ID,
 * จังหวัด และที่อยู่สตรีม central จึงไม่ต้องประกอบ URL เองหรือรู้รหัสผ่านกล้องเลยสักตัว
 */
const http = require('http');
const https = require('https');
const { redactUrls } = require('../shared/redact');

class EdgeAuthError extends Error {}
class EdgeUnavailable extends Error {}
class EdgeRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * เวลารอคำขอที่ edge ต้องไปถามเครื่องบันทึกต่อ (ช่วงบันทึก, ภาพนิ่ง) ทั้งแบบ pull และ link
 * ONVIF Profile G ของกล้อง Tiandy ค้น recording + event ~7–11 วิ (วัดจริง 2026-09-29) — 8 วิเดิมทำให้แถบเวลาว่าง
 */
const RECORDER_TIMEOUT_MS = 45_000;

class EdgeClient {
  constructor({ host, port, key, secure = false, timeoutMs = 8000, recorderTimeoutMs = RECORDER_TIMEOUT_MS }) {
    this.host = String(host || '').trim();
    this.port = Number(port) || 5173;
    this.key = String(key || '').trim();
    this.secure = Boolean(secure);
    this.timeoutMs = timeoutMs;
    this.recorderTimeoutMs = recorderTimeoutMs;
  }

  /** opts.timeoutMs: คำขอที่ edge ต้องไปถามเครื่องบันทึกต่อ (ช่วงบันทึก) รอได้นานกว่าค่าปกติ */
  request(method, path, body, opts = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const transport = this.secure ? https : http;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        method,
        hostname: this.host,
        port: this.port,
        path: `/api/v1${path}`,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          // ให้ edge นับ central เป็น client ตัวหนึ่งในหน้า API Clients ของมัน
          'X-Client-Instance': 'central',
          'X-Client-Name': 'Central gateway',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { /* หน้า error ที่ไม่ใช่ JSON */ }
          if (res.statusCode === 401) return reject(new EdgeAuthError(data?.error || 'edge ไม่รับ API key นี้'));
          if (res.statusCode >= 400) {
            return reject(new EdgeRequestError(res.statusCode, data?.error || `edge ตอบ HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      });
      req.on('timeout', () => req.destroy(new EdgeUnavailable(`edge ${this.host}:${this.port} ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`)));
      req.on('error', (err) => reject(err instanceof EdgeUnavailable ? err : new EdgeUnavailable(`ติดต่อ edge ${this.host}:${this.port} ไม่ได้: ${err.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** `/health` — ยืนยันว่าเป็น edge จริง ไม่ใช่ central อีกตัวหรือเครื่องที่ไม่ใช่ Gateway */
  async health() {
    const h = await this.request('GET', '/health');
    if (!h || !h.ok || h.gateway !== 'gw-cctv-gateway') throw new EdgeUnavailable('ที่อยู่นี้ไม่ใช่ Gateway');
    return h;
  }

  async listCameras() {
    const data = await this.request('GET', '/cameras');
    return Array.isArray(data?.cameras) ? data.cameras : [];
  }

  /** id ของกล้องที่คนลบที่ edge — [{ id, deletedAt }] (edge รุ่นก่อนตอบ 404) */
  async deletedCameras() {
    const data = await this.request('GET', '/cameras/deleted');
    return Array.isArray(data?.deleted) ? data.deleted : [];
  }

  streams(cameraId) {
    return this.request('GET', `/cameras/${encodeURIComponent(cameraId)}/streams`);
  }

  ptzInfo(cameraId) {
    return this.request('GET', `/cameras/${encodeURIComponent(cameraId)}/ptz`);
  }

  ptz(cameraId, command) {
    return this.request('POST', `/cameras/${encodeURIComponent(cameraId)}/ptz`, command);
  }

  /** event ของ AI ถัดจาก seq `since` (shared/ai-events.js) — edge รุ่นก่อนตอบ 404 */
  aiEvents(since = 0, limit = 200) {
    return this.request('GET', `/ai/events?since=${Number(since) || 0}&limit=${Number(limit) || 200}`);
  }

  /** ภาพประกอบของ event เป็น Buffer (null = ไม่มีภาพ) */
  aiSnapshot(seq) {
    const transport = this.secure ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        method: 'GET',
        hostname: this.host,
        port: this.port,
        path: `/api/v1/ai/events/${Number(seq)}/snapshot.jpg`,
        timeout: this.timeoutMs,
        headers: { Authorization: `Bearer ${this.key}`, 'X-Client-Instance': 'central', 'X-Client-Name': 'Central gateway' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : resolve(null)));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new EdgeUnavailable(`edge ${this.host}:${this.port} ไม่ตอบ`)));
      req.on('error', reject);
      req.end();
    });
  }

  /** ช่วงเวลาที่ edge มีภาพย้อนหลัง (gateway/playback.js) */
  recordings(cameraId, { from, to } = {}) {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return this.request('GET', `/cameras/${encodeURIComponent(cameraId)}/recordings?${q}`, undefined, { timeoutMs: this.recorderTimeoutMs });
  }

  /** ดึง JPEG สำหรับ Regional ที่ต้องส่งภาพนิ่งต่อขึ้น Central ทางสาย link */
  frame(cameraId, at) {
    const transport = this.secure ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        method: 'GET', hostname: this.host, port: this.port,
        path: `/api/v1/cameras/${encodeURIComponent(cameraId)}/frame.jpg?at=${encodeURIComponent(at || '')}`,
        timeout: this.recorderTimeoutMs,
        headers: { Authorization: `Bearer ${this.key}`, 'X-Client-Instance': 'central', 'X-Client-Name': 'Central gateway' },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (part) => {
          size += part.length;
          if (size > 20 * 1024 * 1024) req.destroy(new EdgeRequestError(502, 'ภาพนิ่งจาก edge ใหญ่เกิน 20 MB'));
          else chunks.push(part);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode === 200) return resolve(body);
          let error = `edge ตอบ HTTP ${res.statusCode}`;
          try { error = JSON.parse(body.toString('utf8')).error || error; } catch { /* คำตอบไม่ใช่ JSON */ }
          reject(new EdgeRequestError(res.statusCode === 401 ? 502 : res.statusCode, error));
        });
      });
      req.on('timeout', () => req.destroy(new EdgeUnavailable(`edge ${this.host}:${this.port} ไม่ตอบภายใน ${this.recorderTimeoutMs / 1000} วินาที`)));
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * ส่งต่อคำขอที่ตอบเป็นไฟล์ (ภาพย้อนหลัง, ภาพนิ่ง) จาก edge ลง response ตรง ๆ ไม่พักในหน่วยความจำ
   * error ของ edge ส่งต่อเป็น JSON พร้อมสถานะเดิม (401 ของ edge = key ที่ central ถือเสีย → 502)
   */
  pipe(pathAndQuery, res) {
    const transport = this.secure ? https : http;
    return new Promise((resolve) => {
      const req = transport.request({
        method: 'GET',
        hostname: this.host,
        port: this.port,
        path: `/api/v1${pathAndQuery}`,
        timeout: this.recorderTimeoutMs,
        headers: { Authorization: `Bearer ${this.key}`, 'X-Client-Instance': 'central', 'X-Client-Name': 'Central gateway' },
      }, (up) => {
        // ผู้ชมปิดไปก่อน edge ตอบ — ทิ้งคำตอบ ตัดสาย (edge หยุด ffmpeg เอง)
        if (res.destroyed || res.writableEnded) {
          up.resume();
          req.destroy();
          resolve();
          return;
        }
        if (up.statusCode >= 400) {
          let text = '';
          up.setEncoding('utf8');
          up.on('data', (c) => { text += c; });
          up.on('end', () => {
            let data = null;
            try { data = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
            res.status(up.statusCode === 401 ? 502 : up.statusCode).json({ error: `edge: ${data?.error || `HTTP ${up.statusCode}`}` });
            resolve();
          });
          return;
        }
        res.status(up.statusCode);
        for (const h of ['content-type', 'cache-control', 'x-playback-start']) if (up.headers[h]) res.set(h, up.headers[h]);
        up.pipe(res);
        up.on('end', resolve);
        up.on('error', () => { res.destroy(); resolve(); });
      });
      // ลงทะเบียนทันทีหลังสร้างคำขอ ไม่ใช่ตอนได้คำตอบ — ผู้ชมที่ปิดระหว่าง edge ค้นบันทึกต้องตัดสายไป edge ด้วย
      res.on('close', () => { req.destroy(); resolve(); });
      // timeout ใช้ตอนรอคำตอบแรกเท่านั้น — ภาพยาวหนึ่งชั่วโมงวิ่งนานกว่านั้นได้
      req.on('response', () => req.setTimeout(0));
      req.on('timeout', () => req.destroy(new EdgeUnavailable(`edge ${this.host}:${this.port} ไม่ตอบ`)));
      req.on('error', (err) => {
        if (!res.headersSent && !res.destroyed) res.status(502).json({ error: `ติดต่อ edge ไม่ได้: ${err.message}` });
        resolve();
      });
      req.end();
    });
  }

  /**
   * ฟัง SSE `/api/v1/events` ของ edge ค้างไว้
   *
   * เรียก onEvent(obj) ทุกบรรทัด `data:` และ onClose(err) ครั้งเดียวเมื่อสายขาด (ไม่ว่าจากฝั่งไหน)
   * คืนฟังก์ชันปิดสาย — ผู้เรียกเป็นคนตัดสินใจต่อใหม่ ตัวนี้ไม่ retry เอง
   *
   * ไม่ตั้ง timeout ของ socket: สายนี้ตั้งใจให้เงียบได้นาน edge ส่ง `: ping` ทุก 20 วิ ถ้าเงียบเกิน
   * 60 วิ ถือว่าสายตาย (เช่น NAT ตัดทิ้งเงียบ ๆ) แล้วปิดเอง
   */
  events({ onOpen, onEvent, onClose }) {
    const transport = this.secure ? https : http;
    let done = false;
    let idle = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      onClose?.(err || null);
    };
    const req = transport.request({
      method: 'GET',
      hostname: this.host,
      port: this.port,
      path: '/api/v1/events',
      headers: {
        Authorization: `Bearer ${this.key}`,
        Accept: 'text/event-stream',
        'X-Client-Instance': 'central',
        'X-Client-Name': 'Central gateway',
      },
    }, (res) => {
      if (res.statusCode === 401) { res.resume(); return finish(new EdgeAuthError('edge ไม่รับ API key นี้')); }
      if (res.statusCode !== 200) { res.resume(); return finish(new EdgeRequestError(res.statusCode, `edge ตอบ HTTP ${res.statusCode}`)); }
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(() => req.destroy(new EdgeUnavailable('สาย events ของ edge เงียบเกิน 60 วินาที')), 60_000);
      };
      bump();
      onOpen?.();
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bump();
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          try { onEvent?.(JSON.parse(line.slice(5).trim())); } catch { /* บรรทัดที่ไม่ใช่ JSON ข้ามไป */ }
        }
      });
      res.on('end', () => finish(new EdgeUnavailable('edge ปิดสาย events')));
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err instanceof EdgeUnavailable ? err : new EdgeUnavailable(`ต่อ events ของ edge ${this.host}:${this.port} ไม่ได้: ${err.message}`)));
    req.end();
    return () => { req.destroy(); finish(null); };
  }
}

/**
 * RTSP ที่ central จะให้ go2rtc ของตัวเองดึงจาก edge
 *
 * เอาเส้น `rtspRaw` (codec ของกล้องเอง ไม่ผ่าน transcode ที่ edge) ก่อนเสมอ: edge ตามแผนคือ
 * passthrough ล้วน ส่วนการ transcode เป็นหน้าที่ของ central ที่มีการ์ดจอ ถ้า edge ปิดเส้น raw ไว้
 * ก็ถอยไปใช้ `rtsp` ซึ่งเป็น H.264 ที่ edge transcode มาแล้ว
 *
 * URL ที่ edge คืนมามีบัญชี RTSP ของ go2rtc ที่ edge ติดมาด้วย (ถ้าเปิดไว้) — นั่นคือรหัสของ edge
 * ไม่ใช่รหัสกล้อง และต้องเก็บไว้เพื่อให้ go2rtc ที่นี่ดึงได้
 */
function rtspFrom(streamSet, which) {
  const s = streamSet?.[which];
  if (!s) return null;
  for (const url of [s.urls?.rtspRaw, s.urls?.rtsp]) {
    if (!url) continue;
    if (isSafeEdgeRtsp(url)) return String(url);
    warnRejected(url, `edge stream ${which}`);
  }
  return null;
}

/**
 * URL ที่ edge ส่งมาให้ go2rtc ของ central ดึง — รับเฉพาะ rtsp:// / rtsps:// ล้วน
 *
 * go2rtc ตีความ `exec:`, `ffmpeg:`, `file`, `http` และ fragment `#raw=...` (อาร์กิวเมนต์ ffmpeg ดิบ) เป็นคำสั่งได้
 * edge ที่ถูกยึดหรือปลอมจึงห้ามส่งอะไรนอกจาก RTSP เปล่า ๆ — ไม่มีช่องว่าง, `"` หรือ `#`
 */
const isSafeEdgeRtsp = (url) => /^rtsps?:\/\/[^\s"#]+$/i.test(String(url || ''));

/** ตัดบัญชีใน URL ออกก่อนเขียน log — redactUrls ครอบ rtsp/http ทุกตำแหน่ง ตัวแรกครอบ scheme แปลก ๆ ที่หัวสตริง */
const redactUrl = (url) => redactUrls(String(url || '').replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]*@/i, '$1***@')).slice(0, 200);

const warnedUrls = new Set();
/** log การปฏิเสธครั้งเดียวต่อ URL (sync วนทุกไม่กี่วินาที อย่าให้ log ท่วม) */
function warnRejected(url, where) {
  const key = String(url);
  if (warnedUrls.has(key)) return;
  if (warnedUrls.size > 500) warnedUrls.clear();
  warnedUrls.add(key);
  console.warn(`[Edge] ปฏิเสธที่อยู่สตรีมที่ไม่ใช่ RTSP (${where}): ${redactUrl(url)}`);
}

module.exports = {
  EdgeClient, EdgeAuthError, EdgeUnavailable, EdgeRequestError, rtspFrom, isSafeEdgeRtsp, redactUrl, warnRejected,
  RECORDER_TIMEOUT_MS,
};
