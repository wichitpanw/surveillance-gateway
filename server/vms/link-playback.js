/**
 * ภาพย้อนหลังจาก edge แบบ link (central) — docs/EDGE-PLAN.md เฟส 5
 *
 * central ต่อเข้า edge แบบ link ไม่ได้ (edge อยู่หลัง NAT) และภาพย้อนหลังเป็นไฟล์ที่มีจุดจบ ส่งทาง RTSP push แบบภาพสด
 * ไม่เหมาะ จึงกลับทิศ: central สั่ง rpc `recording.upload` บนสาย → edge เปิด HTTP POST ขึ้นมาที่
 * `/api/edge-link/playback/:session` (token ของสาย ทางเดียวกับที่ edge โหลดแพ็กเกจอัปเดต) แล้วส่ง fMP4 เป็นสตรีม
 * → central ต่อท่อตรงไปที่ผู้ชมที่รออยู่ ไม่พักลงดิสก์ · ผู้ชมปิด = ตัดสายอัปโหลด = ffmpeg ที่ edge หยุด
 *
 * session ใช้ได้ครั้งเดียว ต้องเป็น edge เจ้าของ session และต้องมาภายใน waitMs (ค่าเริ่ม 45 วิ ตั้งได้ด้วย
 * env LINK_PLAYBACK_WAIT_MS) ไม่งั้นผู้ชมได้ 504 — นานกว่า rpc ปกติเพราะ Profile G ค้นบันทึกหลายรอบได้ถึงสิบกว่าวินาที
 */
const crypto = require('crypto');

const DEFAULT_WAIT_MS = 45_000;

function createLinkPlayback(edgeSources, { waitMs = Number(process.env.LINK_PLAYBACK_WAIT_MS) || DEFAULT_WAIT_MS } = {}) {
  const sessions = new Map(); // id → { sourceId, res, timer, settle }

  /**
   * เริ่มส่งภาพย้อนหลังของกล้อง `cameraRef` (id ที่ edge) ลง `res` — คืนเมื่อสายอัปโหลดต่อติดแล้ว (หรือ error)
   * @param {object} link  สายของ edge (มี rpc)
   */
  function play(sourceId, link, cameraRef, q, res) {
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const session = { sourceId, res, settled: false };
      const settle = (err) => {
        if (session.settled) return;
        session.settled = true;
        clearTimeout(session.timer);
        if (err) {
          sessions.delete(id);
          reject(err);
        } else {
          resolve();
        }
      };
      session.settle = settle;
      session.timer = setTimeout(() => settle(Object.assign(
        new Error(`edge ไม่ส่งภาพย้อนหลังขึ้นมาภายใน ${Math.round(waitMs / 1000)} วินาที`), { status: 504 },
      )), waitMs);
      sessions.set(id, session);
      // ผู้ชมปิดก่อน edge อัปโหลด: ลบ session → อัปโหลดที่มาทีหลังได้ 404 → edge หยุด ffmpeg เอง
      res.on('close', () => { if (!session.settled) settle(Object.assign(new Error('ผู้ชมปิดไปก่อน'), { status: 499 })); });
      if (res.destroyed) {
        settle(Object.assign(new Error('ผู้ชมปิดไปก่อน'), { status: 499 }));
        return;
      }
      // edge ตอบหลังเปิดภาพได้ (ค้นบันทึกนานได้) — รอ rpc เท่ากับเวลารอสายอัปโหลด · ตัวจับเวลา session ตั้งก่อนจึงหมดก่อน (504)
      link.rpc('recording.upload', { sessionId: id, cameraId: cameraRef, start: q.start, duration: q.duration, video: q.video, complete: q.complete }, { timeoutMs: waitMs })
        .catch((err) => settle(err));
    });
  }

  /** route ที่ edge อัปโหลดเข้ามา (ต้องอยู่เหนือ checkAuth — edge ไม่มีบัญชีผู้ใช้) */
  function uploadHandler() {
    return async (req, res) => {
      const session = sessions.get(req.params.session);
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
      const source = m ? await edgeSources.findLinkSource(m[1]).catch(() => null) : null;
      if (!session || !source || source.id !== session.sourceId) {
        req.resume();
        return res.status(404).json({ error: 'ไม่มี session นี้' });
      }
      sessions.delete(req.params.session);
      const viewer = session.res;
      if (session.settled || viewer.writableEnded || viewer.destroyed) {
        req.destroy();
        return undefined;
      }
      viewer.status(200);
      viewer.set('Content-Type', 'video/mp4');
      viewer.set('Cache-Control', 'no-store');
      if (req.headers['x-playback-start']) viewer.set('X-Playback-Start', String(req.headers['x-playback-start']));
      session.settle(null);
      req.pipe(viewer);
      viewer.on('close', () => req.destroy()); // ผู้ชมปิด → ตัดสาย → edge หยุด ffmpeg
      req.on('end', () => res.status(204).end());
      req.on('error', () => viewer.destroy());
      return undefined;
    };
  }

  return { play, uploadHandler };
}

module.exports = { createLinkPlayback };
