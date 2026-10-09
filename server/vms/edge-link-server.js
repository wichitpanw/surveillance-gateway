/**
 * ปลายรับสาย link จาก edge ที่ central ต่อเข้าไปไม่ถึง (docs/EDGE-PLAN.md เฟส 4)
 *
 * edge เปิด WebSocket ขาออกมาที่ `ws://<central>:5173/api/edge-link` แล้วถือสายไว้ — ทุกอย่างที่
 * central เคยถามทาง HTTP (รายการกล้อง, สถานะ, PTZ, สั่งเปิดภาพ) วิ่งบนสายเดียวนี้แทน
 *
 * ข้อความเป็น JSON หนึ่งก้อนต่อ frame:
 *   edge → central   hello {node, build, name, via, platform, runner, province} · heartbeat · catalog {cameras, deleted}
 *                    camera_state {...} · update_status {state, build, error} · reply {id, ok, data | error}
 *   central → edge   welcome {node} · rpc {id, method, params} · error {error}
 *                    update {build, platform, file, size, sha256, signature, path} — มีแพ็กเกจใหม่ (vms/edge-updates.js)
 *
 * ยังไม่มี TLS (ws:// เท่านั้น) — ใช้บน Tailscale/LAN เปิดสู่ internet ตรงไม่ได้จนกว่าจะมี cert
 * เพราะ token และบัญชี RTSP ของ go2rtc วิ่งบนสายนี้เป็นข้อความเปล่า
 */
const { WebSocketServer } = require('ws');
const { EdgeUnavailable, EdgeRequestError } = require('./edge');
const { NODE_NUMBER } = require('../shared/instance');

const PATH = '/api/edge-link';
const HELLO_TIMEOUT_MS = 10_000;
/** edge ส่ง heartbeat ทุก 20 วิ — เงียบเกินนี้ถือว่าสายตาย (NAT ตัดทิ้งเงียบ ๆ ได้) */
const SILENCE_LIMIT_MS = 60_000;
const RPC_TIMEOUT_MS = 10_000;
/** central ping edge ทุก 20 วิ — edge รุ่นใหม่ถือว่าสายตายเมื่อเงียบเกิน ~70 วิ (vms/edge-link-client.js) */
const PING_EVERY_MS = 20_000;
/** ตรวจว่ามีแพ็กเกจอัปเดตที่เผยแพร่ใหม่ไหม — edge ที่ต่อค้างอยู่ได้ข้อเสนอโดยไม่ต้องต่อใหม่ */
const UPDATE_CHECK_MS = 60_000;

/** ดึง token จาก header Authorization: Bearer ... */
const tokenFrom = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
};

/**
 * ผูกปลายรับเข้ากับ http server ของ Express — ใช้เฉพาะ central
 * @param {import('http').Server} server
 * @param {object} edgeSources  ตัวที่ createEdgeSources คืนมา (findLinkSource, linkUp, ...)
 * @param {object} [updates]  vms/edge-updates.js — ไม่ส่ง = ไม่เสนออัปเดต
 */
function attachEdgeLink(server, edgeSources, updates = null) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = ''; }
    if (pathname !== PATH) return; // upgrade ของทางอื่น (ไม่มีตอนนี้) ไม่ใช่เรื่องของเรา

    // socket ดิบยังไม่มีตัวรับ error ระหว่างรอ DB — edge ตัดสายตอนนี้ = 'error' ไม่มีคนรับ = central ล้มทั้งตัว
    socket.on('error', () => {});
    let source;
    try {
      source = await edgeSources.findLinkSource(tokenFrom(req));
    } catch (err) {
      console.warn(`[Edge link] ตรวจ token ไม่ได้ — ${err.message}`);
      try { socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch { /* สายปิดไปแล้ว */ }
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;
    if (!source) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, source, req));
  });

  function handle(ws, source, req) {
    const pending = new Map(); // rpc id → { resolve, reject, timer }
    let nextId = 1;
    let ready = false;
    let lastSeen = Date.now();
    const remote = req.socket.remoteAddress;

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    /**
     * สั่ง edge แล้วรอคำตอบ — edge ตอบ error = EdgeRequestError, หมดเวลา/สายขาด = EdgeUnavailable
     * opts.timeoutMs: รอนานกว่าปกติสำหรับคำสั่งที่ edge ใช้เวลานาน (เช่น recording.upload ที่ค้นบันทึกหลายรอบ)
     */
    const rpc = (method, params = {}, opts = {}) => new Promise((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) return reject(new EdgeUnavailable('สาย link ของ edge ปิดอยู่'));
      const timeoutMs = Number(opts?.timeoutMs) > 0 ? Number(opts.timeoutMs) : RPC_TIMEOUT_MS;
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EdgeUnavailable(`edge ไม่ตอบคำสั่ง ${method} ภายใน ${Math.round(timeoutMs / 1000)} วินาที`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ type: 'rpc', id, method, params });
    });

    const link = {
      rpc,
      close: (reason) => {
        send({ type: 'error', error: reason || 'closed' });
        ws.close(4000, String(reason || '').slice(0, 100));
      },
    };

    const helloTimer = setTimeout(() => {
      if (!ready) ws.close(4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_LIMIT_MS) ws.terminate();
    }, 15_000);
    /*
      ping ของ WebSocket ทุก 20 วิ — edge รุ่นใหม่ใช้ตรวจว่าสายยังเป็นอยู่ (NAT ตัดเงียบ ๆ แล้ว edge ไม่รู้ตัว)
      edge ทุกรุ่นตอบ pong ให้เองอัตโนมัติ (ไลบรารี ws) จึงนับ pong เป็นสัญญาณชีวิตของ edge ด้วย
    */
    ws.on('pong', () => { lastSeen = Date.now(); });
    const pinger = setInterval(() => {
      if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch { /* close ตามมาเอง */ } }
    }, PING_EVERY_MS);

    // เสนออัปเดตเมื่อ build ของ edge ไม่ตรงกับแพ็กเกจที่เผยแพร่ — ส่งซ้ำเฉพาะเมื่อแพ็กเกจเปลี่ยน
    let edgeInfo = null; // { platform, build } จาก hello
    let offered = null;
    let lastUpdateStatus = null;
    const offerUpdate = () => {
      if (!updates || !edgeInfo) return;
      const offer = updates.offerFor(edgeInfo);
      if (!offer) return;
      if (offered === offer.sha256 && (!lastUpdateStatus || lastUpdateStatus.build === offer.build || lastUpdateStatus.state === 'installing')) return;
      offered = offer.sha256;
      send({ type: 'update', ...offer });
      console.log(`[Edge link] ${source.label}: เสนออัปเดต ${edgeInfo.build} → ${offer.build} (${offer.platform})`);
    };
    const updateTimer = setInterval(offerUpdate, UPDATE_CHECK_MS);

    ws.on('message', async (raw) => {
      lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!ready) {
        if (msg.type !== 'hello') return;
        let problem;
        try {
          problem = await edgeSources.linkUp(source, { ...msg, remote }, link);
        } catch (err) {
          // DB ล้ม/ล็อกตอนรับ hello — ต้องไม่หลุดเป็น unhandled rejection (central ล้มทั้งตัว) · edge ต่อใหม่เอง
          console.warn(`[Edge link] ${source.label} (${remote}): รับ hello ไม่ได้ — ${err.message}`);
          Promise.resolve(edgeSources.linkDown(source.id, link, 'รับ hello ไม่ได้')).catch(() => {});
          send({ type: 'error', error: 'central รับการเชื่อมต่อไม่ได้ชั่วคราว' });
          ws.close(1011, 'internal error');
          return;
        }
        if (ws.readyState !== ws.OPEN) {
          // สายขาดระหว่างรอ linkUp — close ทำงานไปแล้วตอน ready ยังเป็น false จึงต้องถอดสายที่เพิ่งลงทะเบียนเอง
          if (!problem) Promise.resolve(edgeSources.linkDown(source.id, link, 'สายขาดระหว่างรับ hello')).catch(() => {});
          return;
        }
        if (problem) {
          console.warn(`[Edge link] ${source.label} (${remote}): ไม่รับ — ${problem}`);
          send({ type: 'error', error: problem });
          ws.close(4003, 'rejected');
          return;
        }
        ready = true;
        clearTimeout(helloTimer);
        send({ type: 'welcome', protocol: 2, node: NODE_NUMBER });
        edgeInfo = { platform: msg.platform || null, build: msg.build || null };
        offerUpdate();
        return;
      }

      try {
        switch (msg.type) {
          case 'heartbeat':
            break;
          case 'catalog':
            await edgeSources.linkCatalog(source, msg.cameras, msg.deleted);
            break;
          case 'camera_state':
            await edgeSources.linkState(source.id, msg);
            break;
          case 'ai_event':
            // สัญญาณว่ามี event ใหม่ — central ไล่ตามด้วย rpc ai.since เอง (vms/edge-source.js)
            edgeSources.syncAiEvents(source.id);
            break;
          case 'update_status':
            lastUpdateStatus = msg;
            edgeSources.setUpdateStatus(source.id, msg);
            break;
          case 'reply': {
            const p = pending.get(msg.id);
            if (!p) break;
            pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.data ?? null);
            else p.reject(new EdgeRequestError(Number(msg.status) || 502, msg.error || 'edge ทำคำสั่งไม่สำเร็จ'));
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.warn(`[Edge link] ${source.label}: ประมวลผล ${msg.type} ไม่ได้ — ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(helloTimer);
      clearInterval(watchdog);
      clearInterval(pinger);
      clearInterval(updateTimer);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new EdgeUnavailable('สาย link ของ edge ขาด'));
      }
      pending.clear();
      if (ready) edgeSources.linkDown(source.id, link, `${code} ${String(reason || '')}`.trim());
    });
    ws.on('error', () => { /* close ตามมาเสมอ */ });
  }

  console.log(`[Edge link] รอ edge ต่อขึ้นมาที่ ${PATH}`);
  return wss;
}

module.exports = { attachEdgeLink, EDGE_LINK_PATH: PATH };
