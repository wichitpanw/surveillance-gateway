/**
 * อ่านผล perimeter ที่ Tiandy ประมวลผลแล้ว — ใช้ AlarmInfo จากเว็บ firmware จริง
 * ไม่ล้างคิวในกล้อง และไม่เปลี่ยนกฎ/ตารางเวลา
 */
const crypto = require('crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { digestRequest } = require('./http-digest');
const { toBangkokIso } = require('../../shared/time');
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const TYPES = {
  fielddetection: 'intrusion', linedetection: 'line_cross',
  doublelinedetection: 'line_cross', regionentrance: 'region_enter',
  regionexiting: 'region_exit', loitering: 'loitering',
};

/** firmware ของกล้องทดลองใส่ GMT/Z หลังเวลาหน้าปัดไทย — เลือกวิธีอ่านต่อแหล่งได้ */
function cameraTime(raw, mode = 'bangkok-wall') {
  let text = String(raw || '').trim();
  if (mode === 'bangkok-wall') {
    if (/GMT$/.test(text)) text = text.replace(/GMT$/, '+0700');
    else if (/Z$/.test(text)) text = text.replace(/Z$/, '+07:00');
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) text += '+07:00';
  }
  if (!text || !/(?:GMT|Z|[+-]\d{2}:?\d{2})$/.test(text)) throw new Error('เวลา event ของ Tiandy ไม่มีเขตเวลา: ' + String(raw || ''));
  const ts = toBangkokIso(text);
  if (!ts) throw new Error('อ่านเวลา event ของ Tiandy ไม่ได้');
  return ts;
}

/** แปลงเฉพาะ perimeter ที่รู้จัก — ไม่ตีความ motion เป็น intrusion */
function parseAlarmInfo(xml, { cameraId, channel = 1, timeMode = 'bangkok-wall' }) {
  if (XMLValidator.validate(xml) !== true) throw new Error('AlarmInfo ไม่ใช่ XML ที่สมบูรณ์');
  const root = parser.parse(xml);
  if (!Object.hasOwn(root, 'AlarmItemList')) throw new Error('Tiandy ไม่ตอบ AlarmItemList');
  const items = root.AlarmItemList?.AlarmItem;
  const list = items ? (Array.isArray(items) ? items : [items]) : [];
  return list.flatMap((item) => {
    const vendorType = String(item.eventType || '');
    const type = TYPES[vendorType.toLowerCase()];
    if (!type || Number(item.channelID) !== Number(channel)) return [];
    const ts = cameraTime(item.dateTime, timeMode);
    const scene = String(item.SceneID || '');
    const ruleId = String(item.ruleID || '');
    const identity = [cameraId, channel, scene, ruleId, vendorType.toLowerCase(), ts];
    return [{
      type, origin: 'camera', ts,
      eventId: 'tiandy:' + crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 56),
      rule: String(item.ruleName || '') || ('Scene ' + scene + ' / Rule ' + ruleId),
      attrs: { provider: 'tiandy', vendorEventType: vendorType, channel: Number(channel),
        sceneId: scene, ruleId, rawTime: String(item.dateTime), timeMode,
        transport: 'alarm-info', detectionSource: 'camera', deliverySource: 'camera' },
    }];
  });
}

/** อ่านอย่างเดียว: GET นี้คือรายการที่กล้องเก็บไว้จำนวนจำกัด ไม่ใช่ประวัติถาวร */
async function readPerimeter(cam, options) {
  const xml = await digestRequest(cam, '/CGI/Smart/AlarmInfo');
  return parseAlarmInfo(xml, options);
}

module.exports = { parseAlarmInfo, cameraTime, readPerimeter };
