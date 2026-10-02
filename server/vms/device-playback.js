/**
 * เลือกแหล่งภาพย้อนหลังตามชนิดและยี่ห้ออุปกรณ์ โดยไม่เปลี่ยนสัญญา Playback ของ gateway
 *
 * ลำดับ: ทางเฉพาะยี่ห้อที่ทดสอบแล้ว (AXIS S30, Uniview NVR) → ทางเฉพาะยี่ห้อที่รอเครื่องทดสอบ (Hikvision, Dahua)
 * → ONVIF Profile G สำหรับ onvif_cam / onvif_nvr ที่เหลือทั้งหมด (รวม Milestone Open Network Bridge)
 * · Dahua DSS (dss_relay): QueryRecords + StartPlaybackByFile (dss-playback.js)
 * · Digifort: ยังไม่มีเอกสาร API ย้อนหลัง → 501 · กล้อง RTSP ที่กรอกเอง (manual) ไม่มีทางถามบันทึก → 501
 */
const { PlaybackError } = require('../gateway/playback');
const { createAxisS30Playback } = require('./axis-s30-playback');
const { createUniviewPlayback, channelOf: univiewChannelOf } = require('./uniview-playback');
const { createHikvisionPlayback } = require('./hikvision-playback');
const { createDahuaPlayback } = require('./dahua-playback');
const { createOnvifProfileGPlayback } = require('./onvif-profile-g-playback');
const { createDssPlayback } = require('./dss-playback');
const { loadCamera, rtspTimeoutArgs } = require('./playback-common');
const { DIGIFORT_TYPE } = require('./routes');

const ONVIF_TYPES = new Set(['onvif_cam', 'onvif_nvr']);

/** แหล่งภาพที่รับแถวกล้องแทน id (แหล่งใหม่) ห่อให้เป็นรูปเดียวกับแหล่งเดิมที่รับ id */
const byRow = (source) => ({
  ranges: (camera, from, to) => source.ranges(camera, from, to),
  openPlayback: (camera, q) => source.openPlayback(camera, q),
  frame: (camera, at) => source.frame(camera, at),
});
const byId = (source) => ({
  ranges: (camera, from, to) => source.ranges(camera.id, from, to),
  openPlayback: (camera, q) => source.openPlayback(camera.id, q),
  frame: (camera, at) => source.frame(camera.id, at),
});

/** ชื่อแหล่งภาพของกล้องหนึ่งแถว · null = ไม่มี (ใช้ทั้งเลือกแหล่งและบอกผู้ใช้ว่ากล้องใช้ทางไหน) */
function sourceKindOf(camera) {
  if (!camera) return null;
  if (camera.type === 'dss_relay') return 'dss';
  if (camera.type === DIGIFORT_TYPE) return 'digifort';
  if (!ONVIF_TYPES.has(camera.type)) return null;
  if (camera.brand === 'axis' && camera.type === 'onvif_nvr' && camera.onvif_main_token) return 'axis-s30';
  if (camera.brand === 'uniview' && camera.type === 'onvif_nvr' && univiewChannelOf(camera)) return 'uniview';
  if (camera.brand === 'hikvision') return 'hikvision';
  if (camera.brand === 'dahua') return 'dahua';
  return 'onvif-profile-g';
}

/** เพดานงานอ่านภาพย้อนหลังพร้อมกัน — NVR/กล้องรับ session replay ได้จำกัด และ ffmpeg หนึ่งตัวกิน CPU ของ edge */
const DEFAULT_LIMITS = { perCamera: 2, perHost: 8, total: 16 };

/**
 * ตัวนับงานพร้อมกันสามระดับ (ต่อกล้อง / ต่อที่อยู่อุปกรณ์ / ทั้ง edge)
 * acquire() เกินเพดาน = PlaybackError 429 · คืน release() ที่เรียกซ้ำได้ปลอดภัย
 */
function createPlaybackLimiter(limits = DEFAULT_LIMITS) {
  const byCamera = new Map();
  const byHost = new Map();
  let total = 0;
  const bump = (map, key, delta) => {
    const next = (map.get(key) || 0) + delta;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  };

  function acquire(camera) {
    const cameraKey = String(camera.id);
    const hostKey = String(camera.ip || '').toLowerCase() || `camera:${cameraKey}`;
    if ((byCamera.get(cameraKey) || 0) >= limits.perCamera) {
      throw new PlaybackError(429, `กล้องนี้เปิดภาพย้อนหลังพร้อมกันได้ไม่เกิน ${limits.perCamera} รายการ — ปิดหน้าต่างอื่นแล้วลองใหม่`);
    }
    if ((byHost.get(hostKey) || 0) >= limits.perHost) {
      throw new PlaybackError(429, `อุปกรณ์นี้กำลังส่งภาพย้อนหลังครบ ${limits.perHost} รายการแล้ว — รอสักครู่แล้วลองใหม่`);
    }
    if (total >= limits.total) {
      throw new PlaybackError(429, `edge กำลังอ่านภาพย้อนหลังครบ ${limits.total} รายการแล้ว — รอสักครู่แล้วลองใหม่`);
    }
    bump(byCamera, cameraKey, 1);
    bump(byHost, hostKey, 1);
    total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bump(byCamera, cameraKey, -1);
      bump(byHost, hostKey, -1);
      total -= 1;
    };
  }

  return { acquire, stats: () => ({ total, cameras: byCamera.size, hosts: byHost.size }) };
}

/** เปิดภาพโดยถือสิทธิ์ไว้จน ffmpeg ออก (close/error) · เปิดไม่สำเร็จ = คืนสิทธิ์ทันที */
async function openLimited(limiter, camera, open) {
  const release = limiter.acquire(camera);
  let pb;
  try {
    pb = await open();
  } catch (err) {
    release();
    throw err;
  }
  if (!pb?.proc) { release(); return pb; }
  if (pb.proc.exitCode !== null || pb.proc.signalCode !== null) release();
  pb.proc.once('close', release);
  pb.proc.once('error', release);
  return pb;
}

/** ภาพนิ่ง: ถือสิทธิ์ระหว่างดึง แล้วคืนเสมอ */
async function frameLimited(limiter, camera, grab) {
  const release = limiter.acquire(camera);
  try {
    return await grab();
  } finally {
    release();
  }
}

function createDevicePlayback({ db, ffmpegPath, limits = DEFAULT_LIMITS, dssSessions = null }) {
  const limiter = createPlaybackLimiter(limits);
  // ถามรุ่น ffmpeg ไว้ก่อนตั้งแต่ตอนสร้าง ผู้ชมคนแรกจะได้ไม่ต้องรอ probe (ผลเก็บใน cache ของ playback-common)
  rtspTimeoutArgs(ffmpegPath).catch(() => {});
  const sources = {
    'axis-s30': byId(createAxisS30Playback({ db, ffmpegPath })),
    uniview: byId(createUniviewPlayback({ db, ffmpegPath })),
    hikvision: byRow(createHikvisionPlayback({ ffmpegPath })),
    dahua: byRow(createDahuaPlayback({ ffmpegPath })),
    'onvif-profile-g': byRow(createOnvifProfileGPlayback({ ffmpegPath })),
    dss: byRow(createDssPlayback({ ffmpegPath, sessions: dssSessions })),
  };

  async function resolve(cameraId) {
    const camera = await loadCamera(db, cameraId);
    const kind = sourceKindOf(camera);
    if (kind === 'digifort') {
      throw new PlaybackError(501, 'ภาพย้อนหลังจาก Digifort ยังไม่รองรับ (รอเอกสาร API ส่วน playback)');
    }
    const source = kind ? sources[kind] : null;
    if (!source) throw new PlaybackError(501, 'กล้องนี้ยังไม่มีแหล่งภาพย้อนหลัง');
    return { camera, source };
  }

  return {
    ranges: async (cameraId, from, to) => {
      const { camera, source } = await resolve(cameraId);
      return source.ranges(camera, from, to);
    },
    openPlayback: async (cameraId, q) => {
      const { camera, source } = await resolve(cameraId);
      return openLimited(limiter, camera, () => source.openPlayback(camera, q));
    },
    frame: async (cameraId, at) => {
      const { camera, source } = await resolve(cameraId);
      return frameLimited(limiter, camera, () => source.frame(camera, at));
    },
    limiterStats: () => limiter.stats(),
  };
}

module.exports = { createDevicePlayback, sourceKindOf, createPlaybackLimiter, openLimited, frameLimited };
