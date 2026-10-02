/**
 * แจ้งเตือนเมื่อ edge หลุด/กลับมา (central) — docs/EDGE-PLAN.md เฟส 5 ข้อ B
 *
 * เหตุที่ต้องมี: edge 002 หลุด 2 วัน (25–27 ก.ย. 2026) โดยไม่มีใครรู้ เพราะสถานะแสดงแค่ในหน้า Edge Nodes
 *
 * ตรวจทุก 30 วิจาก listEdges() (ค่า reachable เดียวกับหน้า Edge Nodes) ไม่ผูกกับจุดที่ตั้งสถานะ
 * จึงครอบทั้ง pull และ link รวมถึง edge แบบ link ที่ไม่เคยต่อเข้ามาเลยตั้งแต่ central เริ่ม (ไม่มีสถานะ = ไม่รู้)
 * หลุดติดกันเกิน ALERT_AFTER_MS ค่อยแจ้ง — สายกระพริบสั้น ๆ ไม่ปลุกคน · ตอนเริ่มระบบให้เวลาเท่ากันก่อนแจ้ง
 *
 * แจ้งทาง: log ของระบบ (EDGE_DOWN / EDGE_UP), SSE `edge_state` ใน /api/v1/events, และ GET /api/edges/alerts
 * (แถบเตือนบนหน้าเว็บ central)
 */
const { nowIso, toBangkokIso } = require('../shared/time');

const CHECK_MS = 30_000;
const ALERT_AFTER_MS = Number(process.env.EDGE_ALERT_AFTER_MS || 120_000);

function createEdgeAlerts({ listEdges, saveLog }) {
  const listeners = new Set();
  const started = Date.now();
  /** source id → { downSince, alerted } */
  const down = new Map();

  const emit = (ev) => {
    for (const fn of listeners) {
      try { fn(ev); } catch { /* ผู้ฟังพังไม่ลามมาที่นี่ */ }
    }
  };

  async function check() {
    const edges = await listEdges();
    const seen = new Set();
    for (const e of edges) {
      seen.add(e.id);
      const node = e.remote_node || null;
      const name = e.label || e.id;
      const role = e.remote_role === 'regional' ? 'regional' : 'edge';
      const title = role === 'regional' ? 'Regional' : 'Edge';
      if (e.reachable === true) {
        const d = down.get(e.id);
        down.delete(e.id);
        if (d?.alerted) {
          const minutes = Math.round((Date.now() - d.downSince) / 60_000);
          saveLog('system', 'EDGE_UP', `${title} ${node || '-'} (${name}) กลับมาติดต่อได้ หลังหลุด ${minutes} นาที`);
          console.log(`[Edge alert] ${name}: กลับมาแล้ว (หลุด ${minutes} นาที)`);
          emit({ sourceId: e.id, node, name, role, reachable: true, downSince: null, at: nowIso() });
        }
        continue;
      }
      // false หรือ null (ยังไม่เคยติดต่อได้ตั้งแต่เริ่ม) — นับเป็นหลุดทั้งคู่ เริ่มนับไม่ก่อนเวลาเริ่มระบบ
      if (!down.has(e.id)) down.set(e.id, { downSince: Date.now(), alerted: false, error: e.status_error || null });
      const d = down.get(e.id);
      d.error = e.status_error || d.error;
      if (!d.alerted && Date.now() - Math.max(d.downSince, started) >= ALERT_AFTER_MS) {
        d.alerted = true;
        saveLog('system', 'EDGE_DOWN', `${title} ${node || '-'} (${name}) ติดต่อไม่ได้${d.error ? ` — ${d.error}` : ''} · กล้อง ${e.cameraCount} ตัวสถานะไม่ทราบ`);
        console.warn(`[Edge alert] ${name}: ติดต่อไม่ได้เกิน ${ALERT_AFTER_MS / 60_000} นาที`);
        emit({ sourceId: e.id, node, name, role, reachable: false, downSince: toBangkokIso(d.downSince), cameras: e.cameraCount, error: d.error, at: nowIso() });
      }
    }
    for (const id of [...down.keys()]) if (!seen.has(id)) down.delete(id); // edge ถูกถอด
  }

  function start() {
    const tick = () => check().catch((err) => console.warn(`[Edge alert] ตรวจไม่สำเร็จ: ${err.message}`));
    const timer = setInterval(tick, CHECK_MS);
    timer.unref?.();
    setTimeout(tick, 5_000).unref?.();
  }

  /** edge ที่กำลังหลุดและแจ้งไปแล้ว — ให้แถบเตือนบนหน้าเว็บ */
  async function current() {
    const edges = await listEdges();
    return edges
      .filter((e) => down.get(e.id)?.alerted)
      .map((e) => ({ sourceId: e.id, node: e.remote_node || null, name: e.label || e.id, role: e.remote_role === 'regional' ? 'regional' : 'edge', cameras: e.cameraCount,
        downSince: toBangkokIso(down.get(e.id).downSince), error: down.get(e.id).error || null }));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { start, current, subscribe, check };
}

module.exports = { createEdgeAlerts };
