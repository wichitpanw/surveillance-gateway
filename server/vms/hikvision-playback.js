/**
 * ภาพย้อนหลัง Hikvision (กล้องที่มี SD card และ NVR): ISAPI ContentMgmt/search บอกช่วงบันทึก,
 * RTSP /Streaming/tracks/<ช่อง>01?starttime=...&endtime=... ส่งภาพ
 *
 * ยังไม่ได้ทดสอบกับเครื่องจริง (2026-09-28) — เขียนตามเอกสาร ISAPI สิ่งที่ต้องยืนยันเมื่อได้เครื่อง:
 * · เวลาที่ลงท้าย Z: firmware ส่วนใหญ่ใช้เป็น "เวลาท้องถิ่นของเครื่อง" ไม่ใช่ UTC จริง (ค่าเริ่มต้นของเราถือแบบนั้น)
 *   ถ้าเครื่องไหนใช้ UTC จริง ตั้ง HIKVISION_TIME_UTC=1 ใน env ของ edge
 * · เลข track: NVR ช่อง N = N01, กล้องเดี่ยว = 101
 * ข้อจำกัดที่รู้ (ตั้งใจยังไม่แก้): รหัสผ่านอยู่ใน URL ที่ส่งให้ ffmpeg ทาง argv — เห็นได้จากรายการ process
 * บนเครื่อง edge · stderr ของ ffmpeg ถูกทิ้งเพื่อไม่ให้รหัสหลุดลง log
 */
const { randomUUID } = require('node:crypto');
const { digestRequest } = require('../gateway/analytics/http-digest');
const { blocksOf, textOf } = require('../gateway/analytics/onvif-capabilities');
const { PlaybackError } = require('../gateway/playback');
const common = require('./playback-common');

const LABEL = 'Hikvision';
const TIME_IS_UTC = process.env.HIKVISION_TIME_UTC === '1';
const PAGE = 100;
const MAX_PAGES = 20;

/** epoch ms → `YYYY-MM-DDTHH:MM:SSZ` แบบที่ ISAPI ใช้ (compact = แบบใน URL ของ RTSP) */
function deviceTime(ms, compact = false) {
  const p = TIME_IS_UTC ? (() => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return { Y: d.getUTCFullYear(), M: pad(d.getUTCMonth() + 1), D: pad(d.getUTCDate()),
      h: pad(d.getUTCHours()), m: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()) };
  })() : common.localParts(ms);
  return compact
    ? `${p.Y}${p.M}${p.D}T${p.h}${p.m}${p.s}Z`
    : `${p.Y}-${p.M}-${p.D}T${p.h}:${p.m}:${p.s}Z`;
}

/** เวลาจากผลค้น: มี offset จริง (+07:00) ใช้ตามนั้น · ลงท้าย Z หรือไม่มี offset = เวลาท้องถิ่นของเครื่อง */
function parseDeviceTime(text) {
  const value = String(text || '').trim();
  if (/[+-]\d{2}:?\d{2}$/.test(value)) return common.parseTime(value);
  if (TIME_IS_UTC) return common.parseTime(value.endsWith('Z') ? value : `${value}Z`);
  return common.fromDeviceLocal(value.replace(/Z$/, ''));
}

/** NVR ONVIF ให้ RTSP แบบ /Streaming/Channels/101 → ช่อง 1 */
const trackOf = (camera) => {
  const channel = common.channelFrom(camera, /\/Streaming\/(?:Channels|tracks)\/(\d+)/i, (n) => Math.floor(n / 100));
  return channel ? `${channel}01` : null;
};

function createHikvisionPlayback({ ffmpegPath }) {
  async function prepare(camera) {
    const track = trackOf(camera);
    if (!track) throw new PlaybackError(400, 'ไม่รู้เลขช่องของกล้องนี้บน Hikvision NVR');
    common.requireDeviceAccess(camera, LABEL);
    return { ...camera, track };
  }

  /** ค้นคลิปในช่วง [from, to] ทีละหน้าจนหมด (responseStatusStrg = MORE แปลว่ายังมีต่อ) */
  async function clips(camera, from, to) {
    const searchID = randomUUID().toUpperCase();
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
<searchID>${searchID}</searchID>
<trackList><trackID>${camera.track}</trackID></trackList>
<timeSpanList><timeSpan><startTime>${deviceTime(from)}</startTime><endTime>${deviceTime(to)}</endTime></timeSpan></timeSpanList>
<maxResults>${PAGE}</maxResults>
<searchResultPostion>${page * PAGE}</searchResultPostion>
<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
      let xml;
      try {
        xml = await digestRequest(
          { host: camera.ip, port: Number(camera.onvifPort), user: camera.onvifUser, pass: camera.onvifPass },
          '/ISAPI/ContentMgmt/search', { method: 'POST', body, timeoutMs: 12000 },
        );
      } catch (err) {
        throw new PlaybackError(502, `ค้นบันทึกจาก ${LABEL} ไม่สำเร็จ: ${err.message}`);
      }
      const status = (textOf(xml, 'responseStatusStrg') || '').toUpperCase();
      if (status === 'NO MATCHES') break;
      if (!textOf(xml, 'responseStatus') && !status) throw new PlaybackError(502, `${LABEL} ไม่ส่งผลค้นที่ถูกต้อง`);
      for (const item of blocksOf(xml, 'searchMatchItem')) {
        const span = textOf(item.body, 'timeSpan') || item.body;
        const start = parseDeviceTime(textOf(span, 'startTime'));
        const end = parseDeviceTime(textOf(span, 'endTime'));
        if (start !== null && end !== null && end > start) out.push({ start, end });
      }
      if (status !== 'MORE') break;
    }
    return out;
  }

  async function ranges(camera, from, to) {
    const span = common.requireSpan(from, to);
    const cam = await prepare(camera);
    return common.mergeClips(camera.id, await clips(cam, span.start, span.end), span.start, span.end);
  }

  /** URL ของ RTSP ที่เริ่มตรงเวลาที่ขอ (อุปกรณ์ seek ให้เอง ไม่ต้อง -ss) */
  async function sourceAt(camera, at, duration) {
    const ms = common.parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    const cam = await prepare(camera);
    const clip = common.clipAt(await clips(cam, ms - 1000, ms + Math.max(1000, duration * 1000)), ms);
    // คลิปถัดไปที่ต่อกันอาจยาวกว่านี้ แต่ผู้ชมขอช่วงถัดไปเองเมื่อเล่นจบ
    const seconds = Math.min(duration, (clip.end - ms) / 1000);
    const url = `rtsp://${common.rtspAuth(cam)}@${cam.ip}:${common.rtspPortOf(cam)}/Streaming/tracks/${cam.track}`
      + `?starttime=${deviceTime(ms, true)}&endtime=${deviceTime(ms + Math.ceil(seconds) * 1000, true)}`;
    return { url, at: ms, seconds };
  }

  async function openPlayback(camera, q) {
    const duration = common.requireDuration(q.duration);
    const source = await sourceAt(camera, q.start, duration);
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

module.exports = { createHikvisionPlayback, trackOf, deviceTime, parseDeviceTime };
