/**
 * กล้องที่ central ดึงมาจาก edge (docs/EDGE-PLAN.md เฟส 2)
 *
 * ต่อยอดกลไกเดียวกับ Digifort: edge หนึ่งตัวคือแถวหนึ่งใน camera_sources (kind = 'edge') และกล้อง
 * ทุกตัวของมันผูกด้วย (source_id, source_ref) โดย source_ref = id ของกล้องที่ edge ตัวนั้น
 *
 * เจ้าของข้อมูล — ห้ามสลับ:
 *   edge   ชื่อ, ยี่ห้อ, พิกัด, จังหวัด/อำเภอ, global ID, ที่อยู่สตรีม → resync เขียนทับทุกรอบ
 *   central กลุ่มที่ใช้แสดงผล (group_name), ผัง wall, สิทธิ์ → resync ไม่แตะเลย
 *
 * central ไม่เคยได้รหัสผ่านกล้อง สิ่งเดียวที่เก็บคือ API key ที่ edge ออกให้ (seal ด้วย key-vault)
 * กับบัญชี RTSP ของ go2rtc ที่ edge ซึ่งติดมากับ URL สตรีม
 */
const { EdgeClient, EdgeAuthError, EdgeUnavailable, EdgeRequestError, rtspFrom, RECORDER_TIMEOUT_MS } = require('./edge');
const { seal, unseal } = require('../gateway/key-vault');
const { nowIso } = require('../shared/time');
const crypto = require('crypto');
const { NODE_NUMBER, HTTP_PORT, GO2RTC_RTSP_PORT, ROLE, REGION } = require('../shared/instance');
const { CODES: REGION_CODES, regionForProvince } = require('../shared/region-groups');
const { lookup: lookupArea } = require('../shared/regions');
const { rtspCredentials, withRtspCredentials } = require('../gateway/rtsp-auth');
const { resolveCore } = require('../gateway/streams');

const EDGE_TYPE = 'edge_relay';
const HEALTH_EVERY_MS = 60_000;
/** ทบทวนชื่อ/พิกัด/สตรีมจาก edge เองทุก 10 นาที ถ้า edge ตอบอยู่ — คนไม่ต้องคอยกด Re-sync */
const AUTO_RESYNC_EVERY_MS = 10 * 60_000;

const sourceIdFor = (host, port) => `vms_edge_${String(host).replace(/[^\w]/g, '_')}_${port}`;
/** หมายเหตุจุดติดตั้งเป็นข้อมูลของผู้ดูแลต้นทาง ไม่เปลี่ยนชื่อหรือเลข node */
const normaliseRemark = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length > 500) throw Object.assign(new Error('Remark ต้องเป็นข้อความไม่เกิน 500 ตัวอักษร'), { status: 400 });
  return value.trim() || null;
};
const cameraIdFor = (node, edgeCameraId) =>
  `cam_edge_${node}_${crypto.createHash('sha256').update(String(edgeCameraId)).digest('hex').slice(0, 32)}`;

/** แปลง error ของ client เป็น HTTP ที่บอกได้ว่าลองใหม่ได้ไหม */
function sendEdgeError(res, err) {
  if (err instanceof EdgeAuthError) return res.status(401).json({ error: err.message });
  if (err instanceof EdgeUnavailable) return res.status(502).json({ error: err.message });
  if (err instanceof EdgeRequestError) return res.status(err.status >= 500 ? 502 : 400).json({ error: err.message });
  console.error('[Edge]', err.message);
  return res.status(500).json({ error: err.message || 'edge request failed' });
}

function createEdgeSources({ db, saveLog, resyncStreamCore, cameraState, onBeforeCamerasRemoved = null, onCamerasRemoved = null, onCatalogChanged = null, aiEvents = null }) {
  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
  const get = (sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); }));

  const ensureSchema = async () => {
    // mode: NULL/'pull' = central ต่อเข้า edge (ของเดิม) · 'link' = edge ต่อขึ้นมาเอง · link_token_hash: token ของ link
    for (const col of ['status TEXT', 'status_at TEXT', 'remote_node TEXT', 'remote_build TEXT', 'status_error TEXT', 'mode TEXT', 'link_token_hash TEXT', 'link_via TEXT', 'link_remote TEXT', 'remote_role TEXT', 'remote_region TEXT', 'node_block TEXT', 'remark TEXT', 'remote_province TEXT']) {
      await run(`ALTER TABLE camera_sources ADD COLUMN ${col}`).catch(() => {});
    }
    // กล้องที่หายจากต้นทาง — ติดเวลาไว้ ไม่ลบ (wall, สิทธิ์, log อาจยังอ้างถึงอยู่)
    await run('ALTER TABLE cameras ADD COLUMN source_missing_at TEXT').catch(() => {});
  };

  /** source id → { reachable, node, build, at } ในหน่วยความจำ — /api/v1 อ่านทุกคำขอ ไม่ควรยิง DB */
  const status = new Map();
  /** edge ที่ถูกถอดใน process นี้ — รอบซิงก์ที่ค้างอยู่ห้ามใส่กล้องของมันกลับ (แอดใหม่ = ลบออกจากชุดนี้) */
  const removedSources = new Set();
  const warnedInsert = new Set(); // กล้องที่เพิ่มไม่ได้เพราะชน — เตือนแล้ว
  const warnedOutside = new Map(); // source id → รายชื่อกล้องนอกภาคที่เตือนล่าสุด (เตือนซ้ำเมื่อชุดเปลี่ยน)
  /** จังหวัดนี้อยู่นอกภาคของ Regional ไหม — จังหวัดว่าง/ไม่รู้จัก = ไม่นับ */
  const isOutsideRegion = (provinceCode) => {
    const region = regionForProvince(provinceCode);
    return Boolean(region) && region !== REGION;
  };
  /** จังหวัดที่ edge รายงานใน hello/health — 2 หลักที่รู้จักเท่านั้น (00 = edge ไม่ได้ตั้ง, รุ่นเก่า = ไม่ส่ง) */
  const reportedProvince = (value) => {
    const code = String(value ?? '').replace(/\D/g, '');
    return code.length === 2 && regionForProvince(code) ? code : null;
  };

  const clientForSource = (source) => new EdgeClient({ host: source.host, port: source.port, key: unseal(source.password_sealed),
    recorderTimeoutMs: ROLE === 'central' && source.remote_role === 'regional' ? RECORDER_TIMEOUT_MS * 2 + 10_000 : RECORDER_TIMEOUT_MS });

  /*
    สถานะกล้องแบบสดจาก edge (docs/EDGE-PLAN.md งาน "ส่งต่อ SSE ของ edge เข้า central")

    ต่อ /api/v1/events ของ edge แต่ละตัวค้างไว้หนึ่งสาย แล้วเขียน reachable ของกล้องลง camera-state
    ของ central ทันทีที่ edge แจ้ง — client ที่ต่อ central เห็นกล้องที่ edge ดับภายในรอบเช็คของ edge
    (15 วิ) แทนที่จะไม่เห็นเลย

    central ไม่เอา streaming ของ edge: การที่ edge ดึงภาพอยู่ไม่ได้แปลว่า central ดึงอยู่ central มี
    go2rtc ของตัวเองซึ่ง updateCameraStatuses อ่านเอง · สายขาด = กล้องของ edge นั้น reachable=null
    (ไม่รู้) ไม่ใช่ false — edge หายไม่ได้แปลว่ากล้องดับทั้งไซต์
  */
  const feeds = new Map();

  /** source_ref (id ที่ edge) → id ที่ central ของ edge หนึ่งตัว */
  async function refMapOf(sourceId) {
    const rows = await all('SELECT id, source_ref FROM cameras WHERE source_id = ?', [sourceId]).catch(() => []);
    return new Map(rows.map((r) => [r.source_ref, r.id]));
  }

  /** เขียนสถานะที่ edge รายงานของกล้องหนึ่งตัว — คืน false ถ้ายังไม่รู้จักกล้องนี้ (รอ resync รับเข้ามา) */
  function applyEdgeState(feed, edgeCamId, st) {
    const id = feed.map.get(edgeCamId);
    if (!id) return false;
    cameraState.set(id, { reachable: st.reachable === undefined ? null : st.reachable });
    if (st.enabled !== undefined) {
      // enabled เป็นของ edge — เก็บลงแถวด้วย ไม่งั้น updateCameraStatuses ของ central เปิดกลับเองรอบถัดไป
      run('UPDATE cameras SET enabled = ? WHERE id = ? AND COALESCE(enabled, 1) != ?', [st.enabled ? 1 : 0, id, st.enabled ? 1 : 0])
        .then((r) => {
          if (!r.changes) return;
          cameraState.set(id, st.enabled ? { enabled: true } : { enabled: false, reachable: null, streaming: false });
          resyncStreamCore();
        })
        .catch(() => {});
    }
    return true;
  }

  /** กล้องทุกตัวของ edge หนึ่งตัวกลับเป็น "ไม่รู้" — ใช้ตอนสายขาดหรือ edge ติดต่อไม่ได้ */
  async function markUnknown(sourceId) {
    if (!cameraState) return;
    for (const id of (await refMapOf(sourceId)).values()) {
      if (cameraState.get(id)?.enabled !== false) cameraState.set(id, { reachable: null });
    }
  }

  /** เปิดสาย events ไปยัง edge หนึ่งตัว ถ้ายังไม่เปิด — ต่อใหม่เองด้วย backoff 2 → 60 วิ จนกว่าจะ stopFeed */
  function ensureFeed(sourceId) {
    if (!cameraState || feeds.has(sourceId)) return;
    const feed = { close: null, timer: null, retryMs: 2000, map: new Map(), warned: false };
    feeds.set(sourceId, feed);

    const connect = async () => {
      feed.timer = null;
      if (feeds.get(sourceId) !== feed) return;
      const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [sourceId]).catch(() => null);
      if (!source) { feeds.delete(sourceId); return; }
      const client = clientForSource(source);
      feed.map = await refMapOf(sourceId);
      feed.close = client.events({
        onOpen: async () => {
          feed.retryMs = 2000;
          syncAiEvents(sourceId); // ไล่ตาม event ที่เกิดระหว่างสายขาด
          if (feed.warned) console.log(`[Edge] ${source.label}: สายสถานะกล้องกลับมาแล้ว`);
          feed.warned = false;
          // SSE ส่งแค่ตอนเปลี่ยน — สถานะตั้งต้นอ่านจากรายชื่อกล้องครั้งเดียว
          try {
            for (const cam of await client.listCameras()) {
              // edge รุ่นก่อนมี state: ไม่รู้สถานะหัวกล้อง ปล่อยเป็น null ดีกว่าเดาว่า online
              applyEdgeState(feed, cam.id, cam.state ? { reachable: cam.state.reachable, enabled: cam.state.enabled } : { reachable: null });
            }
          } catch (err) {
            console.warn(`[Edge] ${source.label}: อ่านสถานะตั้งต้นไม่ได้ — ${err.message}`);
          }
        },
        onEvent: (ev) => {
          if (ev?.type === 'ai_event') { syncAiEvents(sourceId); return; }
          if (ev?.type !== 'camera_state') return;
          const st = { reachable: ev.reachable, enabled: ev.enabled };
          if (!applyEdgeState(feed, ev.cameraId, st)) {
            // กล้องที่เพิ่งแอดที่ edge — โหลดรายการใหม่ ถ้า resync รับเข้ามาแล้วจะเจอ
            refMapOf(sourceId).then((m) => { feed.map = m; applyEdgeState(feed, ev.cameraId, st); });
          }
        },
        onClose: (err) => {
          feed.close = null;
          if (feeds.get(sourceId) !== feed) return;
          markUnknown(sourceId);
          if (err && !feed.warned) {
            console.warn(`[Edge] ${source.label}: สายสถานะกล้องขาด — ${err.message} (ต่อใหม่เอง)`);
            feed.warned = true;
          }
          feed.timer = setTimeout(connect, feed.retryMs);
          feed.retryMs = Math.min(feed.retryMs * 2, 60_000);
        },
      });
    };
    connect();
  }

  function stopFeed(sourceId) {
    const feed = feeds.get(sourceId);
    if (!feed) return;
    feeds.delete(sourceId);
    clearTimeout(feed.timer);
    feed.close?.();
  }

  /** health + ยืนยันว่าเป็น edge จริง และเลขเครื่องไม่ชนกับเรา */
  async function checkEdge(client) {
    const h = await client.health();
    if (h.role !== (ROLE === 'central' ? 'regional' : 'edge')) {
      throw new EdgeRequestError(400, `เครื่องนี้เป็น ${h.role || 'Gateway รุ่นเก่า'} — ${ROLE} รับ ${ROLE === 'central' ? 'Regional' : 'Edge'} เท่านั้น`);
    }
    if (h.node === NODE_NUMBER) {
      throw new EdgeRequestError(400, `edge ใช้เลขเครื่อง ${h.node} ซ้ำกับเครื่องนี้ — global ID จะชนกัน`);
    }
    if (h.role === 'regional' && (!REGION_CODES.includes(h.region) || !/^[1-6]00$/.test(String(h.node)))) {
      throw new EdgeRequestError(400, 'Regional ต้องรายงาน region และเลขต้นบล็อกที่ถูกต้อง');
    }
    if (ROLE === 'regional' && (Number(h.node) <= Number(NODE_NUMBER) || Number(h.node) >= Number(NODE_NUMBER) + 100)) {
      throw new EdgeRequestError(400, `edge ${h.node} อยู่นอกบล็อกของ regional ${NODE_NUMBER}`);
    }
    return h;
  }

  /** field ที่ edge เป็นเจ้าของ ยกเว้นที่อยู่สตรีม — เหมือนกันทั้ง pull และ link */
  const baseFields = (cam) => ({
    name: cam.name,
    brand: cam.brand || 'generic',
    lat: cam.location?.lat ?? null,
    lng: cam.location?.lng ?? null,
    province: cam.region?.province?.code || null,
    district: cam.region?.district?.code || null,
    globalId: cam.globalId || null,
    // ปิดใช้งานที่ edge = ปิดที่ central ด้วย (edge เป็นเจ้าของ) — edge รุ่นเก่าไม่มีฟิลด์นี้ ถือว่าเปิด
    enabled: cam.enabled === false ? 0 : 1,
    // ส่งเสียงต่อ — edge เป็นเจ้าของ · edge รุ่นเก่าไม่มีฟิลด์นี้ = ไม่มีเสียง (ทางเดิม)
    audio: cam.audio === true ? 1 : 0,
  });

  /** pull: ที่อยู่สตรีมมาจาก /cameras/:id/streams ของ edge (go2rtc ของเราดึงจาก edge) */
  async function edgeFields(client, cam) {
    if (cam.streamConfigured === false) {
      return { ...baseFields(cam), rtsp: null, rtspSub: null };
    }
    const streams = await client.streams(cam.id);
    return { ...baseFields(cam), rtsp: rtspFrom(streams, 'main'), rtspSub: rtspFrom(streams, 'sub') };
  }

  /** รายชื่อกล้องบน edge ในรูปเดียวกับที่หน้าจอ import ของ Digifort ใช้ */
  const toListItem = (c) => ({
    ref: c.id,
    name: c.name,
    groupName: c.group || '',
    model: [c.globalId, c.region?.province?.name].filter(Boolean).join(' · '),
    active: true,
    working: c.streams?.main?.ready !== false,
    fps: 0,
  });

  async function probe(req, res) {
    const { host, port, key } = req.body || {};
    if (!host || !key) return res.status(400).json({ error: 'ต้องมีที่อยู่ของ edge และ API key ที่ edge ออกให้' });
    try {
      const client = new EdgeClient({ host, port, key });
      const h = await checkEdge(client);
      const cameras = await client.listCameras();
      res.json({
        cameras: cameras.map(toListItem),
        serverInfo: { edition: `${h.role} ${h.node}`, version: h.build || '', serverType: h.role },
      });
    } catch (err) {
      sendEdgeError(res, err);
    }
  }

  async function importCameras(req, res) {
    const { host, port, key, group, refs, label } = req.body || {};
    if (!host || !key) return res.status(400).json({ error: 'ต้องมีที่อยู่ของ edge และ API key ที่ edge ออกให้' });
    if (!Array.isArray(refs) || !refs.length) return res.status(400).json({ error: 'เลือกกล้องอย่างน้อย 1 ตัว' });

    const apiPort = String(Number(port) || 5173);
    const sourceId = sourceIdFor(host, apiPort);
    try {
      const client = new EdgeClient({ host, port: apiPort, key });
      const h = await checkEdge(client);
      const byId = new Map((await client.listCameras()).map((c) => [c.id, c]));
      const unknown = refs.filter((r) => !byId.has(r));
      if (unknown.length) return res.status(400).json({ error: `ไม่พบกล้องนี้บน edge: ${unknown.slice(0, 3).join(', ')}` });
      const owner = await nodeOwnedElsewhere(h.node, sourceId);
      if (owner) {
        return res.status(409).json({ error: `edge ${h.node} ถูกเพิ่มไว้แล้วเป็น "${owner.label}"${owner.host ? ` (${owner.host}:${owner.port})` : ' (link)'} — ถอดของเดิมออกก่อน หรือ Re-sync ของเดิม` });
      }
      const regionOwner = await regionOwnedElsewhere(h.role, h.region, sourceId);
      if (regionOwner) return res.status(409).json({ error: `ภาค ${h.region} มี Regional "${regionOwner.label}" แล้ว` });
      removedSources.delete(sourceId);

      await run(
        `INSERT INTO camera_sources (id, kind, label, host, port, rtsp_port, username, password_sealed, created_at, last_sync_at,
                                     status, status_at, remote_node, remote_build, remote_role, remote_region, node_block)
         VALUES (?,?,?,?,?,NULL,NULL,?,?,?,'ok',?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, password_sealed=excluded.password_sealed,
           last_sync_at=excluded.last_sync_at, status='ok', status_at=excluded.status_at,
           remote_node=excluded.remote_node, remote_build=excluded.remote_build, remote_role=excluded.remote_role,
           remote_region=excluded.remote_region, node_block=excluded.node_block`,
        [sourceId, 'edge', label || `Edge ${h.node} (${host})`, host, apiPort, seal(key),
          nowIso(), nowIso(), nowIso(), h.node, h.build || null, h.role, h.region || null, h.role === 'regional' ? h.node : null],
      );
      status.set(sourceId, { reachable: true, node: h.node, build: h.build || null, at: Date.now() });

      let added = 0;
      let skipped = 0;
      const failed = [];
      for (const ref of refs) {
        const cam = byId.get(ref);
        let f;
        try {
          f = await edgeFields(client, cam);
        } catch (err) {
          failed.push(`${cam.name}: ${err.message}`);
          continue;
        }
        if (!f.rtsp && cam.streamConfigured !== false) {
          failed.push(`${cam.name}: edge ไม่ให้ที่อยู่สตรีม`);
          continue;
        }
        try {
          if (await insertEdgeCamera(sourceId, h.node, cam, f, group)) added += 1; else skipped += 1;
        } catch (err) {
          failed.push(`${cam.name}: ${err.message}`);
        }
      }

      saveLog(req.user?.username || 'unknown', 'Add Camera',
        `เพิ่มกล้องจาก edge ${h.node} (${host}) จำนวน ${added} ตัว (ข้ามที่มีอยู่แล้ว ${skipped}${failed.length ? `, ล้มเหลว ${failed.length}` : ''})`);
      resyncStreamCore();
      res.json({ success: true, added, skipped, failed, sourceId });
    } catch (err) {
      sendEdgeError(res, err);
    }
  }

  /**
   * เพิ่มกล้องหนึ่งตัวของ edge เป็นแถว edge_relay — คืน true ถ้าเพิ่มจริง, false ถ้ามีแถวของ (source, ref) นี้อยู่แล้ว
   * โยน EdgeRequestError(409) ถ้าไม่ได้เพิ่มเพราะ id หรือ global ID ชนกับแถวของแหล่งอื่น (เดิมเงียบ = กล้องหายไปเฉย ๆ)
   * edge ที่ถูกถอดระหว่างรอบซิงก์ = ไม่เพิ่ม (removedSources)
   */
  async function insertEdgeCamera(sourceId, node, cam, f, group) {
    if (removedSources.has(sourceId)) return false;
    const id = cameraIdFor(node, cam.id);
    // INSERT OR IGNORE คู่กับ unique (source_id, source_ref) และ unique global_id = ซ้ำไม่สร้างแถวซ้ำ
    const result = await run(
      `INSERT OR IGNORE INTO cameras
         (id, name, group_name, brand, type, rtsp, rtsp_sub, ip, onvifPort, rtspPort, onvifUser, onvifPass,
          lat, lng, stream_type, source_id, source_ref, global_id, province_code, district_code, enabled, audio_enabled)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,'sub',?,?,?,?,?,?,?)`,
      [id, f.name, group || cam.group || 'Default', f.brand, EDGE_TYPE,
        f.rtsp, f.rtspSub, f.lat, f.lng, sourceId, cam.id, f.globalId, f.province, f.district, f.enabled, f.audio],
    );
    if (result.changes > 0) return true;
    const mine = await get('SELECT id FROM cameras WHERE source_id = ? AND source_ref = ?', [sourceId, cam.id]).catch(() => null);
    if (mine) return false;
    // ถูก IGNORE เพราะชนกับแถวอื่น — มักเป็น edge ที่ถูกแอดซ้ำเป็นแหล่งใหม่ (ที่อยู่/พอร์ตเปลี่ยน) ขณะแถวเก่ายังอยู่
    const clash = await get(
      'SELECT id, source_id, global_id FROM cameras WHERE id = ? OR (? IS NOT NULL AND global_id = ?) LIMIT 1',
      [id, f.globalId, f.globalId],
    ).catch(() => null);
    const what = clash
      ? (clash.id === id ? `id ${id}` : `global ID ${f.globalId} (กล้อง ${clash.id})`)
      : `id ${id} / global ID ${f.globalId || '-'}`;
    // คนเรียกเป็นคน log (syncRows) หรือส่งกลับให้ผู้ใช้ (importCameras)
    throw new EdgeRequestError(409, `${what} มีอยู่แล้ว${clash?.source_id ? ` ในแหล่ง ${clash.source_id}` : ''} (ถอด edge เดิมออกก่อน)`);
  }

  /** edge เลขนี้เป็นของแหล่งอื่นอยู่แล้วไหม — กันแอด edge ตัวเดิมซ้ำเป็นแหล่งใหม่ (id กล้องจะชนแล้วได้ 0 ตัว) */
  async function nodeOwnedElsewhere(node, sourceId) {
    return get("SELECT id, label, host, port FROM camera_sources WHERE kind = 'edge' AND remote_node = ? AND id != ?", [String(node), sourceId]);
  }
  /** ประเทศมี Regional ได้หนึ่งแหล่งต่อภาค */
  async function regionOwnedElsewhere(role, region, sourceId) {
    if (role !== 'regional') return null;
    return get("SELECT id, label FROM camera_sources WHERE kind='edge' AND remote_role='regional' AND remote_region=? AND id!=?", [region, sourceId]);
  }

  /**
   * เขียนรายการกล้องของ edge หนึ่งตัวลงตาราง cameras — เขียน field ที่ edge เป็นเจ้าของใหม่ทุกแถว
   * ติดเวลาให้ตัวที่หาย และเพิ่มกล้องที่ edge เพิ่งแอดเข้ามา
   *
   * ใช้ร่วมกันสองทาง ต่างกันแค่ที่มาของที่อยู่สตรีม (fieldsFor):
   *   pull  central ถาม /cameras/:id/streams ของ edge (resyncSource)
   *   link  edge ส่งรายการขึ้นมาทาง WebSocket และภาพ push เข้า go2rtc ของเราเอง (edge-link-server.js)
   *
   * ไม่ลบกล้องเอง (เหตุผลเดียวกับ Digifort) แต่เพิ่มเอง: ตั้งแต่ 2026-09-23 ระบบเป็น "edge แอดกล้อง,
   * central แอด edge" การเพิ่ม edge คือการรับกล้องทุกตัวของมัน ภาพยังวิ่งเฉพาะตอนมีคนดู การมีแถว
   * อยู่ที่ central จึงไม่กินแบนด์วิดท์ข้ามไซต์
   */
  async function syncRows(source, node, available, fieldsFor, deletedRefs = []) {
    /*
      กล้องจังหวัดนอกภาคของ Regional รับเข้าตามปกติ (ผู้ใช้ตัดสินใจ 2026-10-07 — เช่น Edge ทดสอบที่ต่อข้ามภาค)
      เดิมปฏิเสธทั้งชุด (409) ซึ่งเงียบในสาย link: กล้องทุกตัวของ edge นั้นหยุด sync โดยหน้าเว็บไม่บอก
      ตอนนี้แค่เตือนใน log เมื่อรายชื่อเปลี่ยน และหน้า Edge Nodes แสดงจำนวนจาก listEdges()
    */
    if (ROLE === 'regional') {
      const outside = available.filter((camera) => isOutsideRegion(camera.region?.province?.code || camera.province_code));
      const key = outside.map((camera) => camera.id).sort().join(',');
      if (key && warnedOutside.get(source.id) !== key) {
        console.warn(`[Edge] ${source.label || source.id}: กล้อง ${outside.length} ตัวมีจังหวัดนอกภาค ${REGION} — รับเข้าแต่แจ้งเตือน (${outside.slice(0, 5).map((c) => c.name || c.id).join(', ')}${outside.length > 5 ? ' …' : ''})`);
      }
      if (key) warnedOutside.set(source.id, key); else warnedOutside.delete(source.id);
    }
    const byId = new Map(available.map((c) => [c.id, c]));
    // กล้องที่คนลบที่ edge (edge จดไว้ — shared/camera-deletions.js) — ลบตามได้ ต่างจากกล้องที่แค่หายไป
    const deletedAtEdge = new Set((Array.isArray(deletedRefs) ? deletedRefs : []).map(String));
    const rows = await all(
      'SELECT id, name, rtsp, rtsp_sub, enabled, audio_enabled, source_ref, source_missing_at FROM cameras WHERE source_id = ?',
      [source.id],
    );
    const importedRefs = new Set(rows.map((r) => r.source_ref));
    const missing = [];
    const removed = [];
    let rewritten = 0;
    let streamsChanged = false;
    const where = source.host || source.label || source.id;

    for (const row of rows) {
      const cam = byId.get(row.source_ref);
      if (!cam) {
        if (deletedAtEdge.has(String(row.source_ref))) {
          removed.push({ id: row.id, name: row.name });
          continue;
        }
        missing.push({ id: row.id, name: row.name });
        if (!row.source_missing_at) {
          await run('UPDATE cameras SET source_missing_at = ? WHERE id = ?', [nowIso(), row.id]);
          streamsChanged = true; // ถอดออกจาก go2rtc (go2rtc-sync ข้ามแถวที่หาย)
        }
        // edge ไม่รายงานสถานะของกล้องที่ไม่มีแล้ว — ค่าล่าสุดจะค้างเป็น "ออนไลน์" ถ้าไม่ล้าง
        if (cameraState && cameraState.get(row.id)?.reachable !== null) cameraState.set(row.id, { reachable: null, streaming: false });
        continue;
      }
      let f;
      try {
        f = await fieldsFor(cam);
      } catch (err) {
        console.warn(`[Edge] ${where}: อ่านสตรีมของ ${cam.name} ไม่ได้ — ${err.message}`);
        continue;
      }
      if ((f.rtsp && f.rtsp !== row.rtsp) || (f.rtspSub && f.rtspSub !== row.rtsp_sub)) streamsChanged = true;
      if (Number(row.enabled ?? 1) !== f.enabled) streamsChanged = true;
      if (Number(row.audio_enabled || 0) !== f.audio) streamsChanged = true; // go2rtc ต้องเติม/ถอด #audio=aac
      if (row.source_missing_at) streamsChanged = true; // กลับมาที่ edge — ใส่กลับเข้า go2rtc
      /*
        global_id: ใช้ COALESCE ไม่เขียนทับ — ID ที่ออกไปแล้วห้ามเปลี่ยนแม้ edge จะรายงานต่างไป
        (ถ้าเป็นแบบนั้นจริงคือ edge ถูกล้างฐานข้อมูล ซึ่งต้องให้คนตรวจ ไม่ใช่ให้ระบบตามไปเงียบ ๆ)
      */
      // แถวเดียวเขียนไม่ได้ (เช่น global_id ชนกับกล้องอื่น) ต้องไม่ทำให้ทั้งรายการหยุด — ข้ามแล้วไปแถวถัดไป
      try {
        const result = await run(
          `UPDATE cameras SET name=?, brand=?, lat=?, lng=?, province_code=?, district_code=?, enabled=?, audio_enabled=?,
                  global_id = COALESCE(global_id, ?), rtsp = COALESCE(?, rtsp), rtsp_sub = COALESCE(?, rtsp_sub),
                  source_missing_at = NULL
           WHERE id = ?`,
          [f.name, f.brand, f.lat, f.lng, f.province, f.district, f.enabled, f.audio, f.globalId, f.rtsp, f.rtspSub, row.id],
        );
        rewritten += result.changes;
      } catch (err) {
        console.warn(`[Edge] ${where}: เขียนข้อมูลกล้อง ${row.name} (${row.id}) ไม่ได้ — ${err.message}`);
      }
    }

    const added = [];
    for (const cam of available.filter((c) => !importedRefs.has(c.id))) {
      try {
        const f = await fieldsFor(cam);
        // รุ่นเก่าที่อ่านสตรีมไม่ได้ยังไม่ควรเพิ่ม; รับแถวว่างเฉพาะเมื่อ edge ยืนยันว่าไม่มี RTSP
        if (!f.rtsp && cam.streamConfigured !== false && cam.hasStream !== false) continue;
        if (await insertEdgeCamera(source.id, node, cam, f, null)) {
          added.push(cam.name);
          streamsChanged = true;
        }
      } catch (err) {
        // id/global ID ชน (409) เกิดซ้ำทุกรอบซิงก์จนกว่าคนจะแก้ — เตือนครั้งเดียวต่อกล้อง
        const key = `${source.id}\u0000${cam.id}\u0000${err.message}`;
        if (err.status !== 409 || !warnedInsert.has(key)) console.warn(`[Edge] ${where}: เพิ่ม ${cam.name} ไม่ได้ — ${err.message}`);
        if (err.status === 409) warnedInsert.add(key);
      }
    }
    if (added.length) {
      saveLog('System', 'Add Camera', `รับกล้องใหม่จาก edge ${node} (${where}) ${added.length} ตัว: ${added.slice(0, 5).join(', ')}`);
    }
    if (removed.length) {
      await deleteCameraRows(removed.map((r) => r.id));
      saveLog('System', 'Delete Camera', `ลบกล้องตาม edge ${node} (${where}) ${removed.length} ตัว — ถูกลบที่ edge: ${removed.slice(0, 5).map((r) => r.name).join(', ')}${removed.length > 5 ? ' …' : ''}`);
      streamsChanged = true;
    }
    if (streamsChanged) resyncStreamCore();
    await onCatalogChanged?.(available.map((camera) => cameraIdFor(node, camera.id)));

    return {
      vmsTotal: available.length,
      imported: rows.length - removed.length + added.length,
      added: added.length,
      removed: removed.length,
      missing,
      newCameras: [],
      rewritten,
    };
  }

  /** ลบแถวกล้องที่ central พร้อมสิทธิ์ที่ผูกไว้ และล้างสถานะในหน่วยความจำ */
  async function deleteCameraRows(ids) {
    if (!ids.length) return 0;
    await onBeforeCamerasRemoved?.(ids);
    const marks = ids.map(() => '?').join(',');
    const del = await run(`DELETE FROM cameras WHERE id IN (${marks})`, ids);
    await run(`DELETE FROM role_devices WHERE camera_id IN (${marks})`, ids).catch(() => {});
    for (const id of ids) cameraState?.remove(id);
    onCamerasRemoved?.(ids);
    return del.changes;
  }

  /** ล้างกล้องที่หายจาก edge (ไม่มีบันทึกการลบ) ของ edge หนึ่งตัว — คนกดเองจากหน้า Edge Nodes */
  async function purgeMissing(sourceId, username) {
    const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [sourceId]);
    if (!source) return null;
    const rows = await all('SELECT id FROM cameras WHERE source_id = ? AND source_missing_at IS NOT NULL', [sourceId]);
    const count = await deleteCameraRows(rows.map((r) => r.id));
    saveLog(username || 'unknown', 'Delete Camera', `ลบกล้องที่หายจาก edge ${source.remote_node || ''} "${source.label}" ${count} ตัว`);
    resyncStreamCore();
    return count;
  }

  /** ทบทวนกล้องของ edge แบบ pull — central ถาม edge เอง */
  async function resyncSource(source, { key } = {}) {
    const client = key ? new EdgeClient({ host: source.host, port: source.port, key }) : clientForSource(source);
    const h = await checkEdge(client);
    const available = await client.listCameras();
    // edge รุ่นก่อนไม่มี /cameras/deleted (404) — ถือว่าไม่มีบันทึกการลบ กล้องที่หายยังแค่ติดป้าย
    const deleted = await client.deletedCameras().catch(() => []);
    const result = await syncRows(source, h.node, available, (cam) => edgeFields(client, cam), deleted.map((d) => d.id));

    // รอบซิงก์อาจเพิ่มกล้องหลังสาย SSE เปิดแล้ว จึงต้องเติมสถานะเริ่มต้นและอัปเดต map ของสายนั้นด้วย
    if (cameraState) {
      const map = await refMapOf(source.id);
      const feed = feeds.get(source.id);
      if (feed) feed.map = map;
      for (const cam of available) {
        applyEdgeState({ map }, cam.id, cam.state
          ? { reachable: cam.state.reachable, enabled: cam.state.enabled }
          : { reachable: null });
      }
    }

    await run(
      `UPDATE camera_sources SET last_sync_at = ?, status = 'ok', status_at = ?, status_error = NULL,
              remote_node = ?, remote_build = ?, remote_role = ?, remote_region = ?, node_block = ?, remote_province = ?${key ? ', password_sealed = ?' : ''} WHERE id = ?`,
      [nowIso(), nowIso(), h.node, h.build || null, h.role, h.region || null, h.role === 'regional' ? h.node : null,
        h.role === 'edge' ? reportedProvince(h.province) : null, ...(key ? [seal(key)] : []), source.id],
    );
    if (!removedSources.has(source.id)) status.set(source.id, { reachable: true, node: h.node, build: h.build || null, at: Date.now() });
    return result;
  }

  /**
   * เพิ่ม edge หนึ่งตัว: ตรวจว่าเป็น edge จริง บันทึกเป็นแหล่งกล้อง แล้วรับกล้องทุกตัวของมันมาทันที
   * ที่อยู่เดิมซ้ำ = อัปเดต key/ชื่อ (ใช้ตอน edge ออก key ใหม่)
   */
  async function addEdge({ host, port, key, label, remark }, username) {
    const note = normaliseRemark(remark);
    if (!host || !key) throw new EdgeRequestError(400, 'ต้องมีที่อยู่ของ edge และ API key ที่ edge ออกให้');
    const apiPort = String(Number(port) || 5173);
    const id = sourceIdFor(host, apiPort);
    const client = new EdgeClient({ host, port: apiPort, key });
    const h = await checkEdge(client);
    // edge ตัวเดิมที่แอดไว้แล้วด้วยที่อยู่อื่น (หรือแบบ link) — แอดซ้ำจะได้กล้อง 0 ตัวเพราะ id/global ID ชนกับแถวเดิม
    const owner = await nodeOwnedElsewhere(h.node, id);
    if (owner) {
      throw new EdgeRequestError(409, `edge ${h.node} ถูกเพิ่มไว้แล้วเป็น "${owner.label}"${owner.host ? ` (${owner.host}:${owner.port})` : ' (link)'} — ถอดของเดิมออกก่อน`);
    }
    const regionOwner = await regionOwnedElsewhere(h.role, h.region, id);
    if (regionOwner) throw new EdgeRequestError(409, `ภาค ${h.region} มี Regional "${regionOwner.label}" แล้ว`);
    removedSources.delete(id);
    await run(
      `INSERT INTO camera_sources (id, kind, label, host, port, rtsp_port, username, password_sealed, created_at, last_sync_at,
                                   status, status_at, remote_node, remote_build, remote_role, remote_region, node_block)
       VALUES (?,?,?,?,?,NULL,NULL,?,?,?,'ok',?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label=excluded.label, password_sealed=excluded.password_sealed,
         status='ok', status_at=excluded.status_at, remote_node=excluded.remote_node, remote_build=excluded.remote_build,
         remote_role=excluded.remote_role, remote_region=excluded.remote_region, node_block=excluded.node_block`,
      [id, 'edge', label || `${h.role} ${h.node}`, host, apiPort, seal(key), nowIso(), nowIso(), nowIso(), h.node, h.build || null, h.role, h.region || null, h.role === 'regional' ? h.node : null],
    );
    await run('UPDATE camera_sources SET remark = ? WHERE id = ?', [note, id]);
    const source = await get('SELECT * FROM camera_sources WHERE id = ?', [id]);
    const result = await resyncSource(source);
    saveLog(username || 'unknown', 'Add Edge', `เพิ่ม edge ${h.node} (${host}:${apiPort}) — รับกล้อง ${result.imported} ตัว`);
    return { id, node: h.node, build: h.build || null, ...result };
  }

  /*
    ─── edge แบบ link (docs/EDGE-PLAN.md เฟส 4) ─────────────────────────────────────────────

    edge ที่ central ต่อเข้าไปไม่ถึง (หลัง NAT) ต่อ WebSocket ขึ้นมาหาเราเอง (vms/edge-link-server.js)
    แถว camera_sources ของมันมี mode = 'link', ไม่มี host/port และยืนยันตัวด้วย token ที่เราออกให้
    (เก็บเฉพาะ hash) · รายการกล้องและสถานะมาทางสายนั้น · ภาพ: edge push RTSP เข้าสตรีม `<ชื่อ>_in`
    ของ go2rtc เราเมื่อมีคนเปิดดู (ensureLinkStream) และหยุดเมื่อไม่มีคนดูเกิน 60 วิ (reapLinkStreams)
  */
  const links = new Map(); // source id → { rpc(method, params), close(reason), node, build }
  // สถานะอัปเดตที่ edge แบบ link รายงานมา (update_status) + แพลตฟอร์ม/ตัวคุมจาก hello — อยู่ในหน่วยความจำ
  // edge ส่งซ้ำทุกครั้งที่ต่อสาย จึงไม่ต้องเก็บลง DB
  const updateInfo = new Map(); // source id → { platform, runner, state, build, error, at }
  const setUpdateStatus = (sourceId, s) => {
    const prev = updateInfo.get(sourceId) || {};
    updateInfo.set(sourceId, {
      ...prev,
      state: s.state ? String(s.state).slice(0, 20) : prev.state || null,
      build: s.build ? String(s.build).slice(0, 40) : null,
      error: s.error ? String(s.error).slice(0, 300) : null,
      retryable: s.retryable === true,
      retryAt: s.retryAt ? String(s.retryAt).slice(0, 40) : null,
      at: nowIso(),
    });
  };
  const LINK_IDLE_MS = 60_000;
  const linkIdleSince = new Map(); // ชื่อสตรีม _in → เวลาที่เริ่มไม่มีผู้ดู
  const openLinkStreams = new Map(); // ชื่อสตรีม _in → { sourceId, cameraId, which }

  const hashLinkToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
  const streamBase = (id) => String(id || '').toLowerCase().replace(/\s+/g, '_');
  const linkInName = (centralId, which) => `${streamBase(centralId)}${which === 'sub' ? '_sub' : ''}_in`;
  /** ที่อยู่ loopback ให้ go2rtc ของเราดึงจากสตรีมรับ push — go2rtc-sync.js สร้างสตรีม _in จากรูปแบบนี้ */
  const linkLoopback = (centralId, which) =>
    withRtspCredentials(`rtsp://127.0.0.1:${GO2RTC_RTSP_PORT}/${linkInName(centralId, which)}`);

  /** link: สตรีมทุกเส้นวนผ่าน go2rtc ของเราเอง — ไม่มีที่อยู่ของ edge เลย */
  const linkFields = (node, cam) => {
    const id = cameraIdFor(node, cam.id);
    const hasStream = cam.hasStream !== false;
    return {
      ...baseFields(cam),
      rtsp: hasStream ? linkLoopback(id, 'main') : null,
      rtspSub: hasStream && cam.hasSub ? linkLoopback(id, 'sub') : null,
    };
  };

  /** เลข node ถัดไปในบล็อกที่ role นี้ออกให้ได้ */
  async function nextFreeNode(targetRole = ROLE === 'central' ? 'regional' : 'edge') {
    if (targetRole !== (ROLE === 'central' ? 'regional' : 'edge')) {
      throw Object.assign(new Error(`${ROLE} ออกเลขให้ ${ROLE === 'central' ? 'Regional' : 'Edge'} เท่านั้น`), { status: 400 });
    }
    const rows = await all("SELECT remote_node FROM camera_sources WHERE kind = 'edge' AND remote_node IS NOT NULL").catch(() => []);
    const used = new Set(rows.map((r) => String(r.remote_node)).concat(NODE_NUMBER));
    if (ROLE === 'central' && targetRole === 'regional') {
      for (let n = 100; n <= 600; n += 100) {
        const s = String(n);
        if (!used.has(s)) return s;
      }
      return null;
    }
    const first = Number(NODE_NUMBER) + 1;
    const last = Number(NODE_NUMBER) + 99;
    for (let n = first; n <= last; n += 1) {
      const s = String(n).padStart(3, '0');
      if (!used.has(s)) return s;
    }
    return null;
  }

  /**
   * ออก token ให้ edge ใหม่แบบ link — คืน token ครั้งเดียว เก็บแค่ hash
   * ระบุ node = จองเลขนั้นไว้ในแถวนี้ทันที (linkUp กันเลขซ้ำจาก remote_node ของแถวอื่น) ให้ไฟล์ edge.json
   * ที่ดาวน์โหลดไปติดตั้งมีเลขที่แน่นอนว่าไม่ชน
   */
  async function createLinkEdge({ label, node, role = ROLE === 'central' ? 'regional' : 'edge', region, remark } = {}, username) {
    const note = normaliseRemark(remark);
    if (role !== (ROLE === 'central' ? 'regional' : 'edge')) {
      throw Object.assign(new Error(`${ROLE} ออก token ให้ ${ROLE === 'central' ? 'Regional' : 'Edge'} เท่านั้น`), { status: 400 });
    }
    if (role === 'regional' && !REGION_CODES.includes(region)) {
      throw Object.assign(new Error('ต้องระบุภาคของ Regional'), { status: 400 });
    }
    if (role === 'regional') {
      const owner = await regionOwnedElsewhere(role, region, null);
      if (owner) throw Object.assign(new Error(`ภาค ${region} มี Regional "${owner.label}" แล้ว`), { status: 409 });
    }
    let reserved = null;
    if (node !== undefined && node !== null && String(node).trim() !== '') {
      reserved = String(node).trim();
      if (!/^\d{3}$/.test(reserved) || reserved === NODE_NUMBER) throw Object.assign(new Error(`เลข edge ${reserved} ใช้ไม่ได้ — ต้องเป็นเลข 3 หลักและไม่ใช่ ${NODE_NUMBER}`), { status: 400 });
      if (ROLE === 'regional' && (Number(reserved) <= Number(NODE_NUMBER) || Number(reserved) >= Number(NODE_NUMBER) + 100)) {
        throw Object.assign(new Error(`เลข edge ${reserved} อยู่นอกบล็อกของ regional ${NODE_NUMBER}`), { status: 400 });
      }
      if (ROLE === 'central' && !/^[1-6]00$/.test(reserved)) {
        throw Object.assign(new Error(`เลข ${reserved} ไม่อยู่ในช่วงของ ${role}`), { status: 400 });
      }
      const other = await get("SELECT label FROM camera_sources WHERE kind = 'edge' AND remote_node = ?", [reserved]).catch(() => null);
      if (other) throw Object.assign(new Error(`เลข edge ${reserved} ถูกใช้โดย "${other.label}" แล้ว`), { status: 409 });
    }
    const token = `ntlink_${crypto.randomBytes(24).toString('hex')}`;
    const id = `vms_edge_link_${crypto.randomBytes(4).toString('hex')}`;
    const name = String(label || '').trim() || `${role === 'regional' ? 'Regional' : 'Edge'} (link)`;
    await run(
      `INSERT INTO camera_sources (id, kind, label, host, port, created_at, mode, link_token_hash, status, status_at, remote_node, remote_role, remote_region, node_block, remark)
       VALUES (?, 'edge', ?, NULL, NULL, ?, 'link', ?, 'unreachable', ?, ?, ?, ?, ?, ?)`,
      [id, name, nowIso(), hashLinkToken(token), nowIso(), reserved, role, role === 'regional' ? region : null, role === 'regional' ? reserved : null, note],
    );
    saveLog(username || 'unknown', 'Add Edge', `ออก token ให้ ${role} แบบต่อขึ้นเอง "${name}"${reserved ? ` (จองเลข ${reserved})` : ''}`);
    return { id, token, node: reserved, role, region: role === 'regional' ? region : null, remark: note };
  }

  /** หาแถว edge จาก token ที่ edge ส่งมา — null = ไม่รู้จัก */
  const findLinkSource = (token) => (token
    ? get("SELECT * FROM camera_sources WHERE kind = 'edge' AND mode = 'link' AND link_token_hash = ?", [hashLinkToken(token)]).catch(() => null)
    : Promise.resolve(null));

  /** edge ส่ง hello มา — ตรวจเลขเครื่องแล้วบันทึกว่าต่ออยู่ คืนข้อความ error ถ้าไม่รับ */
  async function linkUp(source, { node, role = 'edge', region, protocol, build, via, remote, platform, runner, province }, link) {
    if (role !== (ROLE === 'central' ? 'regional' : 'edge')) {
      return `${ROLE} รับสายจาก ${role} ไม่ได้`;
    }
    if (role === 'regional' && protocol !== 2) return 'Regional ต้องใช้โปรโตคอล link รุ่น 2';
    if (Number(protocol || 1) > 2) return `โปรโตคอล link รุ่น ${protocol} ใหม่กว่าเครื่องนี้`;
    if (source.remote_role && source.remote_role !== role) return `token นี้ออกให้ ${source.remote_role} ไม่ใช่ ${role}`;
    if (source.remote_region && source.remote_region !== region) return `token นี้ออกให้ภาค ${source.remote_region}`;
    const n = String(node || '').replace(/\D/g, '').padStart(3, '0').slice(-3);
    if (!n || n === NODE_NUMBER) return `เลขเครื่อง ${n || '-'} ใช้ไม่ได้ (ซ้ำกับ central หรือว่าง)`;
    if (ROLE === 'regional' && (Number(n) <= Number(NODE_NUMBER) || Number(n) >= Number(NODE_NUMBER) + 100)) {
      return `เลข edge ${n} อยู่นอกบล็อก ${NODE_NUMBER}–${String(Number(NODE_NUMBER) + 99).padStart(3, '0')}`;
    }
    if (role === 'regional') {
      if (!REGION_CODES.includes(region) || !/^[1-6]00$/.test(n)) return 'Regional ต้องส่ง region และเลขต้นบล็อก';
      const sameRegion = await get("SELECT id FROM camera_sources WHERE kind='edge' AND remote_role='regional' AND remote_region=? AND id!=?", [region, source.id]).catch(() => null);
      if (sameRegion) return `ภาค ${region} มี Regional อยู่แล้ว`;
    }
    if (source.remote_node && source.remote_node !== n) return `token นี้จองเลข ${source.remote_node} ไม่ใช่ ${n}`;
    const other = await get("SELECT id FROM camera_sources WHERE kind = 'edge' AND remote_node = ? AND id != ?", [n, source.id]).catch(() => null);
    if (other) return `เลขเครื่อง ${n} ถูกใช้โดย edge อื่นแล้ว — global ID จะชนกัน`;
    const previous = links.get(source.id);
    links.set(source.id, { ...link, node: n, build: build || null });
    // edge ต่อซ้ำด้วย token เดิม (สายเก่ายังไม่ถูกตัด) — ปิดสายเก่า ให้เหลือสายเดียว
    if (previous && previous.close !== link.close) previous.close?.('มีสายใหม่จาก edge เดียวกัน');
    status.set(source.id, { reachable: true, node: n, build: build || null, at: Date.now() });
    updateInfo.set(source.id, { ...(updateInfo.get(source.id) || {}),
      platform: platform ? String(platform).slice(0, 20) : null, runner: runner ? String(runner).slice(0, 20) : null });
    // via = ที่อยู่ของ central ที่ edge ใช้ต่อ, remote = IP ที่สายมาถึงจริง — ให้ผู้ดูแลเห็นว่าแต่ละ edge มาทางไหน
    const viaText = via ? String(via).replace(/[?].*$/, '').slice(0, 200) : null;
    const remoteText = remote ? String(remote).replace(/^::ffff:/, '').slice(0, 64) : null;
    // บันทึกลง DB ไม่ได้ (ล็อก/ดิสก์) ไม่ใช่เหตุให้ปฏิเสธสาย — สถานะในหน่วยความจำตั้งไปแล้ว รอบหน้าเขียนใหม่
    await run(`UPDATE camera_sources SET status='ok', status_at=?, status_error=NULL, remote_node=?, remote_build=?, remote_role=?, remote_region=?, node_block=?,
                                        link_via=?, link_remote=?, remote_province=? WHERE id=?`,
      [nowIso(), n, build || null, role, role === 'regional' ? region : null, role === 'regional' ? n : null, viaText, remoteText,
        role === 'edge' ? reportedProvince(province) : null, source.id])
      .catch((err) => console.warn(`[Edge link] ${source.label}: บันทึกสถานะสายลง DB ไม่ได้ — ${err.message}`));
    console.log(`[Edge link] ${source.label}: edge ${n} ต่อเข้ามาแล้ว (build ${build || '?'}${viaText ? ` ผ่าน ${viaText}` : ''}${remoteText ? ` จาก ${remoteText}` : ''})`);
    if (ROLE === 'regional' && role === 'edge' && isOutsideRegion(reportedProvince(province))) {
      console.warn(`[Edge link] ${source.label}: edge ${n} ตั้งจังหวัด ${reportedProvince(province)} นอกภาค ${REGION} — รับสายแต่แจ้งเตือน`);
    }
    // ไล่ตาม event หลังส่ง welcome แล้ว — edge ตอบ rpc ได้เมื่อรู้ว่าสายพร้อม
    setTimeout(() => syncAiEvents(source.id), 2000).unref?.();
    return null;
  }

  /** สายของ edge ขาด — ถือว่าติดต่อไม่ได้ กล้องกลับเป็นไม่รู้สถานะ · link = สายที่ขาด (กันสายเก่าลบสายใหม่) */
  async function linkDown(sourceId, link, reason) {
    const current = links.get(sourceId);
    if (!current || current.close !== link?.close) return;
    links.delete(sourceId);
    const prev = status.get(sourceId);
    status.set(sourceId, { reachable: false, node: prev?.node || null, build: prev?.build || null, at: Date.now(), error: reason });
    for (const [name, s] of openLinkStreams) if (s.sourceId === sourceId) openLinkStreams.delete(name);
    await markUnknown(sourceId);
    await run("UPDATE camera_sources SET status='unreachable', status_at=?, status_error=? WHERE id=?",
      [nowIso(), String(reason || 'สายขาด').slice(0, 300), sourceId]).catch(() => {});
    console.warn(`[Edge link] ${sourceId}: สายขาด — ${reason || ''}`);
  }

  /** รายการกล้องที่ edge ส่งขึ้นมา — เขียนแถวแบบเดียวกับ pull แล้วใช้สถานะที่ติดมาด้วย */
  async function linkCatalog(source, cameras, deleted) {
    const link = links.get(source.id);
    if (!link) return null;
    if (removedSources.has(source.id)) return null; // edge ถูกถอดระหว่างทาง — ห้ามใส่แถวกลับ
    const list = Array.isArray(cameras) ? cameras : [];
    const result = await syncRows(source, link.node, list, async (cam) => linkFields(link.node, cam), deleted);
    await run('UPDATE camera_sources SET last_sync_at = ? WHERE id = ?', [nowIso(), source.id]);
    if (cameraState) {
      const map = await refMapOf(source.id);
      /*
        ระหว่าง await ข้างบน สายอาจขาด (linkDown ตั้งกล้องเป็น "ไม่รู้" ไปแล้ว) หรือมีสายใหม่มาแทน — ถ้าเขียนสถานะ
        จากรายการเก่าตอนนี้ กล้องจะค้างเป็น "ออนไลน์" ทั้งที่ edge หลุด · สายไม่ใช่เส้นเดิม = ข้าม
      */
      if (links.get(source.id) !== link) {
        if (!links.has(source.id)) await markUnknown(source.id);
        return result;
      }
      for (const cam of list) {
        applyEdgeState({ map }, cam.id, cam.state
          ? { reachable: cam.state.reachable, enabled: cam.state.enabled }
          : { reachable: null });
      }
    }
    return result;
  }

  /** สถานะกล้องหนึ่งตัวที่ edge แจ้งมาทาง link */
  async function linkState(sourceId, ev) {
    if (!cameraState) return;
    const map = await refMapOf(sourceId);
    applyEdgeState({ map }, ev.cameraId, { reachable: ev.reachable, enabled: ev.enabled });
  }

  /** go2rtc มีผู้ push อยู่ในสตรีม _in นี้ไหม */
  async function linkStreamActive(name) {
    try {
      const live = await resolveCore().listStreams();
      return Boolean(live.get(name)?.active);
    } catch {
      return false;
    }
  }

  /**
   * ให้แน่ใจว่าภาพของกล้อง link กำลังถูก push เข้ามา — เรียกก่อนเปิดดู (/stream, stream/start,
   * /api/v1/.../streams, snapshot) · กล้องที่ไม่ใช่ link คืน false ทันที ไม่ทำอะไร
   * รอจน go2rtc เห็นผู้ push (สูงสุด 8 วิ) ถ้ายังไม่มา ผู้เล่นได้จอดำแล้ว retry เอง
   */
  async function ensureLinkStream(row, which = 'main') {
    if (!row || row.type !== EDGE_TYPE || !row.source_id) return false;
    const link = links.get(row.source_id);
    if (!link) {
      const source = await get('SELECT mode FROM camera_sources WHERE id = ?', [row.source_id]).catch(() => null);
      if (source?.mode === 'link') throw new EdgeUnavailable('edge ของกล้องนี้ไม่ได้ต่อสายอยู่');
      return false;
    }
    const w = which === 'sub' && row.rtsp_sub ? 'sub' : 'main';
    const name = linkInName(row.id, w);
    linkIdleSince.delete(name);
    if (await linkStreamActive(name)) return true;
    const creds = rtspCredentials();
    await link.rpc('stream.open', {
      cameraId: row.source_ref,
      which: w,
      dst: { port: GO2RTC_RTSP_PORT, path: name, username: creds?.username || null, password: creds?.password || null },
    }, { timeoutMs: ROLE === 'central' ? 25_000 : 12_000 });
    openLinkStreams.set(name, { sourceId: row.source_id, cameraId: row.source_ref, which: w });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await linkStreamActive(name)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** ชั้นบนเลิกดูหลังรอ idle แล้ว: ปิดชั้นล่างต่อเมื่อ go2rtc ยืนยันว่าไม่มีผู้ชมในภาค */
  async function releaseLinkStream(row, which = 'main') {
    if (!row || row.type !== EDGE_TYPE) return;
    const w = which === 'sub' && row.rtsp_sub ? 'sub' : 'main';
    const name = linkInName(row.id, w);
    const stream = openLinkStreams.get(name);
    if (!stream) return;
    const live = await resolveCore().listStreams();
    if ((live.get(name)?.readers || 0) > 0) return; // ผู้ชมในภาคยังดูอยู่
    openLinkStreams.delete(name);
    linkIdleSince.delete(name);
    const link = links.get(stream.sourceId);
    if (link) await link.rpc('stream.close', { cameraId: stream.cameraId, which: stream.which });
  }

  /** หยุด push ของสตรีมที่ไม่มีคนดูเกิน 60 วิ — ไม่งั้นภาพข้ามไซต์วิ่งค้างตลอดไป */
  async function reapLinkStreams() {
    if (!openLinkStreams.size) return;
    let live;
    try { live = await resolveCore().listStreams(); } catch { return; }
    for (const [name, s] of openLinkStreams) {
      const readers = live.get(name)?.readers || 0;
      if (readers > 0) { linkIdleSince.delete(name); continue; }
      const since = linkIdleSince.get(name) || Date.now();
      linkIdleSince.set(name, since);
      if (Date.now() - since < LINK_IDLE_MS) continue;
      openLinkStreams.delete(name);
      linkIdleSince.delete(name);
      const link = links.get(s.sourceId);
      if (link) link.rpc('stream.close', { cameraId: s.cameraId, which: s.which }).catch(() => {});
    }
  }
  const reaper = setInterval(() => reapLinkStreams().catch(() => {}), 20_000);
  reaper.unref?.();

  // ภาพย้อนหลังของ edge แบบ link — edge อัปโหลดขึ้นมาที่ /api/edge-link/playback/:session (route ใน server.js)
  const linkPlayback = require('./link-playback').createLinkPlayback(
    { findLinkSource: (token) => findLinkSource(token) },
    { waitMs: ROLE === 'central' ? 100_000 : 45_000 },
  );

  /** ตัวส่งคำสั่ง PTZ ผ่านสาย link — หน้าตาเดียวกับ EdgeClient ที่ ptz.js ใช้ */
  const linkClient = (sourceId) => {
    const call = (method, params, opts) => {
      const link = links.get(sourceId);
      if (!link) return Promise.reject(new EdgeUnavailable('edge ของกล้องนี้ไม่ได้ต่อสายอยู่'));
      return link.rpc(method, params, opts);
    };
    // คำสั่งที่ edge ต้องไปถามเครื่องบันทึก (ONVIF Profile G ค้นหลายรอบ) ใช้เวลาเกิน rpc ปกติ 10 วิ
    const DEVICE_RPC = { timeoutMs: ROLE === 'central' ? RECORDER_TIMEOUT_MS * 2 + 10_000 : RECORDER_TIMEOUT_MS };
    return {
      ptzInfo: (cameraId) => call('ptz.info', { cameraId }),
      listNodes: () => call('nodes.list', {}),
      ptz: (cameraId, command) => call('ptz.cmd', { cameraId, command }),
      aiEvents: (since, limit) => call('ai.since', { since, limit }),
      aiSnapshot: async (seq) => {
        const b64 = (await call('ai.snapshot', { seq }))?.jpeg;
        return b64 ? Buffer.from(b64, 'base64') : null;
      },
      // ภาพบันทึก: รายการช่วงเวลาและภาพนิ่งวิ่งบนสาย · ตัววิดีโอ edge อัปโหลดขึ้นมาทาง HTTP (vms/link-playback.js)
      recordings: (cameraId, range) => call('recording.list', { cameraId, ...range }, DEVICE_RPC),
      playback: (cameraId, q, res) => {
        const link = links.get(sourceId);
        if (!link) return Promise.reject(new EdgeUnavailable('edge ของกล้องนี้ไม่ได้ต่อสายอยู่'));
        return linkPlayback.play(sourceId, link, cameraId, q, res);
      },
      frame: async (cameraId, at) => Buffer.from((await call('recording.frame', { cameraId, at }, DEVICE_RPC))?.jpeg || '', 'base64'),
      link: true,
    };
  };

  /*
    ─── ที่อยู่ของ central (Central endpoints) ─────────────────────────────────────────────
    central ถูกเข้าถึงได้หลายเส้นทาง (LAN, VPN/MPLS ของแต่ละหน่วยงาน, IP ที่ NAT มา — พอร์ตภายนอกอาจไม่ใช่
    5173/8555) edge แต่ละแห่งเห็นคนละที่อยู่ ผู้ดูแลบันทึกไว้ที่นี่ แล้วหน้า Edge Nodes สร้างคำสั่งตั้ง edge
    ให้ลองตามลำดับ · เดิมหน้าเว็บใช้ที่อยู่ของเบราว์เซอร์ ซึ่ง edge ข้ามวงเข้าไม่ถึง (พบกับ edge 002, 2026-09-23)
  */
  const ENDPOINTS_KEY = 'CENTRAL_ENDPOINTS';
  const validPort = (v, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
  };

  async function readEndpoints() {
    const row = await get('SELECT setting_value FROM settings WHERE setting_key = ?', [ENDPOINTS_KEY]).catch(() => null);
    try {
      const list = JSON.parse(row?.setting_value || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async function saveEndpoints(list) {
    if (!Array.isArray(list)) throw new Error('ต้องส่ง endpoints เป็นรายการ');
    if (list.length > 50) throw new Error('ที่อยู่เกิน 50 รายการ');
    const clean = list.map((e, i) => {
      const host = String(e?.host || '').trim();
      if (!host || !/^[\w.:[\]-]+$/.test(host)) throw new Error(`รายการที่ ${i + 1}: host ไม่ถูกต้อง`);
      if (e?.port !== undefined && e.port !== '' && !validPort(e.port, null)) throw new Error(`รายการที่ ${i + 1}: พอร์ตต้องเป็น 1–65535`);
      if (e?.rtspPort !== undefined && e.rtspPort !== '' && !validPort(e.rtspPort, null)) throw new Error(`รายการที่ ${i + 1}: พอร์ต RTSP ต้องเป็น 1–65535`);
      return {
        label: String(e?.label || '').trim().slice(0, 40) || host,
        host,
        port: validPort(e?.port, HTTP_PORT),
        rtspPort: validPort(e?.rtspPort, GO2RTC_RTSP_PORT),
      };
    });
    await run(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
      [ENDPOINTS_KEY, JSON.stringify(clean)],
    );
    return clean;
  }

  /** IPv4 ของเครื่องนี้ที่น่าจะเป็นทางเข้า — ช่วยกรอก ไม่ได้ใช้เอง (IP ที่ NAT มาเครื่องนี้ไม่รู้) */
  function suggestEndpoints() {
    const out = [];
    for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const [x, y] = a.address.split('.').map(Number);
        const tailscale = x === 100 && y >= 64 && y <= 127;
        const docker = /docker|br-|veth|wsl|hyper-v/i.test(name) || (x === 172 && y >= 17 && y <= 31);
        if (docker) continue;
        out.push({ label: tailscale ? 'Tailscale' : `LAN (${name})`, host: a.address, port: HTTP_PORT, rtspPort: GO2RTC_RTSP_PORT });
      }
    }
    return out;
  }

  /** รายการ edge พร้อมสถานะล่าสุด — ไม่มี key ออกไป */
  async function listEdges() {
    const rows = await all(
      `SELECT s.id, s.label, s.remark, s.host, s.port, s.created_at, s.last_sync_at, s.status, s.status_at, s.status_error,
              s.remote_node, s.remote_build, s.remote_role, s.remote_region, s.node_block, s.remote_province, COALESCE(s.mode, 'pull') AS mode, s.link_via, s.link_remote,
              (SELECT COUNT(*) FROM cameras c WHERE c.source_id = s.id) AS cameraCount,
              (SELECT COUNT(*) FROM cameras c WHERE c.source_id = s.id AND c.source_missing_at IS NOT NULL) AS missingCount
       FROM camera_sources s WHERE s.kind = 'edge' ORDER BY s.created_at`,
    );
    // Regional: นับกล้องจังหวัดนอกภาคต่อ edge ให้หน้า Edge Nodes เตือน (รับเข้าแล้ว ไม่ได้ปฏิเสธ)
    const outside = new Map();
    if (ROLE === 'regional') {
      const cams = await all("SELECT source_id, name, province_code FROM cameras WHERE province_code IS NOT NULL AND province_code != ''");
      for (const c of cams) {
        if (!isOutsideRegion(c.province_code)) continue;
        const o = outside.get(c.source_id) || { count: 0, names: [] };
        o.count += 1;
        if (o.names.length < 10) o.names.push(c.name);
        outside.set(c.source_id, o);
      }
    }
    return rows.map((r) => ({
      ...r,
      reachable: status.get(r.id)?.reachable ?? null,
      update: updateInfo.get(r.id) || null,
      // edge ตั้งจังหวัดของตัวเองนอกภาค — เตือนเหมือนกล้อง ไม่ปฏิเสธ (ไม่รู้จังหวัด = ไม่เตือน)
      edgeOutsideRegion: ROLE === 'regional' && r.remote_role === 'edge' && isOutsideRegion(r.remote_province),
      remoteProvinceName: r.remote_province ? lookupArea(r.remote_province)?.nameTh || null : null,
      outOfRegionCount: outside.get(r.id)?.count || 0,
      outOfRegionNames: outside.get(r.id)?.names || [],
    }));
  }

  /** ถอด edge ออก — ลบกล้องทุกแถวของมันที่ central (ของที่ edge ไม่ถูกแตะ) */
  async function removeEdge(id, username) {
    const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [id]);
    if (!source) return false;
    // ปิดทางเข้าก่อน: รอบซิงก์/สาย link ที่ค้างอยู่จะไม่ใส่กล้องกลับ (insertEdgeCamera, linkCatalog ดู removedSources)
    removedSources.add(id);
    stopFeed(id);
    const link = links.get(id);
    links.delete(id);
    link?.close?.('edge ถูกถอดออกจาก central');
    for (const [name, s] of openLinkStreams) if (s.sourceId === id) { openLinkStreams.delete(name); linkIdleSince.delete(name); }
    // ลบทางเดียวกับการลบกล้องปกติ — role_devices, สถานะในหน่วยความจำ, onCamerasRemoved (wall ฯลฯ)
    const ids = (await all('SELECT id FROM cameras WHERE source_id = ?', [id])).map((r) => r.id);
    let removed = await deleteCameraRows(ids);
    await run('DELETE FROM camera_sources WHERE id = ?', [id]);
    // แถวที่ INSERT ของรอบซิงก์ที่ผ่านด่านไปก่อนหน้าเพิ่งลงมา — กวาดอีกรอบ
    const late = (await all('SELECT id FROM cameras WHERE source_id = ?', [id]).catch(() => [])).map((r) => r.id);
    if (late.length) removed += await deleteCameraRows(late);
    status.delete(id);
    updateInfo.delete(id);
    lastAutoResync.delete(id);
    aiCursor.delete(id);
    saveLog(username || 'unknown', 'Remove Edge', `ถอด edge ${source.remote_node || ''} (${source.host ? `${source.host}:${source.port}` : 'link'}) และกล้อง ${removed} ตัวออกจาก central`);
    resyncStreamCore();
    return true;
  }

  /** เส้นทางของหน้า Edge Nodes (/api/edges) — ใช้สิทธิ์ device.manage เดียวกับการจัดการกล้อง */
  function createRouter({ requirePerm }) {
    const router = require('express').Router();
    router.use(requirePerm('device.manage'));
    router.get('/', async (req, res) => {
      try { res.json(await listEdges()); } catch (err) { res.status(500).json({ error: err.message }); }
    });
    // ที่อยู่ของ central ที่ edge ใช้ต่อได้ (แต่ละเส้นทาง) — ใช้สร้างคำสั่งตั้งค่า edge แบบ link
    router.get('/endpoints', async (req, res) => {
      try { res.json({ endpoints: await readEndpoints(), suggestions: suggestEndpoints() }); } catch (err) { res.status(500).json({ error: err.message }); }
    });
    router.put('/endpoints', async (req, res) => {
      try {
        const saved = await saveEndpoints(req.body?.endpoints);
        saveLog(req.user?.username || 'unknown', 'Central Endpoints', `ตั้งที่อยู่ของ central ${saved.length} รายการ: ${saved.map((e) => `${e.host}:${e.port}`).join(', ')}`);
        res.json({ endpoints: saved });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
    router.post('/', async (req, res) => {
      try { res.json(await addEdge(req.body || {}, req.user?.username)); } catch (err) { sendEdgeError(res, err); }
    });
    // edge แบบต่อขึ้นเอง: ออก token ให้ไปตั้งที่ edge (GATEWAY_CENTRAL_TOKEN) — แสดงครั้งเดียว
    router.post('/link', async (req, res) => {
      try { res.json(await createLinkEdge(req.body || {}, req.user?.username)); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    });
    router.get('/next-node', async (req, res) => {
      try { res.json({ node: await nextFreeNode(req.query.role) }); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    });
    // สั่ง edge แบบ link ติดตั้งแพ็กเกจที่โหลดไว้แล้ว (docs/EDGE-KIT.md ข้อ 5) — edge ถอยกลับเองถ้ารุ่นใหม่ต่อ central ไม่ติด
    router.post('/:id/update/retry', requirePerm('device.manage'), async (req, res) => {
      const link = links.get(req.params.id);
      if (!link) return res.status(502).json({ error: 'เครื่องนี้ไม่ได้ต่อสายอยู่' });
      try { res.status(202).json(await link.rpc('update.retry', {})); }
      catch (err) { sendEdgeError(res, err); }
    });
    router.get('/:id/children', async (req, res) => {
      const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [req.params.id]);
      if (!source || source.remote_role !== 'regional') return res.status(404).json({ error: 'ไม่พบ Regional นี้' });
      try {
        const children = source.mode === 'link'
          ? await linkClient(source.id).listNodes()
          : (await clientForSource(source).health()).edges || [];
        res.json({ children });
      } catch (err) { sendEdgeError(res, err); }
    });
    router.post('/:id/update', requirePerm('device.manage'), async (req, res) => {
      const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [req.params.id]).catch(() => null);
      if (!source) return res.status(404).json({ error: 'ไม่พบ edge นี้' });
      const link = links.get(source.id);
      if (!link) return res.status(502).json({ error: 'edge นี้ไม่ได้ต่อสายอยู่ — อัปเดตผ่านสายได้เฉพาะ edge แบบต่อขึ้นมาเอง' });
      try {
        const r = await link.rpc('update.apply', { by: req.user?.username || null });
        setUpdateStatus(source.id, { state: 'installing', build: r?.build });
        saveLog(req.user?.username || 'unknown', 'Edge Update', `สั่ง edge ${source.remote_node || ''} "${source.label}" ติดตั้งเวอร์ชัน ${r?.build || '?'}`);
        res.json({ success: true, build: r?.build || null });
      } catch (err) {
        sendEdgeError(res, err);
      }
    });
    router.post('/:id/resync', async (req, res) => {
      const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [req.params.id]).catch(() => null);
      if (!source) return res.status(404).json({ error: 'ไม่พบ edge นี้' });
      if (source.mode === 'link') {
        // link: edge ส่งรายการขึ้นมาเองทุกครั้งที่ต่อและทุก 5 นาที — ขอให้ส่งใหม่ทันที
        const link = links.get(source.id);
        if (!link) return res.status(502).json({ error: 'edge นี้ไม่ได้ต่อสายอยู่' });
        return link.rpc('catalog.push', {}).then(() => res.json({ success: true, requested: true })).catch((err) => sendEdgeError(res, err));
      }
      return resync(req, res, source);
    });
    // ลบกล้องของ edge นี้ที่หายจาก edge แล้ว (ไม่มีบันทึกการลบจาก edge — เช่น ลบก่อนมีระบบบันทึก หรือ DB ของ edge ถูกล้าง)
    router.delete('/:id/missing', async (req, res) => {
      try {
        const count = await purgeMissing(req.params.id, req.user?.username);
        if (count === null) return res.status(404).json({ error: 'ไม่พบ edge นี้' });
        res.json({ success: true, removed: count });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    router.delete('/:id', async (req, res) => {
      try {
        if (!(await removeEdge(req.params.id, req.user?.username))) return res.status(404).json({ error: 'ไม่พบ edge นี้' });
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    return router;
  }

  async function resync(req, res, source) {
    try {
      const result = await resyncSource(source, { key: req.body?.key || req.body?.pass });
      saveLog(req.user?.username || 'unknown', 'Edge Re-sync',
        `ทบทวน edge ${source.host}: ในระบบ ${result.imported} ตัว, รับใหม่ ${result.added} ตัว, หายจาก edge ${result.missing.length} ตัว`);
      res.json(result);
    } catch (err) {
      sendEdgeError(res, err);
    }
  }

  /**
   * เฝ้า edge ทุกตัวทุก 60 วินาที
   *
   * นี่คือสิ่งที่ทำให้แยก "edge หาย" ออกจาก "กล้องเสีย" ได้: ตอน edge ตอบไม่ได้ กล้องทุกตัวของมัน
   * ขึ้นเป็นไม่ทราบสถานะใน /api/v1 แทนที่จะดูเหมือนกล้องดับพร้อมกันทั้งจังหวัด
   */
  let timer = null;
  const lastAutoResync = new Map();
  async function checkAll() {
    // edge แบบ link ไม่มีที่อยู่ให้ถาม — สถานะมาจากสาย WebSocket (linkUp/linkDown)
    const sources = await all("SELECT * FROM camera_sources WHERE kind = 'edge' AND COALESCE(mode, 'pull') != 'link'").catch(() => []);
    for (const source of sources) {
      const prev = status.get(source.id);
      try {
        const h = await checkEdge(clientForSource(source));
        status.set(source.id, { reachable: true, node: h.node, build: h.build || null, at: Date.now() });
        if (prev && !prev.reachable) console.log(`[Edge] ${source.label}: กลับมาติดต่อได้แล้ว`);
        ensureFeed(source.id);
        await run("UPDATE camera_sources SET status='ok', status_at=?, status_error=NULL, remote_build=? WHERE id=?",
          [nowIso(), h.build || null, source.id]);

        if (Date.now() - (lastAutoResync.get(source.id) || 0) >= AUTO_RESYNC_EVERY_MS) {
          lastAutoResync.set(source.id, Date.now());
          await resyncSource(source).catch((err) => console.warn(`[Edge] ${source.label}: ทบทวนอัตโนมัติไม่สำเร็จ — ${err.message}`));
        }
      } catch (err) {
        status.set(source.id, { reachable: false, node: source.remote_node || null, build: source.remote_build || null, at: Date.now(), error: err.message });
        if (!prev || prev.reachable) console.warn(`[Edge] ${source.label}: ติดต่อไม่ได้ — ${err.message}`);
        markUnknown(source.id);
        await run("UPDATE camera_sources SET status='unreachable', status_at=?, status_error=? WHERE id=?",
          [nowIso(), String(err.message).slice(0, 300), source.id]).catch(() => {});
      }
    }
  }

  function startMonitor() {
    if (timer) return;
    setTimeout(() => checkAll().catch(() => {}), 5000);
    timer = setInterval(() => checkAll().catch(() => {}), HEALTH_EVERY_MS);
  }

  /** สถานะของ edge ที่กล้องแถวนี้มาจาก — null ถ้าไม่ใช่กล้องจาก edge */
  function originOf(row) {
    if (row.type !== EDGE_TYPE || !row.source_id) return null;
    const s = status.get(row.source_id);
    return {
      kind: 'edge',
      node: s?.node || null,
      // null = ยังไม่ได้ตรวจตั้งแต่ start ไม่ใช่ติดต่อไม่ได้
      reachable: s ? s.reachable : null,
      missingAtSource: Boolean(row.source_missing_at),
    };
  }

  /*
    ─── event ของ AI จาก edge (shared/ai-events.js, docs/EDGE-PLAN.md เฟส 5 ข้อ B) ───────────────────────
    central ไม่รับ event แบบเชื่อสายสด: สายสด (SSE ของ pull / ข้อความ ai_event ของ link) เป็นแค่สัญญาณให้ไปไล่ตาม
    ตัว event ดึงจาก edge ด้วยเคอร์เซอร์ remote_seq เสมอ — edge หลุดนานแค่ไหน กลับมาแล้วได้ครบ ไม่ซ้ำ ไม่ข้าม
    ไล่ตามตอน: สายต่อติด, มีสัญญาณ, และทุก 60 วิ (กันสัญญาณหาย) · ทีละ edge ไม่ซ้อนกัน
  */
  const aiSyncing = new Map(); // source id → { running, again }
  const aiUnsupported = new Set(); // edge รุ่นเก่าที่ยังไม่มี /ai/events — เตือนครั้งเดียว

  /*
    เคอร์เซอร์ในหน่วยความจำต่อ edge — เดินไปถึง seq สุดท้ายที่ดึงมาแม้ ingest ไม่รับแถวนั้น (เช่น origin 'camera' จาก edge
    รุ่นเก่า) ไม่งั้นหน้าเต็มไปด้วยแถวที่ข้ามจะถูกดึงซ้ำตลอดไปและไม่มีวันถึง event ใหม่ · restart แล้วเริ่มจาก MAX(remote_seq)
  */
  const aiCursor = new Map(); // source id → seq

  /**
   * DB ของ edge ถูกล้าง (หรือ edge ลบ event หมดแล้ว seq เริ่มใหม่): seq ใหม่ของ edge จะต่ำกว่าเคอร์เซอร์ของเรา
   * และชน unique (source_id, remote_seq) ของแถวเก่า = หายเงียบ · ตรวจโดยขอตั้งแต่ cursor-1 ถ้า edge ไม่มีแถวใด ≥ cursor
   * เลย แปลว่า seq สูงสุดของ edge ต่ำกว่าเรา → ปลด remote_seq ของแถวเก่า (ประวัติยังอยู่ ค้นได้เหมือนเดิม) แล้วเริ่มจาก 0
   * คืนเคอร์เซอร์ที่ควรใช้
   */
  async function checkAiReset(source, client, cursor) {
    if (cursor <= 0) return cursor;
    const probe = (await client.aiEvents(cursor - 1, 1))?.events || [];
    if (probe.length && Number(probe[0].seq) >= cursor) return cursor;
    // ปลด remote_seq ของแถวเก่า — ตาราง ai_events เป็นของ shared/ai-events.js แต่ลบ/แก้ต้องทำที่นี่เพื่อให้ seq ใหม่ไม่ชน
    await run('UPDATE ai_events SET remote_seq = NULL WHERE source_id = ?', [source.id]);
    console.warn(`[Edge] ${source.label}: seq ของ event AI ที่ edge ต่ำกว่าที่ central รับไว้ (${cursor}) — DB ของ edge น่าจะถูกล้าง เริ่มไล่ตามจาก 0 ใหม่`);
    return 0;
  }

  async function pullAiEvents(sourceId) {
    const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [sourceId]);
    if (!source || removedSources.has(sourceId)) return;
    if (source.mode === 'link' && !links.has(sourceId)) return;
    const client = source.mode === 'link' ? linkClient(source.id) : clientForSource(source);
    const map = await refMapOf(sourceId);
    let since = Math.max(aiCursor.get(sourceId) || 0, await aiEvents.lastRemoteSeq(sourceId));
    since = await checkAiReset(source, client, since);
    aiCursor.set(sourceId, since);
    for (let page = 0; page < 50; page += 1) {
      const list = (await client.aiEvents(since, 200))?.events || [];
      for (const ev of list) {
        const cameraId = map.get(ev.cameraId) || cameraIdFor(source.remote_node || '000', ev.cameraId);
        const snap = ev.hasSnapshot ? await client.aiSnapshot(ev.seq) : null;
        // ต้นทางประกาศว่ามีภาพ แต่โหลดไม่ได้: ไม่เดิน cursor ทิ้งภาพ รอรอบถัดไป
        if (ev.hasSnapshot && !snap) throw new EdgeUnavailable('ภาพประกอบ event ' + ev.seq + ' ยังไม่พร้อม');
        await aiEvents.ingest(sourceId, cameraId, ev, snap);
        // เดินเคอร์เซอร์ทีละแถวหลัง ingest สำเร็จหรือถูกข้าม — ingest โยน = หยุดตรงนี้ รอบหน้าเริ่มแถวเดิม
        const seq = Number(ev.seq);
        if (Number.isFinite(seq) && seq > since) {
          since = seq;
          aiCursor.set(sourceId, since);
        }
      }
      if (list.length < 200) break;
    }
  }

  function syncAiEvents(sourceId) {
    if (!aiEvents) return;
    const st = aiSyncing.get(sourceId) || { running: false, again: false };
    aiSyncing.set(sourceId, st);
    if (st.running) { st.again = true; return; }
    st.running = true;
    (async () => {
      do {
        st.again = false;
        try {
          await pullAiEvents(sourceId);
          aiUnsupported.delete(sourceId);
        } catch (err) {
          if (!aiUnsupported.has(sourceId)) console.warn(`[Edge] ${sourceId}: ดึง event ของ AI ไม่ได้ — ${err.message}`);
          aiUnsupported.add(sourceId);
        }
      } while (st.again);
    })().finally(() => { st.running = false; });
  }

  if (aiEvents) {
    const aiTimer = setInterval(() => {
      for (const [id, s] of status) if (s.reachable) syncAiEvents(id);
    }, 60_000);
    aiTimer.unref?.();
  }

  /** client ที่ใช้ส่งคำสั่งต่อไปยัง edge ของกล้องแถวหนึ่ง (PTZ, ภาพบันทึก) */
  async function clientForCamera(row) {
    const source = await get("SELECT * FROM camera_sources WHERE id = ? AND kind = 'edge'", [row.source_id]);
    if (!source) return null;
    if (source.mode === 'link') return linkClient(source.id);
    return clientForSource(source);
  }

  return {
    ensureSchema, probe, importCameras, resync, startMonitor, originOf, clientForCamera, createRouter, listEdges, EDGE_TYPE,
    findLinkSource, linkUp, linkDown, setUpdateStatus, linkCatalog, linkState, ensureLinkStream, releaseLinkStream, syncAiEvents,
    linkPlaybackUpload: linkPlayback.uploadHandler(),
  };
}

module.exports = { createEdgeSources, EDGE_TYPE, sendEdgeError };
