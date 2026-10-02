/** จำกัดดาวน์โหลดหนึ่งงานต่อ API key + instance และช่วงไม่เกิน 30 นาที */
const { isValidTime, toBangkokIso } = require('../shared/time');
const { PlaybackError } = require('./playback');
const MAX_DOWNLOAD_SECONDS = 1800;

function downloadQuery(query) {
  const duration = Number(query.duration);
  if (!/^\d+$/.test(String(query.duration ?? '')) || duration < 1 || duration > MAX_DOWNLOAD_SECONDS) {
    throw new PlaybackError(400, 'ดาวน์โหลดได้ครั้งละ 1–1800 วินาที (สูงสุด 30 นาทีต่อไฟล์)');
  }
  if (typeof query.start !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(query.start) || !isValidTime(query.start)) {
    throw new PlaybackError(400, 'เวลาเริ่มต้องเป็น ISO-8601 พร้อมเขตเวลา');
  }
  return { start: toBangkokIso(query.start), duration, video: 'raw', complete: '1' };
}

/** จองก่อนเปิดภาพ และคืนช่องเมื่อจบ/ยกเลิก/เปิดภาพไม่สำเร็จ */
function createPlaybackDownload({ playback, playbackCamera }) {
  const active = new Set();
  return async (req, res) => {
    let release = () => {};
    try {
      const query = downloadQuery(req.query);
      const camera = await playbackCamera(req, res);
      if (!camera || res.destroyed || res.writableEnded) return;
      const instance = String(req.headers['x-client-instance'] || '').trim()
        || `addr:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
      const key = JSON.stringify([req.apiClient.id, instance]);
      if (active.has(key)) throw new PlaybackError(429, 'client นี้กำลังดาวน์โหลดอยู่ — รอให้เสร็จหรือยกเลิกก่อน');
      active.add(key);
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        active.delete(key);
      };
      res.once('finish', release);
      res.once('close', release);
      res.set('Content-Disposition', 'attachment; filename="playback.mp4"');
      await playback.pipeVideo(camera, query, res);
    } catch (err) {
      release();
      if (!res.headersSent) res.removeHeader('Content-Disposition');
      playback.sendError(res, err);
    }
  };
}

module.exports = { createPlaybackDownload, downloadQuery, MAX_DOWNLOAD_SECONDS };
