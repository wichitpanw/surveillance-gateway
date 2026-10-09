/**
 * กล้องสาธารณะของหน่วยงานรัฐ — Central ดึงรายชื่อ/สถานะจาก API ของหน่วยงานเองโดยตรง (docs/PUBLIC-CAMS.md)
 *
 * ข้อยกเว้นเดียวของกฎ "Central ไม่แอดกล้องเอง" (ผู้ใช้สั่ง 2026-10-07): กล้องพวกนี้ไม่มีรหัสผ่าน ไม่อยู่ในวงแลน
 * ของใคร และไม่มี Edge เป็นเจ้าของ · ไม่เปิด POST /api/cameras ให้ Central — แถวเกิดจากโมดูลนี้เท่านั้น
 *
 * เก็บเป็นแถวใน `cameras` (type = public_hls) เพื่อให้ go2rtc sync, /api/v1, stream token และหน้า Live ใช้ได้ทันที
 *   - source_id = `public:<แหล่ง>`, source_ref = id ของกล้องฝั่งหน่วยงาน (unique index กันแถวซ้ำ)
 *   - rtsp = URL ของ HLS (ชื่อคอลัมน์เดิม) — ตรวจ https + host ใน whitelist ของแหล่งก่อนเขียนทุกครั้ง
 *   - หายจาก API = source_missing_at (ไม่ลบ — global ID คงเดิมถ้ากลับมา) · go2rtc-sync ข้ามแถวที่หายให้เอง
 *   - สถานะ online มาจาก API ของหน่วยงาน (ไม่ยิง TCP เอง) · API key เห็นกล้องชุดนี้เมื่อติ๊ก allow_public
 *
 * เพิ่มแหล่งใหม่ = เพิ่มรายการใน SOURCES (ดู udon เป็นตัวอย่าง) — parse() ต้องคืน { ref, name, url, lat, lng, online }
 */
const { nowIso } = require('../shared/time');

const PUBLIC_TYPE = 'public_hls';
const SYNC_EVERY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

/** แปลงตัวเลขพิกัดที่มาเป็นสตริงจาก API ภายนอก — นอกช่วงประเทศไทยคร่าว ๆ ถือว่าไม่มีพิกัด (ไม่เดาจุดกลาง) */
const coord = (v, min, max) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

const SOURCES = {
  /*
    เทศบาลนครอุดรธานี — หน้าแผนที่ https://www.udoncity.go.th/frontend/web/cctv/map เรียก JSON นี้เอง
    { success, data: [{ id, title, videoUrl, latitude, longitude, status }] } · HLS H.264 จาก Wowza :1935
    videoUrl เป็น chunklist_w<session>.m3u8 ซึ่งผูก session ของ Wowza — ใช้ playlist.m3u8 แทนให้ ffmpeg ขอ session ใหม่เอง
  */
  udon: {
    label: 'เทศบาลนครอุดรธานี',
    credit: 'Udon Thani City Municipality (เทศบาลนครอุดรธานี)',
    pageUrl: 'https://www.udoncity.go.th/frontend/web/cctv/map',
    listUrl: 'https://www.udoncity.go.th/frontend/web/cctv/api/cameras',
    /*
      www.udoncity.go.th ไม่ส่ง intermediate ของ Certum มาด้วย (ตรวจ 2026-10-07: UNABLE_TO_VERIFY_LEAF_SIGNATURE)
      เบราว์เซอร์ตามไปโหลดเองจาก AIA แต่ Node ไม่ทำ — โหลด intermediate จาก URL ที่ตรึงไว้นี้แล้วตรวจกับ root ของ Node ตามปกติ
      ไม่ปิดการตรวจใบรับรอง · streaming.udoncity.go.th ส่ง chain ครบ ffmpeg ต่อได้เอง
    */
    caIssuerUrl: 'http://certumdvtlsg2r39ca.repository.certum.pl/certumdvtlsg2r39ca.cer',
    allowedHosts: ['streaming.udoncity.go.th'],
    group: 'Public · อุดรธานี',
    province: '41',
    district: '4101',
    parse(json) {
      if (!json || json.success === false || !Array.isArray(json.data)) throw new Error('รูปแบบข้อมูลจากเทศบาลนครอุดรธานีไม่ตรงที่คาด');
      return json.data.map((c) => ({
        ref: String(c.id ?? ''),
        name: String(c.title || '').trim(),
        url: String(c.videoUrl || '').replace(/\/chunklist_[^/]*\.m3u8(\?.*)?$/i, '/playlist.m3u8'),
        lat: coord(c.latitude, 5, 21),
        lng: coord(c.longitude, 97, 106),
        online: String(c.status || '').toLowerCase() === 'online',
      }));
    },
  },
};

const sourceIdOf = (key) => `public:${key}`;
const keyOfSourceId = (sourceId) => (String(sourceId || '').startsWith('public:') ? String(sourceId).slice(7) : null);

/**
 * URL ของภาพจากแหล่งนี้ใช้ได้ไหม — https เท่านั้น, host อยู่ใน whitelist, ไม่มี user:pass, ลงท้าย .m3u8
 * ใช้สองที่: ตอนเขียนแถว และ go2rtc-sync ก่อนส่งให้ ffmpeg (ด่านที่สอง กันแถวที่ถูกแก้ทางอื่น)
 * ไม่มีด่านนี้ = API ของหน่วยงานที่ถูกแก้ส่ง URL ไหนมาก็ได้ ให้ ffmpeg ของเรายิงเข้าเครือข่ายภายใน (SSRF)
 */
function isAllowedPublicUrl(url, sourceKey) {
  const source = SOURCES[sourceKey];
  if (!source) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password
    && source.allowedHosts.includes(u.hostname.toLowerCase())
    && /\.m3u8$/i.test(u.pathname);
}

/** intermediate ที่โหลดแล้ว ต่อ URL — PEM · โหลดครั้งเดียวต่อ process */
const issuerCache = new Map();

/** DER → PEM — ไฟล์ .cer จาก AIA เป็น DER ส่วน option `ca` ของ tls รับ PEM */
const derToPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

async function issuerPem(url) {
  if (issuerCache.has(url)) return issuerCache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`โหลด intermediate CA ไม่ได้ (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 16 * 1024) throw new Error('ไฟล์ intermediate CA ใหญ่ผิดปกติ');
  const text = buf.toString('latin1');
  const pem = text.includes('-----BEGIN CERTIFICATE-----') ? text : derToPem(buf);
  // ตรวจว่าอ่านเป็นใบรับรองได้จริง — ไม่ได้แปลว่าเชื่อถือ (การเชื่อถือตัดสินตอน TLS ด้วย root ของ Node)
  new (require('crypto').X509Certificate)(pem);
  issuerCache.set(url, pem);
  return pem;
}

/**
 * GET JSON จาก API ของหน่วยงาน — ตรวจใบรับรองเต็มเสมอ
 * caIssuerUrl: เพิ่ม intermediate ที่เซิร์ฟเวอร์ลืมส่งเข้าไปใน chain (root ยังเป็นชุดของ Node ทั้งหมด)
 */
async function fetchJson(url, { caIssuerUrl } = {}) {
  if (!caIssuerUrl) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const https = require('https');
  const tls = require('tls');
  const ca = [...tls.rootCertificates, await issuerPem(caIssuerUrl)];
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, headers: { Accept: 'application/json' }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 2 * 1024 * 1024) req.destroy(new Error('คำตอบใหญ่เกิน 2 MB'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error(`อ่าน JSON ไม่ได้: ${err.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('หน่วยงานไม่ตอบภายในเวลาที่กำหนด')));
    req.on('error', reject);
  });
}

/** id ของกล้องในระบบเรา — คงที่ตลอด (go2rtc path, LiveWall และ log อ้างอยู่) */
const cameraIdOf = (key, ref) => `PUB-${key.toUpperCase()}-${ref}`;

function createPublicCams({ db, cameraState, resyncStreamCore, onCatalogChanged } = {}) {
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function cb(err) { return err ? reject(err) : resolve(this); }));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));

  /** สถานะล่าสุดต่อแหล่ง — ในหน่วยความจำ หน้า Public Cam Map ใช้บอกว่าซิงก์ล่าสุดเมื่อไรและพังเพราะอะไร */
  const status = new Map();
  /** สถานะ online ล่าสุดที่หน่วยงานรายงาน ต่อ id กล้อง — รอบ health ของ server.js อ่านต่อ */
  const online = new Map();
  let timer = null;
  let running = null;

  async function syncSource(key) {
    const source = SOURCES[key];
    const sourceId = sourceIdOf(key);
    const st = { lastAttemptAt: nowIso(), lastSyncAt: status.get(key)?.lastSyncAt || null, lastError: null, count: 0 };
    let items;
    try {
      items = source.parse(await fetchJson(source.listUrl, { caIssuerUrl: source.caIssuerUrl }));
    } catch (err) {
      st.lastError = String(err?.message || err);
      status.set(key, st);
      console.warn(`[Public Cams] ${key}: ดึงรายชื่อไม่สำเร็จ — ${st.lastError}`);
      // ไม่รู้สถานะ ≠ ดับ — ล้างเป็น null ไม่ทับเป็น false (ตรงกับกล้องจาก edge ที่ติดต่อไม่ได้)
      for (const row of await all('SELECT id FROM cameras WHERE source_id = ?', [sourceId])) {
        online.delete(row.id);
        if (cameraState?.get(row.id)?.reachable !== null) cameraState?.set(row.id, { reachable: null });
      }
      return { changed: false };
    }

    const existing = new Map((await all(
      'SELECT id, source_ref, name, rtsp, lat, lng, source_missing_at FROM cameras WHERE source_id = ?', [sourceId],
    )).map((r) => [r.source_ref, r]));

    let streamsChanged = false;
    let catalogChanged = false;
    const seen = new Set();
    for (const item of items) {
      if (!/^[\w-]{1,40}$/.test(item.ref) || seen.has(item.ref)) continue;
      if (!isAllowedPublicUrl(item.url, key)) {
        console.warn(`[Public Cams] ${key}/${item.ref}: ข้าม — URL ไม่อยู่ใน whitelist ของแหล่ง`);
        continue;
      }
      seen.add(item.ref);
      const id = cameraIdOf(key, item.ref);
      const name = item.name || id;
      const prev = existing.get(item.ref);
      if (!prev) {
        await run(
          `INSERT OR IGNORE INTO cameras (id, name, group_name, brand, type, rtsp, lat, lng, stream_type, enabled, always_on,
             source_id, source_ref, province_code, district_code)
           VALUES (?, ?, ?, 'public', ?, ?, ?, ?, 'main', 1, 0, ?, ?, ?, ?)`,
          [id, name, source.group, PUBLIC_TYPE, item.url, item.lat, item.lng, sourceId, item.ref, source.province, source.district],
        );
        streamsChanged = true;
        catalogChanged = true;
      } else if (prev.name !== name || prev.rtsp !== item.url || prev.lat !== item.lat || prev.lng !== item.lng || prev.source_missing_at) {
        if (prev.rtsp !== item.url || prev.source_missing_at) streamsChanged = true;
        catalogChanged = true;
        await run(
          'UPDATE cameras SET name = ?, rtsp = ?, lat = ?, lng = ?, source_missing_at = NULL WHERE id = ?',
          [name, item.url, item.lat, item.lng, prev.id],
        );
      }
      online.set(id, item.online);
      cameraState?.set(id, { reachable: item.online });
      st.count += 1;
    }

    // หายจาก API ของหน่วยงาน — ไม่ลบ (global ID ต้องอยู่ถ้ากลับมา) แค่ถอดออกจาก go2rtc และบอกว่าหาย
    for (const [ref, row] of existing) {
      if (seen.has(ref)) continue;
      online.delete(row.id);
      if (cameraState?.get(row.id)?.reachable !== null) cameraState?.set(row.id, { reachable: null, streaming: false });
      if (!row.source_missing_at) {
        await run('UPDATE cameras SET source_missing_at = ? WHERE id = ?', [nowIso(), row.id]);
        streamsChanged = true;
        catalogChanged = true;
      }
    }

    st.lastSyncAt = nowIso();
    status.set(key, st);
    if (catalogChanged) console.log(`[Public Cams] ${key}: ${st.count} กล้อง (มีการเปลี่ยนแปลง)`);
    return { changed: catalogChanged, streamsChanged };
  }

  /** ซิงก์ทุกแหล่ง — เรียงคิว กันรอบตั้งเวลากับปุ่ม "ซิงก์ตอนนี้" ชนกัน */
  function syncNow() {
    if (running) return running;
    running = (async () => {
      let streams = false;
      let catalog = false;
      for (const key of Object.keys(SOURCES)) {
        try {
          const r = await syncSource(key);
          streams = streams || Boolean(r.streamsChanged);
          catalog = catalog || Boolean(r.changed);
        } catch (err) {
          status.set(key, { ...(status.get(key) || {}), lastError: String(err?.message || err), lastAttemptAt: nowIso() });
          console.warn(`[Public Cams] ${key}: ${err?.message || err}`);
        }
      }
      if (catalog) onCatalogChanged?.();
      if (streams) resyncStreamCore?.();
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return;
    syncNow().catch(() => {});
    timer = setInterval(() => syncNow().catch(() => {}), SYNC_EVERY_MS);
  }

  /** online ที่หน่วยงานรายงานล่าสุด — undefined = ยังไม่รู้ (ยังไม่ซิงก์ หรือ API ของหน่วยงานล่ม) */
  const reportedOnline = (id) => online.get(id);

  /** ข้อมูลต้นทางของแถว public สำหรับ /api/v1 (origin) — null ถ้าไม่ใช่กล้อง public */
  function originOf(row) {
    if (row.type !== PUBLIC_TYPE) return null;
    const key = keyOfSourceId(row.source_id);
    const source = SOURCES[key];
    return {
      kind: 'public',
      source: key,
      credit: source?.credit || null,
      pageUrl: source?.pageUrl || null,
      missingAtSource: Boolean(row.source_missing_at),
    };
  }

  /** route ของหน้า Public Cam Map (ใต้ checkAuth) — คนที่มี menu.publiccam เห็นกล้อง public ทุกตัว ไม่ขึ้นกับขอบเขต role */
  function createRouter({ requirePerm }) {
    const express = require('express');
    const router = express.Router();
    router.use(requirePerm('menu.publiccam'));

    router.get('/', async (req, res) => {
      try {
        const rows = await all(
          `SELECT id, name, global_id, lat, lng, group_name, source_id, source_ref, source_missing_at, province_code, district_code
             FROM cameras WHERE type = ? ORDER BY group_name, name`, [PUBLIC_TYPE],
        );
        const sources = Object.entries(SOURCES).map(([key, s]) => ({
          key, label: s.label, credit: s.credit, pageUrl: s.pageUrl, group: s.group,
          ...(status.get(key) || { lastSyncAt: null, lastAttemptAt: null, lastError: null, count: 0 }),
        }));
        res.json({
          syncEveryMs: SYNC_EVERY_MS,
          sources,
          cameras: rows.map((r) => {
            const st = cameraState?.get(r.id);
            return {
              id: r.id,
              name: r.name,
              global_id: r.global_id,
              lat: r.lat,
              lng: r.lng,
              group_name: r.group_name,
              source: keyOfSourceId(r.source_id),
              ref: r.source_ref,
              missing: Boolean(r.source_missing_at),
              // true/false = หน่วยงานรายงาน · null = ยังไม่รู้
              online: st?.reachable ?? null,
              streaming: Boolean(st?.streaming),
            };
          }),
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/sync', requirePerm('device.manage'), async (req, res) => {
      await syncNow().catch(() => {});
      res.json({ ok: true, sources: Object.fromEntries(status) });
    });

    return router;
  }

  return { start, syncNow, originOf, reportedOnline, createRouter };
}

module.exports = { PUBLIC_TYPE, SOURCES, isAllowedPublicUrl, keyOfSourceId, createPublicCams };
