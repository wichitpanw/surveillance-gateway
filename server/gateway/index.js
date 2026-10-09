/**
 * API Gateway v1 — ตัวกลางรวบรวม stream และ metadata จากกล้องหลายยี่ห้อ
 *
 * นี่คือสัญญาที่ระบบภายนอก (Edge AI, ระบบวิเคราะห์อื่น) ใช้คุยกับเรา ต่างจาก
 * /api/* เดิมตรงที่ /api/* เดิมเป็นของหน้าเว็บตัวเอง เปลี่ยนได้ตามใจเพราะ deploy
 * พร้อมกัน ส่วน /api/v1/* มีผู้ใช้ที่เรา deploy ให้ไม่ได้ จึงต้องนิ่งและมีเวอร์ชัน
 *
 * หลักการสองข้อที่ทุก endpoint ในไฟล์นี้ต้องรักษา:
 *
 *   1. ห้าม credential ของกล้องหลุดออกไปแม้แต่ field เดียว ตาราง cameras เก็บ
 *      รหัสผ่านเป็น plaintext ทั้งในคอลัมน์ onvifPass และฝังอยู่ใน RTSP URL การ
 *      SELECT * แล้วส่งออกคือการแจกรหัสผ่านกล้องทุกตัวให้ client ทุกราย ทุก
 *      query ในไฟล์นี้จึงระบุคอลัมน์แบบ whitelist เสมอ ไม่มีข้อยกเว้น
 *
 *   2. client เห็นได้เฉพาะกล้องใน scope ของตัวเอง และการกรองต้องเกิดที่ SQL
 *      ไม่ใช่ที่การ render เพราะการกรองตอน render พลาดแล้วไม่มีอะไรจับได้
 */
const express = require('express');
const crypto = require('crypto');
const { normalizeEvent } = require('../shared/ai-events');
const { ownerEdge, filterCameraIds } = require('../shared/ai-camera-filters');
const { createApiKeyAuth } = require('./auth');
const {
  resolveCore,
  streamPathName,
  rawStreamPathName,
  rawStreamsEnabled,
  urlsFor,
} = require('./streams');
const streamTokens = require('./stream-token');
const { createPtz, dispatchPtz, PtzError } = require('./ptz');
const { adapterFor, credsFor, cameraToday } = require('./analytics');
const { topicLabel } = require('./analytics/discovery');
const { publicRegion } = require('../shared/regions');
const { publicState } = require('../shared/camera-state');
const { ROLE, REGION, NODE_NUMBER, DEFAULT_PROVINCE, BUILD: GATEWAY_VERSION } = require('../shared/instance');
const { nowIso, todayKey, startOfDayIso, isValidTime, toBangkokIso, BANGKOK_SUFFIX } = require('../shared/time');
const { PUBLIC_TYPE } = require('../vms/public-cams');

/** คอลัมน์ที่ปลอดภัยจะส่งออกนอกระบบ — ทุกอย่างที่ไม่อยู่ในนี้ถือว่าเป็นความลับ */
const SAFE_CAMERA_COLUMNS =
  "id, name, group_name, brand, type, stream_type, lat, lng, always_on, enabled, audio_enabled, analytics_kind, analytics_probed_at, global_id, province_code, district_code, source_id, source_missing_at, CASE WHEN rtsp IS NOT NULL AND rtsp != '' THEN 1 ELSE 0 END AS stream_configured";

/**
 * สร้าง router ของ Gateway
 *
 * รับ dependency เข้ามาแทนที่จะ require เอง เพื่อให้ใช้ db connection และฟังก์ชัน
 * จับภาพตัวเดียวกับ server.js — ไม่ใช่สร้างของตัวเองขึ้นมาซ้อน
 *
 * @param {object} deps
 * @param {object} deps.db                        sqlite3 connection ของ server.js
 * @param {function} deps.getCameraRow            คืนแถวกล้องเต็ม (มี credential) ใช้ภายในเท่านั้น
 * @param {function} deps.captureMainSnapshotBuffer  จับภาพนิ่งจากกล้อง
 */
function createGatewayRouter({ db, getCameraRow, captureMainSnapshotBuffer, initOnvifDevice, saveLog, originOf, edgeClientFor, cameraState, listEdges, listDeletedCameras, playback, aiEvents, edgeAlerts, dssPtz = null }) {
  const router = express.Router();
  const auth = createApiKeyAuth(db);
  const ptz = createPtz({ initOnvifDevice, edgeClientFor, dssPtz });
  const core = resolveCore();

  console.log(`[Gateway] API v1 พร้อมใช้งาน — streaming core = ${core.id}`);

  /**
   * เงื่อนไข SQL สำหรับจำกัดกล้องตาม scope ของ client
   *
   * scopeGroups === null แปลว่าไม่จำกัด ส่วน array ว่างแปลว่าไม่ให้เห็นอะไรเลย
   * สองกรณีนี้ต้องแยกกันให้ขาด การเผลอทำให้ array ว่างกลายเป็น "ไม่จำกัด" คือ
   * ช่องโหว่ที่เงียบที่สุดเท่าที่จะเป็นไปได้ในโค้ดแบบนี้
   *
   * กล้องสาธารณะ (vms/public-cams.js) ไม่ขึ้นกับกลุ่ม — เห็นทั้งชุดเมื่อ key มี allowPublic เท่านั้น
   * key ที่เห็น "ทุกกลุ่ม" จึงยังไม่เห็นกล้อง public · คืน WHERE เสมอ ผู้เรียกต่อด้วย `AND ...` ได้
   */
  const scopeClause = (client) => {
    let own = '1 = 1';
    let params = [];
    if (client.scopeGroups && client.scopeGroups.length === 0) own = '1 = 0';
    else if (client.scopeGroups) {
      own = `group_name IN (${client.scopeGroups.map(() => '?').join(',')})`;
      params = [...client.scopeGroups];
    }
    const pub = client.allowPublic ? `type = '${PUBLIC_TYPE}'` : '1 = 0';
    return { sql: `WHERE ((COALESCE(type, '') != '${PUBLIC_TYPE}' AND ${own}) OR ${pub})`, params };
  };

  router.use(auth.requireApiKey);

  // ---------------------------------------------------------------- สถานะระบบ

  router.get('/health', async (req, res) => {
    /*
      central บอก build ของ edge ทุกตัวด้วย ให้ client เตือนได้เมื่อรุ่นไม่ตรงกัน (ช่วงที่อัปเดตไม่พร้อมกัน
      สัญญา /api/v1 ระหว่างสองฝั่งอาจไม่ตรง) — ไม่มีที่อยู่หรือ key ของ edge ออกไป
    */
    let edges;
    if (ROLE !== 'edge' && listEdges) {
      try {
        edges = (await listEdges()).map((e) => ({
          node: e.remote_node || null,
          name: e.label || null,
          build: e.remote_build || null,
          reachable: e.reachable,
          remark: e.remark || null,
          cameras: e.cameraCount,
          lastSyncAt: e.last_sync_at,
        }));
      } catch {
        edges = [];
      }
    }
    res.json({
      ...(edges ? { edges } : {}),
      ok: true,
      gateway: 'gw-cctv-gateway',
      version: 1,
      // บทบาทและเลขเครื่อง — central ใช้ยืนยันว่าที่อยู่ที่กรอกเป็น edge จริง และเลขไม่ชนกับเครื่องอื่น
      role: ROLE,
      region: REGION || null,
      node: NODE_NUMBER,
      // จังหวัดของ edge (edge.json → GATEWAY_DEFAULT_PROVINCE) — Regional ใช้เตือนเมื่อ edge อยู่นอกภาค
      ...(ROLE === 'edge' ? { province: DEFAULT_PROVINCE } : {}),
      build: GATEWAY_VERSION,
      streamCore: core.id,
      client: req.apiClient.name,
      time: nowIso(),
    });
  });

  // ------------------------------------------------------------------- กล้อง

  /**
   * รายการกล้องทั้งหมดที่ client รายนี้เห็นได้
   *
   * รวมสถานะสตรีมจริงจาก core มาให้ด้วยในคำขอเดียว เพราะผู้ใช้จริงของ endpoint นี้
   * คือโปรแกรมที่กำลังจะตัดสินใจว่าจะต่อกล้องตัวไหน การให้ไปถาม /streams ต่ออีกรอบ
   * แปลว่าทุก client ต้องเขียนโค้ดรวมข้อมูลเองเหมือนกันหมด
   */
  router.get('/cameras', async (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    db.all(
      `SELECT ${SAFE_CAMERA_COLUMNS} FROM cameras ${sql} ORDER BY group_name, name`,
      params,
      async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let live = new Map();
        try {
          live = await core.listStreams();
        } catch (coreErr) {
          // core ล่มไม่ควรทำให้ถามรายชื่อกล้องไม่ได้ — คืนรายชื่อพร้อมบอกตรงๆ ว่า
          // สถานะสตรีมไม่รู้ ดีกว่าคืน 500 แล้วให้ client เดาเอง
          console.warn(`[Gateway] อ่านสถานะจาก ${core.id} ไม่ได้: ${coreErr.message}`);
        }

        const caps = await loadCapabilities(db, (rows || []).map((r) => r.id));
        res.json({
          cameras: (rows || []).map((row) => toPublicCamera(row, live, caps.get(row.id), originOf ? originOf(row) : null, cameraState ? cameraState.get(row.id) : null)),
          streamStatusAvailable: live.size > 0,
        });
      },
    );
  });

  /**
   * กล้องที่คนลบที่เครื่องนี้ (edge) — central แบบ pull ใช้ลบแถวของตัวเองตาม · มีแค่ id กับเวลา
   * ต้องอยู่ก่อน /cameras/:id ไม่งั้น "deleted" ถูกตีความเป็น id ของกล้อง
   */
  router.get('/cameras/deleted', async (req, res) => {
    try {
      res.json({ deleted: listDeletedCameras ? await listDeletedCameras() : [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/cameras/:id', (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    const where = sql ? `${sql} AND id = ?` : 'WHERE id = ?';
    db.get(
      `SELECT ${SAFE_CAMERA_COLUMNS} FROM cameras ${where}`,
      [...params, req.params.id],
      async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
        let live = new Map();
        try {
          live = await core.listStreams();
        } catch {
          // เหมือน /cameras — สถานะไม่รู้ ดีกว่าไม่ตอบ
        }
        const caps = await loadCapabilities(db, [row.id]);
        res.json(toPublicCamera(row, live, caps.get(row.id), originOf ? originOf(row) : null, cameraState ? cameraState.get(row.id) : null));
      },
    );
  });

  /**
   * URL สำหรับต่อสตรีมของกล้องหนึ่งตัว
   *
   * นี่คือ endpoint ที่ทำให้โมเดล Gateway มีความหมาย: client ได้ที่อยู่ของ Gateway
   * ไม่ใช่ที่อยู่ของกล้อง จึงไม่ต้องรู้รหัสผ่านกล้อง ไม่ต้องเข้าถึงเครือข่ายกล้อง
   * และการที่กล้องย้าย IP หรือเปลี่ยนยี่ห้อไม่กระทบ client เลย
   */
  router.get('/cameras/:id/streams', (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    const where = sql ? `${sql} AND id = ?` : 'WHERE id = ?';
    db.get(
      `SELECT id, name, stream_type FROM cameras ${where}`,
      [...params, req.params.id],
      async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });

        let live = new Map();
        try {
          live = await core.listStreams();
        } catch {
          // สถานะไม่รู้ แต่ URL ยังถูกต้องและใช้ได้ จึงตอบต่อไป
        }

        /*
          ออก token ให้ทีละสตรีม ไม่ใช่ใบเดียวใช้ได้ทั้งกล้อง

          main กับ sub เป็นคนละ path และมีราคาต่างกัน — main เป็น on-demand ที่ไปปลุกกล้อง
          ให้ทำงานเพิ่ม ส่วน sub เปิดค้างอยู่แล้ว การแยก token จึงทำให้ client ที่ขอดูแต่ sub
          ไม่ได้สิทธิ์เปิด main ติดไม้ติดมือไปด้วย

          HLS ได้ TTL ยาวกว่าเพราะถูกตรวจทุก segment ต่างจาก fMP4 ที่ตรวจครั้งเดียวตอนเปิด
          connection แล้วดูต่อได้ยาว — ดูเหตุผลเต็มใน stream-token.js
        */
        const build = (streamType) => {
          const name = streamPathName(row.id, streamType);
          const status = live.get(name);
          const clientId = req.apiClient?.id;

          // เส้น transcode ออกมาเป็น H.264 เสมอ ส่วนเส้น `_raw` เป็นโคเดคจริงของกล้อง
          // client ต้องเลือกเองว่าถอดรหัสอะไรได้ จึงต้องบอกทั้งสองค่า ไม่ใช่ค่าเดียว
          const rawName = rawStreamPathName(row.id, streamType);
          const rawStatus = rawStreamsEnabled() ? live.get(rawName) : undefined;

          return {
            path: name,
            urls: urlsFor(req, core, row.id, streamType, {
              short: streamTokens.sign({ streamName: name, clientId }),
              hls: streamTokens.sign({
                streamName: name,
                clientId,
                ttlMs: streamTokens.HLS_TTL_MS,
              }),
              // token ผูกกับชื่อสตรีมเส้นเดียว เส้น `_raw` จึงต้องมีใบของตัวเอง
              rawShort: rawStreamsEnabled()
                ? streamTokens.sign({ streamName: rawName, clientId })
                : undefined,
            }),
            ready: status ? status.ready : null,
            tracks: status ? status.tracks : [],
            raw: rawStreamsEnabled()
              ? {
                  path: rawName,
                  ready: rawStatus ? rawStatus.ready : null,
                  tracks: rawStatus ? rawStatus.tracks : [],
                }
              : null,
          };
        };

        res.json({
          id: row.id,
          name: row.name,
          core: core.id,
          // แนะนำ sub เป็นค่าเริ่มต้นสำหรับงาน analytics: ความละเอียดพอสำหรับการ
          // ตรวจจับ กิน decode น้อยกว่ามาก และเป็นสตรีมที่เปิดค้างอยู่แล้วเสมอ
          // ส่วน main เป็น on-demand ซึ่งต้องรอ core เปิดให้ก่อน
          recommendedForAnalytics: 'sub',
          main: build('main'),
          sub: build('sub'),
        });
      },
    );
  });

  /**
   * ภาพนิ่งล่าสุดของกล้อง
   *
   * ใช้ captureMainSnapshotBuffer ตัวเดียวกับที่ route ภายในใช้อยู่ แทนที่จะเขียน
   * วิธีจับภาพขึ้นมาใหม่ — ฟังก์ชันนั้นมีลำดับ fallback ที่ผ่านการแก้บั๊กมาแล้ว
   */
  router.get('/cameras/:id/snapshot', (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    const where = sql ? `${sql} AND id = ?` : 'WHERE id = ?';
    db.get(`SELECT id FROM cameras ${where}`, [...params, req.params.id], async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
      try {
        const camera = await getCameraRow(row.id);
        const { buffer, source } = await captureMainSnapshotBuffer(camera);
        res.set('Cache-Control', 'no-store');
        res.set('X-Snap-Source', source);
        res.type('image/jpeg').send(buffer);
      } catch (capErr) {
        // ข้อความจริงมักมี IP/พอร์ต (หรือ URL ที่ฝังรหัส) ของกล้อง — เก็บใน log ของเครื่อง ส่งข้อความกลาง ๆ ให้ client
        const detail = String(capErr?.message || capErr).replace(/\/\/[^/@\s]*@/g, '//***@');
        console.warn(`[API v1] snapshot ${row.id}: ${detail}`);
        res.status(502).json({ error: 'จับภาพจากกล้องไม่ได้' });
      }
    });
  });

  // --------------------------------------------------------------------- PTZ

  /**
   * แถวกล้องเต็ม (มี credential) ของกล้องใน scope — คืน null ถ้าไม่พบหรืออยู่นอก scope
   * ตอบ 404 ทั้งสองกรณีโดยตั้งใจ: การบอกว่า "มีแต่ไม่ให้" คือการยืนยันว่ากล้อง id นั้นมีอยู่
   */
  const scopedCameraRow = (req) => new Promise((resolve, reject) => {
    const { sql, params } = scopeClause(req.apiClient);
    const where = sql ? `${sql} AND id = ?` : 'WHERE id = ?';
    db.get(`SELECT id FROM cameras ${where}`, [...params, req.params.id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      getCameraRow(row.id).then(resolve, reject);
    });
  });

  const sendPtzError = (res, err) => {
    const status = err instanceof PtzError ? err.status : 500;
    res.status(status).json({ error: err?.message || 'สั่ง PTZ ไม่สำเร็จ' });
  };

  /**
   * กล้องตัวนี้หมุนได้ไหม มี preset อะไร และ key ใบนี้สั่งได้ไหม
   *
   * แยกจาก /cameras เพราะต้องถามกล้องสด (ช้าเป็นวินาทีตอน init ครั้งแรก) — client ถาม
   * ตอนเปิดหน้าต่างกล้องตัวนั้นเท่านั้น ไม่ใช่ทุกตัวในรายการ
   */
  router.get('/cameras/:id/ptz', async (req, res) => {
    try {
      const camera = await scopedCameraRow(req);
      if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
      const caps = await ptz.capabilities(camera);
      res.json({ ...caps, allowed: Boolean(req.apiClient.allowPtz) });
    } catch (err) {
      sendPtzError(res, err);
    }
  });

  /**
   * สั่งกล้อง
   *
   * body: { action, pan, tilt, zoom, token, name }
   *   move           pan/tilt/zoom เป็นความเร็ว −1..1 กล้องหมุนไปจนได้ stop (หรือครบ 10 วิ)
   *   stop
   *   home
   *   preset.goto    token
   *   preset.set     name → คืน token ใหม่
   *   preset.remove  token
   *
   * move/stop ไม่ลง log เพราะกดค้างครั้งเดียวคือสองแถว ส่วน preset ที่เปลี่ยนค่าในกล้อง
   * (set/remove) ลง log ให้ตอบได้ว่าใครลบ preset ที่คนอื่นตั้งไว้
   */
  router.post('/cameras/:id/ptz', async (req, res) => {
    if (!req.apiClient.allowPtz) {
      return res.status(403).json({ error: 'API key ใบนี้ไม่มีสิทธิ์ควบคุม PTZ' });
    }
    try {
      const camera = await scopedCameraRow(req);
      if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
      const result = await dispatchPtz(ptz, camera, req.body || {}, { actor: `api:${req.apiClient.name}`, saveLog });
      res.json({ ok: true, ...(result || {}) });
    } catch (err) {
      sendPtzError(res, err);
    }
  });

  // ---------------------------------------------------------- ภาพย้อนหลัง

  /*
    ภาพย้อนหลังมาจากแหล่งภาพที่ edge · central ส่งต่อไปที่ edge ของกล้อง (gateway/playback.js)
    ทั้งสามเส้นต้องมี allow_playback — ภาพย้อนหลังคือหลักฐาน แยกสิทธิ์จากการดูสด
  */
  const playbackCamera = async (req, res) => {
    if (!req.apiClient.allowPlayback) {
      res.status(403).json({ error: 'API key ใบนี้ไม่มีสิทธิ์ดูภาพย้อนหลัง' });
      return null;
    }
    const camera = await scopedCameraRow(req);
    if (!camera) res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    // กล้องสาธารณะไม่มีภาพย้อนหลังให้ดึง (ระบบไม่บันทึกเอง และต้นทางไม่เปิด playback)
    else if (camera.type === PUBLIC_TYPE) {
      res.status(501).json({ error: 'กล้อง Public ไม่มีภาพย้อนหลัง' });
      return null;
    }
    return camera;
  };

  // ดาวน์โหลดแยกจากการเล่น: สูงสุด 30 นาที และหนึ่งงานต่อ instance ของ client
  router.get('/cameras/:id/download.mp4',
    require('./playback-download').createPlaybackDownload({ playback, playbackCamera }));

  /** ช่วงเวลาที่มีภาพบันทึก · query: from, to (ISO-8601 บังคับทั้งคู่ และ to > from — ไม่ส่ง/ผิด = 400) */
  router.get('/cameras/:id/recordings', async (req, res) => {
    try {
      const camera = await playbackCamera(req, res);
      if (!camera) return;
      res.json(await playback.ranges(camera, { from: req.query.from, to: req.query.to }));
    } catch (err) {
      playback.sendError(res, err);
    }
  });

  /** ออก token เฉพาะกล้องใน scope และคีย์ที่มีสิทธิ์ playback ให้ native client เปิด MP4 ได้ */
  router.get('/cameras/:id/playback-token', async (req, res) => {
    try {
      const camera = await playbackCamera(req, res);
      if (!camera) return;
      res.json({
        token: streamTokens.sign({
          streamName: `rec:${camera.id}`,
          clientId: req.apiClient.id,
          ttlMs: streamTokens.DEFAULT_TTL_MS,
        }),
        video: `/playback/${encodeURIComponent(camera.id)}.mp4`,
      });
    } catch (err) {
      playback.sendError(res, err);
    }
  });

  /**
   * ภาพย้อนหลังเป็น fMP4 · query: start (ISO-8601, บังคับ), duration (วินาที 1–3600, บังคับ — ไม่ส่ง/ผิด = 400),
   * video=h264 (แปลงให้เบราว์เซอร์ — ไม่ส่ง = โคเดคของกล้องตรง ๆ) · เวลาจริงของเฟรมแรกอยู่ใน X-Playback-Start
   */
  router.get('/cameras/:id/playback.mp4', async (req, res) => {
    try {
      const camera = await playbackCamera(req, res);
      if (!camera) return;
      await playback.pipeVideo(camera, req.query, res);
    } catch (err) {
      playback.sendError(res, err);
    }
  });

  /** ภาพนิ่งจากไฟล์บันทึก ณ เวลา `at` (ISO-8601) */
  router.get('/cameras/:id/frame.jpg', async (req, res) => {
    try {
      const camera = await playbackCamera(req, res);
      if (!camera) return;
      await playback.sendFrame(camera, req.query.at, res);
    } catch (err) {
      playback.sendError(res, err);
    }
  });

  // ------------------------------------------------------------ event ของ AI

  /*
    รับผล AI จากต้นทางที่ Edge แล้วส่งต่อผ่าน Regional/Central
    central ได้สำเนาจาก edge (vms/edge-source.js) แล้วให้ client อ่านทางเดียวกัน · ขอบเขตกล้องตาม key เสมอ
  */
  const scopeIds = (client) => new Promise((resolve, reject) => {
    if (!client.scopeGroups && client.allowPublic) return resolve(null);
    const { sql, params } = scopeClause(client);
    db.all(`SELECT id FROM cameras ${sql}`, params, (err, rows) => (err ? reject(err) : resolve(new Set((rows || []).map((r) => r.id)))));
  });
  const cameraInfo = (ids) => new Promise((resolve) => {
    const list = [...new Set(ids)];
    if (!list.length) return resolve(new Map());
    db.all(`SELECT c.id,c.name,c.global_id,c.type,c.source_ref,c.group_name,s.remote_role AS source_role,s.remote_node AS source_node FROM cameras c LEFT JOIN camera_sources s ON s.id=c.source_id WHERE c.id IN (${list.map(() => '?').join(',')})`, list,
      (err, rows) => resolve(new Map((rows || []).map((r) => [r.id, r]))));
  });
  const withCamera = (rows, info) => rows.map((r) => {
    const c = info.get(r.camera_id);
    return { ...aiEvents.publicEvent(r), cameraName: c?.name || null, globalId: c?.global_id || null,
      edgeNode: c ? ownerEdge(c) || null : null, group: c?.group_name || 'Default' };
  });
  const sendAiError = (res, err) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.warn(`[API v1] AI events: ${err?.message || err}`);
    res.status(status).json({
      error: status >= 500 ? 'ทำรายการ event ไม่สำเร็จ' : (err?.message || 'ทำรายการ event ไม่สำเร็จ'),
      ...(Number.isInteger(err?.index) ? { index: err.index } : {}),
    });
  };

  /**
   * รายการ event · query: since (ไล่ตามทีละหน้า เรียงเก่า→ใหม่) หรือ from/to (เรียงใหม่→เก่า)
   * cameraId, type, label, origin, limit (≤ 1000) · ตอบ nextSince = seq สุดท้ายที่ส่ง
   */
  router.get('/ai/events', async (req, res) => {
    try {
      const { edgeNode, group } = req.query;
      if ((edgeNode !== undefined && !/^\d{1,3}$/.test(String(edgeNode))) ||
          (group !== undefined && (typeof group !== 'string' || group.length > 200))) {
        return res.status(400).json({ error: 'ตัวกรอง Edge หรือกลุ่มไม่ถูกต้อง' });
      }
      const scope = await scopeIds(req.apiClient);
      const cameras = await new Promise((resolve, reject) => db.all(
        'SELECT c.id,c.type,c.source_ref,c.group_name,s.remote_role AS source_role,s.remote_node AS source_node FROM cameras c LEFT JOIN camera_sources s ON s.id=c.source_id',
        (err, rows) => err ? reject(err) : resolve(rows || [])));
      const visible = cameras.filter((cam) => !scope || scope.has(cam.id));
      const cameraIds = edgeNode || group !== undefined ? filterCameraIds(cameras, { edgeNode, group }, scope) : scope;
      const rows = await aiEvents.list({ ...req.query, cameraIds });
      const events = withCamera(rows, await cameraInfo(rows.map((r) => r.camera_id)));
      const nextSince = rows.length ? Math.max(...rows.map((r) => r.id)) : (Number(req.query.since) || 0);
      res.json({ events, nextSince,
        edges: [...new Set(visible.map(ownerEdge).filter(Boolean))].sort((a, b) => Number(a) - Number(b)),
        groups: [...new Set(visible.map((cam) => cam.group_name || 'Default'))].sort() });
    } catch (err) {
      sendAiError(res, err);
    }
  });

  /**
   * ปิด endpoint inference เดิม — การรับผลภายนอกตั้งค่าใน AI Sources
   */
  router.get('/ai/config', async (req, res) => {
    return res.status(410).json({ error: 'รับผล AI ภายนอกแล้ว — inference worker ปิดใช้งาน' });
  });

  /** ภาพประกอบของ event */
  router.get('/ai/events/:seq/snapshot.jpg', async (req, res) => {
    try {
      const row = await aiEvents.getRow(req.params.seq);
      const scope = await scopeIds(req.apiClient);
      if (!row || (scope && !scope.has(row.camera_id))) return res.status(404).json({ error: 'ไม่พบ event นี้' });
      const file = aiEvents.snapshotFile(row);
      if (!file) return res.status(404).json({ error: 'event นี้ไม่มีภาพ' });
      res.set('Cache-Control', 'private, no-store');
      res.type('image/jpeg').sendFile(file, { dotfiles: 'allow' });
    } catch (err) {
      sendAiError(res, err);
    }
  });

  /**
   * ส่ง event เข้ามา (edge เท่านั้น, key ต้องมี allow_event_write และกล้องเปิดแหล่งรับ API)
   * body: event เดียว หรือ { events: [...] } ไม่เกิน 100 · แต่ละตัว: cameraId, type, label?, rule?, ts?, trackId?,
   * attrs?, origin? (ค่าเริ่ม api), snapshot? (JPEG base64 ≤ 300 KB), eventId (ตัวระบุจากผู้ส่ง ≤ 64 ตัว — ส่งซ้ำไม่เกิดแถวซ้ำ)
   * ทั้งชุดบันทึกหรือไม่บันทึกเลย · ตอบ 201 { seqs ตามลำดับ (ตัวที่ซ้ำ = seq เดิม), duplicates }
   * ตอบ 400/404 พร้อม `index` ของ event ที่เสีย/กล้องที่ไม่พบ — ผู้ส่งตัดตัวนั้นออกแล้วส่งที่เหลือใหม่ได้
   */
  router.post('/ai/events', express.json({ limit: '40mb' }), async (req, res) => {
    if (ROLE !== 'edge') return res.status(403).json({ error: 'รับ event ภายนอกที่ Edge เท่านั้น — Regional/Central รับสำเนาจากลูก' });
    if (!req.apiClient.allowEventWrite) return res.status(403).json({ error: 'API key ใบนี้ไม่มีสิทธิ์ส่ง event' });
    const list = Array.isArray(req.body?.events) ? req.body.events : [req.body || {}];
    if (!list.length || list.length > 100) return res.status(400).json({ error: 'ส่งได้ครั้งละ 1–100 event' });
    try {
      const scope = await scopeIds(req.apiClient);
      const requested = list.map((e) => String(e?.cameraId || ''));
      const slots = requested.map(() => '?').join(',');
      // ใช้ Global ID เดิมได้ แต่ตรวจสิทธิ์ด้วย local ID ของ Edge เสมอ
      const resolved = await new Promise((resolve, reject) => db.all(
        'SELECT id, global_id FROM cameras WHERE id IN (' + slots + ') OR global_id IN (' + slots + ')',
        [...requested, ...requested], (err, rows) => err ? reject(err) : resolve(rows || [])));
      const lookup = new Map();
      for (const c of resolved) { lookup.set(c.id, c.id); if (c.global_id) lookup.set(c.global_id, c.id); }
      const ids = requested.map((id) => lookup.get(id) || id);
      const known = await cameraInfo(ids);
      const badIndex = ids.findIndex((id) => !known.has(id) || (scope && !scope.has(id)));
      if (badIndex >= 0) {
        return res.status(404).json({ error: `ไม่พบกล้อง ${ids[badIndex] || '(ไม่ได้ส่ง cameraId)'}`, index: badIndex });
      }
      // ตรวจทั้งชุดก่อน แล้วบันทึกใน transaction เดียว — ตัวไหนเสียตอบ 400 พร้อม index โดยยังไม่มีแถวไหนถูกบันทึก
      const sourceRows = await new Promise((resolve, reject) => db.all(
        'SELECT camera_id, driver, enabled FROM ai_event_sources WHERE camera_id IN (' + slots + ')', ids,
        (err, rows) => err ? reject(err) : resolve(rows || [])));
      const allowed = new Set(sourceRows.filter((r) => r.driver === 'api' && r.enabled).map((r) => r.camera_id));
      const blocked = ids.findIndex((id) => !allowed.has(id));
      if (blocked >= 0) return res.status(403).json({ error: 'กล้องนี้ไม่ได้เปิดรับจาก API ภายนอก', index: blocked });
      const prepared = list.map((e, index) => {
        if (e?.origin === 'edge-ai') throw Object.assign(new Error('รับผลภายนอกเท่านั้น: origin ต้องเป็น camera, nvr, vms หรือ api'), { status: 400, index });
        try { normalizeEvent(e); } catch (err) { err.index = index; throw err; }
        if (!e.eventId) throw Object.assign(new Error('API ภายนอกต้องส่ง eventId เพื่อกันซ้ำ'), { status: 400, index });
        // กันผู้ส่งสองรายใช้ eventId เดียวกัน — namespace ด้วย key + กล้อง + origin
        const eventId = 'api:' + crypto.createHash('sha256').update(JSON.stringify([req.apiClient.id, ids[index], e.origin || 'api', e.eventId])).digest('hex').slice(0, 60);
        return { cameraId: ids[index], input: { ...e, eventId, attrs: { ...(e.attrs || {}), transport: 'api', apiClientId: req.apiClient.id, sourceEventId: e.eventId } }, snapshot: e.snapshot || null };
      });
      const { seqs, duplicates } = await aiEvents.recordBatch(prepared);
      res.status(201).json({ ok: true, seqs, duplicates });
    } catch (err) {
      sendAiError(res, err);
    }
  });

  // -------------------------------------------------------------- metadata AI

  /**
   * ความสามารถและยอดวันนี้ของกล้องหนึ่งตัว
   *
   * ยอดสะสมอ่านจากสำเนาที่ Gateway เก็บไว้ ส่วน "สถานะกฎ" ยิงถามกล้องสดๆ เพราะเป็น
   * ข้อมูลการตั้งค่าที่เปลี่ยนได้ทุกเมื่อจากหน้าเว็บของกล้องเอง และเป็นสิ่งเดียวที่บอกได้ว่า
   * เลข 0 ที่เห็นแปลว่า "ไม่มีคนเดิน" หรือ "มีคนไปปิดระบบนับไว้"
   */
  router.get('/cameras/:id/analytics', (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    const where = sql ? `${sql} AND id = ?` : 'WHERE id = ?';
    db.get(
      `SELECT id, name, brand, ip, onvifPort, onvifUser, onvifPass, analytics_kind, analytics_probed_at
       FROM cameras ${where}`,
      [...params, req.params.id],
      async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });

        if (!row.analytics_kind) {
          // 404 พร้อมเหตุผล ไม่ใช่ 200 ที่มีเลข 0 — client ต้องแยกออกว่าไม่มีข้อมูลให้
          return res.status(404).json({
            error: 'กล้องนี้ไม่มีข้อมูล AI ให้เรียกใช้',
            cameraId: row.id,
            analytics: { supported: false, kind: null, probedAt: row.analytics_probed_at || null },
          });
        }

        const day = cameraToday();
        /*
          รวมทุกกฎของกล้องตัวเดียวกันเข้าด้วยกันตั้งแต่ในคำสั่ง SQL

          ตอนนี้ทุกกล้องมีชุดเดียว ผลจึงเท่ากับของเดิมทุกประการ แต่ตารางเริ่มมีคอลัมน์ rule
          แล้ว วันที่กล้องหนึ่งตัวมีสามเส้น ถ้ายังอ่านดิบ ๆ แบบเดิมจะได้สามแถวต่อหนึ่งช่วงเวลา
          แล้วกราฟของ client ที่ใช้อยู่จะเปลี่ยนรูปโดยไม่มีใครสั่ง — เขียนกันไว้ตอนนี้ถูกกว่า
          ตามแก้ตอนข้อมูลออกไปแล้ว
        */
        db.all(
          `SELECT ts, SUM(count_in) AS count_in, SUM(count_out) AS count_out
             FROM camera_analytics
            WHERE camera_id = ? AND ts >= ?
            GROUP BY ts ORDER BY ts`,
          [row.id, startOfDayIso(day)],
          async (aErr, buckets) => {
            if (aErr) return res.status(500).json({ error: aErr.message });

            let rule = null;
            try {
              const adapter = adapterFor(row);
              if (adapter?.getDemographics) rule = await adapter.getDemographics(credsFor(row));
            } catch (ruleErr) {
              // กล้องไม่ตอบเรื่องกฎ ไม่ควรทำให้ยอดที่เก็บไว้แล้วเรียกไม่ได้
              rule = { error: ruleErr.message };
            }

            res.json({
              cameraId: row.id,
              name: row.name,
              analytics: {
                supported: true,
                kind: row.analytics_kind,
                probedAt: row.analytics_probed_at || null,
              },
              rule,
              today: {
                totalIn: (buckets || []).reduce((n, b) => n + (b.count_in || 0), 0),
                totalOut: (buckets || []).reduce((n, b) => n + (b.count_out || 0), 0),
                buckets: (buckets || []).map((b) => ({
                  at: b.ts, in: b.count_in, out: b.count_out,
                })),
              },
            });
          },
        );
      },
    );
  });

  /**
   * อนุกรมเวลาข้ามกล้อง — จุดที่หน่วยงานเอาไปทำรายงาน
   *
   * timestamp เป็น ISO-8601 เวลากรุงเทพพร้อม offset +07:00 เสมอ (เปลี่ยนจาก UTC เมื่อ
   * 2026-08-22) — ปลายทางอ่านแล้วเห็นเวลาไทยตรงกับนาฬิกาบนผนังทันที ไม่ต้องแปลง
   *
   * สิ่งที่ห้ามทำคือส่งเวลาท้องถิ่นแบบไร้ offset ออกไป นั่นคือความกำกวมที่โยนปัญหาให้
   * ปลายทางตีความผิดกันคนละแบบ การมี +07:00 ติดอยู่ทำให้ parser ทุกตัวเข้าใจตรงกัน
   */
  router.get('/analytics/counts', (req, res) => {
    const interval = req.query.interval === 'day' ? 'day' : 'hour';
    const now = Date.now();
    const from = String(req.query.from || toBangkokIso(now - 24 * 3600_000));
    const to = String(req.query.to || nowIso());
    if (!isValidTime(from) || !isValidTime(to)) {
      return res.status(400).json({ error: 'from/to ต้องเป็น ISO-8601' });
    }

    const { sql, params } = scopeClause(req.apiClient);
    const filters = [...params];
    let where = sql ? `${sql} AND analytics_kind IS NOT NULL` : 'WHERE analytics_kind IS NOT NULL';
    if (req.query.camera) {
      where += ' AND id = ?';
      filters.push(String(req.query.camera));
    }

    db.all(`SELECT id, name FROM cameras ${where}`, filters, (err, cams) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!cams || cams.length === 0) {
        return res.json({ interval, from, to, cameras: [] });
      }

      const ids = cams.map((c) => c.id);
      // จัดกลุ่มด้วยการตัดหัว ISO string ได้ตรง ๆ เพราะค่าที่เก็บเป็นเวลาไทยอยู่แล้ว
      // 10 ตัวแรกคือวันตามปฏิทินไทย 13 ตัวแรกคือชั่วโมงตามเวลาไทย — ตรงกับที่ผู้อ่าน
      // รายงานคาดหวังโดยไม่ต้องอธิบายเพิ่ม ต่างจากตอนเก็บเป็น UTC ที่ "วัน" คาบเกี่ยว
      // 07:00 ของวันไทยหนึ่งไปอีกวันหนึ่ง
      const bucket = interval === 'day' ? "substr(ts, 1, 10)" : "substr(ts, 1, 13)";
      db.all(
        `SELECT camera_id, ${bucket} AS bucket,
                SUM(count_in) AS total_in, SUM(count_out) AS total_out
         FROM camera_analytics
         WHERE camera_id IN (${ids.map(() => '?').join(',')})
           AND ts >= ? AND ts <= ?
         GROUP BY camera_id, bucket ORDER BY camera_id, bucket`,
        [...ids, from, to],
        (rErr, rows) => {
          if (rErr) return res.status(500).json({ error: rErr.message });
          const byCamera = new Map(cams.map((c) => [c.id, { cameraId: c.id, name: c.name, points: [] }]));
          for (const r of rows || []) {
            byCamera.get(r.camera_id)?.points.push({
              at: interval === 'day'
                ? `${r.bucket}T00:00:00.000${BANGKOK_SUFFIX}`
                : `${r.bucket}:00:00.000${BANGKOK_SUFFIX}`,
              in: r.total_in || 0,
              out: r.total_out || 0,
            });
          }
          res.json({ interval, from, to, cameras: [...byCamera.values()] });
        },
      );
    });
  });

  /**
   * สถิติของ AI **ทุกชนิด** ที่ Gateway เก็บมาได้ แยกรายกล้อง
   *
   * `/analytics/counts` ตอบเฉพาะการนับคน ซึ่งเป็นชนิดเดียวจากหลายชนิดที่กล้องทำได้จริง
   * เส้นนี้ตอบว่า **กล้องแต่ละตัวส่ง AI อะไรมาแล้วเท่าไร** — ข้ามเส้น ล้ำพื้นที่ ใบหน้า
   * กล้องถูกบัง ทุกอย่างที่วิ่งมาบน ONVIF metadata track
   *
   * `events` คือจำนวนครั้งที่เกิด ซึ่งตอบได้เหมือนกันทุกชนิด ส่วน `in`/`out` มีค่าเฉพาะ
   * ชนิดที่นับจำนวนคน — ชนิดอื่นเป็นศูนย์เพราะไม่มีตัวเลขให้นับ ไม่ใช่เพราะนับได้ศูนย์
   */
  router.get('/analytics/events', (req, res) => {
    /*
      รับได้ทั้งช่วงย้อนหลังแบบกลม ๆ และวันที่ระบุเอง

      `hours` ใช้ง่ายสำหรับ "ดูตอนนี้" แต่ตอบคำถาม "วันที่ 22 เกิดอะไรบ้าง" ไม่ได้เลย
      เพราะขอบของช่วงเลื่อนตามเวลาปัจจุบันตลอด — ตัวเลขจึงเปลี่ยนทุกครั้งที่กดโหลดใหม่
      แม้ไม่มีเหตุการณ์ใหม่สักอัน `from`/`to` ให้ขอบที่นิ่ง เอาไปทำรายงานได้
    */
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 24));
    const from = isValidTime(req.query.from)
      ? toBangkokIso(req.query.from)
      : toBangkokIso(new Date(Date.now() - hours * 3600_000));
    const to = isValidTime(req.query.to) ? toBangkokIso(req.query.to) : nowIso();
    if (!from || !to) return res.status(400).json({ error: 'from/to ต้องเป็น ISO-8601' });

    const { sql, params } = scopeClause(req.apiClient);
    const empty = { from, to, interval, cameras: [] };

    db.all(`SELECT id, name, group_name FROM cameras ${sql} ORDER BY group_name, name`, params, (err, cams) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!cams || cams.length === 0) return res.json(empty);

      const ids = cams.map((c) => c.id);
      const one = req.query.camera ? String(req.query.camera) : null;
      const wanted = one ? ids.filter((id) => id === one) : ids;
      if (wanted.length === 0) return res.json(empty);

      // ตัดหัว ISO ได้ตรง ๆ เพราะค่าที่เก็บเป็นเวลาไทยอยู่แล้ว — 10 ตัวแรกคือวัน 13 ตัวแรกคือชั่วโมง
      const bucket = interval === 'hour' ? 'substr(ts, 1, 13)' : 'substr(ts, 1, 10)';
      const holes = wanted.map(() => '?').join(',');
      const range = [from, to, ...wanted];

      const byCamera = new Map(
        cams.filter((c) => wanted.includes(c.id))
          .map((c) => [c.id, { cameraId: c.id, name: c.name, group: c.group_name || null, kinds: [] }]),
      );

      /** หา (หรือสร้าง) ชนิดหนึ่งของกล้องหนึ่ง — ใช้ topic+rule เป็นกุญแจ */
      const kindOf = (cameraId, topic, rule) => {
        const cam = byCamera.get(cameraId);
        if (!cam) return null;
        let k = cam.kinds.find((x) => x.topic === topic && (x.rule || '') === (rule || ''));
        if (!k) {
          k = {
            topic,
            rule: rule || null,
            label: topicLabel(topic) || String(topic).split('/').pop(),
            events: 0, in: 0, out: 0, lastAt: null,
            points: [],
          };
          cam.kinds.push(k);
        }
        return k;
      };

      const atOf = (b) => (interval === 'hour' ? `${b}:00:00.000${BANGKOK_SUFFIX}` : `${b}T00:00:00.000${BANGKOK_SUFFIX}`);

      const pointOf = (k, b) => {
        const at = atOf(b);
        let pt = k.points.find((x) => x.at === at);
        if (!pt) { pt = { at, events: 0, in: 0, out: 0 }; k.points.push(pt); }
        return pt;
      };

      db.all(
        `SELECT camera_id, topic, rule, ${bucket} AS bucket,
                SUM(events) AS events, SUM(count_in) AS count_in, SUM(count_out) AS count_out,
                MAX(updated_at) AS last_at
           FROM camera_ai_stats
          WHERE ts >= ? AND ts <= ? AND camera_id IN (${holes})
          GROUP BY camera_id, topic, rule, bucket`,
        range,
        (sErr, rows) => {
          // ตารางนี้เพิ่งมีในเวอร์ชันนี้ — Gateway ที่ยังไม่ได้อัปเดตต้องตอบรายชื่อกล้องได้ตามปกติ
          for (const r of sErr ? [] : rows || []) {
            const k = kindOf(r.camera_id, r.topic, r.rule);
            if (!k) continue;
            k.events += r.events || 0;
            if (!k.lastAt || (r.last_at && r.last_at > k.lastAt)) k.lastAt = r.last_at || k.lastAt;
            const pt = pointOf(k, r.bucket);
            pt.events += r.events || 0;
          }

          /*
            ยอดนับต้องมาจาก camera_analytics ไม่ใช่จากตารางสถิติ

            ตารางสถิติมีเฉพาะสิ่งที่ไหลมาทาง metadata track — กล้องที่ให้ยอดผ่าน API ของยี่ห้อ
            (Tiandy) จึงไม่มีแถวอยู่ในนั้นเลย แล้วจะขึ้นว่า "ไม่มีข้อมูล" ทั้งที่ยอดถูกเก็บอยู่
            ครบถ้วนคนละที่ ซึ่งเป็นคำตอบที่ผิดในแบบที่ดูเหมือนถูก

            in/out จึงเอาจาก camera_analytics ซึ่งรวมทุกที่มา ส่วน events ยังมาจากตารางสถิติ
            (จำนวนข้อความที่รับมา ซึ่งของ Tiandy เป็นศูนย์จริงเพราะเป็นการ poll ไม่ใช่รับ event)
          */
          db.all(
            `SELECT camera_id, rule, ${bucket} AS bucket,
                    SUM(count_in) AS count_in, SUM(count_out) AS count_out, MAX(updated_at) AS last_at
               FROM camera_analytics
              WHERE ts >= ? AND ts <= ? AND camera_id IN (${holes})
              GROUP BY camera_id, rule, bucket`,
            range,
            (cErr, counts) => {
              for (const r of cErr ? [] : counts || []) {
                const cam = byCamera.get(r.camera_id);
                if (!cam) continue;
                // จับกับชนิดนับที่มีอยู่แล้วก่อน ถ้าไม่มีเลยค่อยสร้างใหม่ (กรณี Tiandy)
                let k = cam.kinds.find((x) => /CountAggregation/.test(x.topic) && (x.rule || '') === (r.rule || ''));
                if (!k) {
                  if (!(r.count_in || r.count_out)) continue;
                  k = kindOf(r.camera_id, 'tns1:RuleEngine/CountAggregation/Counter', r.rule);
                }
                k.in += r.count_in || 0;
                k.out += r.count_out || 0;
                if (!k.lastAt || (r.last_at && r.last_at > k.lastAt)) k.lastAt = r.last_at || k.lastAt;
                const pt = pointOf(k, r.bucket);
                pt.in += r.count_in || 0;
                pt.out += r.count_out || 0;
              }

              for (const c of byCamera.values()) {
                for (const k of c.kinds) k.points.sort((a, b) => (a.at < b.at ? -1 : 1));
                c.kinds.sort((a, b) => (b.events + b.in) - (a.events + a.in));
              }
              res.json({ from, to, interval, cameras: [...byCamera.values()] });
            },
          );
        },
      );
    });
  });

  // ----------------------------------------------------------------- สตรีม

  /** สถานะสตรีมทั้งหมดในขอบเขตของ client — ใช้เฝ้าดูว่าตัวไหนหลุด */
  router.get('/streams', (req, res) => {
    const { sql, params } = scopeClause(req.apiClient);
    db.all(`SELECT id, name FROM cameras ${sql}`, params, async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      let live;
      try {
        live = await core.listStreams();
      } catch (coreErr) {
        return res.status(502).json({ error: `ติดต่อ ${core.id} ไม่ได้: ${coreErr.message}` });
      }

      const streams = [];
      for (const row of rows || []) {
        for (const streamType of ['main', 'sub']) {
          // เส้น `_raw` ต้องอยู่ในรายการนี้ด้วย ไม่งั้นคนที่ใช้ /streams เฝ้าดูว่าอะไรหลุด
          // จะมองไม่เห็นครึ่งหนึ่งของสิ่งที่ตัวเองกำลังดูอยู่
          const variants = rawStreamsEnabled()
            ? [
                { name: streamPathName(row.id, streamType), transport: 'transcoded' },
                { name: rawStreamPathName(row.id, streamType), transport: 'passthrough' },
              ]
            : [{ name: streamPathName(row.id, streamType), transport: 'transcoded' }];

          for (const variant of variants) {
            const status = live.get(variant.name);
            if (!status) continue;
            streams.push({
              cameraId: row.id,
              cameraName: row.name,
              streamType,
              transport: variant.transport,
              path: variant.name,
              ready: status.ready,
              tracks: status.tracks,
              readers: status.readers,
            });
          }
        }
      }
      res.json({ core: core.id, count: streams.length, streams });
    });
  });

  // -------------------------------------------------------------- metadata

  /**
   * เหตุการณ์สถานะกล้องแบบ SSE
   *
   * ส่งเฉพาะ "ตอนที่เปลี่ยน" ทันทีที่ shared/camera-state.js แจ้ง ไม่ poll เอง
   *
   * เดิม route นี้ poll `core.listStreams()` ทุก 5 วิ แล้วถือว่า "มี producer" = online ซึ่ง go2rtc
   * รายงานเป็นจริงตลอดแม้ไม่มีใครดูและกล้องถอดสายอยู่ (producer ที่ยังไม่ต่อมีแค่ { url }) —
   * ตอนนี้สถานะมาจากที่เดียวกับหน้าเว็บ (TCP ไปหัวกล้อง หรือค่าที่ edge รายงาน)
   *
   * event ที่ส่ง:
   *   camera_state   { cameraId, cameraName, enabled, reachable, streaming, at }  — ตัวหลักตั้งแต่ client 1.3.4
   *   camera_status  { ..., streamType: 'main', from, to: 'online'|'offline' }     — คงไว้ให้ client รุ่นเก่า
   *                  ส่งเมื่อ reachable เปลี่ยนเท่านั้น (online = reachable === true)
   *   camera_removed { cameraId }
   */
  router.get('/events', async (req, res) => {
    const PING_MS = 20_000;
    const SCOPE_REFRESH_MS = 30_000;
    const { sql, params } = scopeClause(req.apiClient);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    if (!cameraState) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'สถานะกล้องยังไม่พร้อม' })}\n\n`);
      return res.end();
    }

    let closed = false;
    /** id → ชื่อ ของกล้องใน scope ของ client รายนี้ — อ่านใหม่เป็นระยะ เผื่อกลุ่มหรือกล้องเปลี่ยน */
    let scope = new Map();
    const loadScope = () => new Promise((resolve) => {
      db.all(`SELECT id, name FROM cameras ${sql}`, params, (err, rows) => {
        if (!err) scope = new Map((rows || []).map((r) => [r.id, r.name]));
        resolve();
      });
    });
    const send = (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const onChange = (id, next, prev) => {
      if (!scope.has(id)) return;
      const cameraName = scope.get(id);
      send({
        type: 'camera_state',
        cameraId: id,
        cameraName,
        enabled: next.enabled,
        reachable: next.reachable,
        streaming: next.streaming,
        at: next.at,
      });
      const was = prev ? prev.reachable === true : null;
      const now = next.reachable === true;
      if (was !== now) {
        send({
          type: 'camera_status',
          cameraId: id,
          cameraName,
          streamType: 'main',
          path: streamPathName(id, 'main'),
          from: was === null ? 'unknown' : was ? 'online' : 'offline',
          to: now ? 'online' : 'offline',
          at: next.at,
        });
      }
    };
    const onRemove = (id) => {
      if (!scope.has(id)) return;
      send({ type: 'camera_removed', cameraId: id, cameraName: scope.get(id), at: nowIso() });
    };

    await loadScope();
    if (closed) return;
    const unsubscribe = cameraState.subscribe({ onChange, onRemove });
    // event ของ AI — `{ type: 'ai_event', event }` (ห่อไว้ เพราะ event มี field type ของตัวเอง)
    // ไม่มีภาพ ภาพขอที่ /ai/events/:seq/snapshot.jpg · ตกหล่นตอนสายขาด = ไล่ตามด้วย GET /ai/events?since=
    const unsubscribeAi = aiEvents ? aiEvents.subscribe((row) => {
      if (!scope.has(row.camera_id)) return;
      void cameraInfo([row.camera_id]).then((info) => {
        if (!closed && scope.has(row.camera_id)) send({ type: 'ai_event', event: withCamera([row], info)[0] });
      }).catch((err) => console.warn('[API v1] AI event metadata: ' + err.message));
    }) : () => {};
    // edge หลุด/กลับมา (central) — ไม่ผูกกับขอบเขตกล้อง ทุก client ควรรู้ว่าภาพส่วนหนึ่งหายไป
    const unsubscribeEdge = edgeAlerts ? edgeAlerts.subscribe((ev) => send({ type: 'edge_state', ...ev })) : () => {};
    // ครั้งแรกคือฐาน ไม่ใช่การเปลี่ยนแปลง — client ที่อยากได้สถานะตั้งต้นอ่าน /cameras (มี state ครบ)
    res.write(`event: hello\ndata: ${JSON.stringify({ cameras: scope.size })}\n\n`);

    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, PING_MS);
    const refresh = setInterval(() => { loadScope(); }, SCOPE_REFRESH_MS);
    req.on('close', () => {
      closed = true;
      unsubscribe();
      unsubscribeAi();
      unsubscribeEdge();
      clearInterval(ping);
      clearInterval(refresh);
    });
  });

  return {
    router,
    // ตัวเดียวกับที่ /api/v1 ใช้ — หน้า Live ของเว็บใช้ร่วม (cache ONVIF และคิวคำสั่งต่อกล้องชุดเดียว)
    ptz,
    invalidateApiKeyCache: auth.invalidate,
    listActiveInstances: auth.listActiveInstances,
    countActiveInstances: auth.countActiveInstances,
  };
}

/**
 * แปลงแถวกล้องเป็นรูปแบบที่ส่งออกนอกระบบได้
 *
 * แยกเป็นฟังก์ชันเดียวเพื่อให้มีที่เดียวที่ตัดสินว่า "อะไรออกไปข้างนอกได้บ้าง"
 * ถ้ากระจายอยู่หลาย route ไม่ช้าก็เร็วจะมี route ที่ลืมกรอง
 */
/**
 * ความสามารถ AI ที่ค้นพบของกล้องชุดหนึ่ง — Map ของ cameraId -> รายการ
 *
 * อยู่คนละตารางกับ cameras เพราะกล้องหนึ่งตัวมีได้หลายกฎ (สามเส้น + สองพื้นที่) การยัด
 * ลงคอลัมน์เดียวจะแยกไม่ออกว่าอันไหนของกฎไหน
 *
 * ล้มแล้วคืน Map ว่าง ไม่โยนต่อ — ตารางนี้เพิ่งมีในเวอร์ชันนี้ Gateway ที่ยังไม่ได้รัน
 * migration ต้องยังตอบ /cameras ได้ตามปกติ แค่ไม่มีฟิลด์ใหม่ติดไปด้วย
 */
function loadCapabilities(db, ids) {
  return new Promise((resolve) => {
    if (!ids.length) return resolve(new Map());
    db.all(
      `SELECT camera_id, source, topic, rule, enabled, label FROM camera_ai
        WHERE camera_id IN (${ids.map(() => '?').join(',')})`,
      ids,
      (err, rows) => {
        if (err) return resolve(new Map());
        const map = new Map();
        for (const r of rows || []) {
          if (!map.has(r.camera_id)) map.set(r.camera_id, []);
          map.get(r.camera_id).push({
            topic: r.topic,
            rule: r.rule || null,
            label: r.label || null,
            enabled: Boolean(r.enabled),
            source: r.source,
          });
        }
        resolve(map);
      },
    );
  });
}

function toPublicCamera(row, live, capabilities, origin = null, state = null) {
  const mainStatus = live.get(row.id.toLowerCase().replace(/\s+/g, '_'));
  const subStatus = live.get(`${row.id.toLowerCase().replace(/\s+/g, '_')}_sub`);
  return {
    id: row.id,
    // ชื่อที่กล้องตัวนี้ใช้ร่วมกันทุกชั้น edge → central → client และไม่เปลี่ยนตลอดอายุกล้อง
    globalId: row.global_id || null,
    name: row.name,
    group: row.group_name || null,
    region: {
      province: publicRegion(row.province_code),
      district: publicRegion(row.district_code),
    },
    brand: row.brand || null,
    type: row.type || null,
    location: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null,
    // ตรึงสตรีมหลักให้เปิดค้างไว้หรือไม่ — มาแทน aiEnabled เดิมตอนถอด AI ออกจาก Gateway
    alwaysOn: Boolean(row.always_on),
    // สตรีมของกล้องนี้มีเสียงไหม (ตั้งที่ edge) — client แสดงปุ่มเปิดเสียงเฉพาะกล้องที่เป็น true · ตั้งต้นปิดเสียงเสมอ
    audio: Number(row.audio_enabled) === 1,
    /*
      ความสามารถด้าน AI ที่ "อยู่ในหัวกล้อง" ไม่ใช่ของ Gateway

      supported=false มีได้สองความหมายที่ client ไม่ต้องแยก: กล้องไม่มีระบบ AI หรือมีแต่
      ปิดไว้ สิ่งที่ client ต้องรู้คือ "ที่นี่ไม่มีข้อมูลให้" ซึ่งต่างจากการคืนเลข 0
      อย่างสิ้นเชิง — เลข 0 แปลว่าไม่มีคนเดินผ่าน
    */
    analytics: {
      supported: Boolean(row.analytics_kind),
      kind: row.analytics_kind || null,
      probedAt: row.analytics_probed_at || null,
      /*
        เพิ่มเข้ามาโดยไม่แตะสามฟิลด์ข้างบน — ของเดิมยังหมายถึง "นับคนได้ไหม" เหมือนเดิม
        ทุกประการ client ที่ใช้อยู่จึงไม่ต้องแก้อะไร

        ส่วนนี้ตอบคำถามที่ตอบไม่ได้มาตลอด: กล้องตัวนี้เปิด AI อะไรไว้บ้าง ไม่ใช่แค่
        นับคนหรือเปล่า — กล้องที่ตั้ง Cross Line จับรถยนต์เคยขึ้นว่า supported=false
        ทั้งที่มี AI ทำงานอยู่จริง
      */
      capabilities: capabilities || [],
    },
    /*
      กล้องที่ central ดึงมาจาก edge: { kind: 'edge', node, reachable, missingAtSource }
      reachable=false แปลว่า edge ติดต่อไม่ได้ — สถานะของกล้องตัวนี้จึงไม่รู้ ไม่ใช่กล้องดับ
      null สำหรับกล้องที่เครื่องนี้ต่อเอง
    */
    origin,
    // ปิดใช้งานที่ edge = ไม่มีสตรีมให้ (ไม่ใช่กล้องดับ)
    enabled: row.enabled === undefined || row.enabled === null ? true : Number(row.enabled) !== 0,
    // ใช้ boolean เท่านั้น — RTSP จริงมีรหัสฝังอยู่และห้ามส่งผ่าน /api/v1
    streamConfigured: Boolean(row.stream_configured),
    /*
      สถานะสามค่า (shared/camera-state.js): enabled / reachable (หัวกล้องตอบไหม — null = ไม่รู้) /
      streaming (core กำลังดึงภาพอยู่ไหม) — ใช้ reachable ตัดสินว่ากล้องเสีย ไม่ใช่ streams.*.ready
    */
    state: publicState(state),
    streams: {
      main: { ready: mainStatus ? mainStatus.ready : null, tracks: mainStatus ? mainStatus.tracks : [] },
      sub: { ready: subStatus ? subStatus.ready : null, tracks: subStatus ? subStatus.tracks : [] },
    },
  };
}

module.exports = { createGatewayRouter };
