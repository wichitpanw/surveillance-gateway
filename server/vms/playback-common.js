/**
 * ของที่แหล่งภาพย้อนหลังจากอุปกรณ์ใช้ร่วมกัน: ตรวจเวลา รวมช่วงบันทึก เปิด ffmpeg ส่ง fMP4 และดึงภาพนิ่ง
 *
 * แหล่งภาพ AXIS S30 และ Uniview เขียนก่อนมีไฟล์นี้และทดสอบกับเครื่องจริงแล้ว จึงยืมแค่ตัวตรวจ
 * (requireDuration, validHost/validPort, rtspInput) ไม่ได้ย้ายทั้งตัวมาใช้ spawnFmp4/grabJpeg
 */
const { spawn, execFile } = require('child_process');
const { PlaybackError } = require('../gateway/playback');
const { toBangkokIso, BANGKOK_OFFSET_MINUTES } = require('../shared/time');

const parseTime = (value) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
};

/** from/to ของคำขอ ranges → epoch ms (ผิด = 400) */
function requireSpan(from, to) {
  const start = parseTime(from);
  const end = parseTime(to);
  if (start === null || end === null || end <= start) throw new PlaybackError(400, 'ช่วงเวลาไม่ถูกต้อง');
  return { start, end };
}

/** duration ของคำขอเล่น: จำนวนเต็ม 1–3600 วินาที (หน้าเว็บและ client ส่งจำนวนเต็มเสมอ) */
function requireDuration(value) {
  const text = String(value ?? '').trim();
  const duration = Number(text);
  if (!/^\d+$/.test(text) || duration < 1 || duration > 3600) {
    throw new PlaybackError(400, 'duration ต้องเป็นจำนวนเต็ม 1–3600 วินาที');
  }
  return duration;
}

/** timeout ของ socket RTSP ใน ffmpeg (ไมโครวินาที) — อุปกรณ์เงียบกลางทาง ffmpeg ต้องออกเอง ไม่ค้างถือ session */
const RTSP_IO_TIMEOUT_US = 15_000_000;

/** `ffmpeg -version` บรรทัดแรก → เลขรุ่นหลัก · build จาก git (`N-12345-g...`) หรืออ่านไม่ออก = null */
function ffmpegMajorOf(text) {
  const m = /ffmpeg version\s+n?(\d+)\.\d/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * ตัวเลือก timeout ของ socket RTSP ตามรุ่น ffmpeg: ≥ 5 = `-timeout`, 4.x = `-stimeout`
 * (ffmpeg 4.x ตีความ `-timeout` ของ RTSP เป็นโหมด listen — ใส่ผิดรุ่นแล้วเล่นไม่ได้เลย) · ไม่รู้รุ่น = ไม่ใส่
 */
function timeoutArgsFor(major) {
  if (major >= 5) return ['-timeout', String(RTSP_IO_TIMEOUT_US)];
  if (major === 4) return ['-stimeout', String(RTSP_IO_TIMEOUT_US)];
  return [];
}

const probeCache = new Map(); // executable → Promise<string[]>
/** ถามรุ่น ffmpeg ครั้งเดียวต่อ executable (execFile, 5 วิ) แล้วจำผลไว้ — probe ล้มก็จำว่าไม่ใส่ timeout */
function rtspTimeoutArgs(ffmpegPath) {
  const exe = ffmpegExecutable(ffmpegPath);
  if (!probeCache.has(exe)) {
    probeCache.set(exe, new Promise((resolve) => {
      execFile(exe, ['-hide_banner', '-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        const args = timeoutArgsFor(err ? null : ffmpegMajorOf(stdout));
        if (!args.length) console.warn(`[Playback] ไม่รู้รุ่น ffmpeg (${exe}) — เปิด RTSP ย้อนหลังโดยไม่มี I/O timeout`);
        resolve(args);
      });
    }));
  }
  return probeCache.get(exe);
}

/**
 * อาร์กิวเมนต์อินพุต RTSP มาตรฐานของ ffmpeg: TCP + I/O timeout ตามรุ่น (rtspTimeoutArgs)
 * before = อาร์กิวเมนต์ที่ต้องอยู่ก่อน `-i` เช่น `-ss` · async เพราะรอผล probe ครั้งแรก (ครั้งต่อไปได้จาก cache)
 */
async function rtspInput(ffmpegPath, url, before = []) {
  return ['-rtsp_transport', 'tcp', ...(await rtspTimeoutArgs(ffmpegPath)), ...before, '-i', url];
}

/** ตัดช่วงคลิปให้อยู่ใน [start, end] แล้วรวมช่วงที่ห่างกันไม่เกิน 1 วินาที → ranges ตามสัญญาของ gateway */
function mergeClips(cameraId, clips, start, end) {
  const merged = [];
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const a = Math.max(start, clip.start);
    const b = Math.min(end, clip.end);
    if (b <= a) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last.end + 1000) last.end = Math.max(last.end, b);
    else merged.push({ start: a, end: b });
  }
  return { cameraId, ranges: merged.map((item) => ({ start: toBangkokIso(item.start), end: toBangkokIso(item.end) })) };
}

/** คลิปที่ครอบเวลา ms (ตัวที่ยาวต่อไปได้ไกลสุด) หรือ 404 */
function clipAt(clips, ms) {
  const clip = clips.filter((item) => item.start <= ms && ms < item.end).sort((a, b) => b.end - a.end)[0];
  if (!clip) throw new PlaybackError(404, 'ไม่มีภาพบันทึก ณ เวลาที่เลือก');
  return clip;
}

/**
 * นาฬิกาหน้าปัดของอุปกรณ์ ↔ epoch ms
 *
 * API ของ NVR/กล้องส่วนใหญ่ (Hikvision ISAPI, Dahua CGI) รับและคืน "เวลาท้องถิ่นของเครื่อง"
 * ระบบนี้ติดตั้งในไทยทั้งหมด (ไม่มี DST) จึงถือเป็น +07:00 · อุปกรณ์ที่ตั้งเขตเวลาอื่นจะเหลื่อม
 */
const DEVICE_OFFSET_MS = BANGKOK_OFFSET_MINUTES * 60_000;
const localParts = (ms) => {
  const d = new Date(ms + DEVICE_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    Y: d.getUTCFullYear(), M: pad(d.getUTCMonth() + 1), D: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()), m: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()),
  };
};
/** `YYYY-MM-DD HH:MM:SS` (ไม่มี offset) → epoch ms โดยถือเป็นเวลาท้องถิ่นของอุปกรณ์ */
const fromDeviceLocal = (text) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - DEVICE_OFFSET_MS;
};

const ffmpegExecutable = (ffmpegPath) => String(ffmpegPath || 'ffmpeg').replace(/\\\\/g, '\\');

/**
 * เปิด ffmpeg อ่าน RTSP ย้อนหลังแล้วส่ง fMP4 ทาง stdout ตามสัญญา openPlayback ของ gateway/playback.js
 * inputArgs = ทุกอย่างก่อนและรวม `-i <url>` · stderr ทิ้งเพราะมี URL พร้อมรหัสผ่านได้
 * frag_every_frame: อุปกรณ์ส่งภาพย้อนหลังตามเวลาจริง รอ keyframe แล้วผู้ชมจะได้แต่ header นานเกินไป
 */
function spawnFmp4({ ffmpegPath, inputArgs, seconds, video, startMs, label, onClose }) {
  const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs,
    '-t', String(seconds), '-map', '0:v:0', '-an',
    ...(video === 'h264' ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : ['-c:v', 'copy']),
    '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const proc = spawn(ffmpegExecutable(ffmpegPath), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  proc.stderr.resume();
  if (onClose) {
    proc.on('close', onClose);
    proc.on('error', onClose);
  }
  return {
    proc,
    startIso: toBangkokIso(startMs),
    lastError: () => `อ่านภาพย้อนหลังจาก ${label} ไม่สำเร็จ`,
    kill: () => { try { if (!proc.killed) proc.kill(); } catch { /* ออกไปแล้ว */ } },
  };
}

/** ภาพนิ่งหนึ่งเฟรมเป็น JPEG · จำกัด 15 วินาทีและ 8 MB */
function grabJpeg({ ffmpegPath, inputArgs, label, onClose }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegExecutable(ffmpegPath), [
      '-hide_banner', '-loglevel', 'error', ...inputArgs,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stderr.resume();
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => proc.kill(), 15000);
    const done = () => { clearTimeout(timer); if (onClose) onClose(); };
    proc.stdout.on('data', (buf) => {
      size += buf.length;
      if (size > 8_000_000) proc.kill();
      else chunks.push(buf);
    });
    proc.on('error', (err) => { done(); reject(new PlaybackError(502, err.message)); });
    proc.on('close', (code) => {
      done();
      if (code === 0 && size) resolve(Buffer.concat(chunks));
      else reject(new PlaybackError(502, `อ่านเฟรมย้อนหลังจาก ${label} ไม่สำเร็จ`));
    });
  });
}

/** แถวกล้องพร้อมคอลัมน์ที่แหล่งภาพต้องใช้ (มีรหัส — ใช้ภายใน edge เท่านั้น ห้ามส่งออก API) */
function loadCamera(db, cameraId) {
  return new Promise((resolve, reject) => db.get(
    `SELECT id, name, brand, type, ip, onvifPort, rtspPort, onvifUser, onvifPass,
            nvr_channel, rtsp, onvif_main_token, source_id, source_ref
       FROM cameras WHERE id = ?`,
    [cameraId], (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new PlaybackError(404, 'ไม่พบกล้อง'));
      return resolve(row);
    },
  ));
}

const validPort = (value) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535;
const validHost = (value) => /^[a-z\d][a-z\d.-]*$/i.test(String(value || ''));

/** ตรวจที่อยู่และบัญชีของอุปกรณ์ก่อนต่อ — ไม่ครบ = 400 */
function requireDeviceAccess(camera, label) {
  if (!validHost(camera.ip) || !validPort(camera.onvifPort) || !camera.onvifUser || !camera.onvifPass) {
    throw new PlaybackError(400, `ข้อมูล ${label} ไม่ครบ (IP / พอร์ต / บัญชี)`);
  }
}

const rtspPortOf = (camera) => (validPort(camera.rtspPort) ? Number(camera.rtspPort) : 554);
const rtspAuth = (camera) => `${encodeURIComponent(camera.onvifUser)}:${encodeURIComponent(camera.onvifPass)}`;

/** อ่านเลขช่องจาก RTSP ด้วย regex ของยี่ห้อ ไม่เจอใช้ nvr_channel · กล้องเดี่ยว (onvif_cam) = ช่อง 1 */
function channelFrom(camera, pattern, map = (n) => n) {
  if (camera.type === 'onvif_cam') return 1;
  const match = pattern.exec(camera.rtsp || '');
  const fromUrl = match ? map(Number(match[1])) : null;
  if (Number.isInteger(fromUrl) && fromUrl > 0) return fromUrl;
  const saved = Number(camera.nvr_channel);
  return Number.isInteger(saved) && saved > 0 ? saved : null;
}

/** งานดาวน์โหลดต้องครบช่วงที่ขอ — ห้ามตัดเหลือคลิปแรกแล้วแจ้งสำเร็จ */
function requireCompleteClip(q, seconds) {
  if ((q.complete === true || q.complete === '1') && seconds + 0.001 < requireDuration(q.duration)) {
    const maximum = Math.max(0, Math.floor(seconds));
    throw new PlaybackError(416, 'ช่วงที่เลือกคร่อมไฟล์บันทึกของอุปกรณ์ กรุณาเลือกไม่เกิน ' + maximum + ' วินาทีจากเวลาเริ่มนี้');
  }
}

module.exports = { requireCompleteClip,
  parseTime, requireSpan, requireDuration, mergeClips, clipAt,
  localParts, fromDeviceLocal, spawnFmp4, grabJpeg, loadCamera,
  requireDeviceAccess, rtspPortOf, rtspAuth, validHost, validPort, channelFrom,
  rtspInput, rtspTimeoutArgs, ffmpegMajorOf, timeoutArgsFor, RTSP_IO_TIMEOUT_US,
};
