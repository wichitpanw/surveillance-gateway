/**
 * ซิงก์กล้องจากตาราง cameras เข้า go2rtc
 *
 * คู่ขนานกับ syncCamerasToMediaMTX() ใน server.js และตั้งใจให้เรียบง่ายกว่ามาก
 * เพราะ go2rtc รับผิดชอบสิ่งที่เดิมเราต้องทำเองทั้งหมด: ตรวจ codec, transcode
 * H.265, เปิด/ปิดสตรีมตามผู้ชม ทั้งชุด `spawnTranscode` / `detectNvenc` /
 * `codecCache` / `ensureAlwaysOnMainTranscode` ที่เคยเป็นหัวใจของฝั่ง MediaMTX
 * จึงไม่มีอะไรให้ทำที่นี่เลย
 *
 * ใช้ REST API แทนการเขียน go2rtc.yaml แล้วรีสตาร์ต ด้วยเหตุผลเดียวกับที่ฝั่ง
 * MediaMTX ใช้ REST: การรีสตาร์ต core ตัดสตรีมของทุกกล้องพร้อมกันเพียงเพราะมีคน
 * เพิ่มกล้องมาหนึ่งตัว
 */
const http = require('http');
const fs = require('fs');

const { GO2RTC_API_PORT: API_PORT, stateFile } = require('../shared/instance');
const { isSafeEdgeRtsp, warnRejected } = require('../vms/edge');
const HOST = '127.0.0.1';

/** ชื่อ path — ต้องตรงกับ streamPathName ใน gateway/streams.js และ src/lib/api.js */
const pathName = (cameraId, streamType = 'main') => {
  const sn = String(cameraId || '').toLowerCase().replace(/\s+/g, '_');
  return streamType === 'sub' ? `${sn}_sub` : sn;
};

/** ชื่อ path ของเส้น passthrough — ต้องตรงกับ rawStreamPathName ใน gateway/streams.js */
const rawPathName = (cameraId, streamType = 'main') => `${pathName(cameraId, streamType)}_raw`;

/**
 * เปิด/ปิดเส้น passthrough ทั้งชุดจาก ecosystem.windows.config.cjs โดยไม่ต้องแก้โค้ด
 *
 * ตั้งไว้ให้ปิดได้เพราะเส้นพวกนี้เพิ่มการเชื่อมต่อไปยังกล้องอีกชุดหนึ่ง ถ้ากล้องรุ่นไหน
 * รับ session พร้อมกันได้จำกัดแล้วมีปัญหา ต้องดับได้ทันทีด้วยการรีสตาร์ต backend เฉยๆ
 */
const rawStreamsEnabled = () => String(process.env.GATEWAY_RAW_STREAMS || '') === '1';

function request(method, path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: API_PORT, path, method, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('go2rtc ไม่ตอบภายในเวลาที่กำหนด')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * แหล่งที่มาของสตรีมหนึ่งเส้นในรูปแบบที่ go2rtc เข้าใจ
 *
 * `#video=h264` บังคับให้ทุกสตรีมออกมาเป็น H.264 เสมอ ไม่ใช่การเผื่อไว้:
 * go2rtc 1.9.14 panic (SIGSEGV) ใน pkg/h265/rtp.go เมื่อส่ง H.265 ออกทาง MSE
 * ซึ่งทำให้ความพยายามย้ายครั้งแรกเมื่อ 2026-07-23 ล้มเหลว — ดู
 * ~/.pm2/logs/0-go2rtc-error.log บน VM การ normalise เป็น H.264 ก่อนถึงผู้ชม
 * ทำให้ไม่มีทางเดินไปถึงโค้ดส่วนนั้นได้เลย อย่าถอดออกเพื่อ "ประหยัด transcode"
 *
 * `#hardware` ให้ go2rtc ใช้ NVENC/NVDEC ของ GPU เมื่อจำเป็นต้อง transcode จริง
 * และไม่มีผลอะไรเมื่อต้นทางเป็น H.264 อยู่แล้ว (go2rtc จะ passthrough)
 */
const sourceFor = (rtsp) => `ffmpeg:${String(rtsp).replace(/"/g, '')}#video=h264#hardware`;

/**
 * แหล่งเดียวกันแต่ไม่ผ่าน ffmpeg — go2rtc ต่อ RTSP เองแล้วส่งต่อ elementary stream ดิบ
 *
 * ในคลังกล้องชุดนี้ 140 จาก 182 เส้นเป็น H.265 (ดู server/codec_cache.json) ทุกเส้น
 * จึงถูก NVENC transcode ทิ้งตลอดเวลาเพียงเพื่อเลี่ยง SIGSEGV ของฝั่ง MSE เท่านั้น
 * client ที่ไม่ได้ดูผ่าน MSE — เช่นตัว native บน Windows ที่ถอดรหัสด้วย D3D11VA เอง —
 * ไม่จำเป็นต้องจ่ายค่านั้น เส้น `_raw` จึงมีไว้ให้ปลายทางแบบนั้นดึง H.265 ไปตรงๆ
 *
 * ยืนยันแล้วเมื่อ 2026-09-08 ว่า go2rtc 1.9.14 ส่ง H.265 ออกทาง RTSP :8555 ได้โดยไม่ panic
 * (ทดสอบด้วย instance แยกพอร์ต 8557 อ่านต่อเนื่อง 30 วินาที ได้ 751 เฟรมที่ 25fps
 * encoder ของ GPU อยู่ที่ 0% ตลอด) — เส้นทาง MSE ยังต้องใช้ sourceFor() ตามเดิม
 *
 * `#backchannel=0` ไม่ใช่ของแถม แต่จำเป็น
 *
 * go2rtc ใส่ `Require: www.onvif.org/ver20/backchannel` ใน DESCRIBE เสมอเมื่อไม่ได้สั่งปิด
 * ตาม ONVIF Streaming Spec กล้องต้องตอบ SDP ที่มีทั้ง video, audio recvonly และ audio
 * sendonly — แต่ NVR ที่ 203.0.113.99:55101 (SDP บอกตัวเองว่า "ONVIF RTSP Server")
 * ตอบมาแค่สอง audio แล้วทิ้ง m=video ทิ้งไปเฉย ๆ ผลคือ go2rtc ดูดมาแต่ pcm_mulaw
 * ผู้ชมได้ path ที่ "ต่อติด" แต่ไม่มีภาพเลย
 *
 * go2rtc retry แบบไม่มี backchannel ให้เองเฉพาะตอนกล้องตอบ 551 Option not supported
 * เคสนี้กล้องตอบ 200 OK พร้อม SDP ที่ผิดสเปก จึงไม่มีอะไรให้ retry
 *
 * ทดสอบเทียบแล้วเมื่อ 2026-09-08: กล้อง LAN (203.0.113.12) ได้ hevc 704x576 + pcm_alaw
 * เท่ากันทั้งมีและไม่มีธงนี้ ส่วน NVR ตัวปัญหากลับมาได้ h264 720x576 — ปิดทิ้งทั้งระบบ
 * จึงไม่มีต้นทุน นอกจากเสียความสามารถคุยกลับ ซึ่งเส้น `_raw` ไม่ได้มีไว้ทำอยู่แล้ว
 */
const rawSourceFor = (rtsp, brand) => `${String(rtsp).replace(/"/g, '')}#backchannel=0${brand === 'milestone' ? '#transport=tcp' : ''}`;

/**
 * ตัด prefix และ fragment ออกให้เหลือแต่ URL จริง เพื่อเทียบว่าต้นทางเปลี่ยนหรือยัง
 *
 * go2rtc รายงาน url กลับมาไม่ตรงรูปแบบที่เราส่งไปเสมอ — บางเส้นมี `ffmpeg:` นำหน้า
 * บางเส้นไม่มี และ fragment (`#video=h264#hardware`) ก็ไม่ถูกส่งกลับมาด้วย การเทียบ
 * ทั้งสตริงจึงต่างกันตลอดเวลาแล้วกลายเป็น PUT ทุกรอบ ซึ่งตัดผู้ชมที่กำลังดูอยู่ทิ้ง
 */
const bareUrl = (s) => String(s || '').replace(/^ffmpeg:/, '').split('#')[0];

/**
 * สูตรของ source เส้น `_raw` เปลี่ยนเมื่อไหร่ ให้ขยับเลขนี้
 *
 * มีไว้เพราะ bareUrl() ตัด fragment ทิ้งก่อนเทียบ และ go2rtc ก็ไม่เคยส่ง fragment กลับมาใน
 * /api/streams ด้วย การแก้สูตรที่อยู่ใน fragment (เช่นเพิ่ม `#backchannel=0`) จึง "มองไม่เห็น"
 * ทั้งสองทาง — sync จะสรุปว่าไม่มีอะไรเปลี่ยนแล้วข้าม PUT ไปตลอดกาล ของที่รันอยู่ก็ค้างสูตรเก่า
 * เงียบ ๆ (เจอจริงตอนเพิ่ม `#backchannel=0` เมื่อ 2026-09-08: แก้โค้ด รีสตาร์ต แล้ว go2rtc.yaml
 * ยังไม่มีคำนั้นอยู่เลยสักบรรทัด)
 *
 * เทียบทั้งสตริงแทนไม่ได้ เพราะ go2rtc รายงาน url ของเส้น transcode กลับมาไม่ตรงรูปแบบที่ส่งไป
 * ผลจะกลายเป็น PUT ทุกรอบ ซึ่งตัดผู้ชมที่กำลังดูอยู่ทิ้ง — ปัญหาที่ bareUrl() มีไว้แก้ตั้งแต่แรก
 *
 * เลขนี้จึงเป็นทางที่สาม: บันทึกว่าเคยลงสูตรเวอร์ชันไหนไว้ ถ้าไม่ตรงก็บังคับ PUT รอบเดียว
 */
const RAW_RECIPE_VERSION = 2;
const RECIPE_STAMP_PATH = stateFile('.go2rtc-raw-recipe');

const readRecipeStamp = () => {
  try {
    return Number(fs.readFileSync(RECIPE_STAMP_PATH, 'utf8').trim()) || 0;
  } catch {
    // ยังไม่เคยเขียน = ยังไม่เคยลงสูตรไหน
    return 0;
  }
};

const writeRecipeStamp = (version) => {
  try {
    fs.writeFileSync(RECIPE_STAMP_PATH, `${version}\n`, 'utf8');
  } catch (err) {
    // เขียนไม่ได้ก็แค่บังคับ PUT ซ้ำรอบหน้า ไม่ใช่เหตุให้ sync ล้ม
    console.warn(`[go2rtc Sync] บันทึกเวอร์ชันสูตรไม่ได้: ${err.message}`);
  }
};

/**
 * ทำให้สตรีมใน go2rtc ตรงกับกล้องใน DB
 *
 * @param {object} db  sqlite3 connection ของ server.js
 * @param {function} resolveSubRtsp  ตัวหา RTSP ของ substream (ใช้ของ server.js ตัวเดิม)
 */
/** ที่อยู่ loopback ของสตรีมรับ push จาก edge แบบ link — กลุ่มที่ 1 คือชื่อสตรีม `..._in` */
const LINK_IN = /^rtsp:\/\/(?:[^@/]*@)?127\.0\.0\.1:\d+\/([\w.-]+_in)$/;
/** ต้นทางปลอมของสตรีม `_in` — พอร์ต 1 ไม่มีใครฟัง ภาพมาจากผู้ push เท่านั้น */
const LINK_IDLE_SOURCE = 'rtsp://127.0.0.1:1/edge-link-idle';

async function syncCamerasToGo2rtc(db, resolveSubRtsp) {
  let current;
  try {
    const res = await request('GET', '/api/streams');
    if (res.status !== 200) throw new Error(`go2rtc ตอบ ${res.status}`);
    current = JSON.parse(res.body || '{}');
  } catch (err) {
    console.warn(`[go2rtc Sync] อ่านสตรีมปัจจุบันไม่ได้: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const rows = await new Promise((resolve, reject) => {
    // `type` ต้องติดมาด้วย ไม่ใช่ของเกิน: resolveSubRtsp ตัดสินจากมันว่ากล้องตัวนี้มี substream
    // จริงไหม กล้องจาก VMS ที่ไม่มี sub จะได้ path `_sub` ที่ transcode ภาพเดิมซ้ำถ้าไม่มีค่านี้
    // กล้องที่ปิดใช้งาน (enabled = 0) ไม่เข้า core — ลูปท้ายสุดจะลบสตรีมเดิมของมันทิ้งเอง
    // กล้องที่หายจาก edge (source_missing_at) ก็ไม่เข้า core — edge ไม่มีกล้องนี้แล้ว ดึงภาพไม่ได้
    // (SELECT * + กรองใน JS: คอลัมน์นี้ถูก ALTER เพิ่มตอน start อาจยังไม่มีตอน sync รอบแรกของ DB ใหม่)
    db.all('SELECT * FROM cameras WHERE COALESCE(enabled, 1) != 0',
      (err, r) => (err ? reject(err) : resolve((r || []).filter((c) => !c.source_missing_at))));
  });

  const withRaw = rawStreamsEnabled();
  // สูตรที่ลงไว้ครั้งก่อนตรงกับของตอนนี้ไหม — ตัดสินครั้งเดียวต่อรอบ sync
  const rawRecipeStale = withRaw && readRecipeStamp() !== RAW_RECIPE_VERSION;

  const wanted = new Map();
  for (const cam of rows) {
    if (!cam.rtsp) continue;
    // กล้องจาก edge: ที่อยู่มาจากเครื่องอื่น — รับเฉพาะ RTSP เปล่า (ดู isSafeEdgeRtsp) ด่านที่สองหลัง rtspFrom
    // เผื่อแถวที่เขียนไว้ก่อนมีด่านแรก · main ไม่ผ่าน = ข้ามทั้งกล้อง, sub ไม่ผ่าน = ไม่มี sub
    if (cam.type === 'edge_relay' && !isSafeEdgeRtsp(cam.rtsp)) {
      warnRejected(cam.rtsp, `camera ${cam.id} main`);
      continue;
    }
    wanted.set(pathName(cam.id, 'main'), sourceFor(cam.rtsp));
    let sub = cam.rtsp_sub || (resolveSubRtsp ? resolveSubRtsp(cam) : null);
    if (sub && cam.type === 'edge_relay' && !isSafeEdgeRtsp(sub)) {
      warnRejected(sub, `camera ${cam.id} sub`);
      sub = null;
    }
    // ไม่มี substream ก็ไม่สร้างชื่อ _sub ทิ้งไว้ให้ 404 — ปลายทางที่ขอ sub จะได้
    // ตกไปใช้ main อย่างถูกต้อง ดีกว่าเจอ path ที่มีอยู่แต่ไม่มีภาพ
    if (sub) wanted.set(pathName(cam.id, 'sub'), sourceFor(sub));

    // เส้น passthrough ต้องเข้ามาทาง wanted เท่านั้น ไม่ใช่ PUT แยกต่างหาก เพราะลูป
    // ล่างสุดลบทุก stream ที่ไม่มีใน wanted ทิ้ง — ของที่ใส่นอกทางนี้จะหายทุกรอบ sync
    if (withRaw) {
      wanted.set(rawPathName(cam.id, 'main'), rawSourceFor(cam.rtsp, cam.brand));
      if (sub) wanted.set(rawPathName(cam.id, 'sub'), rawSourceFor(sub, cam.brand));
    }

    /*
      กล้องจาก edge แบบ link (vms/edge-link-server.js): ภาพไม่ได้ถูกดึง แต่ edge push เข้ามาที่สตรีม
      `<ชื่อ>_in` ของ go2rtc เครื่องนี้ แล้วสตรีมปกติของกล้องดึงต่อจาก `_in` ทาง loopback

      go2rtc 1.9.14 รับ push เฉพาะชื่อที่มีอยู่แล้ว (ชื่อที่ไม่รู้จักได้ Broken pipe) และสตรีมที่เพิ่ม
      ผ่าน API ต้องมี src — จึงใส่ต้นทางปลอมที่ไม่มีวันต่อได้ไว้เป็นตัวแรก ผู้ push จะเป็น producer
      ตัวที่สอง และการเทียบ URL ข้างล่างดูแค่ตัวแรก จึงไม่ PUT ทับ (ซึ่งจะตัดการ push ทิ้ง)
    */
    for (const url of [cam.rtsp, sub]) {
      const m = LINK_IN.exec(url || '');
      if (m) wanted.set(m[1], LINK_IDLE_SOURCE);
    }
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const [name, src] of wanted) {
    const existing = current[name];

    if (!existing) {
      const res = await request('PUT', `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
      if (res.status >= 200 && res.status < 300) added += 1;
      else console.warn(`[go2rtc Sync] เพิ่ม ${name} ไม่สำเร็จ (${res.status})`);
      continue;
    }

    /*
      สตรีมที่มีอยู่แล้วต้องเทียบ URL ด้วย ไม่ใช่ข้ามไปเฉยๆ

      เดิมโค้ดนี้ `continue` ทันทีเมื่อพบว่ามีสตรีมชื่อนี้แล้ว ผลคือกล้องที่ถูกแก้
      รหัสผ่านหรือแก้ RTSP path ในหน้าเว็บ จะยังถูก go2rtc ต่อด้วยค่าเดิมตลอดไป
      จนกว่าจะรีสตาร์ต go2rtc — อาการที่ผู้ใช้เห็นคือ "แก้รหัสผ่านถูกแล้วแต่ยัง
      ดูไม่ได้" โดยไม่มี error ที่ไหนบอกว่าทำไม (เจอจริงกับกล้อง 203.0.113.147)

      เทียบเฉพาะ URL เปล่าๆ เพราะ go2rtc รายงาน url กลับมาไม่เหมือนที่เราส่งไปเสมอ
      (บางเส้นตัด prefix `ffmpeg:` ออก บางเส้นคงไว้) การเทียบทั้งสตริงจึงให้ผลว่า
      "ต่างกัน" ตลอดเวลา แล้วกลายเป็น PUT ทุกรอบ ซึ่งตัดผู้ชมที่กำลังดูอยู่ทิ้ง
    */
    const currentUrl = (existing.producers || [])[0]?.url;
    if (!currentUrl) continue; // ไม่รู้ของเดิม อย่าเดา — PUT มั่วจะตัดผู้ชมทิ้งเปล่าๆ

    // สูตรของเส้น `_raw` เปลี่ยน = ต้องลงใหม่ ถึงแม้ URL เปล่าจะเท่าเดิม เพราะสิ่งที่เปลี่ยน
    // อยู่ใน fragment ซึ่งไม่มีทางเห็นจากการเทียบ
    const recipeChanged = name.endsWith('_raw') && rawRecipeStale;
    if (!recipeChanged && bareUrl(currentUrl) === bareUrl(src)) continue;

    const res = await request('PUT', `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
    if (res.status >= 200 && res.status < 300) {
      updated += 1;
      console.log(`[go2rtc Sync] ${name}: ที่อยู่ต้นทางเปลี่ยน — อัปเดตแล้ว`);
    } else {
      console.warn(`[go2rtc Sync] อัปเดต ${name} ไม่สำเร็จ (${res.status})`);
    }
  }

  for (const name of Object.keys(current)) {
    if (wanted.has(name)) continue;
    const res = await request('DELETE', `/api/streams?src=${encodeURIComponent(name)}`);
    if (res.status >= 200 && res.status < 300) removed += 1;
  }

  if (rawRecipeStale) writeRecipeStamp(RAW_RECIPE_VERSION);

  console.log(`[go2rtc Sync] สตรีมทั้งหมด ${wanted.size} เส้น (เพิ่ม ${added}, อัปเดต ${updated}, ลบ ${removed})`);
  return { ok: true, total: wanted.size, added, updated, removed };
}

module.exports = { syncCamerasToGo2rtc, pathName, rawPathName, rawStreamsEnabled };
