/**
 * ภาพย้อนหลัง AXIS S30: ค้น VAPIX แล้วอ่านคลิปจาก recorder ผ่าน RTSP
 *
 * ข้อจำกัดที่รู้ (ตั้งใจยังไม่แก้): รหัสผ่านอยู่ใน URL ที่ส่งให้ ffmpeg ทาง argv — ผู้ใช้อื่นบนเครื่อง edge
 * ที่ดูรายการ process ได้จะเห็น · stderr ของ ffmpeg ถูกทิ้งเพื่อไม่ให้รหัสหลุดลง log
 * ทางแก้เต็มคือส่งผ่านตัวกลางแบบ onvif-replay-proxy.js ซึ่งใหญ่เกินรอบนี้
 */
const { spawn } = require('child_process');
const { listAxisS30Recordings } = require('./axis-s30');
const { PlaybackError } = require('../gateway/playback');
const { toBangkokIso } = require('../shared/time');
const common = require('./playback-common');

const parseTime = (value) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
};

function createAxisS30Playback({ db, ffmpegPath }) {
  const executable = String(ffmpegPath || 'ffmpeg').replace(/\\\\/g, '\\');
  async function cameraFor(cameraId) {
    const row = await new Promise((resolve, reject) => db.get(
      'SELECT id, brand, type, ip, onvifPort, rtspPort, onvifUser, onvifPass, onvif_main_token FROM cameras WHERE id = ?',
      [cameraId], (err, camera) => err ? reject(err) : resolve(camera),
    ));
    if (!row) throw new PlaybackError(404, 'ไม่พบกล้อง');
    if (row.brand !== 'axis' || row.type !== 'onvif_nvr' || !row.onvif_main_token) {
      throw new PlaybackError(501, 'กล้องนี้ยังไม่มีแหล่งภาพย้อนหลัง');
    }
    // ที่อยู่ไปประกอบเป็น URL ของ ffmpeg — ต้องเป็น host/พอร์ตล้วน (กัน `@`, `/`, ช่องว่างแทรก)
    const hasRtspPort = row.rtspPort !== null && row.rtspPort !== undefined && row.rtspPort !== '';
    if (!common.validHost(row.ip) || (hasRtspPort && !common.validPort(row.rtspPort))
      || !row.onvifUser || !row.onvifPass) {
      throw new PlaybackError(400, 'ข้อมูล AXIS S30 ไม่ครบ (IP / พอร์ต / บัญชี)');
    }
    return row;
  }

  async function clips(camera) {
    const items = await listAxisS30Recordings({
      ip: camera.ip, apiPort: camera.onvifPort, user: camera.onvifUser, pass: camera.onvifPass,
    });
    return items.filter((item) => item.source === `${camera.onvif_main_token}:1`)
      .map((item) => ({
        id: String(item.recordingid || ''),
        start: parseTime(item.starttime),
        end: parseTime(item.stoptime) || Date.now(),
        high: String(item.recordinggroupid || '').startsWith('High_'),
      }))
      .filter((item) => /^[a-z\d_]+$/i.test(item.id) && item.start !== null && item.end > item.start)
      .sort((a, b) => a.start - b.start);
  }

  async function ranges(cameraId, from, to) {
    const start = parseTime(from);
    const end = parseTime(to);
    if (start === null || end === null || end <= start) throw new PlaybackError(400, 'ช่วงเวลาไม่ถูกต้อง');
    const items = await clips(await cameraFor(cameraId));
    const merged = [];
    for (const clip of items) {
      const a = Math.max(start, clip.start);
      const b = Math.min(end, clip.end);
      if (b <= a) continue;
      const last = merged[merged.length - 1];
      if (last && a <= last.end + 1000) last.end = Math.max(last.end, b);
      else merged.push({ start: a, end: b });
    }
    return { cameraId, ranges: merged.map((item) => ({
      start: toBangkokIso(item.start), end: toBangkokIso(item.end),
    })) };
  }

  async function sourceAt(cameraId, at) {
    const ms = parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    const camera = await cameraFor(cameraId);
    const available = (await clips(camera)).filter((item) => item.start <= ms && ms < item.end);
    const clip = available.sort((a, b) => Number(b.high) - Number(a.high) || b.start - a.start)[0];
    if (!clip) throw new PlaybackError(404, 'ไม่มีภาพบันทึก ณ เวลาที่เลือก');
    const user = encodeURIComponent(camera.onvifUser);
    const pass = encodeURIComponent(camera.onvifPass);
    const port = common.rtspPortOf(camera);
    const url = `rtsp://${user}:${pass}@${camera.ip}:${port}/axis-media/media.amp?recordingid=${clip.id}`;
    return { url, clip, offset: (ms - clip.start) / 1000, at: ms };
  }

  /** ffmpeg seek ใน RTSP clip แล้วส่ง fMP4 โดยไม่ส่ง stderr ที่อาจมีรหัส */
  async function openPlayback(cameraId, q) {
    const source = await sourceAt(cameraId, q.start);
    const requested = common.requireDuration(q.duration);
    const seconds = Math.min(requested, (source.clip.end - source.at) / 1000);
    common.requireCompleteClip(q, seconds);
    const args = ['-hide_banner', '-loglevel', 'error',
      ...(await common.rtspInput(ffmpegPath, source.url, ['-ss', String(source.offset)])), '-t', String(seconds), '-map', '0:v:0', '-an',
      ...(q.video === 'h264' ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : ['-c:v', 'copy']),
      // S30 ส่งคลิปย้อนหลังตามเวลาจริง; รอ keyframe แล้วเบราว์เซอร์จะได้แต่ MP4 header นานเกินไป
      '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
    const proc = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stderr.resume();
    return {
      proc, startIso: toBangkokIso(source.at),
      lastError: () => 'อ่านภาพย้อนหลังจาก AXIS S30 ไม่สำเร็จ',
      kill: () => { try { if (!proc.killed) proc.kill(); } catch { /* ออกไปแล้ว */ } },
    };
  }

  async function frame(cameraId, at) {
    const source = await sourceAt(cameraId, at);
    const input = await common.rtspInput(ffmpegPath, source.url, ['-ss', String(source.offset)]);
    return new Promise((resolve, reject) => {
      const proc = spawn(executable, [
        '-hide_banner', '-loglevel', 'error',
        ...input, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => proc.kill(), 15000);
      proc.stdout.on('data', (buf) => {
        size += buf.length;
        if (size > 8_000_000) proc.kill();
        else chunks.push(buf);
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(new PlaybackError(502, err.message)); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && size) resolve(Buffer.concat(chunks));
        else reject(new PlaybackError(502, 'อ่านเฟรมย้อนหลังจาก AXIS S30 ไม่สำเร็จ'));
      });
    });
  }

  return { ranges, openPlayback, frame };
}

module.exports = { createAxisS30Playback };
