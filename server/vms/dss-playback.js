/**
 * ภาพย้อนหลังของกล้องจาก Dahua DSS: QueryRecords บอกไฟล์บันทึก → StartPlaybackByFile ให้ URL ที่เริ่มกลางไฟล์ได้
 *
 * ทดสอบกับ DSS Pro V8.5.0 (2026-09-29): ภาพแรก ~0.6–0.8 วิ · เริ่มที่ +600/+1200 วิ ของไฟล์ได้ภาพคนละช่วงจริง
 * StartPlaybackByTime ใช้ไม่ได้บนเครื่องนี้ (2060) · URL ใช้ได้ครั้งเดียว → ขอใหม่ทุกครั้งที่เปิด
 * ffmpeg ต่อ URL ของ DSS ตรง (token อยู่ใน query ของ argv ช่วงสั้น ๆ เหมือนแหล่งภาพ AXIS/Uniview)
 */
const { PlaybackError } = require('../gateway/playback');
const { DssAuthError } = require('./dss');
const common = require('./playback-common');

const LABEL = 'DSS';

function createDssPlayback({ ffmpegPath, sessions }) {
  async function target(camera) {
    const t = sessions ? await sessions.forCamera(camera.id) : null;
    if (!t) throw new PlaybackError(501, 'ไม่พบแหล่ง DSS ของกล้องนี้');
    return t;
  }

  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PlaybackError) throw err;
      if (err instanceof DssAuthError) throw new PlaybackError(502, err.message);
      throw new PlaybackError(502, `DSS: ${err.message || err}`);
    }
  };

  async function ranges(camera, from, to) {
    const span = common.requireSpan(from, to);
    const { client, channelId } = await target(camera);
    const recs = await wrap(() => client.records(channelId, span.start, span.end));
    return common.mergeClips(camera.id, recs, span.start, span.end);
  }

  /** ไฟล์ที่ครอบเวลา ms + URL ที่เริ่มตรงนั้น */
  async function sourceAt(camera, at, duration) {
    const ms = common.parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    const { client, channelId } = await target(camera);
    // ไฟล์ของ DSS ยาวได้ถึง ~30 นาที — ค้นย้อนไป 1 ชม. เพื่อให้เจอไฟล์ที่เริ่มก่อนเวลาที่ขอ
    const recs = await wrap(() => client.records(channelId, ms - 3_600_000, ms + Math.max(1000, duration * 1000)));
    const rec = common.clipAt(recs, ms);
    const url = await wrap(() => client.playbackUrl(channelId, rec, ms));
    return { url, at: ms, seconds: Math.min(duration, (rec.end - ms) / 1000) };
  }

  async function openPlayback(camera, q) {
    const duration = common.requireDuration(q.duration);
    const source = await sourceAt(camera, q.start, duration);
    common.requireCompleteClip(q, source.seconds);
    return common.spawnFmp4({
      ffmpegPath, label: LABEL, seconds: source.seconds, video: q.video, startMs: source.at,
      inputArgs: await common.rtspInput(ffmpegPath, source.url),
    });
  }

  async function frame(camera, at) {
    const source = await sourceAt(camera, at, 2);
    return common.grabJpeg({ ffmpegPath, label: LABEL, inputArgs: await common.rtspInput(ffmpegPath, source.url) });
  }

  return { ranges, openPlayback, frame };
}

module.exports = { createDssPlayback };
