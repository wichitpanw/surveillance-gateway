/**
 * ภาพย้อนหลังผ่าน ONVIF Profile G — ทางกลางสำหรับอุปกรณ์ที่ไม่มีแหล่งภาพเฉพาะยี่ห้อ:
 * กล้องที่มี SD card (onvif_cam ทุกยี่ห้อ), NVR ยี่ห้ออื่น (Tiandy, Hi-View, generic) และ Milestone Open Network Bridge
 *
 * ทางเดิน: GetServices หา search/replay/media → GetProfile หา VideoSource ของกล้อง
 * → FindRecordings จับคู่ recording กับกล้อง → ranges จาก FindEvents (RecordingHistory/Track/State)
 *   ถ้าอุปกรณ์ไม่รองรับใช้ช่วง DataFrom–DataTo ของ track แบบหยาบ
 * → GetReplayUri → ffmpeg ต่อผ่านตัวกลาง onvif-replay-proxy.js ที่ใส่ `Range: clock=` ให้
 *
 * ทดสอบ Tiandy SD card (2026-09-29) และ Milestone Bridge AXIS/Tiandy (2026-09-30) แล้ว — ไม่มี search/replay service ตอบ 501
 * เวลาใน Profile G เป็น UTC ตามสเปก (ต่างจาก CGI ของ Hikvision/Dahua)
 */
const mUrl = require('node:url');
const soap = require('node-onvif/lib/modules/soap.js');
const { blocksOf, textOf } = require('../gateway/analytics/onvif-capabilities');
const { PlaybackError } = require('../gateway/playback');
const { openReplayProxy } = require('./onvif-replay-proxy');
const common = require('./playback-common');

const LABEL = 'ONVIF Profile G';
const SESSION_TTL_MS = 5 * 60_000;
/*
  ถามผลค้นทีละ WaitTime 1 วิ ไม่ใช่ 5 วิ: กล้อง Tiandy ตอบรอบแรกเป็น Queued แล้วเสร็จในรอบถัดไป —
  WaitTime 5 วิ ทำให้ค้น recording + event รวม ~11 วิ (เกิน timeout เดิมของ central 8 วิ) · 1 วิ × 30 รอบ = รอได้นานเท่าเดิม
*/
const POLL_WAIT = 'PT1S';
const MAX_POLLS = 30;
/*
  recording ที่จับคู่แล้ว + replay URI ใช้ซ้ำได้ 10 นาที — token ของ recording แทบไม่เปลี่ยน แต่กล้อง Tiandy ค้น recording
  เองนาน ~4 วิ (วัด 2026-09-29) · ขอบเวลา Earliest/Latest ในนี้เก่าได้ ผู้ใช้จึงอิงเวลาปัจจุบัน/event ประกอบเสมอ
*/
const RECORDING_TTL_MS = 10 * 60_000;

const NS = {
  tds: 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
  trt: 'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
  tse: 'xmlns:tse="http://www.onvif.org/ver10/search/wsdl"',
  trp: 'xmlns:trp="http://www.onvif.org/ver10/replay/wsdl"',
  tt: 'xmlns:tt="http://www.onvif.org/ver10/schema"',
  wsnt: 'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"',
  tns1: 'xmlns:tns1="http://www.onvif.org/ver10/topics"',
};

const esc = (value) => String(value ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** XAddr / URI ที่อุปกรณ์รายงาน → ใช้ host ที่เราต่อถึงจริง (NVR หลัง NAT มักรายงาน IP ภายใน — ดู onvif_patch.js) */
function withHost(raw, base, keepPort) {
  try {
    const parsed = new URL(raw);
    const port = keepPort ? (parsed.port ? `:${parsed.port}` : '') : (base.port ? `:${base.port}` : '');
    const protocol = keepPort ? parsed.protocol : base.protocol;
    return `${protocol}//${base.hostname}${port}${parsed.pathname}${parsed.search || ''}`;
  } catch {
    return null;
  }
}

function parseRecording(body) {
  const source = blocksOf(body, 'Source')[0]?.body || '';
  const tracks = blocksOf(body, 'Track').map((t) => ({
    token: textOf(t.body, 'TrackToken'),
    type: textOf(t.body, 'TrackType'),
    from: parseUtc(textOf(t.body, 'DataFrom')),
    to: parseUtc(textOf(t.body, 'DataTo')),
  }));
  const video = tracks.find((t) => /video/i.test(t.type || '')) || null;
  return {
    token: textOf(body, 'RecordingToken'),
    sourceId: textOf(source, 'SourceId') || '',
    sourceName: textOf(source, 'Name') || '',
    earliest: parseUtc(textOf(body, 'EarliestRecording')) ?? video?.from ?? null,
    latest: parseUtc(textOf(body, 'LatestRecording')) ?? video?.to ?? null,
    videoTrack: video?.token || null,
    hasVideo: Boolean(video) || tracks.length === 0,
    // ยังบันทึกอยู่ = ขอบบนขยับตามเวลาจริง (ใช้ตอนข้อมูลใน cache เก่ากว่ากล้อง)
    recording: /^Recording$/i.test(textOf(body, 'RecordingStatus') || ''),
  };
}

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** token อยู่ใน SourceId แบบมีตัวคั่นล้อม (VideoSource_1 ไม่ตรง VideoSource_10) */
const containsToken = (sourceId, token) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(token)}(?:$|[^a-z0-9])`, 'i').test(sourceId);

/**
 * จับคู่ recording กับกล้อง: SourceId = token ของ VideoSource/Profile → token อยู่ใน SourceId แบบมีขอบคั่น
 * → ชื่อตรงกัน → มี recording ภาพเดียว (เฉพาะ onvif_cam ที่มีเซนเซอร์เดียว และ SourceId ไม่ขัดกับ token ที่รู้)
 * จับคู่ไม่ได้ = null (ดีกว่าเปิดภาพของกล้องตัวอื่น)
 */
function matchRecording(recordings, { sourceToken, profileToken, name, type }) {
  const list = recordings.filter((r) => r.token && r.hasVideo);
  const tokens = [sourceToken, profileToken].filter(Boolean);
  const found = list.find((r) => tokens.includes(r.sourceId))
    || list.find((r) => r.sourceId && tokens.some((t) => containsToken(r.sourceId, t)))
    || list.find((r) => name && (r.sourceName === name || r.sourceId === name));
  if (found) return found;
  if (type !== 'onvif_cam' || list.length !== 1) return null;
  const only = list[0];
  if (sourceToken && only.sourceId && only.sourceId !== sourceToken) return null;
  return only;
}

/** เวลาใน Profile G เป็น UTC ตามสเปก — ค่าที่ไม่มี Z/offset ถือเป็น UTC ไม่ใช่เวลาเครื่องของเรา */
function parseUtc(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return common.parseTime(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) return common.parseTime(`${value}Z`);
  return common.parseTime(value);
}

/** ช่วงที่มีภาพจากเหตุการณ์ IsDataPresent (true = เริ่ม, false = หยุด) เรียงตามเวลา */
function intervalsFromStates(states, from, to) {
  const out = [];
  let open = null;
  for (const s of [...states].sort((a, b) => a.time - b.time)) {
    if (s.present && open === null) open = Math.max(from, s.time);
    else if (!s.present && open !== null) {
      if (s.time > open) out.push({ start: open, end: Math.min(to, s.time) });
      open = null;
    }
  }
  if (open !== null && to > open) out.push({ start: open, end: to });
  return out;
}

function createOnvifProfileGPlayback({ ffmpegPath }) {
  const sessions = new Map();

  const call = (xaddr, session, body, xmlns) => soap._request(
    typeof xaddr === 'string' ? mUrl.parse(xaddr) : xaddr,
    soap.createRequestSoap({ body, xmlns, diff: session.diff, user: session.user, pass: session.pass }),
  );

  /** ต่ออุปกรณ์ครั้งแรก (http ก่อนแล้ว https) หา offset นาฬิกาสำหรับ WS-Security และ XAddr ของบริการ */
  async function openSession(camera) {
    common.requireDeviceAccess(camera, LABEL);
    const key = `${camera.ip}:${camera.onvifPort}:${camera.onvifUser}`;
    const cached = sessions.get(key);
    if (cached && cached.expires > Date.now() && cached.pass === camera.onvifPass) return cached;

    const session = { user: camera.onvifUser, pass: camera.onvifPass, diff: 0 };
    let base = null;
    for (const scheme of ['http', 'https']) {
      const candidate = mUrl.parse(`${scheme}://${camera.ip}:${Number(camera.onvifPort)}/onvif/device_service`);
      try {
        const xml = await soap._request(candidate, soap.createRequestSoap({ body: '<tds:GetSystemDateAndTime/>', xmlns: [NS.tds] }));
        const utc = blocksOf(xml, 'UTCDateTime')[0]?.body || '';
        const n = (tag) => Number(textOf(utc, tag));
        const deviceMs = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
        if (Number.isFinite(deviceMs)) session.diff = deviceMs - Date.now();
        base = candidate;
        break;
      } catch { /* ลองอีก scheme */ }
    }
    if (!base) throw new PlaybackError(502, `ต่อ ONVIF ของ ${camera.ip} ไม่ได้`);

    let servicesXml;
    try {
      servicesXml = await call(base, session,
        '<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>', [NS.tds]);
    } catch (err) {
      throw new PlaybackError(502, `อ่านบริการ ONVIF ไม่สำเร็จ: ${err.message}`);
    }
    session.device = base;
    for (const svc of blocksOf(servicesXml, 'Service')) {
      const ns = textOf(svc.body, 'Namespace') || '';
      const xaddr = withHost(textOf(svc.body, 'XAddr'), base, false);
      if (!xaddr) continue;
      if (ns.endsWith('/ver10/search/wsdl')) session.search = xaddr;
      else if (ns.endsWith('/ver10/replay/wsdl')) session.replay = xaddr;
      else if (ns.endsWith('/ver10/media/wsdl')) session.media = xaddr;
    }
    if (!session.search || !session.replay) {
      throw new PlaybackError(501, 'อุปกรณ์นี้ไม่มีบริการค้น/เล่นย้อนหลังของ ONVIF (Profile G)');
    }
    session.expires = Date.now() + SESSION_TTL_MS;
    sessions.set(key, session);
    return session;
  }

  /** token ของ VideoSource ที่ profile ของกล้องชี้อยู่ — ใช้จับคู่กับ Source ของ recording */
  async function sourceTokenOf(session, camera) {
    if (!camera.onvif_main_token || !session.media) return null;
    try {
      const xml = await call(session.media, session,
        `<trt:GetProfile><trt:ProfileToken>${esc(camera.onvif_main_token)}</trt:ProfileToken></trt:GetProfile>`,
        [NS.trt, NS.tt]);
      return textOf(blocksOf(xml, 'VideoSourceConfiguration')[0]?.body || '', 'SourceToken');
    } catch {
      return null;
    }
  }

  async function listRecordings(session, scope = '<tse:Scope/>') {
    const start = await call(session.search, session,
      `<tse:FindRecordings>${scope}<tse:MaxMatches>200</tse:MaxMatches><tse:KeepAliveTime>PT30S</tse:KeepAliveTime></tse:FindRecordings>`,
      [NS.tse, NS.tt]);
    const token = textOf(start, 'SearchToken');
    if (!token) throw new Error('ไม่ได้ SearchToken');
    const out = [];
    let completed = false;
    try {
      for (let i = 0; i < MAX_POLLS; i += 1) {
        const xml = await call(session.search, session,
          `<tse:GetRecordingSearchResults><tse:SearchToken>${esc(token)}</tse:SearchToken><tse:MinResults>1</tse:MinResults>`
          + `<tse:MaxResults>200</tse:MaxResults><tse:WaitTime>${POLL_WAIT}</tse:WaitTime></tse:GetRecordingSearchResults>`,
          [NS.tse, NS.tt]);
        out.push(...blocksOf(xml, 'RecordingInformation').map((r) => parseRecording(r.body)));
        if (/Completed/i.test(textOf(xml, 'SearchState') || '')) { completed = true; break; }
      }
    } finally {
      await call(session.search, session, `<tse:EndSearch><tse:SearchToken>${esc(token)}</tse:SearchToken></tse:EndSearch>`, [NS.tse])
        .catch(() => {});
    }
    if (scope !== '<tse:Scope/>' && !completed) throw new Error('ค้นบันทึก Milestone ยังไม่เสร็จภายในเวลาที่กำหนด');
    return out;
  }

  /** Milestone ต้องระบุ camera GUID และ filter เวลา; ผลค้นแต่ละแถวเป็นคลิปจริง ไม่ใช่ recording รวม */
  async function milestoneRecordings(camera, from, to) {
    const session = await openSession(camera);
    const token = await sourceTokenOf(session, camera);
    if (!token) throw new PlaybackError(502, 'อ่านรหัสกล้องของ Milestone ไม่สำเร็จ');
    const recordings = [];
    // ค้นทีละช่วงและแบ่งช่วงที่เต็มเพดาน เพื่อไม่ซ่อนคลิปเมื่อ VMS มีการบันทึกแบบ motion หลายช่วง
    async function search(start, end, depth = 0) {
      const center = Math.floor((start + end) / 2);
      const filter = `boolean(//Track[TrackType = "Video"]),${isoUtc(center)},${center - start + 1000},200,${end - center + 1000},200`;
      const scope = `<tse:Scope><tt:IncludedSources><tt:Token>${esc(token)}</tt:Token></tt:IncludedSources>`
        + `<tt:RecordingInformationFilter>${esc(filter)}</tt:RecordingInformationFilter></tse:Scope>`;
      let rows;
      try { rows = await listRecordings(session, scope); }
      catch (err) { throw new PlaybackError(502, `ค้นบันทึก Milestone ไม่สำเร็จ: ${err.message}`); }
      if (rows.length >= 200) {
        if (depth >= 16 || end - start <= 2000) throw new PlaybackError(502, 'Milestone ส่งรายการบันทึกไม่ครบ กรุณาเลือกช่วงเวลาสั้นลง');
        await search(start, center, depth + 1);
        await search(center, end, depth + 1);
        return;
      }
      // RecordingToken ต้องตรงกับ GUID ที่ร้องขอ; SourceId ของ Bridge เป็น anonymous จึงใช้จับคู่ไม่ได้
      recordings.push(...rows.filter((r) => r.token === token && r.hasVideo && r.earliest !== null && r.latest !== null
        && r.latest > start && r.earliest < end));
    }
    for (let start = from; start < to; start += 86400000) await search(start, Math.min(start + 86400000, to));
    const unique = [...new Map(recordings.map((r) => [`${r.token}:${r.earliest}:${r.latest}`, r])).values()];
    return { session, recordings: unique };
  }

  const recordingCache = new Map(); // camera.id → { session, recording, uri, expires }

  /** recording ของกล้องตัวนี้ (ไม่เจอ = 404 ถ้าอุปกรณ์ไม่มีบันทึกเลย, 409 ถ้ามีหลายตัวแต่จับคู่ไม่ได้) · จำไว้ RECORDING_TTL_MS */
  async function recordingFor(camera) {
    const cached = recordingCache.get(camera.id);
    if (cached && cached.expires > Date.now()) return cached;
    const found = await findRecording(camera);
    const entry = { ...found, uri: null, expires: Date.now() + RECORDING_TTL_MS };
    recordingCache.set(camera.id, entry);
    return entry;
  }

  async function findRecording(camera) {
    const session = await openSession(camera);
    let recordings;
    try {
      recordings = await listRecordings(session);
    } catch (err) {
      throw new PlaybackError(502, `ค้น recording ผ่าน ONVIF ไม่สำเร็จ: ${err.message}`);
    }
    if (!recordings.length) throw new PlaybackError(404, 'อุปกรณ์ไม่มีภาพบันทึก (ไม่มี SD card หรือไม่ได้ตั้งบันทึก)');
    const recording = matchRecording(recordings, {
      sourceToken: await sourceTokenOf(session, camera),
      profileToken: camera.onvif_main_token,
      name: camera.source_ref || camera.name,
      type: camera.type,
    });
    if (!recording) throw new PlaybackError(409, 'จับคู่ recording ของอุปกรณ์กับกล้องนี้ไม่ได้');
    return { session, recording };
  }

  /** FindEvents หา IsDataPresent ของ track ภาพ · อุปกรณ์ไม่รองรับ = null (ผู้เรียกใช้ช่วงหยาบแทน) */
  async function stateEvents(session, recording, from, to) {
    try {
      const start = await call(session.search, session,
        `<tse:FindEvents><tse:StartPoint>${isoUtc(from)}</tse:StartPoint><tse:EndPoint>${isoUtc(to)}</tse:EndPoint>`
        + `<tse:Scope><tt:IncludedRecordings>${esc(recording.token)}</tt:IncludedRecordings></tse:Scope>`
        + '<tse:SearchFilter><wsnt:TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">'
        + 'tns1:RecordingHistory/Track/State</wsnt:TopicExpression></tse:SearchFilter>'
        + '<tse:IncludeStartState>true</tse:IncludeStartState><tse:MaxMatches>2000</tse:MaxMatches>'
        + '<tse:KeepAliveTime>PT30S</tse:KeepAliveTime></tse:FindEvents>',
        [NS.tse, NS.tt, NS.wsnt, NS.tns1]);
      const token = textOf(start, 'SearchToken');
      if (!token) return null;
      const states = [];
      try {
        for (let i = 0; i < MAX_POLLS; i += 1) {
          const xml = await call(session.search, session,
            `<tse:GetEventSearchResults><tse:SearchToken>${esc(token)}</tse:SearchToken><tse:MinResults>1</tse:MinResults>`
            + `<tse:MaxResults>500</tse:MaxResults><tse:WaitTime>${POLL_WAIT}</tse:WaitTime></tse:GetEventSearchResults>`,
            [NS.tse, NS.tt]);
          for (const r of blocksOf(xml, 'Result')) {
            const track = textOf(r.body, 'TrackToken');
            if (recording.videoTrack && track && track !== recording.videoTrack) continue;
            const item = /Name\s*=\s*["']IsDataPresent["'][^>]*Value\s*=\s*["'](\w+)["']/i.exec(r.body)
              || /Value\s*=\s*["'](\w+)["'][^>]*Name\s*=\s*["']IsDataPresent["']/i.exec(r.body);
            const time = parseUtc(textOf(r.body, 'Time'));
            if (item && time !== null) states.push({ time, present: /^true$/i.test(item[1]) });
          }
          if (/Completed/i.test(textOf(xml, 'SearchState') || '')) break;
        }
      } finally {
        await call(session.search, session, `<tse:EndSearch><tse:SearchToken>${esc(token)}</tse:SearchToken></tse:EndSearch>`, [NS.tse])
          .catch(() => {});
      }
      return states.length ? states : null;
    } catch {
      return null;
    }
  }

  async function clips(session, recording, from, to) {
    const coarse = recording.earliest !== null && recording.latest !== null && recording.latest > recording.earliest
      ? [{ start: recording.earliest, end: Math.max(recording.latest, recording.recording ? Date.now() : 0) }] : [];
    const states = await stateEvents(session, recording, from, to);
    if (!states) return coarse;
    // ช่วงเปิดค้าง (ยังบันทึกอยู่) ตัดที่ LatestRecording หรือเวลาปัจจุบัน — recording ใน cache อาจเก่าได้ถึง RECORDING_TTL_MS
    const limit = recording.recording ? Math.max(recording.latest ?? 0, Date.now()) : (recording.latest ?? to);
    return intervalsFromStates(states, from, Math.min(to, limit));
  }

  async function ranges(camera, from, to) {
    const span = common.requireSpan(from, to);
    if (camera.brand === 'milestone') {
      const { recordings } = await milestoneRecordings(camera, span.start, span.end);
      return common.mergeClips(camera.id, recordings.map((r) => ({ start: r.earliest, end: r.latest })), span.start, span.end);
    }
    const { session, recording } = await recordingFor(camera);
    return common.mergeClips(camera.id, await clips(session, recording, span.start, span.end), span.start, span.end);
  }

  /**
   * จุดเริ่มเล่น — เช็กแค่ขอบของ recording (EarliestRecording ถึง LatestRecording) ไม่ค้น event ซ้ำ:
   * ผู้ชมเลือกเวลาจากแถบช่วงบันทึกที่ ranges() คืนไปแล้ว และ ONVIF replay ที่ตกช่องว่างอุปกรณ์เล่นจากภาพถัดไปเอง
   * (การค้น event ตอนกดเล่นเคยกินเวลาเพิ่ม ~5 วิ ต่อครั้ง)
   */
  async function sourceAt(camera, at, duration) {
    const ms = common.parseTime(at);
    if (ms === null) throw new PlaybackError(400, 'เวลาเริ่มต้นไม่ถูกต้อง');
    let entry;
    if (camera.brand === 'milestone') {
      const found = await milestoneRecordings(camera, ms - 1000, ms + duration * 1000);
      const recording = found.recordings.filter((r) => r.earliest <= ms && r.latest > ms).sort((a, b) => b.latest - a.latest)[0];
      if (!recording) throw new PlaybackError(404, 'Milestone ไม่มีภาพบันทึก ณ เวลาที่เลือก');
      entry = { session: found.session, recording, uri: null };
    } else entry = await recordingFor(camera);
    const { session, recording } = entry;
    // กล้องที่ยังบันทึกอยู่ LatestRecording ขยับตลอด — ขอบบนใช้เวลาปัจจุบันถ้ามากกว่า
    const end = camera.brand !== 'milestone' && recording.recording ? Math.max(recording.latest ?? 0, Date.now()) : (recording.latest ?? 0);
    if (recording.earliest === null || ms < recording.earliest - 1000 || ms >= end) {
      throw new PlaybackError(404, 'ไม่มีภาพบันทึก ณ เวลาที่เลือก');
    }
    if (!entry.uri) {
      let xml;
      try {
        xml = await call(session.replay, session,
          '<trp:GetReplayUri><trp:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trp:StreamSetup>'
          + `<trp:RecordingToken>${esc(recording.token)}</trp:RecordingToken></trp:GetReplayUri>`,
          [NS.trp, NS.tt]);
      } catch (err) {
        throw new PlaybackError(502, `ขอ replay URI ไม่สำเร็จ: ${err.message}`);
      }
      // Tiandy ตอบ `RTSP://…` ตัวพิมพ์ใหญ่ — URL() ทำ scheme เป็นตัวเล็กให้ใน withHost
      const uri = withHost(textOf(xml, 'Uri'), new URL(`rtsp://${camera.ip}`), true);
      if (!uri || !uri.startsWith('rtsp://')) throw new PlaybackError(502, 'อุปกรณ์ไม่ส่ง replay URI แบบ RTSP');
      entry.uri = uri;
    }
    const seconds = Math.min(duration, (end - ms) / 1000);
    return { uri: entry.uri, at: ms, seconds };
  }

  const proxyFor = (camera, source) => openReplayProxy({
    url: source.uri, user: camera.onvifUser, pass: camera.onvifPass,
    startMs: source.at, endMs: camera.brand === 'milestone' ? undefined : source.at + Math.ceil(source.seconds) * 1000,
    rateControl: camera.brand === 'milestone' ? false : null,
  });

  async function openPlayback(camera, q) {
    const duration = common.requireDuration(q.duration);
    const source = await sourceAt(camera, q.start, duration);
    const proxy = await proxyFor(camera, source);
    return common.spawnFmp4({
      ffmpegPath, label: LABEL, seconds: source.seconds, video: q.video, startMs: source.at,
      inputArgs: await common.rtspInput(ffmpegPath, proxy.url), onClose: proxy.close,
    });
  }

  async function frame(camera, at) {
    const source = await sourceAt(camera, at, 2);
    const proxy = await proxyFor(camera, source);
    return common.grabJpeg({
      ffmpegPath, label: LABEL, inputArgs: await common.rtspInput(ffmpegPath, proxy.url), onClose: proxy.close,
    });
  }

  return { ranges, openPlayback, frame };
}

module.exports = { createOnvifProfileGPlayback, matchRecording, intervalsFromStates, parseRecording, parseUtc };
