/**
 * ฝั่ง edge ของสาย link — edge ต่อ WebSocket ขาออกไปหา central เอง (docs/EDGE-PLAN.md เฟส 4)
 *
 * ใช้เมื่อ central ต่อเข้ามาหา edge ไม่ได้ (edge อยู่หลัง NAT ไม่มี port-forward) แต่ edge ออกไปหา
 * central ได้ เปิดด้วย env สองตัวใน ecosystem.edge.config.cjs:
 *   GATEWAY_CENTRAL_URL    ws://<central>:5173/api/edge-link
 *   GATEWAY_CENTRAL_TOKEN  token ที่ central ออกให้ในหน้า Edge Nodes ("เพิ่ม edge แบบต่อขึ้นเอง")
 *
 * หน้าที่บนสาย: ส่ง hello → รายการกล้อง (ตอนต่อ, ทุก 5 นาที, และเมื่อ central ขอ) → สถานะกล้องทันที
 * ที่เปลี่ยน → ตอบคำสั่ง PTZ และคำสั่งเปิด/ปิดภาพ
 *
 * ภาพ: central สั่ง stream.open แล้ว edge ให้ ffmpeg อ่านสตรีมจาก go2rtc ของตัวเอง (-c copy ไม่
 * transcode) แล้ว push RTSP ขึ้น go2rtc ของ central — go2rtc 1.9.14 push ออกเป็น rtsp:// เองไม่ได้
 * (ตอบ "unsupported scheme") จึงต้องใช้ ffmpeg · ปิดเมื่อ central สั่ง stream.close หรือสายขาด
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { NODE_NUMBER, BUILD, HTTP_PORT, GO2RTC_RTSP_PORT, ROLE, REGION } = require('../shared/instance');
const { withRtspCredentials } = require('../gateway/rtsp-auth');
const { resolveCore, streamPathName, rawStreamPathName, rawStreamsEnabled } = require('../gateway/streams');
const { publicState } = require('../shared/camera-state');
const { dispatchPtz, PtzError } = require('../gateway/ptz');
const { currentPlatform } = require('../shared/edge-update-manifest');

const HEARTBEAT_MS = 20_000;
const CATALOG_EVERY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60_000;
/** ไม่ได้ยินอะไรจาก central นานเกินนี้ = สายตาย (central ping ทุก 20 วิ · เราเองก็ ping ทุก DEAD_CHECK_MS) */
const SILENCE_LIMIT_MS = 70_000;
const DEAD_CHECK_MS = 15_000;

/**
 * เริ่มสาย link ถ้าตั้ง env ไว้ — ไม่ตั้ง = ไม่ทำอะไร (edge แบบ pull ปกติ)
 * @param {object} deps  db, cameraState, ptz (ตัวเดียวกับ /api/v1), getCameraRow, ffmpegPath, name,
 *                      updater (vms/edge-update-client.js — รับข้อเสนออัปเดตจาก central),
 *                      playbackSource (แหล่งภาพย้อนหลังที่ edge — gateway/playback.js · ตอนนี้ยังไม่มี = null),
 *                      aiEvents (shared/ai-events.js — แจ้ง central เมื่อมี event ใหม่ แล้ว central ขอไล่ตามผ่าน rpc)
 */
function startEdgeLink({ db, cameraState, ptz, getCameraRow, ffmpegPath, name, updater = null, listDeleted = null, playbackSource = null, aiEvents = null, ensureChildStream = null, releaseChildStream = null, updateMirror = null, listChildNodes = null }) {
  const NO_SOURCE = 'edge นี้ยังไม่มีแหล่งภาพย้อนหลัง';
  /*
    ที่อยู่ของ central ได้หลายอัน คั่นด้วย , — central ถูกเข้าถึงผ่านหลายเส้นทาง (LAN, VPN/MPLS ของหน่วยงาน,
    IP ที่ NAT มา) และ edge แต่ละแห่งเห็นคนละที่อยู่ จึงลองตามลำดับแล้วใช้อันที่ต่อติด
    ?rtsp=<พอร์ต> ต่อท้าย URL = พอร์ต RTSP ของ central ที่เห็นจากเส้นทางนั้น (NAT ที่แมปพอร์ตภายนอกต่างจาก 8555)
  */
  const token = String(process.env.GATEWAY_CENTRAL_TOKEN || '').trim();
  const endpoints = [];
  for (const raw of String(process.env.GATEWAY_CENTRAL_URL || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const u = new URL(raw);
      const rtsp = Number(u.searchParams.get('rtsp')) || null;
      endpoints.push({ url: raw, host: u.hostname, rtspPort: rtsp });
    } catch {
      console.error(`[Edge link] ข้ามที่อยู่ที่ไม่ใช่ URL: ${raw}`);
    }
  }
  if (!endpoints.length || !token) return null;
  let current = 0; // index ของที่อยู่ที่ใช้อยู่/จะลองต่อไป — ต่อติดแล้วรอบหน้าเริ่มจากอันนี้
  let failedInRow = 0; // ต่อไม่ติดติดกันกี่อัน — ครบทุกอันแล้วค่อยรอ backoff
  const allowPtz = String(process.env.GATEWAY_CENTRAL_ALLOW_PTZ ?? '1') !== '0';
  const core = resolveCore();

  let ws = null;
  let retryMs = 2000;
  let heartbeat = null;
  let catalogTimer = null;
  let unsubscribe = null;
  let unsubscribeAi = null;
  let warned = false;
  let stopped = false;
  const pushes = new Map(); // `${cameraId}:${which}` → { proc, stopped }

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  /** รายการกล้องในรูปที่ central ใช้ (ตรงกับฟิลด์ที่ edge-source.js baseFields อ่าน) — ไม่มีรหัสผ่านหรือ RTSP */
  async function catalog() {
    const rows = await all(
      `SELECT id, name, group_name, brand, lat, lng, enabled, global_id, province_code, district_code,
              CASE WHEN rtsp IS NOT NULL AND rtsp != '' THEN 1 ELSE 0 END AS has_stream
       FROM cameras`,
    );
    let live = new Map();
    try { live = await core.listStreams(); } catch { /* ไม่รู้ว่ามี sub ไหม — ถือว่าไม่มี */ }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      group: r.group_name || null,
      brand: r.brand || null,
      location: r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null,
      region: {
        province: r.province_code ? { code: r.province_code } : null,
        district: r.district_code ? { code: r.district_code } : null,
      },
      globalId: r.global_id || null,
      enabled: Number(r.enabled ?? 1) !== 0,
      hasStream: Boolean(r.has_stream),
      hasSub: live.has(streamPathName(r.id, 'sub')),
      state: publicState(cameraState.get(r.id)),
    }));
  }

  async function pushCatalog() {
    try {
      // deleted = id ของกล้องที่คนลบที่ edge (shared/camera-deletions.js) — central ลบตามเฉพาะตัวพวกนี้
      let deleted = [];
      if (listDeleted) {
        try { deleted = (await listDeleted()).map((d) => d.id); } catch { /* ไม่มีรายการ = central ไม่ลบอะไรเพิ่ม */ }
      }
      send({ type: 'catalog', cameras: await catalog(), deleted });
    } catch (err) {
      console.warn(`[Edge link] ส่งรายการกล้องไม่ได้: ${err.message}`);
    }
  }

  /** เริ่ม push ภาพกล้องหนึ่งเส้นขึ้น central — มีอยู่แล้วไม่เริ่มซ้ำ */
  function openPush(cameraId, which, dst) {
    const key = `${cameraId}:${which}`;
    if (pushes.has(key)) return;
    const local = rawStreamsEnabled() ? rawStreamPathName(cameraId, which) : streamPathName(cameraId, which);
    const input = withRtspCredentials(`rtsp://127.0.0.1:${GO2RTC_RTSP_PORT}/${local}`);
    const auth = dst.username ? `${encodeURIComponent(dst.username)}:${encodeURIComponent(dst.password || '')}@` : '';
    // push ไปที่ host ของเส้นทางที่ต่อติดอยู่ตอนนี้ — ไม่ใช่ host ที่ central คิดว่าตัวเองอยู่
    const via = endpoints[current];
    const port = via.rtspPort || Number(dst.port) || 8555;
    const output = `rtsp://${auth}${via.host}:${port}/${encodeURIComponent(dst.path)}`;
    const entry = { proc: null, stopped: false };
    pushes.set(key, entry);

    const run = () => {
      if (entry.stopped) return;
      const proc = spawn(String(ffmpegPath || 'ffmpeg').replace(/\\\\/g, '\\'), [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp', '-i', input,
        '-c', 'copy', '-an',
        '-f', 'rtsp', '-rtsp_transport', 'tcp', output,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      entry.proc = proc;
      let lastErr = '';
      proc.stderr.on('data', (d) => { lastErr = String(d).trim().split('\n').pop(); });
      /*
        ไม่มีตัวรับ 'error' = หา ffmpeg ไม่เจอ หรือ kill() ชน process ที่กำลังออก (EPERM บน Windows)
        แล้ว gateway ของ edge ล้มทั้งตัว (พบกับตัวบันทึกภาพ 2026-09-27) · 'error' อาจมาแทน 'exit' — ผ่านทางเดียวกันครั้งเดียว
      */
      let ended = false;
      const onEnd = (code) => {
        if (ended) return;
        ended = true;
        if (entry.proc === proc) entry.proc = null;
        if (entry.stopped) return;
        // ต้นทางสะดุด (กล้องหลุด, go2rtc รีสตาร์ต) — ลองใหม่จนกว่า central จะสั่งปิด
        console.warn(`[Edge link] push ${key} หยุด (code ${code})${lastErr ? `: ${lastErr}` : ''} — ลองใหม่ใน 3 วิ`);
        setTimeout(run, 3000);
      };
      proc.on('exit', onEnd);
      proc.on('error', (err) => { lastErr = err.message; onEnd(err.code || 'error'); });
    };
    run();
  }

  function closePush(cameraId, which) {
    const key = `${cameraId}:${which}`;
    const entry = pushes.get(key);
    if (!entry) return;
    entry.stopped = true;
    pushes.delete(key);
    try { entry.proc?.kill(); } catch { /* ออกไปแล้ว */ }
    // ชั้นบนรอ idle มาแล้ว: เมื่อ push ปิดและไม่มีผู้ชมในภาค ให้ปิดชั้นล่างต่อโดยไม่รออีก 60 วิ
    if (releaseChildStream) setTimeout(async () => {
      if (pushes.has(key)) return; // มีคนเปิดใหม่ระหว่างรอ go2rtc ปลด consumer
      try {
        const row = await getCameraRow(cameraId);
        await releaseChildStream(row, which);
      } catch { /* reaper ปกติจะเก็บกวาดต่อ */ }
    }, 5000).unref?.();
  }

  const closeAllPushes = () => {
    for (const key of [...pushes.keys()]) {
      const [cameraId, which] = key.split(':');
      closePush(cameraId, which);
    }
  };

  /**
   * ส่ง fMP4 ของภาพย้อนหลังขึ้น central ทาง HTTP POST (host/พอร์ตเดียวกับเส้นทางที่สายต่อติดอยู่, token ของสาย)
   * central ต่อท่อไปที่ผู้ชม · ผู้ชมปิดหรือสายหลุด = คำขอขาด → ปิด ffmpeg ทันที
   */
  function uploadPlayback(sessionId, pb) {
    const u = new URL(endpoints[current].url);
    const secure = u.protocol === 'wss:';
    const req = (secure ? https : http).request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: `/api/edge-link/playback/${encodeURIComponent(sessionId)}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4', 'X-Playback-Start': pb.startIso },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 400) pb.kill();
    });
    require('../shared/playback-transfer').transferPlayback(pb, req, {
      fail: () => req.destroy(),
    });
  }

  /** ทำคำสั่งจาก central — คืนค่า data หรือโยน error (มี status ถ้าเป็นความผิดของคำขอ) */
  async function handleRpc(method, params = {}) {
    const cameraRow = async () => {
      const row = params.cameraId ? await getCameraRow(params.cameraId).catch(() => null) : null;
      if (!row) throw new PtzError(404, 'ไม่พบกล้องนี้ที่ edge');
      return row;
    };
    switch (method) {
      case 'catalog.push':
        await pushCatalog();
        return { ok: true };
      case 'stream.open': {
        const row = await cameraRow();
        if (Number(row.enabled ?? 1) === 0) throw new PtzError(409, 'กล้องนี้ถูกปิดใช้งานที่ edge');
        if (!params.dst?.path) throw new PtzError(400, 'ไม่มีปลายทาง');
        const which = params.which === 'sub' ? 'sub' : 'main';
        // Regional รับกล้องจาก Edge อีกชั้น ต้องปลุกสายล่างก่อน ffmpeg อ่าน go2rtc ของตัวเอง
        if (ensureChildStream) await ensureChildStream(row, which);
        openPush(row.id, which, params.dst);
        return { ok: true };
      }
      case 'stream.close':
        closePush(params.cameraId, params.which === 'sub' ? 'sub' : 'main');
        return { ok: true };
      case 'ptz.info': {
        const caps = await ptz.capabilities(await cameraRow());
        return { ...caps, allowed: allowPtz };
      }
      case 'update.retry': {
        if (!updater) throw new PtzError(409, 'เครื่องนี้ไม่รองรับการอัปเดตผ่านสาย');
        return updater.retryDownload();
      }
      case 'nodes.list': {
        if (ROLE !== 'regional' || !listChildNodes) throw new PtzError(403, 'เฉพาะ Regional ที่มีรายการ Edge ลูก');
        return (await listChildNodes()).map((e) => ({ node: e.remote_node, name: e.label, remark: e.remark || null,
          build: e.remote_build, reachable: e.reachable, cameras: e.cameraCount, lastSyncAt: e.last_sync_at }));
      }
      case 'update.apply': {
        // central กดปุ่ม "อัปเดต" ในหน้า Edge Nodes — ทางเดียวกับปุ่มบนหน้าเว็บของ edge
        if (!updater) throw new PtzError(409, 'edge นี้ไม่รองรับการอัปเดตผ่านสาย');
        try {
          return updater.requestApply(`central:${params.by || '?'}`);
        } catch (err) {
          throw new PtzError(err.status || 500, err.message);
        }
      }
      case 'recording.list': {
        if (!playbackSource) throw new PtzError(501, NO_SOURCE);
        return playbackSource.ranges((await cameraRow()).id, params.from, params.to);
      }
      case 'recording.upload': {
        // ภาพย้อนหลังไปหา central: เปิด ffmpeg ที่นี่ แล้วอัปโหลดเป็นสตรีมขึ้น central (vms/link-playback.js)
        if (!playbackSource) throw new PtzError(501, NO_SOURCE);
        const row = await cameraRow();
        let pb;
        try {
          pb = await playbackSource.openPlayback(row.id, { start: params.start, duration: params.duration, video: params.video === 'h264' ? 'h264' : undefined, complete: params.complete === '1' || params.complete === true });
        } catch (err) {
          throw new PtzError(err.status || 500, err.message);
        }
        uploadPlayback(String(params.sessionId || ''), pb);
        return { ok: true };
      }
      case 'recording.frame': {
        if (!playbackSource) throw new PtzError(501, NO_SOURCE);
        try {
          return { jpeg: (await playbackSource.frame((await cameraRow()).id, params.at)).toString('base64') };
        } catch (err) {
          throw new PtzError(err.status || 500, err.message);
        }
      }
      case 'ai.since': {
        if (!aiEvents) return { events: [] };
        const rows = await aiEvents.list({ since: Number(params.since) || 0, limit: Math.min(Number(params.limit) || 200, 500) });
        return { events: rows.map((r) => aiEvents.publicEvent(r)) };
      }
      case 'ai.snapshot': {
        const row = aiEvents ? await aiEvents.getRow(params.seq) : null;
        const file = row ? aiEvents.snapshotFile(row) : null;
        return { jpeg: file ? fs.readFileSync(file).toString('base64') : null };
      }
      case 'ptz.cmd':
        if (!allowPtz) throw new PtzError(403, 'edge นี้ไม่อนุญาตให้ central คุม PTZ (GATEWAY_CENTRAL_ALLOW_PTZ=0)');
        return (await dispatchPtz(ptz, await cameraRow(), params.command || {}, { actor: 'central (link)' })) || { ok: true };
      default:
        throw new PtzError(400, `ไม่รู้จักคำสั่ง ${method}`);
    }
  }

  function connect() {
    const target = endpoints[current];
    let welcomed = false;
    let mirrorTimer = null;
    const sock = new WebSocket(target.url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10_000 });
    ws = sock;

    /*
      สายตายเงียบ (NAT/ไฟร์วอลล์ทิ้ง state ไม่ส่ง FIN) — TCP ไม่รู้ตัวเป็นสิบนาที edge จึงค้างสายที่ตายแล้วและ
      central เห็น edge หลุด · นับทุกอย่างที่มาจาก central (ข้อความ, ping ของ central รุ่นใหม่, pong ที่ตอบ ping ของเรา)
      เป็นสัญญาณชีวิต เงียบเกิน SILENCE_LIMIT_MS = ตัดสายแล้วต่อใหม่ · ping ของเราเองทำให้ central รุ่นเก่าที่ไม่ ping
      ก็ยังมี pong ตอบกลับมาให้นับ (ไลบรารี ws ตอบ pong ให้อัตโนมัติ)
    */
    let lastHeard = Date.now();
    const alive = () => { lastHeard = Date.now(); };
    sock.on('ping', alive);
    sock.on('pong', alive);
    const deadCheck = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
        console.warn(`[Edge link] ไม่ได้ยินจาก central เกิน ${SILENCE_LIMIT_MS / 1000} วินาที — ตัดสายแล้วต่อใหม่`);
        sock.terminate();
        return;
      }
      try { sock.ping(); } catch { /* close ตามมาเอง */ }
    }, DEAD_CHECK_MS);

    sock.on('open', () => {
      alive();
      // via = ที่อยู่ที่ edge ใช้ต่อจริง — central แสดงในหน้า Edge Nodes ให้รู้ว่า edge นี้มาทางไหน
      // platform/runner: central ใช้เลือกแพ็กเกจอัปเดตให้ตรงเครื่อง (docs/EDGE-KIT.md)
      send({ type: 'hello', protocol: 2, node: NODE_NUMBER, role: ROLE, region: REGION || null, build: BUILD, name: name || null, via: target.url,
        platform: currentPlatform(), runner: process.env.GW_EDGE_RUNNER || 'pm2' });
    });

    sock.on('message', async (raw) => {
      alive();
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'welcome') {
        if (ROLE === 'regional' && msg.protocol !== 2) {
          console.warn('[Edge link] Central ยังไม่รองรับโปรโตคอล Regional รุ่น 2');
          sock.close(4003, 'regional protocol mismatch');
          return;
        }
        welcomed = true;
        retryMs = 2000;
        failedInRow = 0;
        if (warned) console.log(`[Edge link] ต่อ central ได้อีกครั้ง (${target.url})`);
        else console.log(`[Edge link] ต่อ central (${target.url}) แล้ว`);
        warned = false;
        heartbeat = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), HEARTBEAT_MS);
        catalogTimer = setInterval(pushCatalog, CATALOG_EVERY_MS);
        unsubscribe = cameraState.subscribe({
          onChange: (id, next) => send({ type: 'camera_state', cameraId: id, enabled: next.enabled, reachable: next.reachable, streaming: next.streaming, at: next.at }),
        });
        // มี event ใหม่ = แจ้งแค่ seq ให้ central มาไล่ตามเอง (ไม่ส่งตัว event — ตกหล่นแล้วไม่หาย)
        unsubscribeAi?.();
        unsubscribeAi = aiEvents ? aiEvents.subscribe((row) => send({ type: 'ai_event', seq: row.id })) : null;
        pushCatalog();
        updater?.linked(send, async () => {
          const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/instance`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok || (await res.json()).build !== BUILD) throw new Error('API ยังไม่พร้อมหรือ build ไม่ตรง');
          await catalog();
        });
        if (updateMirror) {
          const u = new URL(target.url);
          const httpBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
          updateMirror.sync(httpBase, token);
          mirrorTimer = setInterval(() => updateMirror.sync(httpBase, token), 60_000);
          mirrorTimer.unref?.();
        }
        return;
      }
      if (msg.type === 'update') {
        // โหลดจาก central ทาง HTTP ที่ host/พอร์ตเดียวกับเส้นทางที่ต่อติดอยู่
        const u = new URL(target.url);
        const httpBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
        updater?.handleOffer(msg, { httpBase, token });
        return;
      }
      if (msg.type === 'error') {
        console.warn(`[Edge link] central ปฏิเสธ: ${msg.error}`);
        return;
      }
      if (msg.type === 'rpc') {
        try {
          const data = await handleRpc(msg.method, msg.params);
          send({ type: 'reply', id: msg.id, ok: true, data });
        } catch (err) {
          send({ type: 'reply', id: msg.id, ok: false, status: err.status || 502, error: err.message });
        }
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(catalogTimer);
      clearInterval(mirrorTimer);
      heartbeat = null;
      catalogTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeAi?.();
      unsubscribeAi = null;
      updater?.unlinked();
      closeAllPushes();
    };

    sock.on('close', (code, reason) => {
      clearInterval(deadCheck);
      cleanup();
      if (!warned) {
        console.warn(`[Edge link] สายไป central (${target.url}) ขาด (${code}${reason ? ` ${reason}` : ''}) — ต่อใหม่เอง`);
        warned = true;
      }
      if (stopped) return;
      if (welcomed) {
        // เคยต่อติดด้วยอันนี้ — ลองอันเดิมก่อน (หลุดชั่วคราวบ่อยกว่าเส้นทางเปลี่ยน)
        setTimeout(connect, 2000);
        return;
      }
      // ต่อไม่ติด: ลองอันถัดไปทันที ครบทุกอันแล้วค่อยรอ
      failedInRow += 1;
      current = (current + 1) % endpoints.length;
      if (failedInRow < endpoints.length) {
        setTimeout(connect, 500);
        return;
      }
      failedInRow = 0;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
    sock.on('error', (err) => {
      if (!warned && endpoints.length === 1) console.warn(`[Edge link] ต่อ central ไม่ได้: ${err.message}`);
      else if (endpoints.length > 1) console.warn(`[Edge link] ต่อ ${target.url} ไม่ได้: ${err.message}`);
    });
  }

  connect();
  // catalogSoon: ส่งรายการใหม่ทันทีหลังคนแอด/ลบกล้อง (หน่วง 1 วิ รวบการลบหลายครั้งติดกัน) แทนรอรอบ 5 นาที
  let soonTimer = null;
  const catalogSoon = () => {
    if (soonTimer) return;
    soonTimer = setTimeout(() => { soonTimer = null; pushCatalog(); }, 1000);
  };
  return { stop: () => { stopped = true; closeAllPushes(); ws?.close(); }, catalogSoon };
}

module.exports = { startEdgeLink };
