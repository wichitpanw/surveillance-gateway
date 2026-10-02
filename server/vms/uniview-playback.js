/**
 * ภาพย้อนหลัง Uniview NVR: LAPI บอกช่วงบันทึก, RTSP replay ส่งภาพของช่องที่แอดผ่าน API หรือ ONVIF
 *
 * ข้อจำกัดที่รู้ (ตั้งใจยังไม่แก้): รหัสผ่านอยู่ใน URL ที่ส่งให้ ffmpeg ทาง argv — ผู้ใช้อื่นบนเครื่อง edge
 * ที่ดูรายการ process ได้จะเห็น · stderr ของ ffmpeg ถูกทิ้งเพื่อไม่ให้รหัสหลุดลง log
 */
const { spawn } = require('child_process');
const { digestRequest } = require('../gateway/analytics/http-digest');
const { PlaybackError } = require('../gateway/playback');
const { toBangkokIso } = require('../shared/time');
const common = require('./playback-common');

const parseTime = (value) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
};

/** ช่องจาก Uniview API มี nvr_channel; ช่อง ONVIF ใช้เลข cN ใน RTSP ที่ NVR คืนมา */
function channelOf(camera) {
  const saved = Number(camera.nvr_channel);
  if (Number.isInteger(saved) && saved > 0) return saved;
  const match = /\/unicast\/c(\d+)\/s\d+\/live(?:[?#]|$)/i.exec(camera.rtsp || '');
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

function createUniviewPlayback({ db, ffmpegPath }) {
  const executable = String(ffmpegPath || 'ffmpeg').replace(/\\\\/g, '\\');

  async function cameraFor(cameraId) {
    const camera = await new Promise((resolve, reject) => db.get(
      'SELECT id, brand, type, ip, onvifPort, rtspPort, onvifUser, onvifPass, nvr_channel, rtsp FROM cameras WHERE id = ?',
      [cameraId], (err, row) => err ? reject(err) : resolve(row),
    ));
    if (!camera) throw new PlaybackError(404, 'ไม่พบกล้อง');
    const channel = channelOf(camera);
    if (camera.brand !== 'uniview' || camera.type !== 'onvif_nvr' || !channel) {
      throw new PlaybackError(501, 'กล้องนี้ยังไม่มีแหล่งภาพย้อนหลัง');
    }
    if (!/^[a-z\d][a-z\d.-]*$/i.test(String(camera.ip || ''))
      || !Number.isInteger(Number(camera.onvifPort)) || Number(camera.onvifPort) < 1 || Number(camera.onvifPort) > 65535
      || !Number.isInteger(Number(camera.rtspPort)) || Number(camera.rtspPort) < 1 || Number(camera.rtspPort) > 65535
      || !camera.onvifUser || !camera.onvifPass) {
      throw new PlaybackError(400, 'ข้อมูล Uniview NVR ไม่ครบ');
    }
    return { ...camera, channel };
  }

  /** ขอเฉพาะช่องและช่วงที่ต้องใช้; ResponseCode ของ LAPI อยู่ใต้ Response */
  async function clips(camera, from, to) {
    const begin = Math.floor(from / 1000);
    const end = Math.ceil(to / 1000);
    const path = `/LAPI/V1.0/Channels/${camera.channel}/Media/Video/Streams/0/Records?Begin=${begin}&End=${end}`;
    let body;
    try {
      body = JSON.parse(await digestRequest(
        { host: camera.ip, port: Number(camera.onvifPort), user: camera.onvifUser, pass: camera.onvifPass },
        path, { timeoutMs: 12000 },
      ));
    } catch (err) {
      throw new PlaybackError(502, `อ่านรายการบันทึกจาก Uniview NVR ไม่สำเร็จ: ${err.message}`);
    }
    const response = body?.Response;
    if (response?.ResponseCode !== 0 || !response.Data
      || (response.Data.Nums !== 0 && !Array.isArray(response.Data.RecordInfos))) {
      throw new PlaybackError(502, 'Uniview NVR ไม่ส่งรายการบันทึกที่ถูกต้อง');
    }
    return (response.Data.RecordInfos || []).map((item) => ({
      start: Number(item.Begin) * 1000,
      end: Number(item.End) * 1000,
    })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
      .sort((a, b) => a.start - b.start);
  }

  async function ranges(cameraId, from, to) {
    const start = parseTime(from);
    const end = parseTime(to);
    if (start === null || end === null || end <= start) throw new PlaybackError(400, 'ช่วงเวลาไม่ถูกต้อง');
    const merged = [];
    for (const clip of await clips(await cameraFor(cameraId), start, end)) {
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

  async function sourceAt(cameraId, at, duration) {
    const ms = parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    const camera = await cameraFor(cameraId);
    const available = (await clips(camera, ms - 1000, ms + Math.max(1000, duration * 1000)))
      .filter((item) => item.start <= ms && ms < item.end);
    const clip = available.sort((a, b) => b.end - a.end)[0];
    if (!clip) throw new PlaybackError(404, 'ไม่มีภาพบันทึก ณ เวลาที่เลือก');
    const seconds = Math.min(duration, (clip.end - ms) / 1000);
    const begin = Math.floor(ms / 1000);
    const end = Math.ceil((ms + seconds * 1000) / 1000);
    const url = `rtsp://${encodeURIComponent(camera.onvifUser)}:${encodeURIComponent(camera.onvifPass)}`
      + `@${camera.ip}:${Number(camera.rtspPort)}/c${camera.channel}/b${begin}/e${end}/replay/`;
    return { url, at: ms, seconds };
  }

  /** Uniview replay เริ่มที่ epoch ใน URL; ไม่ต้อง -ss ซ้ำ */
  async function openPlayback(cameraId, q) {
    const duration = common.requireDuration(q.duration);
    const source = await sourceAt(cameraId, q.start, duration);
    common.requireCompleteClip(q, source.seconds);
    const args = ['-hide_banner', '-loglevel', 'error',
      ...(await common.rtspInput(ffmpegPath, source.url)), '-t', String(source.seconds), '-map', '0:v:0', '-an',
      ...(q.video === 'h264' ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : ['-c:v', 'copy']),
      '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
    const proc = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stderr.resume(); // stderr ของ ffmpeg อาจมี URL พร้อมรหัสผ่าน
    return {
      proc, startIso: toBangkokIso(source.at),
      lastError: () => 'อ่านภาพย้อนหลังจาก Uniview NVR ไม่สำเร็จ',
      kill: () => { try { if (!proc.killed) proc.kill(); } catch { /* ออกไปแล้ว */ } },
    };
  }

  async function frame(cameraId, at) {
    const source = await sourceAt(cameraId, at, 2);
    const input = await common.rtspInput(ffmpegPath, source.url);
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
        else reject(new PlaybackError(502, 'อ่านเฟรมย้อนหลังจาก Uniview NVR ไม่สำเร็จ'));
      });
    });
  }

  return { ranges, openPlayback, frame };
}

module.exports = { createUniviewPlayback, channelOf };
