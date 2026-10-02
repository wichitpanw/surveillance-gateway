/**
 * client ของ Dahua DSS Pro v8 OpenAPI (ยืนยันกับ DSS Pro V8.5.0 เมื่อ 2026-09-29)
 *
 * แนวทางมาจาก D:\AI cam project\camera-watch\dss.py ที่เฝ้า DSS เครื่องเดียวกันอยู่แล้ว + ทดสอบเพิ่ม:
 *   login    POST /brms/api/v1.0/accounts/authorize สองขั้น (ขั้นแรกส่งแค่ userName ได้ realm/randomKey → ขั้นสองส่ง signature)
 *            clientType ต้องเป็น "WEB" (DSS v8 ปฏิเสธ WINPC ด้วย 110001) · token อายุ ~30 วิ → keepalive ทุก 20 วิ
 *   กล้อง    POST /brms/api/v1.1/device/channel/list { ids: ["<deviceCode>$1$0$0", …] } — device/page ใช้ไม่ได้ (1001)
 *            จึงไล่ช่วงรหัสอุปกรณ์เหมือน camera-watch
 *   สด       POST /brms/api/v1.0/MTS/Video/StartVideo → url + token · **URL ใช้ได้ครั้งเดียว** (เปิดซ้ำ = 401)
 *            streamType 1 = main (1920x1080), 2 = sub (704x576)
 *   ย้อนหลัง  POST /brms/api/v1.0/SS/Record/QueryRecords (recordSource 3) → StartPlaybackByFile เริ่มกลางไฟล์ได้
 *            (StartPlaybackByTime ตอบ 2060 "stream id does not exist" บนเครื่องนี้)
 *   PTZ      POST /brms/api/v1.0/DMS/Ptz/OperateDirect (หัน) · /DMS/Ptz/OperateCamera (ซูม) · command 1 = เริ่ม, 0 = หยุด
 *
 * กฎเหล็กเหมือน Digifort: **login ไม่ผ่านเพราะรหัสผิด = หยุด ห้ามลองซ้ำ** (DSS ล็อกบัญชี) — ต้องให้คนกรอกรหัสใหม่
 */
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

/** รหัสผิด / สิทธิ์ไม่พอ — ห้าม retry */
class DssAuthError extends Error {}
/** ติดต่อไม่ได้ / ตอบผิดรูป — retry ได้ */
class DssUnavailable extends Error {}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** signature ของ DSS: MD5 ซ้อนหลายชั้น ลำดับสำคัญ — สลับแล้วได้ 401 โดยไม่มีคำใบ้ */
function buildSignature(user, password, realm, randomKey) {
  const t3 = md5(md5(user + md5(password)));
  return md5(`${md5(`${user}:${realm}:${t3}`)}:${randomKey}`);
}

/** ตัด token ออกจากข้อความก่อน log */
const hideToken = (s) => String(s || '').replace(/([?&](?:token|session)=)[^&\s]+/gi, '$1***');
const withToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${token}` : url);

const KEEPALIVE_MS = 20_000;
const SCAN_START = 1000000;
const SCAN_BATCH = 400;
const SCAN_HEADROOM = 800;

class DssClient {
  /** @param {{host:string, port?:number, user:string, pass:string, secure?:boolean, timeoutMs?:number}} opts */
  constructor({ host, port = 443, user, pass, secure = true, timeoutMs = 20_000 }) {
    this.host = String(host || '').trim();
    this.port = Number(port) || 443;
    this.user = String(user || '');
    this.pass = String(pass || '');
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.authFailed = null; // ข้อความเมื่อรหัสผิด — ตั้งแล้วห้าม login อีกจนกว่าจะสร้าง client ใหม่ (กรอกรหัสใหม่)
    this.keepaliveTimer = null;
    this.loginPromise = null;
  }

  raw(method, path, body) {
    const data = body === undefined ? null : JSON.stringify(body);
    const transport = this.secure ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request({
        host: this.host, port: this.port, path, method, rejectUnauthorized: false, timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'User-Agent': 'gw-cctv-gateway/1.0',
          ...(this.token ? { 'X-Subject-Token': this.token } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', (err) => reject(new DssUnavailable(err.message)));
      });
      req.on('timeout', () => req.destroy(new DssUnavailable(`DSS ${this.host} ไม่ตอบภายใน ${this.timeoutMs / 1000} วินาที`)));
      req.on('error', (err) => reject(err instanceof DssUnavailable ? err : new DssUnavailable(`ติดต่อ DSS ${this.host} ไม่ได้: ${err.message}`)));
      if (data) req.write(data);
      req.end();
    });
  }

  /** login หนึ่งรอบ (คำขอพร้อมกันใช้รอบเดียวกัน) · รหัสผิด = DssAuthError และ latch ไว้ */
  login() {
    if (this.authFailed) return Promise.reject(new DssAuthError(this.authFailed));
    if (!this.loginPromise) {
      this.loginPromise = this.doLogin().finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  async doLogin() {
    this.token = null;
    // ขั้นนี้ยังไม่ส่งรหัสผ่าน จึงไม่นับเป็นการ login พลาด
    const c1 = await this.raw('POST', '/brms/api/v1.0/accounts/authorize', { userName: this.user, ipAddress: '', clientType: 'WEB' });
    const { realm, randomKey, encryptType } = c1.json || {};
    if (!realm || !randomKey) throw new DssUnavailable(`DSS ไม่ส่ง challenge (HTTP ${c1.status})`);
    const c2 = await this.raw('POST', '/brms/api/v1.0/accounts/authorize', {
      userName: this.user, signature: buildSignature(this.user, this.pass, realm, randomKey), randomKey,
      encryptType: encryptType || 'MD5', ipAddress: '', clientType: 'WEB', userType: '0',
    });
    if (c2.status === 200 && c2.json?.token) {
      this.token = c2.json.token;
      this.startKeepalive();
      return c2.json;
    }
    if (c2.status === 401 || c2.status === 403 || c2.status === 200) {
      this.authFailed = `DSS ไม่รับบัญชี ${this.user} (HTTP ${c2.status}${c2.json?.code ? ` code ${c2.json.code}` : ''})`
        + ' — หยุดไว้ไม่ลองซ้ำเพื่อไม่ให้บัญชีถูกล็อก กรอกรหัสใหม่ที่หน้า Cameras';
      throw new DssAuthError(this.authFailed);
    }
    throw new DssUnavailable(`DSS ตอบ HTTP ${c2.status} ตอน login`);
  }

  startKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(async () => {
      if (!this.token) return;
      try {
        const r = await this.raw('PUT', '/brms/api/v1.0/accounts/keepalive', { token: this.token });
        if (r.json?.code !== 1000) this.token = null; // session หลุด — คำขอถัดไป login ใหม่
      } catch {
        this.token = null;
      }
    }, KEEPALIVE_MS);
    this.keepaliveTimer.unref?.();
  }

  /**
   * เรียก OpenAPI ที่ตอบ { code, desc, data } · code 1000 = สำเร็จ
   * session หลุด (401) → login ใหม่หนึ่งครั้ง · 1104 = สิทธิ์ไม่พอ (ไม่ retry)
   */
  async api(path, body, { retry = true } = {}) {
    if (!this.token) await this.login();
    const r = await this.raw('POST', path, body);
    if (r.status === 401 && retry) {
      this.token = null;
      return this.api(path, body, { retry: false });
    }
    const code = r.json?.code;
    if (code === 1104) throw new DssAuthError(`สิทธิ์ของบัญชี ${this.user} ไม่พอสำหรับ ${path}`);
    if (r.status !== 200 || code !== 1000) {
      const err = new DssUnavailable(`DSS ${path.split('/').slice(-2).join('/')}: ${r.json?.desc || `HTTP ${r.status}`}${code ? ` (code ${code})` : ''}`);
      err.code = code;
      throw err;
    }
    return r.json.data;
  }

  /** ช่องตามรายการ id (แบ่งคำขอละ ≤ 400) */
  async channels(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += SCAN_BATCH) {
      const data = await this.api('/brms/api/v1.1/device/channel/list', { ids: ids.slice(i, i + SCAN_BATCH) });
      out.push(...(data?.results || []));
    }
    return out;
  }

  /**
   * ทุกช่องใน DSS — ไล่รหัสอุปกรณ์ตั้งแต่ 1000000 ไปจนเลยรหัสสูงสุดที่เจอ SCAN_HEADROOM ตัว
   * (รหัสของ DSS เดินขึ้นเรื่อย ๆ และบัญชีระดับ operator เรียก device/list ไม่ได้)
   */
  async listAllChannels() {
    const out = [];
    let ceiling = SCAN_START + SCAN_HEADROOM;
    for (let start = SCAN_START; start < ceiling && start < SCAN_START + 200_000; start += SCAN_BATCH) {
      const ids = Array.from({ length: SCAN_BATCH }, (_, i) => `${start + i}$1$0$0`);
      const found = await this.channels(ids);
      out.push(...found);
      for (const c of found) {
        const code = Number(c.deviceCode);
        if (Number.isFinite(code)) ceiling = Math.max(ceiling, code + SCAN_HEADROOM);
      }
    }
    return out;
  }

  /** URL ภาพสดใช้ครั้งเดียว (รวม token แล้ว) · stream = 'main' | 'sub' */
  async liveUrl(channelId, stream = 'main') {
    const data = await this.api('/brms/api/v1.0/MTS/Video/StartVideo', {
      data: { channelId, dataType: '1', streamType: stream === 'sub' ? '2' : '1' },
    });
    if (!data?.url) throw new DssUnavailable('DSS ไม่ส่ง URL ภาพสด');
    return withToken(data.url, data.token);
  }

  /** ไฟล์บันทึกในช่วง [fromMs, toMs] */
  async records(channelId, fromMs, toMs) {
    const data = await this.api('/brms/api/v1.0/SS/Record/QueryRecords', {
      data: {
        channelId, recordSource: '3', streamType: '0', recordType: '0',
        startTime: String(Math.floor(fromMs / 1000)), endTime: String(Math.ceil(toMs / 1000)),
      },
    });
    return (data?.records || []).map((r) => ({ ...r, start: Number(r.startTime) * 1000, end: Number(r.endTime) * 1000 }))
      .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
  }

  /** URL ภาพย้อนหลังใช้ครั้งเดียว เริ่มที่ atMs ภายในไฟล์ rec */
  async playbackUrl(channelId, rec, atMs) {
    const data = await this.api('/brms/api/v1.0/SS/Playback/StartPlaybackByFile', {
      data: {
        ssId: rec.ssId, optional: '/admin/API/SS/Playback/StartPlaybackByFile',
        startTime: String(Math.floor(atMs / 1000)), endTime: String(rec.endTime),
        fileName: rec.recordName, diskId: rec.diskId, nvrId: '', recordSource: rec.recordSource || '3',
        channelId, playbackMode: '0', streamId: rec.streamId || '',
      },
    });
    if (!data?.url) throw new DssUnavailable('DSS ไม่ส่ง URL ภาพย้อนหลัง');
    return withToken(data.url, data.token);
  }

  /** หัน: direct 1–8 (บน ล่าง ซ้าย ขวา ซ้ายบน ขวาบน ซ้ายล่าง ขวาล่าง) · step 1–8 · start true/false */
  ptzDirect(channelId, direct, step, start) {
    const s = String(Math.min(8, Math.max(1, Math.round(step))));
    return this.api('/brms/api/v1.0/DMS/Ptz/OperateDirect', {
      data: { channelId, direct: String(direct), stepX: s, stepY: s, command: start ? '1' : '0' },
    });
  }

  /** ซูม: zoomIn = true เข้า / false ออก */
  ptzZoom(channelId, zoomIn, step, start) {
    return this.api('/brms/api/v1.0/DMS/Ptz/OperateCamera', {
      data: {
        channelId, operateType: '1', direct: zoomIn ? '1' : '2',
        step: String(Math.min(8, Math.max(1, Math.round(step)))), command: start ? '1' : '0',
      },
    });
  }

  /** เลิกใช้ client: หยุด keepalive แล้ว logout (ไม่รอผล) */
  close() {
    clearInterval(this.keepaliveTimer);
    if (this.token) {
      this.raw('POST', '/brms/api/v1.0/accounts/unauthorize', { userName: this.user, token: this.token }).catch(() => {});
    }
    this.token = null;
  }
}

module.exports = { DssClient, DssAuthError, DssUnavailable, buildSignature, hideToken, withToken };
