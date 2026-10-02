/**
 * สถานะกล้องสามค่า — ที่เดียวที่ทั้งเครื่องอ่านและเขียน
 *
 *   enabled    ผู้ดูแลเปิดใช้กล้องนี้ไหม (cameras.enabled) — ปิด = ไม่ซิงก์เข้า core ไม่เช็ค ไม่ส่งต่อ
 *   reachable  หัวกล้องตอบไหม — true / false / null (ไม่รู้ เช่น edge ที่ถือกล้องอยู่ติดต่อไม่ได้)
 *   streaming  core กำลังดึงภาพอยู่ตอนนี้ไหม (มีคนดูหรือ always_on) — ไม่ใช่ตัวบอกว่ากล้องเสีย
 *
 * เดิมสามเรื่องนี้ถูกบีบเป็นคำเดียว "online" ซึ่งแต่ละที่นิยามไม่เหมือนกัน: หน้าเว็บใช้ TCP ส่วน SSE
 * ใช้ "มี producer ใน go2rtc" ที่เป็นจริงตลอดแม้ไม่มีใครดู กล้องจึงดูปกติทั้งที่สายหลุด หรือดูดับ
 * ทั้งที่แค่ไม่มีคนเปิด แยกเป็นสามค่าแล้วให้คนอ่านเลือกเองว่าต้องการคำถามไหน
 *
 * อยู่ในหน่วยความจำ และแจ้งผู้ฟังทันทีเมื่อค่าเปลี่ยน — SSE และ link ไป central ไม่ต้อง poll เอง
 */
const { EventEmitter } = require('events');
const { nowIso } = require('./time');

const FIELDS = ['enabled', 'reachable', 'streaming'];

/** สร้างที่เก็บสถานะ — server.js สร้างตัวเดียวแล้วส่งให้ทุกโมดูล */
function createCameraState() {
  const states = new Map();
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // ผู้ฟังหนึ่งตัวต่อ SSE connection — จำนวนไม่คงที่

  /** รวมค่าใหม่เข้ากับของเดิม แจ้ง 'change' เฉพาะเมื่อมีค่าที่เปลี่ยนจริง */
  function set(id, patch) {
    const prev = states.get(id);
    const next = {
      enabled: prev ? prev.enabled : true,
      reachable: prev ? prev.reachable : null,
      streaming: prev ? prev.streaming : false,
      at: prev ? prev.at : nowIso(),
    };
    let changed = !prev;
    for (const k of FIELDS) {
      if (patch[k] === undefined) continue;
      const v = k === 'reachable' ? (patch[k] === null ? null : Boolean(patch[k])) : Boolean(patch[k]);
      if (next[k] !== v) {
        next[k] = v;
        changed = true;
      }
    }
    if (!changed) return prev;
    next.at = nowIso();
    states.set(id, next);
    bus.emit('change', id, next, prev || null);
    return next;
  }

  /** ลบกล้องที่ไม่มีแล้ว — แจ้ง 'remove' ให้ผู้ฟังล้างของตัวเอง */
  function remove(id) {
    if (!states.has(id)) return;
    states.delete(id);
    bus.emit('remove', id);
  }

  /** ตัดกล้องที่ไม่อยู่ในชุด ids ออก (ใช้หลังอ่านรายชื่อจาก DB ทุกรอบ) */
  function retain(ids) {
    const keep = new Set(ids);
    for (const id of [...states.keys()]) if (!keep.has(id)) remove(id);
  }

  const get = (id) => states.get(id) || null;
  const all = () => new Map(states);

  /** สมัครฟัง — คืนฟังก์ชันยกเลิก ต้องเรียกตอน connection ปิด ไม่งั้นผู้ฟังค้าง */
  function subscribe({ onChange, onRemove }) {
    if (onChange) bus.on('change', onChange);
    if (onRemove) bus.on('remove', onRemove);
    return () => {
      if (onChange) bus.off('change', onChange);
      if (onRemove) bus.off('remove', onRemove);
    };
  }

  return { set, remove, retain, get, all, subscribe };
}

/** รูปที่ส่งออกทาง API — ไม่มีเวลาภายใน */
const publicState = (s) => (s
  ? { enabled: s.enabled, reachable: s.reachable, streaming: s.streaming, since: s.at }
  : { enabled: true, reachable: null, streaming: false, since: null });

module.exports = { createCameraState, publicState };
