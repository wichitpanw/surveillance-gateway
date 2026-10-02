/**
 * ชั้นกลางระหว่าง Gateway กับ streaming core ที่ทำงานอยู่จริง
 *
 * มีไฟล์นี้เพราะเราตั้งใจจะเปลี่ยน core ได้ (MediaMTX วันนี้ อาจเป็น go2rtc วันหน้า)
 * โดยที่ client ภายนอกไม่ต้องรู้เรื่องด้วย ถ้าปล่อยให้ route ยิงไปที่พอร์ต 9997 ตรงๆ
 * การเปลี่ยน core จะกลายเป็นการแก้สัญญาที่ Edge AI ทุกตัวพึ่งพาอยู่
 *
 * ชื่อ path ใช้กติกาเดิมของระบบทั้งหมด (main = <id>, sub = <id>_sub) ซึ่งมีอยู่แล้ว
 * ทั้งใน server.js และ src/lib/api.js — ตั้งใจไม่คิดกติกาใหม่ เพราะกติกานี้คือสิ่งที่ทำให้
 * เปลี่ยน core ได้ด้วยการเปลี่ยนพอร์ตอย่างเดียว
 *
 * core ที่ใช้จริงตั้งแต่ 2026-08-20 คือ **go2rtc** ส่วน mediamtxCore() ที่ยังอยู่ในไฟล์นี้
 * คือของสำรองสำหรับย้อนกลับ ไม่ใช่ค่าปกติ
 */
const http = require('http');
const { withRtspCredentials } = require('./rtsp-auth');

/** แปลง camera id เป็นชื่อ path — ต้องตรงกับ streamPathName ใน src/lib/api.js เป๊ะ */
function streamPathName(cameraId, streamType = 'main') {
  const sn = String(cameraId || '').toLowerCase().replace(/\s+/g, '_');
  return streamType === 'sub' ? `${sn}_sub` : sn;
}

/** ชื่อ path ของเส้น passthrough — ต้องตรงกับ rawPathName ใน gateway/go2rtc-sync.js */
function rawStreamPathName(cameraId, streamType = 'main') {
  return `${streamPathName(cameraId, streamType)}_raw`;
}

/** เส้น passthrough มีอยู่จริงก็ต่อเมื่อ go2rtc-sync ถูกสั่งให้สร้าง — ธงเดียวกัน */
const rawStreamsEnabled = () => String(process.env.GATEWAY_RAW_STREAMS || '') === '1';

/** ยิง GET ไป core แล้ว parse JSON — timeout สั้นเพราะ core อยู่ใน localhost */
function getJson(port, path, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`core ตอบ ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`core ตอบข้อมูลที่ไม่ใช่ JSON (${err.message})`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('core ไม่ตอบภายในเวลาที่กำหนด')));
    req.on('error', reject);
  });
}

/**
 * core สำรองสำหรับย้อนกลับ: MediaMTX
 *
 * RTSP 8554 / HLS 8888 / API 9997 — ไม่ได้รันอยู่บน VM แล้ว เก็บไว้เพราะเป็นครึ่งหนึ่งของ
 * seam ที่ทำให้สลับ core ได้ ถ้าลบทิ้ง การย้อนกลับจะกลายเป็นการเขียนใหม่แทนการเปลี่ยน env
 */
function mediamtxCore({ apiPort = 9997, rtspPort = 8554 } = {}) {
  return {
    id: 'mediamtx',
    rtspPort,

    /**
     * สถานะสตรีมทั้งหมดที่ core รู้จัก
     *
     * คืน Map ของ path -> { ready, tracks } ไม่ใช่ array ดิบของ core เพราะรูปร่าง
     * ที่ core คืนมาคือสิ่งที่เราตั้งใจปิดไม่ให้รั่วออกไปข้างนอก
     */
    async listStreams() {
      const data = await getJson(apiPort, '/v3/paths/list?itemsPerPage=1000');
      const map = new Map();
      for (const item of data.items || []) {
        map.set(item.name, {
          ready: Boolean(item.ready),
          active: Boolean(item.ready),
          tracks: item.tracks || [],
          readers: (item.readers || []).length,
        });
      }
      return map;
    },
  };
}

/**
 * core ที่ใช้งานจริง: go2rtc
 *
 * ข้อควรรู้ที่ยังใช้ได้อยู่: go2rtc 1.9.14 crash ด้วย SIGSEGV เมื่อส่ง H.265 ออกทาง MSE
 * ระบบจึงบังคับทุกสตรีมเป็น H.264 ตั้งแต่ต้นทางด้วย `#video=h264` ใน go2rtc-sync.js
 * — อย่าถอดออกเพื่อ "ประหยัด transcode" ดู ~/.pm2/logs/0-go2rtc-error.log บน VM
 */
function go2rtcCore({ apiPort = 1984, rtspPort = 8555 } = {}) {
  return {
    id: 'go2rtc',
    rtspPort,

    async listStreams() {
      const data = await getJson(apiPort, '/api/streams');
      const map = new Map();
      for (const [name, info] of Object.entries(data || {})) {
        const producers = info.producers || [];
        map.set(name, {
          // ready = มีต้นทางตั้งค่าไว้ (คงความหมายเดิมไว้ให้ client ของ /api/v1 ที่ใช้อยู่)
          ready: producers.length > 0,
          /*
            active = go2rtc กำลังดึงภาพจากต้นทางอยู่จริงตอนนี้

            producer ที่ยังไม่เคยต่อมีแค่ { url } ตัวเดียว (วัดบน 1.9.14 เมื่อ 2026-09-23) ส่วนตัวที่ต่ออยู่
            มี id / remote_addr / medias / bytes_recv เพิ่มเข้ามา — ready ข้างบนจึงเป็นจริงตลอดแม้ไม่มี
            ใครดู และนั่นคือเหตุที่ SSE เคยรายงานทุกกล้องว่า online
          */
          active: producers.some((p) => p && Object.keys(p).some((k) => k !== 'url')),
          tracks: (info.recv_tracks || []).map((t) => t.codec || 'unknown'),
          readers: (info.consumers || []).length,
        });
      }
      return map;
    },
  };
}

/**
 * เลือก core จาก env — ค่าเริ่มต้นคือตัวที่รันอยู่จริงในวันนี้
 *
 * เดิม default ที่นี่เป็น mediamtx ด้วยเหตุผลว่า "การเปลี่ยน core ต้องมีคนกดเอง" ซึ่งฟังดูดี
 * แต่กลายเป็นกับดัก: server.js:167 default เป็น go2rtc ไปแล้ว สองไฟล์จึงไม่ตรงกัน และตรงกัน
 * บน VM ได้เพราะ ecosystem ตั้ง env ให้เท่านั้น ใครรัน backend โดยไม่มีไฟล์ ecosystem จะได้
 * กล้องถูกซิงก์เข้า go2rtc แต่ Gateway ไปถาม MediaMTX แล้วได้ 404 ทุกสตรีม โดยไม่มี error
 * ที่ไหนให้เห็นเลยสักบรรทัด
 *
 * default ที่ปลอดภัยกว่าคือ "ตัวที่รันอยู่จริง" ไม่ใช่ "ตัวที่เคยรัน"
 */
function resolveCore() {
  const which = String(process.env.GATEWAY_STREAM_CORE || 'go2rtc').toLowerCase();
  if (which === 'mediamtx') return mediamtxCore();
  const { GO2RTC_API_PORT, GO2RTC_RTSP_PORT } = require('../shared/instance');
  return go2rtcCore({ apiPort: GO2RTC_API_PORT, rtspPort: GO2RTC_RTSP_PORT });
}

/**
 * ที่อยู่ที่ client ภายนอกใช้ต่อได้จริง
 *
 * ห้ามคืน 127.0.0.1 ออกไปเด็ดขาด — Edge AI อยู่คนละเครื่อง URL แบบนั้นจะชี้กลับไป
 * ที่ตัวมันเองแล้วล้มเหลวแบบที่อ่านไม่ออกว่าเกิดอะไรขึ้น ใช้ GATEWAY_PUBLIC_HOST
 * ถ้าตั้งไว้ ไม่งั้นเดาจาก Host header ของ request ที่เข้ามา ซึ่งก็คือที่อยู่ที่
 * client ตัวนั้นใช้ต่อมาถึงเราได้จริงอยู่แล้ว
 */
function publicHostFrom(req) {
  const configured = String(process.env.GATEWAY_PUBLIC_HOST || '').trim();
  if (configured) return configured;
  return String(req.headers.host || '').split(':')[0] || '203.0.113.80';
}

/**
 * URL ทุกรูปแบบของกล้องหนึ่งตัว
 *
 * HLS ชี้กลับมาที่ Gateway (/hls/...) ไม่ใช่ไปที่พอร์ตของ core โดยตรง เพราะ
 * ระบบนี้ออกแบบมาให้เป็น origin เดียวมาตั้งแต่ต้น (context.md:65) และการเปิดพอร์ต
 * ของ core ให้โลกภายนอกเห็นคือการยกเลิกประโยชน์ของการมี Gateway ไปเสียเปล่า
 *
 * `mp4` เป็นทางเล่นหลักของระบบตั้งแต่ย้ายมา go2rtc แต่เดิม **ไม่เคยอยู่ในสัญญานี้** ทั้งที่
 * เป็นเส้นที่ใช้จริง ผู้เรียกจึงต้องประกอบ URL เองจากกติกาชื่อ path ซึ่งเท่ากับพึ่งรายละเอียด
 * ภายในที่ไม่มีอะไรรับประกัน — ใส่เข้ามาเพื่อให้เลิกเดา
 *
 * `rtspRaw` คือเส้น H.265 ที่ไม่ผ่าน transcode สำหรับปลายทางที่ถอดรหัสเองได้ (client
 * native บน Windows, Edge AI) โผล่เฉพาะเมื่อ GATEWAY_RAW_STREAMS=1 เพราะ go2rtc-sync
 * สร้าง path `_raw` ให้เฉพาะตอนนั้น การคืน URL ของ path ที่ไม่มีอยู่จริงคือสิ่งที่
 * `webrtc` กับ `mse` เคยทำอยู่ในสัญญานี้ — ทั้งคู่ 404 มาตลอดเพราะไม่เคยมี route
 * จึงถอดออกไปแล้ว ไม่ใช่แก้ให้ทำงาน
 *
 * token: ทุก URL ที่วิ่งผ่าน Node (mp4/hls) ต้องมี token ติดไปด้วย ส่วน rtsp ไม่มี เพราะ
 * พอร์ต 8555 ชี้ตรงไป go2rtc ไม่ผ่านเรา — ดู stream-token.js
 *
 * @param {object} [tokens] `{ short, hls, rawShort }` — ไม่ส่งมา = คืน URL เปล่าแบบเดิม (ใช้ในเทส)
 *   `rawShort` ต้องเป็น token ที่ออกให้ชื่อ `_raw` ไม่ใช่ใบเดียวกับ `short` เพราะ token
 *   ผูกกับชื่อสตรีมเส้นเดียว — ใช้ใบของเส้นปกติกับเส้น `_raw` จะถูกปฏิเสธที่ Node
 */
function urlsFor(req, core, cameraId, streamType, tokens = {}) {
  const host = publicHostFrom(req);
  const name = streamPathName(cameraId, streamType);
  const origin = `${req.protocol}://${req.headers.host}`;
  const q = (token) => (token ? `?t=${encodeURIComponent(token)}` : '');

  const urls = {
    // ถ้าเปิด RTSP auth ไว้ URL ที่แจกจะมีบัญชีผู้ใช้ติดไปด้วย — ไม่งั้นเป็น URL เปล่าเหมือนเดิม
    rtsp: withRtspCredentials(`rtsp://${host}:${core.rtspPort}/${name}`),
    hls: `${origin}/hls/${name}/index.m3u8${q(tokens.hls)}`,
  };
  if (core.id === 'go2rtc') {
    urls.mp4 = `${origin}/stream/${name}.mp4${q(tokens.short)}`;
    if (rawStreamsEnabled()) {
      const rawName = rawStreamPathName(cameraId, streamType);
      // ทางที่ควรใช้เป็นค่าเริ่มต้นสำหรับปลายทางที่ถอด H.265 เองได้ — ผ่าน Gateway พอร์ตเดียว
      // มี token เหมือน mp4 ปกติ ต่างกันแค่ไม่ถูกแปลงโคเดคระหว่างทาง
      urls.mp4Raw = `${origin}/stream/${rawName}.mp4${q(tokens.rawShort)}`;
      // ทางตรงเข้า core ไม่ผ่าน Node และไม่มี token — สำหรับเครื่องมือฝั่งปฏิบัติการในวงเดียวกัน
      urls.rtspRaw = withRtspCredentials(`rtsp://${host}:${core.rtspPort}/${rawName}`);
    }
  }
  return urls;
}

module.exports = {
  streamPathName,
  rawStreamPathName,
  rawStreamsEnabled,
  resolveCore,
  mediamtxCore,
  go2rtcCore,
  urlsFor,
  publicHostFrom,
};
