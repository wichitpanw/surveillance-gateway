/**
 * ตัวกลาง RTSP ถาวรของกล้องจาก Dahua DSS — ฟังที่ 127.0.0.1:<DSS_RELAY_PORT> ให้ go2rtc ของเครื่องนี้ต่อ
 *
 * ทำไมต้องมี: URL ภาพสดของ DSS (StartVideo) มี token ที่ **ใช้ได้ครั้งเดียว** — ต่อซ้ำ/ต่อพร้อมกันได้ 401 (ทดสอบ 2026-09-29)
 * แต่ go2rtc ต้องการ URL ตายตัวที่ต่อใหม่ได้เรื่อย ๆ จึงให้ go2rtc ต่อที่
 *     rtsp://127.0.0.1:<port>/dss/<camera id>/<main|sub>
 * แล้วทุกการเชื่อมต่อ ตัวกลางขอ URL ใหม่จาก DSS (resolve) ต่อไปที่ DSS และส่งต่อข้อความ/ภาพสองทาง
 * token ของ DSS จึงไม่อยู่ใน go2rtc.yaml หรือ DB เลย
 *
 * การแก้ข้อความระหว่างทาง (client → DSS): URI ที่ขึ้นต้นด้วย URL ในเครื่อง → URL จริงของ DSS
 *   ตัว URL ตรง ๆ (OPTIONS/DESCRIBE/PLAY) → URL เต็มที่มี token · มีส่วนต่อท้าย (SETUP …/trackID=0) → ต่อจาก Content-Base ที่ DSS ให้
 * (DSS → client): Content-Base / Content-Location เปลี่ยนเป็น URL ในเครื่อง ให้ client อ้าง URL เดียวตลอด
 * ข้อมูลภาพ (interleaved `$`) ส่งผ่านตรง ๆ พร้อม backpressure
 */
const net = require('node:net');
const { RtspSplitter } = require('./onvif-replay-proxy');
const { hideToken } = require('./dss');

const PATH_RE = /^\/dss\/([^/]+)\/(main|sub)(?:\/.*)?$/;
const FIRST_REQUEST_MS = 10_000;
const CONNECT_MS = 4_000;

function headerOf(headers, name) {
  const found = headers.find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
}

/**
 * @param {{ port: number, resolve: (cameraId: string, stream: 'main'|'sub') => Promise<string|string[]>, log?: Console }} opts
 *   resolve คืน URL ภาพสดของ DSS (ใช้ครั้งเดียว มี token) หรือหลายทางเรียงตามลำดับที่ควรลอง
 *   · error ของ resolve = ปิดการเชื่อมต่อ (go2rtc ต่อใหม่เอง)
 */
function startDssRelay({ port, resolve, log = console }) {
  const server = net.createServer((client) => handle(client));
  server.on('error', (err) => log.warn(`[DSS relay] ฟังพอร์ต ${port} ไม่ได้: ${err.message}`));
  server.listen(port, '127.0.0.1', () => log.log(`[DSS relay] พร้อมที่ rtsp://127.0.0.1:${port}/dss/<camera>/<main|sub>`));

  // host:port ที่ DSS บอก → host:port ที่ต่อได้จริงครั้งล่าสุด — ทางที่เคยใช้ได้ลองก่อน ไม่ต้องรอ timeout ทุกครั้ง
  const workedVia = new Map();
  const endpoint = (url) => {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 554, key: `${u.hostname}:${Number(u.port) || 554}` };
  };

  /**
   * ลอง URL ของ DSS ตามลำดับจนกว่า TCP จะต่อติด (token ยังไม่ถูกใช้จนกว่าจะส่ง DESCRIBE จึงลองหลายทางได้)
   * ทุกทางต่อไม่ได้ = throw พร้อม host:port ที่ลอง (ไม่มี token) ให้เห็นใน log ว่าต้องเปิด route/forward ไปที่ไหน
   */
  async function connectFirst(urls) {
    const first = urls[0] ? endpoint(urls[0]).key : '';
    const known = workedVia.get(first);
    const ordered = known ? [...urls].sort((a, b) => (endpoint(b).key === known) - (endpoint(a).key === known)) : urls;
    const failed = [];
    for (const url of ordered) {
      const ep = endpoint(url);
      try {
        const socket = await new Promise((ok, fail) => {
          const s = net.connect({ host: ep.host, port: ep.port });
          const timer = setTimeout(() => { s.destroy(); fail(new Error('timeout')); }, CONNECT_MS);
          s.once('connect', () => { clearTimeout(timer); ok(s); });
          s.once('error', (err) => { clearTimeout(timer); fail(err); });
        });
        if (first && workedVia.get(first) !== ep.key) {
          workedVia.set(first, ep.key);
          if (ep.key !== first) log.log(`[DSS relay] DSS ให้ต่อ ${first} ไม่ถึง — ใช้ ${ep.key} แทน`);
        }
        return { url, socket };
      } catch (err) {
        failed.push(`${ep.key} (${err.code || err.message})`);
      }
    }
    throw new Error(`ต่อ media ของ DSS ไม่ได้ทุกทาง: ${failed.join(', ')}`);
  }

  function handle(client) {
    client.setNoDelay(true);
    let upstream = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(firstTimer);
      client.destroy();
      upstream?.destroy();
    };
    client.on('error', close);
    client.on('close', close);

    // ระหว่างรอ DSS ให้ URL เก็บทุกชิ้นที่ client ส่งมาไว้ก่อน แล้วค่อยป้อนเข้าตัวแยกข้อความเมื่อพร้อม
    const pending = [];
    let fromClient = null;
    let started = false;
    const firstTimer = setTimeout(() => { if (!started) close(); }, FIRST_REQUEST_MS);
    const probe = new RtspSplitter({
      onError: close,
      onFrame: () => {},
      onMessage: ({ startLine }) => {
        if (started) return;
        started = true;
        begin(startLine.split(' ')[1] || '').catch((err) => {
          log.warn(`[DSS relay] ${hideToken(err.message || err)}`);
          close();
        });
      },
    });
    client.on('data', (chunk) => {
      if (fromClient) return fromClient.push(chunk);
      pending.push(chunk);
      if (!started) probe.push(chunk);
      return undefined;
    });

    async function begin(firstUri) {
      clearTimeout(firstTimer);
      let local;
      try { local = new URL(firstUri); } catch { throw new Error(`URI ไม่ถูกต้อง: ${firstUri}`); }
      const m = PATH_RE.exec(local.pathname);
      if (!m) throw new Error(`path ไม่รู้จัก: ${local.pathname}`);
      const cameraId = decodeURIComponent(m[1]);
      const stream = m[2];
      const localBase = `rtsp://${local.host}/dss/${m[1]}/${stream}`;

      const resolved = await resolve(cameraId, stream);
      if (closed) return;
      const picked = await connectFirst(Array.isArray(resolved) ? resolved : [resolved]);
      if (closed) { picked.socket.destroy(); return; }
      const targetUrl = picked.url;
      let contentBase = null;

      upstream = picked.socket;
      upstream.setNoDelay(true);
      upstream.on('error', close);
      upstream.on('close', close);

      const relay = (dst, src, data) => {
        if (closed || dst.destroyed) return;
        if (!dst.write(data) && !src.isPaused()) {
          src.pause();
          dst.once('drain', () => { if (!closed) src.resume(); });
        }
      };

      /** URI ในเครื่อง → URI ของ DSS (URI ของ DSS อยู่แล้ว เช่น a=control แบบเต็ม ส่งผ่านเลย) */
      const toTarget = (uri) => {
        if (!uri.startsWith(localBase)) return uri;
        const rest = uri.slice(localBase.length).replace(/^\/+/, '');
        if (!rest) return targetUrl;
        const cb = contentBase || `${targetUrl.split('?')[0]}/`;
        return `${cb.endsWith('/') ? cb : `${cb}/`}${rest}`;
      };

      fromClient = new RtspSplitter({
        onError: close,
        onFrame: ({ raw }) => relay(upstream, client, raw),
        onMessage: ({ raw, startLine }) => {
          const [method, uri, version] = startLine.split(' ');
          const next = toTarget(uri || '');
          if (next === uri) return relay(upstream, client, raw);
          const text = raw.toString('latin1');
          return relay(upstream, client, Buffer.from(text.replace(startLine, `${method} ${next} ${version}`), 'latin1'));
        },
      });

      const fromUpstream = new RtspSplitter({
        onError: close,
        onFrame: ({ raw }) => relay(client, upstream, raw),
        onMessage: ({ raw, headers }) => {
          const base = headerOf(headers, 'content-base');
          if (base && !contentBase) contentBase = base;
          if (!base && !headerOf(headers, 'content-location')) return relay(client, upstream, raw);
          // ให้ client เห็นแต่ URL ในเครื่อง — SETUP ถัดไปจะกลับมาผ่าน toTarget
          const text = raw.toString('latin1').replace(/^(Content-(?:Base|Location):[ \t]*)[^\r\n]*/gim, `$1${localBase}/`);
          return relay(client, upstream, Buffer.from(text, 'latin1'));
        },
      });
      upstream.on('data', (chunk) => fromUpstream.push(chunk));

      for (const chunk of pending.splice(0)) fromClient.push(chunk);
    }
  }

  return { server, close: () => server.close() };
}

module.exports = { startDssRelay };
