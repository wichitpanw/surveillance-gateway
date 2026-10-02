/**
 * ตัวอ่าน metadata ของ AI จากหัวกล้อง Tiandy (CGI API)
 *
 * ยกมาจากโปรเจค People Counting (`src/camera.js`) ซึ่งอ่าน endpoint เหล่านี้ออกมาจาก
 * web UI ของกล้องเอง (js/app.min.js) และผ่านการใช้งานกับ MODEL-A จริงมาแล้ว
 *
 *   POST /CGI/Smart/QueryReport/channels/{ch}                   -> รายงานนับคน
 *   GET  /CGI/Smart/Demographics/1/channels/{ch}/Scene/{scene}   -> กฎ + ยอดสด
 *
 * กล้องรับเฉพาะ HTTP Digest (Basic ถูกปฏิเสธตั้งแต่ระดับ TCP) และพูด XML ทั้งขาไปขากลับ
 */
const { XMLParser } = require('fast-xml-parser');
const { digestRequest } = require('./http-digest');

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

async function digestXml(cam, path, opts) {
  return parser.parse(await digestRequest(cam, path, opts));
}

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** ช่วงเวลาที่รายงานคืนมา — 0 = รายวัน (ได้ 24 ช่องรายชั่วโมง) */
const REPORT_PRE = { day: 0, week: 1, month: 2, year: 3 };

/**
 * ชนิดรายงานนับคน
 *
 * ต้องเป็น 18 เท่านั้น — 18 คือรายงานแบบเส้นตัดผ่าน (TRIPWIRE) ซึ่งเป็นชนิดเดียวที่มี
 * ข้อมูลจริงบนกล้องรุ่นนี้ ส่วน 21 ที่หน้าเว็บของกล้องเองเรียกใช้ คืนศูนย์ทั้งหมด
 */
const REPORT_TYPE_PEOPLE = 18;

/**
 * แปลง `logContent` ของรายงานนับคน
 *
 * รูปแบบคือ `เข้า:ออก:อื่นๆ` เช่น "4:3:0" = เข้า 4 ออก 3 ส่วนรายงานชนิดอื่นคืนเลขตัวเดียว
 */
function parseLogContent(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { in: 0, out: null };
  if (text.includes(':')) {
    const parts = text.split(':').map((p) => Number.parseInt(p, 10) || 0);
    return { in: parts[0], out: parts[1] ?? 0 };
  }
  return { in: Number.parseInt(text, 10) || 0, out: null };
}


/**
 * จัดรูปเวลาที่กล้องต้องการ: `YYYY-MM-DDTHH:mm:ssZ`
 *
 * ลงท้ายด้วย Z แต่ไม่ใช่ UTC — เป็นเวลาบนนาฬิกาของกล้องเอง ตัว Z เป็นแค่รูปแบบที่
 * firmware ต้องการ ผู้เรียกต้องส่งเวลาที่ "อ่านบนหน้าปัดกล้อง" เข้ามา
 *
 * รับเป็นสตริงล้วน ไม่รับ Date โดยตั้งใจ — ดูเหตุผลที่ queryDay
 *
 * @param {string} dayKey `YYYY-MM-DD`
 * @param {string} clock  `HH:mm:ss`
 */
function toCamTime(dayKey, clock) {
  return `${dayKey}T${clock}Z`;
}

/**
 * ดึงรายงานนับคน คืน `[{ camTime, in, out }]`
 *
 * `camTime` เป็นเวลาบนนาฬิกาของกล้องแบบไร้เขตเวลา (`YYYY-MM-DD HH:mm:ss`) จงใจไม่แปลง
 * ที่นี่ — การแปลงเป็น UTC ต้องรู้เขตเวลาของกล้องซึ่งเป็นความรู้ของชั้นที่เรียกใช้ ไม่ใช่
 * ของตัว adapter
 */
async function queryReport(cam, { reportPre = REPORT_PRE.day, start, end } = {}) {
  const body =
    `<QueryReport>` +
    `<reportType>${REPORT_TYPE_PEOPLE}</reportType>` +
    `<reportPre>${reportPre}</reportPre>` +
    `<timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan>` +
    `</QueryReport>`;

  const xml = await digestXml(cam, `/CGI/Smart/QueryReport/channels/${cam.channel ?? 1}`, {
    method: 'POST',
    body,
  });

  const results = toArray(xml?.QueryReportResult?.queryResultList?.queryResult);
  return results.map((r) => {
    const { in: cin, out } = parseLogContent(r.logContent);
    return {
      camTime: String(r.time ?? '').replace('T', ' ').replace(/Z$/, ''),
      in: cin,
      out,
    };
  });
}

/**
 * ดึงทั้งวัน (24 ช่องรายชั่วโมง)
 *
 * ถามทั้งวันเสมอแม้ต้องการแค่ชั่วโมงล่าสุด เพราะกล้องคิดค่าใช้จ่ายเท่ากันทั้งสองแบบ และการ
 * ดึงทั้งวันทำให้ช่องที่เคยขาดหายถูกเติมกลับเองในรอบถัดไป ไม่ต้องมีกลไกซ่อมแยก
 *
 * ### ทำไมรับเป็นสตริง ไม่ใช่ Date
 *
 * ทั้งเส้นทางนี้พูดภาษาเดียวคือ "เวลาบนหน้าปัดกล้อง" ซึ่งเป็นสตริงไร้เขตเวลา ตั้งแต่สิ่งที่
 * ส่งไป (`YYYY-MM-DDTHH:mm:ssZ` ที่ Z ไม่ได้แปลว่า UTC) จนถึงสิ่งที่ได้กลับมา (`camTime`
 * ที่ camTimeToBangkokIso แค่แปะ `+07:00` ทับ ไม่ได้แปลงเขต)
 *
 * เดิมรับเป็น Date แล้วเรียก setHours/getHours ซึ่งอ่านเขตเวลาของ process มาใช้ ทำให้
 * ผลลัพธ์ขึ้นกับ TZ ของเครื่องที่รัน ทั้งที่ไม่ควรเกี่ยวกันเลย — และเป็นเหตุที่การแก้บั๊ก
 * `today` แบบง่าย ๆ (เปลี่ยนเป็น todayKey เฉย ๆ) จะได้บั๊กเงียบตัวใหม่แทน เพราะ
 * `new Date('2026-08-23')` คือเที่ยงคืน UTC ไม่ใช่เที่ยงคืนที่กล้อง
 *
 * @param {string} dayKey วันที่ตามนาฬิกาของกล้อง รูปแบบ `YYYY-MM-DD`
 */
async function queryDay(cam, dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) {
    throw new Error(`queryDay ต้องการวันที่รูปแบบ YYYY-MM-DD แต่ได้ ${JSON.stringify(dayKey)}`);
  }
  return queryReport(cam, {
    reportPre: REPORT_PRE.day,
    start: toCamTime(dayKey, '00:00:00'),
    end: toCamTime(dayKey, '23:59:59'),
  });
}

const asBool = (v) => String(v).toLowerCase() === 'true';

/**
 * อ่านกฎการนับจากกล้อง — ใช้ตรวจว่ากล้องเปิดระบบนับคนไว้จริงไหม
 *
 * `enabled` สำคัญกว่าที่คิด: กล้องที่ปิดฟังก์ชันนับคนจะตอบทุกคำขอได้อย่างสมบูรณ์แล้ว
 * รายงานว่าไม่มีใครเดินผ่านตลอดกาล ซึ่งแยกไม่ออกจากประตูที่เงียบจริงๆ
 */
async function getDemographics(cam) {
  const xml = await digestXml(
    cam,
    `/CGI/Smart/Demographics/1/channels/${cam.channel ?? 1}/Scene/${cam.scene ?? 0}`,
  );
  const d = xml?.Demographics ?? {};
  return {
    enabled: asBool(d.enabled),
    mode: String(d.mode ?? ''),
    stayNum: Number.parseInt(d.stayNum, 10) || 0,
    clearAt: {
      frequency: String(d.frequency ?? ''),
      hour: Number.parseInt(d.hour, 10) || 0,
      minute: Number.parseInt(d.minute, 10) || 0,
    },
  };
}

/**
 * ตรวจว่ากล้องตัวนี้มี metadata นับคนให้ดึงไหม
 *
 * คืน `null` เมื่อไม่รองรับ ไม่ throw — "กล้องไม่มีระบบนับคน" เป็นสถานะปกติของอุปกรณ์
 * ส่วนใหญ่ ไม่ใช่ความผิดพลาดที่ต้องรายงาน ส่วนความผิดพลาดจริง (เน็ตไม่ถึง รหัสผ่านผิด)
 * ยังโยนขึ้นไปตามเดิม เพราะสองอย่างนี้ต้องแยกกันให้ขาด
 */
async function probe(cam) {
  const demo = await getDemographics(cam);
  if (!demo.enabled) return null;
  return { kind: 'people_counting', mode: demo.mode, clearAt: demo.clearAt };
}

module.exports = {
  probe,
  queryDay,
  queryReport,
  getDemographics,
  parseLogContent,
  REPORT_PRE,
  REPORT_TYPE_PEOPLE,
};
