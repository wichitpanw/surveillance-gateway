/**
 * ดูภาพย้อนหลัง — ทางเดียวที่ทั้ง /api/v1 และหน้าเว็บใช้
 *
 * ภาพย้อนหลังมาจาก "แหล่งภาพ" ที่ edge (ที่ edge เพราะ edge ถือรหัสกล้องและเข้าถึงอุปกรณ์ในวงแลนได้)
 * · กล้อง `edge_relay` ที่ central ส่งคำขอต่อไปที่ /api/v1 ของ edge ด้วย key ที่ edge ออกให้ (แบบเดียวกับ PTZ)
 * · edge แบบ link: ช่วงเวลาและภาพนิ่งวิ่งบนสาย ตัววิดีโอ edge อัปโหลดขึ้นมาทาง HTTP (vms/link-playback.js)
 *
 * แหล่งภาพที่ edge (localSource) อ่านจากอุปกรณ์ — เลือกทางตามยี่ห้อใน vms/device-playback.js
 * แหล่งภาพต้องมี ranges(cameraId, from, to), openPlayback(cameraId, q)
 * (คืน { proc, startIso, lastError(), kill() } ที่ส่ง fMP4 ทาง proc.stdout) และ frame(cameraId, at) → Buffer
 */
class PlaybackError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NO_SOURCE = 'edge นี้ยังไม่มีแหล่งภาพย้อนหลัง';

/** ส่งภาพจาก openPlayback() ลง response — ตอบ 200 เมื่อได้ไบต์แรก ffmpeg พังตั้งแต่ต้น = error เป็น JSON */
async function pipeFromSource(source, cameraId, q, res) {
  // ผู้ชมอาจปิดไประหว่างรออุปกรณ์ค้นบันทึก (หลายวินาที) — จดไว้ก่อน await ไม่งั้น 'close' หลุดไปแล้ว ffmpeg ค้าง
  let viewerGone = false;
  const markGone = () => { viewerGone = true; };
  res.once('close', markGone);
  const { proc, startIso, lastError, kill } = await source.openPlayback(cameraId, q);
  res.removeListener('close', markGone);
  if (viewerGone || res.destroyed || res.writableEnded) {
    kill();
    return;
  }
  require('../shared/playback-transfer').transferPlayback({ proc, startIso, lastError, kill }, res, {
    start: () => {
      res.status(200);
      res.set('Content-Type', 'video/mp4');
      res.set('Cache-Control', 'no-store');
      if (startIso) res.set('X-Playback-Start', startIso);
    },
    fail: () => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.status(502).json({ error: lastError() || 'อ่านภาพย้อนหลังไม่สำเร็จ' });
      else res.destroy();
    },
  });
}

function createPlayback({ localSource = null, edgeClientFor }) {
  const isEdge = (camera) => camera.type === 'edge_relay';
  const local = () => {
    if (!localSource) throw new PlaybackError(501, NO_SOURCE);
    return localSource;
  };

  const edgeClient = async (camera) => {
    const client = edgeClientFor ? await edgeClientFor(camera) : null;
    if (!client) throw new PlaybackError(409, 'ไม่พบ edge ต้นทางของกล้องนี้');
    return client;
  };

  /** error ของ edge → PlaybackError ที่คงสถานะเดิม (401 ของ edge = key ที่ central ถือเสีย → 502) */
  const fromEdge = (err) => {
    if (err instanceof PlaybackError) return err;
    const status = Number(err?.status) || 502;
    return new PlaybackError(status === 401 ? 502 : status, `edge: ${err?.message || err}`);
  };

  async function ranges(camera, { from, to } = {}) {
    if (!isEdge(camera)) return local().ranges(camera.id, from, to);
    const client = await edgeClient(camera);
    try {
      const data = await client.recordings(camera.source_ref, { from, to });
      return { ...data, cameraId: camera.id };
    } catch (err) {
      throw fromEdge(err);
    }
  }

  /** ส่งภาพย้อนหลังลง response · query: start, duration (วินาที), video (h264 = แปลงให้เบราว์เซอร์) */
  async function pipeVideo(camera, query, res) {
    const q = { start: query.start, duration: query.duration, video: query.video === 'h264' ? 'h264' : undefined, complete: query.complete === '1' || query.complete === true ? '1' : undefined };
    if (!isEdge(camera)) return pipeFromSource(local(), camera.id, q, res);
    const client = await edgeClient(camera);
    if (client.link) {
      try {
        return await client.playback(camera.source_ref, q, res);
      } catch (err) {
        throw fromEdge(err);
      }
    }
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null));
    return client.pipe(`/cameras/${encodeURIComponent(camera.source_ref)}/playback.mp4?${qs}`, res);
  }

  /** อ่านภาพนิ่งเป็น Buffer เพื่อให้ regional ส่งต่อผ่าน RPC ได้ */
  async function frameBuffer(camera, at) {
    let buf;
    if (!isEdge(camera)) {
      buf = await local().frame(camera.id, at);
    } else {
      const client = await edgeClient(camera);
      try {
        buf = await client.frame(camera.source_ref, at);
      } catch (err) {
        throw fromEdge(err);
      }
    }
    return buf;
  }

  /** ภาพนิ่ง ณ เวลาหนึ่ง (edge แบบ pull ส่งต่อตรงลง response) */
  async function sendFrame(camera, at, res) {
    if (isEdge(camera)) {
      const client = await edgeClient(camera);
      if (!client.link) return client.pipe(`/cameras/${encodeURIComponent(camera.source_ref)}/frame.jpg?at=${encodeURIComponent(at || '')}`, res);
    }
    const buf = await frameBuffer(camera, at);
    res.set('Cache-Control', 'no-store');
    return res.type('image/jpeg').send(buf);
  }

  /** ส่ง error ของงานนี้เป็น JSON — ใช้ร่วมทั้ง /api/v1 และหน้าเว็บ */
  const sendError = (res, err) => {
    if (res.headersSent) return res.destroy();
    const status = Number(err?.status) || 500;
    return res.status(status).json({ error: err?.message || 'ดูภาพย้อนหลังไม่สำเร็จ' });
  };

  return { ranges, pipeVideo, frameBuffer, sendFrame, sendError, localSource };
}

module.exports = { createPlayback, PlaybackError, NO_SOURCE };
