/** ค้นกล้องที่ผูกกับ AXIS S30 ผ่าน VAPIX โดยไม่ส่งรหัสหรือ URL ภาพกลับหน้าเว็บ */
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const agent = new https.Agent({ rejectUnauthorized: false }); // ใบรับรองที่ recorder สร้างเอง

function validHost(value) {
  return typeof value === 'string' && /^[a-z\d][a-z\d.-]*$/i.test(value) && value.length <= 253;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function axisS30Rtsp({ ip, rtspPort, user, pass, sourceId }) {
  if (!validHost(ip) || !validPort(rtspPort) || !/^[a-z\d_-]{1,100}$/i.test(String(sourceId || ''))
    || !user || !pass) throw new Error('ข้อมูลช่อง AXIS S30 ไม่ถูกต้อง');
  return `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:${Number(rtspPort)}/axis-media/media.amp?device=${encodeURIComponent(sourceId)}`;
}

async function axisGet({ ip, apiPort = 443, user, pass }, path) {
  if (!validHost(ip) || !validPort(apiPort)) throw new Error('AXIS S30 ต้องระบุ IP และ API port ที่ถูกต้อง');
  if (!user || !pass) throw new Error('AXIS S30 ต้องใช้บัญชีเว็บของ recorder');
  const raw = await new Promise((resolve, reject) => {
    const req = https.get({
      hostname: ip, port: Number(apiPort), path,
      agent, timeout: 12000,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('AXIS S30 response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`AXIS S30 API HTTP ${res.statusCode}`));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AXIS S30 API timeout')));
    req.on('error', reject);
  });
  return raw;
}

async function readAxisS30Devices(config) {
  const raw = await axisGet(config, '/axis-cgi/externalipdeviceinfo/list.cgi?schemaversion=2');
  const response = parser.parse(raw)?.DeviceResponse;
  if (!Object.hasOwn(response || {}, 'ListDevicesSuccess')) {
    throw new Error(response?.GeneralError?.Description || 'AXIS S30 ไม่ส่งรายการกล้อง');
  }
  const devices = response.ListDevicesSuccess.Device;
  const list = devices ? (Array.isArray(devices) ? devices : [devices]) : [];
  return list.filter((item) => /^[a-z\d_-]{1,100}$/i.test(String(item.Id || '')))
    .map((item, index) => ({
      id: String(item.Id), sourceId: String(item.Id), channel: index + 1,
      name: String(item.Description === 'Created by AXIS Companion'
        ? item.Serialnumber || `CH ${index + 1}`
        : item.Description || item.Serialnumber || `CH ${index + 1}`).trim(),
      isOnline: true,
    }));
}

/** ดึง metadata ของคลิป; ไม่ดาวน์โหลดภาพและไม่ส่งบัญชีในผลลัพธ์ */
async function listAxisS30Recordings(config) {
  const raw = await axisGet(config, '/axis-cgi/record/list.cgi?recordingid=all');
  const root = parser.parse(raw)?.root;
  const recordings = root?.recordings?.recording;
  if (!root?.recordings) throw new Error('AXIS S30 ไม่ส่งรายการบันทึก');
  return recordings ? (Array.isArray(recordings) ? recordings : [recordings]) : [];
}

/**
 * sub ของช่อง AXIS S30 — S30 ส่งภาพกล้องตัวเดียวต่อ Device ID ไม่มี stream 2 แต่ย่อขนาดให้ได้ด้วยพารามิเตอร์ VAPIX
 * ทดสอบแล้ว 2026-10-06 ที่ 203.0.113.10 (Edge 102): `&resolution=640x360` ได้ h264 640×360 · เดิม sub = main (1080p)
 */
function axisS30SubRtsp(mainRtsp) {
  const url = String(mainRtsp || '');
  if (!url || /[?&]resolution=/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}resolution=640x360`;
}

module.exports = { readAxisS30Devices, listAxisS30Recordings, axisS30Rtsp, axisS30SubRtsp };
