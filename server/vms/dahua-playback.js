/**
 * ภาพย้อนหลัง Dahua (กล้องที่มี SD card และ NVR): mediaFileFind.cgi บอกไฟล์บันทึก,
 * RTSP /cam/playback?channel=N&starttime=YYYY_MM_DD_HH_MM_SS&endtime=... ส่งภาพ
 *
 * ยังไม่ได้ทดสอบกับเครื่องจริง (2026-09-28) — เขียนตามเอกสาร Dahua HTTP API สิ่งที่ต้องยืนยันเมื่อได้เครื่อง:
 * · เวลาทั้งใน CGI และ RTSP เป็นเวลาท้องถิ่นของเครื่อง (ถือเป็น +07:00)
 * · condition.Channel เริ่มที่ 1 ตามเอกสาร (firmware เก่าบางรุ่นเริ่มที่ 0)
 * ข้อจำกัดที่รู้ (ตั้งใจยังไม่แก้): รหัสผ่านอยู่ใน URL ที่ส่งให้ ffmpeg ทาง argv — เห็นได้จากรายการ process
 * บนเครื่อง edge · stderr ของ ffmpeg ถูกทิ้งเพื่อไม่ให้รหัสหลุดลง log
 */
const { digestRequest } = require('../gateway/analytics/http-digest');
const { PlaybackError } = require('../gateway/playback');
const common = require('./playback-common');

const LABEL = 'Dahua';
const PAGE = 100;
const MAX_PAGES = 20;

/** epoch ms → เวลาท้องถิ่นของเครื่องแบบที่ CGI (`YYYY-MM-DD HH:MM:SS`) หรือ RTSP (`YYYY_MM_DD_HH_MM_SS`) ใช้ */
function deviceTime(ms, forRtsp = false) {
  const p = common.localParts(ms);
  return forRtsp
    ? `${p.Y}_${p.M}_${p.D}_${p.h}_${p.m}_${p.s}`
    : `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}`;
}

/** คำตอบของ CGI เป็นบรรทัด key=value */
function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** รายการไฟล์จาก findNextFile: items[i].StartTime / items[i].EndTime */
function parseItems(kv) {
  const out = [];
  for (let i = 0; i < Number(kv.found || 0); i += 1) {
    const start = common.fromDeviceLocal(kv[`items[${i}].StartTime`]);
    const end = common.fromDeviceLocal(kv[`items[${i}].EndTime`]);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }
  return out;
}

const channelOf = (camera) => common.channelFrom(camera, /[?&]channel=(\d+)/i);

function createDahuaPlayback({ ffmpegPath }) {
  async function prepare(camera) {
    const channel = channelOf(camera);
    if (!channel) throw new PlaybackError(400, 'ไม่รู้เลขช่องของกล้องนี้บน Dahua NVR');
    common.requireDeviceAccess(camera, LABEL);
    return { ...camera, channel };
  }

  const cgi = (camera, query) => digestRequest(
    { host: camera.ip, port: Number(camera.onvifPort), user: camera.onvifUser, pass: camera.onvifPass },
    `/cgi-bin/mediaFileFind.cgi?${query}`, { timeoutMs: 12000 },
  );

  /**
   * ค้นไฟล์: factory.create → findFile → findNextFile ซ้ำจนหมด → close + destroy เสมอ
   * (ไม่ปิด object ค้างในเครื่อง — NVR มีจำนวน finder จำกัด)
   */
  async function clips(camera, from, to) {
    let object;
    try {
      object = parseKv(await cgi(camera, 'action=factory.create')).result;
    } catch (err) {
      throw new PlaybackError(502, `ค้นบันทึกจาก ${LABEL} ไม่สำเร็จ: ${err.message}`);
    }
    if (!/^\d+$/.test(String(object || ''))) throw new PlaybackError(502, `${LABEL} ไม่ส่งตัวค้นที่ถูกต้อง`);
    const out = [];
    try {
      const condition = [
        `condition.Channel=${camera.channel}`,
        `condition.StartTime=${encodeURIComponent(deviceTime(from))}`,
        `condition.EndTime=${encodeURIComponent(deviceTime(to))}`,
        'condition.Types[0]=dav',
      ].join('&');
      try {
        await cgi(camera, `action=findFile&object=${object}&${condition}`);
      } catch (err) {
        // ไม่มีไฟล์ในช่วงนั้น Dahua ตอบ 400 "Error" แทนรายการว่าง
        if (/HTTP 400/.test(err.message)) return out;
        throw err;
      }
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const kv = parseKv(await cgi(camera, `action=findNextFile&object=${object}&count=${PAGE}`));
        out.push(...parseItems(kv));
        if (Number(kv.found || 0) < PAGE) break;
      }
      return out;
    } catch (err) {
      if (err instanceof PlaybackError) throw err;
      throw new PlaybackError(502, `ค้นบันทึกจาก ${LABEL} ไม่สำเร็จ: ${err.message}`);
    } finally {
      await cgi(camera, `action=close&object=${object}`).catch(() => {});
      await cgi(camera, `action=destroy&object=${object}`).catch(() => {});
    }
  }

  async function ranges(camera, from, to) {
    const span = common.requireSpan(from, to);
    const cam = await prepare(camera);
    return common.mergeClips(camera.id, await clips(cam, span.start, span.end), span.start, span.end);
  }

  async function sourceAt(camera, at, duration) {
    const ms = common.parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    const cam = await prepare(camera);
    const clip = common.clipAt(await clips(cam, ms - 1000, ms + Math.max(1000, duration * 1000)), ms);
    const seconds = Math.min(duration, (clip.end - ms) / 1000);
    const url = `rtsp://${common.rtspAuth(cam)}@${cam.ip}:${common.rtspPortOf(cam)}/cam/playback`
      + `?channel=${cam.channel}&starttime=${deviceTime(ms, true)}`
      + `&endtime=${deviceTime(ms + Math.ceil(seconds) * 1000, true)}`;
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

module.exports = { createDahuaPlayback, parseKv, parseItems, channelOf, deviceTime };
