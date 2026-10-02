/**
 * PTZ ของกล้องจาก Dahua DSS — แปลงคำสั่งของระบบ (move ความเร็ว -1..1 ต่อแกน / stop) เป็น OpenAPI ของ DSS
 *
 * DSS สั่งเป็น "ทิศ + ความเร็ว 1–8 + เริ่ม/หยุด" ไม่ใช่ความเร็วต่อแกนแบบ ONVIF
 *   OperateDirect direct: 1 บน · 2 ล่าง · 3 ซ้าย · 4 ขวา · 5 ซ้ายบน · 6 ขวาบน · 7 ซ้ายล่าง · 8 ขวาล่าง
 *   OperateCamera operateType 1 (ซูม) direct 1 เข้า · 2 ออก
 * ยืนยันกับ DSS Pro V8.5.0 (2026-09-29): 4 = ขวา, 3 = ซ้าย, ซูมเข้า/ออก กล้องขยับจริง
 * ทิศทแยง (5–8) ยังไม่ได้ยืนยันกับกล้อง — ตามเอกสาร Dahua
 * stop ต้องส่งคำสั่งเดิมด้วย command 0 → จำคำสั่งล่าสุดของแต่ละกล้องไว้
 * preset / home ยังไม่รองรับ (ยังไม่ได้ทดสอบ API ส่วนนั้น)
 */
class DssPtzError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEAD = 0.1;

/** pan/tilt (-1..1, tilt บวก = ขึ้น) → direct ของ DSS · null = ไม่ขยับ */
function directOf(pan, tilt) {
  const x = Math.abs(pan) < DEAD ? 0 : Math.sign(pan);
  const y = Math.abs(tilt) < DEAD ? 0 : Math.sign(tilt);
  const table = { '0,1': 1, '0,-1': 2, '-1,0': 3, '1,0': 4, '-1,1': 5, '1,1': 6, '-1,-1': 7, '1,-1': 8 };
  return table[`${x},${y}`] || null;
}

const stepOf = (v) => Math.min(8, Math.max(1, Math.round(Math.abs(v) * 8)));

function createDssPtz({ sessions }) {
  const last = new Map(); // camera id → คำสั่งที่กำลังขยับอยู่ { kind, direct, step }

  async function target(camera) {
    const t = await sessions.forCamera(camera.id);
    if (!t) throw new DssPtzError(409, 'ไม่พบแหล่ง DSS ของกล้องนี้');
    return t;
  }

  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DssPtzError) throw err;
      throw new DssPtzError(502, `DSS: ${err.message || err}`);
    }
  };

  async function stop(camera) {
    const prev = last.get(camera.id);
    last.delete(camera.id);
    if (!prev) return;
    const { client, channelId } = await target(camera);
    await wrap(() => (prev.kind === 'zoom'
      ? client.ptzZoom(channelId, prev.zoomIn, prev.step, false)
      : client.ptzDirect(channelId, prev.direct, prev.step, false)));
  }

  /** ขยับ — มีทั้งหันและซูมพร้อมกันไม่ได้ใน DSS จึงให้ซูมมาก่อนเมื่อสั่ง zoom */
  async function move(camera, { pan = 0, tilt = 0, zoom = 0 }) {
    const { client, channelId } = await target(camera);
    await stop(camera).catch(() => {});
    if (Math.abs(zoom) >= DEAD) {
      const cmd = { kind: 'zoom', zoomIn: zoom > 0, step: stepOf(zoom) };
      await wrap(() => client.ptzZoom(channelId, cmd.zoomIn, cmd.step, true));
      last.set(camera.id, cmd);
      return;
    }
    const direct = directOf(Number(pan) || 0, Number(tilt) || 0);
    if (!direct) return;
    const cmd = { kind: 'direct', direct, step: stepOf(Math.max(Math.abs(pan), Math.abs(tilt))) };
    await wrap(() => client.ptzDirect(channelId, direct, cmd.step, true));
    last.set(camera.id, cmd);
  }

  /** ทุกช่องจาก DSS แสดงแผง PTZ — DSS ปฏิเสธเองถ้ากล้องตายตัว (ยังไม่มีฟิลด์ที่ยืนยันแล้วว่าบอกว่าเป็น PTZ) */
  const capabilities = async () => ({ supported: true, panTilt: true, zoom: true, presets: [], via: 'dss' });

  const unsupported = async () => { throw new DssPtzError(409, 'กล้องจาก DSS ยังไม่รองรับ preset / home'); };

  return { capabilities, move, stop, home: unsupported, gotoPreset: unsupported, setPreset: unsupported, removePreset: unsupported, directOf };
}

module.exports = { createDssPtz, directOf, DssPtzError };
