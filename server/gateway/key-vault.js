/**
 * ที่เก็บตัว API key แบบเข้ารหัส เพื่อให้ผู้ดูแลเปิดดูซ้ำได้
 *
 * เดิมระบบเก็บแต่ SHA-256 ของ key ซึ่งแปลว่ากู้คืนไม่ได้เลยตามหลักการที่ถูกต้องของ
 * การเก็บความลับ แต่ในทางปฏิบัติมันผลักภาระไปให้ผู้ดูแลว่าต้องคัดลอกให้ทันในครั้งเดียว
 * และเมื่อทำหาย ทางออกเดียวคือออกใบใหม่แล้วไปไล่แก้ config ของทุกเครื่องที่ใช้ใบเก่า
 * ซึ่งเป็นงานที่เสี่ยงกว่าตัวความเสี่ยงที่การเก็บ hash อย่างเดียวป้องกันไว้
 *
 * ทางสายกลางคือเก็บ "ตัว key ที่เข้ารหัสไว้" เพิ่มอีกช่องหนึ่ง โดยกุญแจถอดรหัสอยู่ใน
 * ไฟล์แยกนอกฐานข้อมูล ผลคือไฟล์ backup ของ vms.db ที่หลุดออกไป (ซึ่งเป็นช่องทางรั่ว
 * ที่เกิดจริงบ่อยที่สุด — ไฟล์ถูกคัดลอกไปเครื่องอื่น แนบอีเมล วางไว้ใน share) ยังถอด
 * key ไม่ได้ ต้องได้ไฟล์กุญแจไปด้วยอีกใบหนึ่ง
 *
 * สิ่งที่ยังคงไว้ไม่เปลี่ยน: `key_hash` ยังเป็นตัวที่ใช้ตรวจตอน login จริง การถอดรหัส
 * เกิดขึ้นเฉพาะตอนคนกดดูเท่านั้น เส้นทางยืนยันตัวตนไม่เคยแตะไฟล์กุญแจนี้เลย
 */
const crypto = require('crypto');
const fs = require('fs');

/**
 * ไฟล์กุญแจ — ต้องอยู่คนละที่กับ vms.db และห้ามเข้า git
 *
 * วางไว้ข้าง vms.db ก็จริง แต่ประเด็นไม่ใช่ระยะห่างบนดิสก์ ประเด็นคือมันไม่ได้ถูก
 * คัดลอกไปพร้อมกับฐานข้อมูลเวลามีคน backup หรือส่งไฟล์ .db ให้กัน
 */
const SECRET_PATH = process.env.GATEWAY_KEY_SECRET_FILE
  || require('../shared/instance').stateFile('.gateway-key-secret');

const ALGO = 'aes-256-gcm';
/** ขึ้นต้นด้วยเวอร์ชัน เผื่อวันหนึ่งต้องเปลี่ยนวิธีเข้ารหัสแล้วยังอ่านของเก่าออก */
const VERSION = 'v1';

let cachedSecret = null;

/**
 * อ่านกุญแจ สร้างใหม่ถ้ายังไม่มี
 *
 * `mode: 0o600` ตั้งตอนสร้างไฟล์ ไม่ใช่ chmod ทีหลัง — ระหว่างสองจังหวะนั้นไฟล์จะ
 * อ่านได้โดยทุกคนบนเครื่อง ซึ่งเป็นช่องที่แคบแต่ไม่มีเหตุผลให้เปิดทิ้งไว้
 *
 * บน Windows โหมดไฟล์ไม่มีผล แต่เครื่องที่รันจริงคือ Linux VM ส่วนเครื่อง Windows
 * เป็นแค่ที่เก็บโค้ด (ดู agents.md) จึงไม่ต้องมีทางแยกสำหรับสองระบบ
 */
function loadSecret() {
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = Buffer.from(fs.readFileSync(SECRET_PATH, 'utf8').trim(), 'hex');
    if (cachedSecret.length !== 32) throw new Error('ความยาวกุญแจไม่ถูกต้อง');
  } catch {
    cachedSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, cachedSecret.toString('hex'), { mode: 0o600 });
    console.log(`[Gateway] สร้างไฟล์กุญแจถอดรหัส API key ที่ ${SECRET_PATH}`);
  }
  return cachedSecret;
}

/** เข้ารหัส key คืนสตริงพร้อมเก็บลงฐานข้อมูล */
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, loadSecret(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/**
 * ถอดรหัส คืน `null` เมื่อถอดไม่ได้
 *
 * คืน null แทนที่จะ throw เพราะกรณีที่พบบ่อยที่สุดคือ key ที่ออกไว้ก่อนมีระบบนี้ ซึ่ง
 * ไม่มีข้อมูลให้ถอดตั้งแต่แรก — เป็นสถานะปกติที่หน้าเว็บต้องอธิบายให้ผู้ใช้เข้าใจ
 * ไม่ใช่ข้อผิดพลาดของระบบ ส่วนกุญแจผิดใบก็ให้ผลเดียวกันโดยตั้งใจ: ทั้งสองกรณี
 * ทางออกของผู้ใช้เหมือนกันคือออก key ใบใหม่
 */
function unseal(sealed) {
  if (!sealed) return null;
  try {
    const [version, ivB64, tagB64, ctB64] = String(sealed).split(':');
    if (version !== VERSION) return null;
    const decipher = crypto.createDecipheriv(ALGO, loadSecret(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { seal, unseal, SECRET_PATH };
