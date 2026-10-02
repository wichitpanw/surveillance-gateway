/**
 * ตัวแกะ ONVIF metadata — ฟังก์ชันบริสุทธิ์ล้วน ไม่มี socket
 *
 * สิ่งที่ตัดสินว่าเราบันทึกอะไรอยู่ในไฟล์นี้ทั้งหมด ไม่ใช่ในโมดูลที่ถือ socket เพราะนี่คือ
 * ส่วนที่พังแบบไม่ส่งเสียง — parser ที่จำรูปร่างของกล้องไม่ได้แล้วจะไม่โยน error มันแค่
 * รายงานว่าไม่มีใครเดินผ่านไปเรื่อย ๆ ตลอดกาล จึงต้องไม่มี I/O ปนและทดสอบตรงได้
 *
 * ### ทำไมไม่ผูกกับ topic ใด topic หนึ่ง
 *
 * Gateway ตัวนี้เป็นศูนย์กลาง ไม่ใช่แอปนับคน ข้อความทุกชนิดของกล้องมาทางสายเดียวกันนี้อยู่แล้ว
 * — นับเส้น, ล้ำพื้นที่, ยืนวนเวียน, จำแนกวัตถุ, ตรวจจับความเคลื่อนไหว รวมถึง topic เฉพาะ
 * ของแต่ละยี่ห้อ การกรองทิ้งตั้งแต่ชั้น parser คือการโยนของที่ได้มาฟรีแล้ว และทำให้วันที่
 * ต้องรองรับ AI ตัวถัดไปต้องกลับมารื้อชั้นนี้ใหม่ ที่นี่จึงคืน "ทุกข้อความตามที่มันเป็น"
 * แล้วให้ชั้นบนตัดสินใจว่าจะเก็บอะไร
 *
 * รูปร่างข้างล่างนี้จับมาจากกล้องจริง Uniview MODEL-B firmware
 * FW-B (ผ่านโปรเจค People Counting ซึ่งไล่พิสูจน์มาก่อนแล้ว)
 */

/* ------------------------------------------------------------ RTP / RTSP framing */

/**
 * ตัด frame แบบ interleaved ออกจากหัว buffer
 *
 * รูปแบบคือ `$ <channel> <ความยาว 2 ไบต์> <payload>` และตัดสินด้วยความยาวล้วน — เครื่องหมาย
 * `$` ที่บังเอิญอยู่ใน payload ไม่มีความหมายอะไร จึงห้ามใช้การค้นหา `$` มาหาขอบ frame
 *
 * @returns {{frames: Array<{channel:number, payload:Buffer}>, rest: Buffer}}
 */
function frameInterleaved(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0x24) {
      // ไม่ใช่ขอบ frame — หาเครื่องหมายถัดไป ถ้าไม่มีก็ทิ้งทั้งก้อน
      const next = buffer.indexOf(0x24, offset + 1);
      if (next === -1) return { frames, rest: Buffer.alloc(0) };
      offset = next;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (offset + 4 + length > buffer.length) break; // ยังมาไม่ครบ รอรอบหน้า
    frames.push({ channel: buffer[offset + 1], payload: buffer.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/** ตัดหัว RTP ออกให้เหลือแต่เนื้อ — เผื่อ CSRC และ extension header ด้วย */
function rtpPayload(packet) {
  if (packet.length < 12) return Buffer.alloc(0);
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = (packet[0] >> 4) & 1;
  let offset = 12 + csrcCount * 4;
  if (hasExtension && packet.length >= offset + 4) {
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  return offset >= packet.length ? Buffer.alloc(0) : packet.subarray(offset);
}

/** RTP ทำเครื่องหมายไว้ที่ packet สุดท้ายของหนึ่งหน่วย ใช้รู้ว่าประกอบ XML ครบแล้ว */
const rtpMarker = (packet) => packet.length > 1 && (packet[1] & 0x80) !== 0;

/* ---------------------------------------------------------------- XML */

const MESSAGE_RE = /<(?:\w+:)?NotificationMessage\b[\s\S]*?<\/(?:\w+:)?NotificationMessage>/g;

/**
 * อ่านค่า attribute ตัวหนึ่ง โดยรับทั้ง `x="1"` และ `x='1'`
 *
 * XML อนุญาตทั้งสองแบบเท่าเทียมกัน การรับแบบเดียวคือ parser ที่ทำงานได้เฉพาะกับกล้องที่เรา
 * เคยทดสอบ แล้วเงียบสนิทกับยี่ห้อถัดไป — ซึ่งเป็นความพังชนิดที่ไม่มี error ให้เห็นเลย
 */
function attrOf(source, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(String(source || ''));
  if (!m) return undefined;
  return m[1] !== undefined ? m[1] : m[2];
}

/**
 * อ่าน `<tt:SimpleItem>` ทุกตัวในชิ้นส่วน XML เป็น `{ ชื่อ: ค่า }`
 *
 * จับที่ตัวแท็กก่อนแล้วค่อยอ่าน attribute แยก ไม่ได้จับ `Name="..." Value="..."` เป็นรูปแบบ
 * เดียว เพราะ ONVIF ไม่ได้รับประกันลำดับ attribute — เฟิร์มแวร์รุ่นใหม่สลับตำแหน่งเมื่อไร
 * รูปแบบตายตัวจะได้ค่าว่างตลอดไปโดยไม่มี error ให้เห็น
 */
function parseSimpleItems(xml) {
  const out = {};
  for (const tag of String(xml || '').matchAll(/<(?:\w+:)?SimpleItem\b([^>]*)>/g)) {
    const attrs = tag[1];
    const name = attrOf(attrs, 'Name');
    const value = attrOf(attrs, 'Value');
    if (name !== undefined) out[name] = value;
  }
  return out;
}

/** ตัดเอาเฉพาะเนื้อในของแท็กหนึ่ง เช่น `Source` หรือ `Data` (ไม่มีก็คืนสตริงว่าง) */
function sectionOf(message, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`);
  return re.exec(message)?.[1] ?? '';
}

/**
 * ONVIF ส่ง `UtcTime="2026-8-10T9:57:47Z"` — เดือนกับชั่วโมงไม่เติมศูนย์ ซึ่งไม่ใช่ ISO 8601
 * ที่ถูกต้อง และตกไปอยู่ในมุมที่ `new Date()` ของแต่ละ engine ตีความไม่เหมือนกัน จึงแกะเอง
 */
function parseUtcTime(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.\d+)?Z?$/.exec(
    String(value ?? '').trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * แกะทุกข้อความในหนึ่งเอกสาร metadata โดยไม่สนใจว่าเป็น topic อะไร
 *
 * `source` คือกุญแจของ "มิติ rule" — ONVIF ใส่ชื่อกฎที่ทำให้เกิดเหตุการณ์ไว้ในนั้น
 * (`Rule`, `VideoSourceConfigurationToken`, `VideoAnalyticsConfigurationToken`) กล้อง
 * ตัวเดียวที่ตั้งไว้สามเส้นจะส่งชื่อกฎต่างกันมาสามชุด ถ้าทิ้ง source ไปทั้งสามจะกองรวมกัน
 * จนแยกไม่ออกว่าเลขไหนของประตูไหน
 *
 * @returns {Array<{topic:string, utcTime:Date|null, rawUtcTime:string|null,
 *   propertyOperation:string|null, source:object, data:object, raw:string}>}
 */
function parseMessages(xml) {
  const out = [];
  for (const message of String(xml || '').match(MESSAGE_RE) ?? []) {
    const topic = /<(?:\w+:)?Topic\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Topic>/.exec(message)?.[1]?.trim() ?? '';
    const rawUtcTime = attrOf(message, 'UtcTime') ?? null;
    out.push({
      topic,
      utcTime: parseUtcTime(rawUtcTime),
      rawUtcTime,
      propertyOperation: attrOf(message, 'PropertyOperation') ?? null,
      source: parseSimpleItems(sectionOf(message, 'Source')),
      data: parseSimpleItems(sectionOf(message, 'Data')),
      raw: message,
    });
  }
  return out;
}

/**
 * ชื่อกฎที่ทำให้เกิดเหตุการณ์นี้ — ใช้เป็นมิติ rule ตอนบันทึก
 *
 * ไล่ตามลำดับความเจาะจง กล้องบางตัวไม่ส่ง `Rule` มาแต่ส่ง token ของ analytics config แทน
 * ถ้าไม่มีอะไรเลยคืนสตริงว่าง ซึ่งแปลว่า "กฎเดียวไม่มีชื่อ" ไม่ใช่ "ไม่รู้" — ตรงกับกล้อง
 * ที่มีเส้นเดียวและไม่เคยตั้งชื่อให้มัน
 */
function ruleNameOf(message) {
  const s = message?.source || {};
  return String(s.Rule || s.RuleName || s.VideoAnalyticsConfigurationToken || '').trim();
}

/* ------------------------------------------------------------------ การนับ */

/** ไม่เชื่อ event เดี่ยวที่ใหญ่กว่านี้ ไม่ว่าตั้ง interval ไว้เท่าไร */
const ABSOLUTE_MAX_DELTA = 3000;

/** จำนวนคนต่อวินาทีที่มากที่สุดที่ประตูหนึ่งบานจะเป็นไปได้จริง เผื่อไว้กว้างแล้ว */
const PEOPLE_PER_SECOND_CEILING = 10;

/** เพดานขั้นต่ำ ใช้เมื่อกล้องรายงานถี่มากจนคำนวณแล้วได้น้อยกว่านี้ */
const MIN_MAX_DELTA = 25;

/**
 * เพดานของ event เดี่ยว คิดจากความถี่ที่กล้องรายงาน ไม่ใช่ค่าคงที่
 *
 * ต้องคิดจาก `ReportInterval` ของกล้องเอง: กล้องที่ตั้งให้รายงานทุกวินาทีส่งทีละคน เพดาน 25
 * จึงเหลือเฟือ แต่กล้องที่ตั้งไว้ 60 วินาทีส่ง **ยอดทั้งนาทีมาก้อนเดียว** และประตูที่คนพลุกพล่าน
 * เกิน 25 คนต่อนาทีได้ง่าย ๆ เพดานตายตัวจึงทิ้งทั้งนาทีนั้นทิ้งไปทั้งก้อน ไม่ใช่แค่ตัดยอดส่วนเกิน
 * — โปรเจค People Counting เจอมาแล้วว่าทำให้ยอดจริงหายไปครึ่งหนึ่งโดยไม่มีอะไรฟ้อง
 *
 * เมื่ออ่านค่าไม่ได้ให้เผื่อกว้างไว้ก่อน เพราะการทิ้งคนจริงแย่กว่าการรับตัวเลขที่ดูเกินจริง
 * และการ replay ที่เพดานนี้กันอยู่ก็ถูกกันไว้อีกสองชั้นแล้ว (ข้าม `Initialized` และช่วงเงียบ
 * หลัง PLAY)
 */
function maxDeltaFor(reportIntervalSec) {
  const interval = Number(reportIntervalSec);
  if (!Number.isFinite(interval) || interval <= 0) return ABSOLUTE_MAX_DELTA;
  return Math.min(ABSOLUTE_MAX_DELTA, Math.max(MIN_MAX_DELTA, Math.round(interval * PEOPLE_PER_SECOND_CEILING)));
}

/** ตัวเลขที่รับได้ — คืน null เมื่อไม่ใช่จำนวนเต็มไม่ติดลบ หรือเกินเพดาน */
function sanitizeDelta(raw, max = ABSOLUTE_MAX_DELTA) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n > max ? null : n;
}

/** เป็นข้อความของกลุ่มนับหรือไม่ (นับเส้น และนับคนในพื้นที่) */
const isCountingTopic = (topic) => /CountAggregation/.test(String(topic || ''));

/**
 * ดึงยอดเข้า-ออกจากข้อความหนึ่ง คืน null เมื่อข้อความนี้ไม่ใช่ยอดนับที่ใช้ได้
 *
 * รองรับสองรูปแบบโดยตั้งใจ: มาตรฐาน ONVIF ระบุฟิลด์เดียวชื่อ `Count` ส่วน Uniview ส่ง
 * `EnterCount` กับ `LeftCount` แยกกัน ซึ่งให้ข้อมูลมากกว่าและเป็นสิ่งที่เราต้องการจริง
 *
 * **ไม่เดาชื่อฟิลด์อื่นเด็ดขาด** และไม่ถอยไปนับข้อความละหนึ่งคน — การเดาผิดหน้าตาเหมือน
 * การทำงานถูกทุกประการ ข้อความที่รูปร่างไม่รู้จักต้องถูกนับเป็น "ไม่รู้จัก" ให้ชั้นบนเห็น
 */
function countsFrom(message, { max = ABSOLUTE_MAX_DELTA } = {}) {
  const d = message?.data || {};
  const hasSplit = d.EnterCount !== undefined || d.LeftCount !== undefined;
  const hasPlain = d.Count !== undefined;
  if (!hasSplit && !hasPlain) return null;

  const rawIn = hasSplit ? d.EnterCount ?? 0 : d.Count;
  const rawOut = hasSplit ? d.LeftCount ?? 0 : 0;

  const cin = sanitizeDelta(rawIn, max);
  const cout = sanitizeDelta(rawOut, max);
  if (cin === null || cout === null) return null;
  return { in: cin, out: cout };
}

module.exports = {
  frameInterleaved,
  rtpPayload,
  rtpMarker,
  parseSimpleItems,
  parseMessages,
  parseUtcTime,
  ruleNameOf,
  isCountingTopic,
  countsFrom,
  maxDeltaFor,
  sanitizeDelta,
  ABSOLUTE_MAX_DELTA,
};
