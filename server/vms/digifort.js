/**
 * client ของ Digifort HTTP API (ยืนยันกับ ENTERPRISE 7.4.1.1)
 *
 * ยกกฎมาจาก D:\AI cam project\camera-watch\digifort.py ทั้งชุด ไม่ได้คิดกฎใหม่ —
 * ระบบเฝ้าตัวนั้นวิ่งกับ Digifort เครื่องเดียวกันนี้มาเป็นเดือนแล้ว ข้อจำกัดที่มันเจอ
 * คือข้อจำกัดของเราเหมือนกัน
 *
 * กฎเหล็ก: **เจอ 401/403 แล้วต้องหยุดทันที ห้าม retry**
 * Digifort ตั้ง "Block account after login attempts with wrong password = 3" การ retry
 * ด้วยรหัสที่ผิดสามรอบแปลว่าบัญชีถูกบล็อก แล้วกล้องทุกตัวที่ดึงผ่านบัญชีนั้นดับพร้อมกัน
 *
 * ยืนยันแล้วว่าใช้ได้:
 *   GetStatus   -> Name, Active, Working, RecordingFPS
 *   GetCameras  -> Name, Description, Model, DeviceType, Group (Group เป็น GUID)
 *   GetGroups   -> ID, Name, Parent  (ใช้แปลง GUID ข้างบนเป็นชื่อที่คนอ่านออก)
 *   RTSP relay  -> rtsp://host:554/Interface/Cameras/Media?Camera=<ชื่อ>
 *
 * ยืนยันแล้วว่าใช้ไม่ได้ อย่าเสียเวลาลองซ้ำ:
 *   /Interface/Configuration/*      -> 404 ทั้งหมด (จึงไม่มีทางรู้ IP/รหัสของหัวกล้อง)
 *   HTTP media บนพอร์ต 8601         -> 404 ทั้งหมด (GetPicture, GetLiveStream, ...)
 *   &Stream=1 / &Media=Video&Stream=2 -> คืนเส้นเดียวกับ main (Digifort ไม่มี substream ให้)
 */
const axios = require('axios');

/** 401/403 หรือสิทธิ์ไม่พอ — ต้องให้คนเข้าไปแก้ ห้าม retry เด็ดขาด */
class DigifortAuthError extends Error {}

/** ติดต่อไม่ได้หรือตอบมาผิดรูป — retry ได้ ถือว่า VMS มีปัญหาชั่วคราว */
class DigifortUnavailable extends Error {}

/** ย่อ error ของ axios ให้เหลือสาเหตุจริง ไม่ลากทั้ง config ที่มีรหัสผ่านอยู่ข้างในมาด้วย */
const shortError = (err) => {
  const text = err?.code || err?.message || String(err);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
};

class DigifortClient {
  constructor({ host, port = 8601, user, pass, timeoutMs = 20000 }) {
    this.base = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
    this.http = axios.create({
      baseURL: this.base,
      timeout: timeoutMs,
      auth: { username: user, password: pass },
      headers: { 'User-Agent': 'gw-cctv-gateway/1.0' },
      // ตรวจสถานะเองข้างล่าง เพื่อให้ 401 กลายเป็น DigifortAuthError ไม่ใช่ error ทั่วไป
      // ที่ผู้เรียกอาจ retry ต่อโดยไม่รู้ตัว
      validateStatus: () => true,
    });
  }

  async get(path) {
    const sep = path.includes('?') ? '&' : '?';
    let resp;
    try {
      resp = await this.http.get(`${path}${sep}ResponseFormat=JSON`);
    } catch (err) {
      throw new DigifortUnavailable(shortError(err));
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new DigifortAuthError(
        `Digifort ปฏิเสธการยืนยันตัวตน (HTTP ${resp.status}) — หยุดทันทีเพื่อไม่ให้บัญชีถูกบล็อก`,
      );
    }
    if (resp.status !== 200) throw new DigifortUnavailable(`Digifort ตอบ HTTP ${resp.status}`);

    const body = resp.data;
    if (!body || typeof body !== 'object') throw new DigifortUnavailable('Digifort ตอบกลับมาไม่ใช่ JSON');

    const response = body.Response || {};
    if (response.Code !== 0) {
      const message = response.Message || '';
      // Code 10 = สิทธิ์ไม่พอ ซึ่งคนต้องเข้าไปแก้ ไม่ใช่ปัญหาชั่วคราว
      if (response.Code === 10) throw new DigifortAuthError(`สิทธิ์ไม่พอสำหรับคำสั่งนี้: ${message}`);
      throw new DigifortUnavailable(`Digifort ตอบ Code=${response.Code} ${message}`);
    }
    return response.Data || {};
  }

  async getCameras() {
    const data = await this.get('/Interface/Cameras/GetCameras');
    return (data.Cameras || []).map((c) => ({
      name: c.Name || '',
      description: c.Description || '',
      model: c.Model || '',
      deviceType: c.DeviceType || '',
      groupId: c.Group || '',
    }));
  }

  async getStatus() {
    const data = await this.get('/Interface/Cameras/GetStatus');
    return (data.Cameras || []).map((c) => ({
      name: c.Name || '',
      active: Boolean(c.Active),
      working: Boolean(c.Working),
      fps: Number(c.RecordingFPS) || 0,
    }));
  }

  async getGroups() {
    const data = await this.get('/Interface/Cameras/GetGroups');
    return (data.Groups || []).map((g) => ({ id: g.ID || '', name: g.Name || '', parent: g.Parent || '' }));
  }

  async getServerInfo() {
    const data = await this.get('/Interface/Server/GetInfo');
    return data.Info || {};
  }
}

/**
 * URL ของเส้น relay สำหรับกล้องหนึ่งตัว
 *
 * encode ทุกส่วน ไม่ใช่แค่ชื่อกล้อง: ชื่อกล้องเป็นภาษาไทยได้ และรหัสผ่านของบัญชี
 * service มีสิทธิ์มีอักขระอย่าง @ : / ซึ่งถ้าไม่ encode จะทำให้ URL ชี้ไปคนละที่เงียบๆ
 */
const relayRtspUrl = ({ host, rtspPort = 554, user, pass, cameraName }) => {
  const cred = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
  const cam = encodeURIComponent(cameraName);
  return `rtsp://${cred}@${host}:${rtspPort}/Interface/Cameras/Media?Camera=${cam}`;
};

/** ตัดรหัสผ่านออกจากข้อความก่อน log — URL relay มีรหัสฝังอยู่เสมอ */
const maskRtsp = (url) => String(url || '').replace(/\/\/[^@/]+@/, '//***@');

module.exports = { DigifortClient, DigifortAuthError, DigifortUnavailable, relayRtspUrl, maskRtsp };
