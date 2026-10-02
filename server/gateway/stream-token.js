/**
 * Token อายุสั้นสำหรับดูวิดีโอ
 *
 * ปัญหาที่ไฟล์นี้แก้: `/stream/<ชื่อ>.mp4` และ `/hls/<ชื่อ>/index.m3u8` เปิดดูได้โดยไม่ต้องมี
 * คีย์เลย ยืนยันด้วย curl เปล่า ๆ ได้ 200 ทั้งคู่ ส่วน `/api/stream.mp4` ที่อยู่ข้างใต้ได้ 401
 * — สอง wrapper นั้นถูกวางไว้เหนือ `app.use('/api', checkAuth)` โดยจำเป็น เพราะแท็ก <video>
 * ส่ง Authorization header ไม่ได้
 *
 * ผลที่ตามมาคือสิ่งที่ทำให้ Gateway เสียความหมายไปครึ่งหนึ่ง: scope ของคีย์คุมได้แค่ "รายชื่อ
 * กล้องที่เห็น" ส่วน **ตัววิดีโอใครก็เปิดได้ถ้ารู้ชื่อ path** และการเพิกถอนคีย์ไม่มีผลกับคนที่
 * เคยได้ URL ไปแล้ว เขาดูต่อได้ตลอดไป
 *
 * วิธีแก้: `/api/v1/cameras/:id/streams` แนบ token ที่ผูกกับ **กล้องตัวนั้นตัวเดียว** และ
 * **คีย์ที่ขอมา** พร้อมวันหมดอายุ แล้ว wrapper ทั้งสองตรวจ token ก่อน proxy
 *
 * ### ทำไม token ถึงอยู่ใน query string ทั้งที่ Gateway ห้ามคีย์อยู่ใน query string
 *
 * กฎนั้นยังถูกต้องและยังบังคับอยู่กับ **API key** ซึ่งอายุยาว ใช้ได้ทุก endpoint และใช้ได้ทุกกล้อง
 * ใน scope — คีย์แบบนั้นหลุดใน access log ครั้งเดียวคือจบ
 *
 * ส่วนตัวนี้ต่างออกไปทุกมิติที่สำคัญ: ใช้ได้กับกล้องเดียว ทำได้อย่างเดียวคือดูภาพ และหมดอายุเอง
 * ที่สำคัญคือ **ไม่มีทางเลือกอื่น** — <video> กับ hls.js ส่ง header ไม่ได้ ถ้ายืนกรานว่าต้องเป็น
 * header เท่านั้น ก็เท่ากับเลือกที่จะไม่มีการตรวจสิทธิ์เลย ซึ่งคือสถานะก่อนหน้านี้
 *
 * ### ข้อจำกัดที่ต้องรู้ ไม่ใช่ซ่อนไว้
 *
 * - **RTSP บนพอร์ต 8555 ไม่ได้ถูกครอบด้วยวิธีนี้** โปรโตคอลนั้นพก token แบบนี้ไม่ได้ และพอร์ต
 *   ชี้ตรงไป go2rtc ไม่ผ่าน Node — คุมด้วย username/password ของ go2rtc เองแทน เปิดใช้ด้วย
 *   `node scripts/enable-rtsp-auth.cjs` แล้ว gateway/rtsp-auth.js จะใส่บัญชีนั้นลงใน URL
 *   ที่แจกออกไปให้เอง
 * - **HLS ตรวจทุก segment** ไม่ใช่ครั้งเดียวตอนเปิดเหมือน fMP4 อายุจึงต้องยาวกว่า ไม่งั้น
 *   ดูไปสักพักแล้วภาพจะดับกลางคัน
 * - token ที่ออกไปแล้ว **เพิกถอนทันทีไม่ได้** ต้องรอหมดอายุ นี่คือราคาของการไม่ต้องแตะฐานข้อมูล
 *   ทุกเฟรม ถ้าวันหนึ่งต้องตัดได้ทันที ให้เพิ่ม deny-list ของ jti ไม่ใช่เปลี่ยนไปตรวจคีย์ทุกครั้ง
 */
const crypto = require('crypto');
const fs = require('fs');

/**
 * ไฟล์กุญแจ — คนละใบกับของ key-vault โดยตั้งใจ
 *
 * แยกเพราะสองอย่างนี้มีอายุและผลของการรั่วต่างกัน: กุญแจของ key-vault ถอดรหัส API key ทุกใบ
 * ที่เก็บไว้ ส่วนกุญแจนี้แค่ปลอม token ดูวิดีโอได้ การหมุนกุญแจนี้ทิ้ง (ลบไฟล์แล้ว restart)
 * มีผลแค่ทำให้ token ที่ค้างอยู่ใช้ไม่ได้ ซึ่งเป็นการกระทำที่อยากให้ทำได้ง่าย ๆ ตอนสงสัยว่ารั่ว
 * แต่ห้ามทำกับกุญแจของ key-vault เพราะจะอ่าน key ที่เก็บไว้ไม่ออกทั้งหมด
 */
const SECRET_PATH = process.env.GATEWAY_STREAM_TOKEN_SECRET_FILE
  || require('../shared/instance').stateFile('.stream-token-secret');

/** ขึ้นต้นด้วยเวอร์ชัน เผื่อวันหนึ่งเปลี่ยนวิธีเซ็นแล้วยังต้องอ่านของเก่าออก */
const VERSION = 'v1';

/** fMP4 ตรวจครั้งเดียวตอนเปิด connection — สั้นได้ เพราะดูต่อได้เรื่อย ๆ หลังต่อติดแล้ว */
const DEFAULT_TTL_MS = 5 * 60_000;
/** HLS ตรวจทุก segment — ต้องยาวพอให้ดูได้ต่อเนื่องโดยไม่ต้องขอใหม่กลางคัน */
const HLS_TTL_MS = 60 * 60_000;

let cachedSecret = null;

/**
 * อ่านกุญแจ สร้างใหม่ถ้ายังไม่มี — รูปแบบเดียวกับ key-vault.js
 *
 * `mode: 0o600` ตั้งตอนสร้าง ไม่ใช่ chmod ทีหลัง เพราะระหว่างสองจังหวะนั้นไฟล์อ่านได้โดย
 * ทุกคนบนเครื่อง
 */
function loadSecret() {
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = Buffer.from(fs.readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
    if (cachedSecret.length !== 32) throw new Error('ความยาวกุญแจไม่ถูกต้อง');
  } catch {
    cachedSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, cachedSecret.toString('hex'), { mode: 0o600 });
    console.log(`[Gateway] สร้างไฟล์กุญแจ stream token ที่ ${SECRET_PATH}`);
  }
  return cachedSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * เซ็น token สำหรับสตรีมหนึ่งเส้น
 *
 * ผูกกับ **ชื่อ path ของสตรีม** ไม่ใช่ camera id เฉย ๆ เพราะ main กับ sub เป็นคนละ path และ
 * ควรแยกสิทธิ์กัน — token ของ sub ไม่ควรเปิด main ซึ่งเป็นภาพความละเอียดเต็มและเป็น on-demand
 * ที่ไปปลุกกล้องให้ทำงานเพิ่ม
 *
 * @param {object} opts
 * @param {string} opts.streamName ชื่อ path เช่น `cam_123` หรือ `cam_123_sub`
 * @param {string} opts.clientId   id ของ api_clients ที่ขอ — ไว้ตามรอยว่า token ใบไหนของใคร
 * @param {number} [opts.ttlMs]
 * @returns {string}
 */
function sign({ streamName, clientId, ttlMs = DEFAULT_TTL_MS }) {
  const payload = b64url(
    JSON.stringify({ s: String(streamName), k: String(clientId || ''), e: Date.now() + ttlMs }),
  );
  const mac = b64url(crypto.createHmac('sha256', loadSecret()).update(payload).digest());
  return `${VERSION}.${payload}.${mac}`;
}

/**
 * ตรวจ token ว่าใช้กับสตรีมนี้ได้ไหม
 *
 * คืน payload เมื่อผ่าน คืน null เมื่อไม่ผ่านทุกกรณี — ไม่แยกว่า "ลายเซ็นผิด" หรือ "หมดอายุ"
 * เพราะผู้เรียกไม่ได้ทำอะไรต่างกัน และการบอกให้ละเอียดคือการช่วยคนที่กำลังลองสุ่ม
 *
 * ### ไม่ส่ง streamName มา = ตรวจแค่ลายเซ็นกับอายุ
 *
 * มีไว้สำหรับคำขอชั้นในของ HLS โดยเฉพาะ: go2rtc ให้ master playlist ชี้ไปที่
 * `hls/playlist.m3u8?id=<opaque>` แล้ว matchHlsRequest (server.js) ตัด path เหลือ `/api/hls/playlist.m3u8`
 * — ชื่อสตรีมหายไปจาก path ตั้งแต่ชั้นนั้น จึงไม่มีอะไรให้เทียบ
 *
 * โหมดนี้ยังกันคนที่ไม่มี token ที่เราเซ็นออกไปได้อยู่ (เดา `?id=` 8 ตัวถูกก็ยังผ่านไม่ได้)
 * แต่ **ไม่กันคนที่มี token ของกล้องหนึ่งแล้วเอาไปใช้กับ session ของอีกกล้อง** ถ้าเขาหา `?id=`
 * ของกล้องนั้นเจอ — ข้อจำกัดนี้อยู่ที่รูปร่างของ HLS ใน go2rtc ไม่ใช่ที่ตัว token
 * ทางเล่นหลักคือ fMP4 ซึ่งผูกชื่อสตรีมได้ครบทุกคำขอ
 *
 * @param {string} token
 * @param {string} [streamName] ชื่อ path ที่กำลังจะเปิด — ไม่ส่ง = ข้ามการเทียบชื่อ
 * @returns {{ s: string, k: string, e: number } | null}
 */
function verify(token, streamName) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const [, payload, mac] = parts;
  const expected = b64url(crypto.createHmac('sha256', loadSecret()).update(payload).digest());

  /*
    เทียบแบบ timing-safe — การเทียบสตริงด้วย === หยุดทันทีที่เจอตัวอักษรต่างกัน ทำให้เวลาที่ใช้
    บอกใบ้ว่าเดาถูกไปกี่ตัว ซึ่งพอจะไล่หาลายเซ็นทีละไบต์ได้ ต้องเช็คความยาวก่อนเพราะ
    timingSafeEqual โยน error เมื่อสองฝั่งยาวไม่เท่ากัน
  */
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!data || typeof data.e !== 'number' || Date.now() > data.e) return null;
  if (streamName != null && String(data.s) !== String(streamName)) return null;
  return data;
}

/**
 * ดึง token จาก request
 *
 * รับทาง query `?t=` เป็นหลักเพราะเป็นทางเดียวที่ <video> ส่งได้ แต่ยอมรับ Bearer header ด้วย
 * สำหรับผู้เรียกที่ไม่ใช่เบราว์เซอร์ (เช่น ffmpeg ที่ตั้ง header ได้) — ทางที่ปลอดภัยกว่าควรใช้ได้
 * เสมอ ไม่ใช่ถูกปิดเพราะทางที่ด้อยกว่าถูกออกแบบมาก่อน
 */
function fromRequest(req) {
  const q = req.query?.t;
  if (q) return String(q);
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers?.authorization || ''));
  return m ? m[1] : '';
}

module.exports = { sign, verify, fromRequest, DEFAULT_TTL_MS, HLS_TTL_MS, SECRET_PATH };
