/**
 * สั่ง PTZ ของกล้องผ่าน ONVIF
 *
 * ต้นแบบ logic มาจาก OnvifPtzService ของ a reference project แต่ไม่ได้ port
 * โค้ด Java มา — node-onvif ที่ server.js ใช้อยู่แล้วมี ContinuousMove / Stop / Preset
 * ครบ และชดเชยเวลากล้องใน WS-Security digest ให้เองตอน init
 *
 * สิ่งที่ไฟล์นี้เพิ่มจาก node-onvif มีสามอย่าง:
 *
 *   1. เลือก media profile ให้ถูกช่อง — กล้องที่มาจาก NVR ทุกช่องใช้ ip ของ NVR ร่วมกัน
 *      และตาราง cameras ไม่ได้เก็บ profile token ไว้ ถ้าใช้ profile แรกเสมอ การหมุนกล้อง
 *      ช่อง 5 จะไปหมุนช่อง 1 แทน จึงจับคู่ด้วย path ของ RTSP URL ที่แถวนั้นใช้เล่นภาพจริง
 *
 *   2. เรียงคำสั่งต่อกล้องให้ทีละคำสั่ง — ปุ่มกดค้างส่ง move แล้ว stop ติดกันภายในไม่กี่
 *      ร้อยมิลลิวินาที ถ้าสองคำขอวิ่งขนานกันแล้ว stop ไปถึงกล้องก่อน กล้องจะหมุนค้างไป
 *      จนหมด timeout
 *
 *   3. ส่งชื่อ preset ภาษาไทยได้ — node-onvif ตรวจค่าที่ใส่ใน SOAP ว่าต้องเป็น ASCII
 *      และไม่ escape XML เลย SetPreset จึงประกอบ SOAP เองแล้ว escape ทุกค่า
 */
const onvifSoap = require('node-onvif/lib/modules/soap.js');

/** เก็บ OnvifDevice ที่ init แล้วไว้นานเท่านี้ — init หนึ่งครั้งยิงหลายคำขอ (ถาม stream URI ทุก profile) */
const DEVICE_CACHE_MS = 10 * 60_000;

/**
 * ContinuousMove มี Timeout ให้กล้องหยุดเอง — กันกล้องหมุนค้างถ้าคำสั่ง stop หายระหว่างทาง
 * (client ปิดหน้าต่าง, เน็ตหลุด) ยาวพอที่คนกดค้างเพื่อหมุนไกล ๆ ไม่ต้องกดซ้ำ
 */
const MOVE_TIMEOUT_SECONDS = 10;

class PtzError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const clamp = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
};

/** host, user, pass จาก RTSP URL — ใช้กับกล้องที่เพิ่มด้วย RTSP อย่างเดียว ไม่ได้กรอกช่อง ONVIF */
const parseRtsp = (rtsp) => {
  try {
    const url = new URL(String(rtsp || ''));
    return {
      host: url.hostname || null,
      user: decodeURIComponent(url.username || ''),
      pass: decodeURIComponent(url.password || ''),
      path: `${url.pathname}${url.search}`.toLowerCase(),
    };
  } catch {
    return { host: null, user: '', pass: '', path: '' };
  }
};

/** ข้อมูลที่ต้องใช้ต่อกล้อง ONVIF — ช่อง ONVIF ของแถวมาก่อน ค่อยถอยไปใช้ที่ฝังใน RTSP URL */
const targetOf = (camera) => {
  const rtsp = parseRtsp(camera.rtsp);
  return {
    ip: camera.ip || rtsp.host,
    onvifPort: Number(camera.onvifPort) || 80,
    user: camera.onvifUser || rtsp.user,
    pass: camera.onvifPass || rtsp.pass,
    rtspPath: rtsp.path,
  };
};

/**
 * index ของ profile ที่ตรงกับช่องที่แถวนี้เล่นภาพอยู่
 *
 * เทียบแค่ path + query ไม่เทียบ host/port เพราะกล้องมักตอบ stream URI ด้วย IP ภายในของ
 * มันเอง ขณะที่แถวในตารางอาจเป็น IP ที่ forward มา ไม่เจอก็ใช้ profile แรก ซึ่งถูกเสมอ
 * สำหรับกล้องตัวเดียว (ทุก profile ของกล้องตัวเดียวชี้ไปเลนส์เดียวกัน)
 */
const pickProfileIndex = (profiles, rtspPath) => {
  if (rtspPath) {
    const i = profiles.findIndex((p) => parseRtsp(p?.stream?.rtsp).path === rtspPath);
    if (i >= 0) return i;
  }
  return 0;
};

/**
 * แกนที่กล้องขยับได้จริง อ่านจากขอบเขตใน PTZConfiguration ของ profile
 *
 * PTZ service อย่างเดียวบอกไม่ได้ — Uniview รุ่นเลนส์ varifocal ประกาศ PTZ service และ
 * ตอบ GetNodes ปกติ แต่มีแค่ซูม (ขอบเขต pan/tilt เป็น 0..0) ถ้าให้ปุ่มทิศแสดงกับกล้องแบบนี้
 * คนกดแล้วไม่มีอะไรเกิดขึ้น
 *
 * ขอบเขตเป็นศูนย์ทั้งสามแกนแปลว่ากล้องไม่ได้บอก (node-onvif ใส่ 0 ไว้ก่อนเมื่อ profile
 * ไม่มี limits) ไม่ใช่ว่าขยับไม่ได้ — กรณีนั้นเปิดให้ทุกแกนแล้วให้กล้องเป็นคนปฏิเสธเอง
 */
const axesOf = (profile) => {
  const span = (r) => Boolean(r) && Number(r.max) > Number(r.min);
  const range = profile?.ptz?.range || {};
  const panTilt = span(range.x) || span(range.y);
  const zoom = span(range.z);
  if (!panTilt && !zoom) return { panTilt: true, zoom: true };
  return { panTilt, zoom };
};

/**
 * @param {object} deps
 * @param {function} deps.initOnvifDevice  สร้าง+init OnvifDevice ลอง http แล้ว https (server.js)
 */
function createPtz({ initOnvifDevice, edgeClientFor, dssPtz = null }) {
  /** camera id -> { device, key, at } */
  const devices = new Map();
  /** camera id -> promise ท้ายคิว */
  const queues = new Map();

  /** ต่อคิวคำสั่งของกล้องหนึ่งตัว — คำสั่งถัดไปเริ่มหลังตัวก่อนหน้าจบ ไม่ว่าจะสำเร็จหรือไม่ */
  const enqueue = (cameraId, task) => {
    const prev = queues.get(cameraId) || Promise.resolve();
    const run = prev.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    queues.set(cameraId, tail);
    tail.then(() => {
      if (queues.get(cameraId) === tail) queues.delete(cameraId);
    });
    return run;
  };

  const deviceFor = async (camera) => {
    // กล้องที่มาทาง Digifort มี ip เป็นของเครื่อง VMS ไม่ใช่ของกล้อง — ถาม ONVIF ไปก็ได้แต่
    // timeout แล้วรายงานเป็นกล้องติดต่อไม่ได้ ทั้งที่คำตอบจริงคือ "สั่งผ่านทางนี้ไม่ได้"
    if (String(camera.type || '').startsWith('digifort')) {
      throw new PtzError(409, 'กล้องที่มาผ่าน VMS สั่ง PTZ ผ่าน Gateway ไม่ได้');
    }
    // กล้องสาธารณะ (vms/public-cams.js) — ต้นทางให้แค่ภาพ ห้ามเดา IP จาก URL ของ HLS แล้วยิง ONVIF ไปที่เครื่องหน่วยงาน
    if (camera.type === 'public_hls') {
      throw new PtzError(409, 'กล้อง Public ไม่รองรับ PTZ');
    }
    const target = targetOf(camera);
    if (!target.ip || !target.user) {
      throw new PtzError(409, 'กล้องตัวนี้ไม่มี IP หรือบัญชี ONVIF ให้สั่ง PTZ');
    }

    // key รวมทุกอย่างที่ใช้ต่อกล้อง — แก้ IP/รหัสของกล้องแล้ว cache เดิมต้องไม่ถูกใช้ต่อ
    const key = [target.ip, target.onvifPort, target.user, target.pass, target.rtspPath].join('|');
    const hit = devices.get(camera.id);
    if (hit && hit.key === key && Date.now() - hit.at < DEVICE_CACHE_MS) return hit.device;

    let device;
    try {
      device = await initOnvifDevice({
        ip: target.ip,
        onvifPort: target.onvifPort,
        user: target.user,
        pass: target.pass,
      });
    } catch (err) {
      throw new PtzError(502, `ติดต่อกล้องทาง ONVIF ไม่ได้: ${err?.message || err}`);
    }

    const profiles = device.getProfileList() || [];
    if (profiles.length) device.changeProfile(pickProfileIndex(profiles, target.rtspPath));

    devices.set(camera.id, { device, key, at: Date.now() });
    return device;
  };

  /** ทุกคำสั่งที่ไปถึงกล้องแล้วล้มเหลว ล้าง cache ทิ้ง — รอบหน้าจะ init ใหม่ เผื่อกล้องรีบูตหรือเปลี่ยน profile */
  const withDevice = (camera, fn) => enqueue(camera.id, async () => {
    const device = await deviceFor(camera);
    if (!device.services.ptz) throw new PtzError(409, 'กล้องตัวนี้ไม่รองรับ PTZ');
    try {
      return await fn(device, device.getCurrentProfile().token);
    } catch (err) {
      devices.delete(camera.id);
      if (err instanceof PtzError) throw err;
      throw new PtzError(502, `กล้องปฏิเสธคำสั่ง PTZ: ${err?.message || err}`);
    }
  });

  const listPresets = async (device, profileToken) => {
    const result = await device.services.ptz.getPresets({ ProfileToken: profileToken });
    const raw = result?.data?.GetPresetsResponse?.Preset;
    // Tiandy เติมช่องว่างท้ายชื่อให้ยาวเท่ากันทุกตัว ("PRESET01      ")
    return [].concat(raw || [])
      .map((p) => ({ token: p?.$?.token, name: typeof p?.Name === 'string' ? p.Name.trim() : '' }))
      .filter((p) => p.token);
  };

  /**
   * กล้องรองรับ PTZ ไหม และมี preset อะไรบ้าง
   *
   * supported: false คือคำตอบปกติของกล้องตายตัว ไม่ใช่ error — client ใช้ค่านี้ตัดสินว่า
   * จะแสดงแผง PTZ หรือไม่ ส่วนกล้องที่ติดต่อไม่ได้เลยตอบ error ตามจริง ให้แยกออกจาก
   * "ไม่มี PTZ" ได้
   */
  const capabilities = (camera) => enqueue(camera.id, async () => {
    let device;
    try {
      device = await deviceFor(camera);
    } catch (err) {
      if (err instanceof PtzError && err.status === 409) return { supported: false, reason: err.message, presets: [] };
      throw err;
    }
    if (!device.services.ptz) return { supported: false, reason: 'กล้องตัวนี้ไม่รองรับ PTZ', presets: [] };

    const profile = device.getCurrentProfile();
    const axes = axesOf(profile);
    let presets = [];
    let presetError = null;
    try {
      presets = await listPresets(device, profile.token);
    } catch (err) {
      // NVR บางรุ่นประกาศว่ามี PTZ service ทั้งเครื่องแต่ช่องที่เป็นกล้องตายตัวตอบ GetPresets
      // ไม่ได้ — ยังหมุนไม่ได้ก็จริง แต่ไม่ควรทำให้ทั้งคำขอล้ม
      presetError = String(err?.message || err);
    }
    return { supported: true, ...axes, profile: profile.token, presets, presetError };
  });

  const move = (camera, { pan, tilt, zoom }) => withDevice(camera, (device) => device.ptzMove({
    speed: { x: clamp(pan), y: clamp(tilt), z: clamp(zoom) },
    timeout: MOVE_TIMEOUT_SECONDS,
  }));

  const stop = (camera) => withDevice(camera, (device) => device.ptzStop());

  const home = (camera) => withDevice(camera, (device, profileToken) => (
    device.services.ptz.gotoHomePosition({ ProfileToken: profileToken })
  ));

  const gotoPreset = (camera, token) => withDevice(camera, (device, profileToken) => (
    device.services.ptz.gotoPreset({ ProfileToken: profileToken, PresetToken: String(token) })
  ));

  const removePreset = (camera, token) => withDevice(camera, (device, profileToken) => (
    device.services.ptz.removePreset({ ProfileToken: profileToken, PresetToken: String(token) })
  ));

  /** บันทึกตำแหน่งปัจจุบันเป็น preset ใหม่ — คืน token ที่กล้องตั้งให้ */
  const setPreset = (camera, name) => withDevice(camera, async (device, profileToken) => {
    const ptz = device.services.ptz;
    const body = '<tptz:SetPreset>'
      + `<tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>`
      + `<tptz:PresetName>${escapeXml(name)}</tptz:PresetName>`
      + '</tptz:SetPreset>';
    const result = await onvifSoap.requestCommand(ptz.oxaddr, 'SetPreset', ptz._createRequestSoap(body));
    return { token: result?.data?.SetPresetResponse?.PresetToken || null };
  });

  /*
    กล้องที่ central ดึงมาจาก edge (docs/EDGE-PLAN.md เฟส 3): central ไม่มีรหัสกล้องและเข้าวงแลน
    ของกล้องไม่ได้ จึงส่งคำสั่งต่อไปที่ /api/v1 ของ edge ด้วย API key ที่ edge ออกให้

    สิทธิ์ต้องผ่านสองชั้น: key ของ client ที่ central (ตรวจใน index.js ก่อนมาถึงตรงนี้) และ key ที่
    central ถือไว้กับ edge — edge ตรวจเองและตอบ 403 ถ้าไม่ได้ติ๊ก "คุม PTZ" ให้ central
  */
  const isEdge = (camera) => camera.type === 'edge_relay';

  const edgeClient = async (camera) => {
    const client = edgeClientFor ? await edgeClientFor(camera) : null;
    if (!client) throw new PtzError(409, 'ไม่พบ edge ต้นทางของกล้องนี้');
    return client;
  };

  /** error จาก edge → PtzError ที่มีสถานะเดิม ข้อความของ edge ส่งต่อไปตรง ๆ ให้คนอ่าน */
  const fromEdgeError = (err) => {
    if (err instanceof PtzError) return err;
    const status = Number(err?.status) || 502;
    return new PtzError(status === 401 ? 502 : status, `edge: ${err?.message || err}`);
  };

  const edgeCapabilities = (camera) => enqueue(camera.id, async () => {
    const client = await edgeClient(camera);
    let info;
    try {
      info = await client.ptzInfo(camera.source_ref);
    } catch (err) {
      throw fromEdgeError(err);
    }
    if (info?.supported && !info.allowed) {
      return {
        supported: false,
        reason: 'API key ที่ central ถือไว้กับ edge ไม่มีสิทธิ์ PTZ — ติ๊ก "คุม PTZ" ให้ key นั้นที่ edge',
        presets: [],
      };
    }
    return {
      supported: Boolean(info?.supported),
      panTilt: info?.panTilt,
      zoom: info?.zoom,
      reason: info?.reason,
      presets: info?.presets || [],
      presetError: info?.presetError || null,
      via: 'edge',
    };
  });

  const edgeCommand = (camera, command) => enqueue(camera.id, async () => {
    const client = await edgeClient(camera);
    try {
      return await client.ptz(camera.source_ref, command);
    } catch (err) {
      throw fromEdgeError(err);
    }
  });

  const api = {
    capabilities: (camera) => (isEdge(camera) ? edgeCapabilities(camera) : capabilities(camera)),
    move: (camera, body) => (isEdge(camera)
      ? edgeCommand(camera, { action: 'move', pan: clamp(body.pan), tilt: clamp(body.tilt), zoom: clamp(body.zoom) })
      : move(camera, body)),
    stop: (camera) => (isEdge(camera) ? edgeCommand(camera, { action: 'stop' }) : stop(camera)),
    home: (camera) => (isEdge(camera) ? edgeCommand(camera, { action: 'home' }) : home(camera)),
    gotoPreset: (camera, token) => (isEdge(camera)
      ? edgeCommand(camera, { action: 'preset.goto', token }) : gotoPreset(camera, token)),
    setPreset: (camera, name) => (isEdge(camera)
      ? edgeCommand(camera, { action: 'preset.set', name }) : setPreset(camera, name)),
    removePreset: (camera, token) => (isEdge(camera)
      ? edgeCommand(camera, { action: 'preset.remove', token }) : removePreset(camera, token)),
    PtzError,
  };
  if (!dssPtz) return api;

  /*
    กล้องจาก Dahua DSS (type dss_relay) สั่งผ่าน OpenAPI ของ DSS (vms/dss-ptz.js) ไม่ใช่ ONVIF —
    ต่อคิวเดียวกับกล้องอื่นให้คำสั่งของกล้องหนึ่งตัวไม่แซงกัน และแปลง error เป็น PtzError สถานะเดิม
  */
  const isDss = (camera) => camera.type === 'dss_relay';
  const viaDss = (name) => (camera, ...args) => (!isDss(camera) ? api[name](camera, ...args) : enqueue(camera.id, async () => {
    try {
      return await dssPtz[name](camera, ...args);
    } catch (err) {
      throw err instanceof PtzError ? err : new PtzError(Number(err?.status) || 502, err?.message || String(err));
    }
  }));
  return {
    ...api,
    capabilities: viaDss('capabilities'), move: viaDss('move'), stop: viaDss('stop'), home: viaDss('home'),
    gotoPreset: viaDss('gotoPreset'), setPreset: viaDss('setPreset'), removePreset: viaDss('removePreset'),
  };
}

/**
 * แปลง body ของคำขอเป็นคำสั่ง PTZ แล้วสั่ง — ใช้ร่วมกันระหว่าง /api/v1 (API key) และหน้า Live ของเว็บ (session)
 *
 * body: { action, pan, tilt, zoom, token, name } · actor = ชื่อที่ลง log
 * move/stop ไม่ลง log (กดค้างครั้งเดียวคือสองแถว) ส่วน preset ที่เปลี่ยนค่าในกล้องลง log
 * ให้ตอบได้ว่าใครลบ preset ที่คนอื่นตั้งไว้ · ค่าผิดโยน PtzError(400)
 */
async function dispatchPtz(ptz, camera, body = {}, { actor, saveLog } = {}) {
  const action = String(body.action || '');
  const token = String(body.token || '').trim();
  const name = String(body.name || '').trim();
  switch (action) {
    case 'move':
      await ptz.move(camera, body);
      return null;
    case 'stop':
      await ptz.stop(camera);
      return null;
    case 'home':
      await ptz.home(camera);
      return null;
    case 'preset.goto':
      if (!token) throw new PtzError(400, 'ต้องระบุ token ของ preset');
      await ptz.gotoPreset(camera, token);
      return null;
    case 'preset.set': {
      if (!name) throw new PtzError(400, 'ต้องระบุชื่อ preset');
      if (name.length > 64) throw new PtzError(400, 'ชื่อ preset ยาวเกิน 64 ตัวอักษร');
      const result = await ptz.setPreset(camera, name);
      saveLog?.(actor, 'PTZ Preset', `บันทึก preset "${name}" ของกล้อง "${camera.name}"`);
      return result;
    }
    case 'preset.remove':
      if (!token) throw new PtzError(400, 'ต้องระบุ token ของ preset');
      await ptz.removePreset(camera, token);
      saveLog?.(actor, 'PTZ Preset', `ลบ preset ${token} ของกล้อง "${camera.name}"`);
      return null;
    default:
      throw new PtzError(400, `ไม่รู้จักคำสั่ง "${action}"`);
  }
}

module.exports = { createPtz, dispatchPtz, PtzError };
