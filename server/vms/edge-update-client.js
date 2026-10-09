/**
 * ฝั่ง edge ของการอัปเดตผ่านสาย link — docs/EDGE-KIT.md หัวข้อ "อัปเดตผ่านสาย link"
 *
 * central ส่งข้อเสนอ (update) มาบนสาย → ตรวจลายเซ็น manifest → โหลดแพ็กเกจจาก central ทาง HTTP (token ของสาย)
 * → ตรวจ sha256 → เก็บไว้ที่ <state>/updates/ แล้วรอคนกด "ติดตั้ง" ที่หน้าเว็บของ edge
 * การสลับโปรแกรมจริงเป็นงานของ scripts/edge-run.cjs (ตัวคุมโปรเซส) ซึ่งเห็นไฟล์ apply.json ที่ไฟล์นี้เขียน
 *
 * ไฟล์ใน <state>/updates/
 *   pending.json      manifest ของแพ็กเกจที่โหลดครบและตรวจแล้ว
 *   apply.json        คำขอติดตั้ง (edge-run อ่านแล้วลบ)
 *   last-result.json  ผลการติดตั้งครั้งล่าสุด (edge-run เขียน)
 *   link-ok.json      build + เวลาที่สาย link ต่อติดล่าสุด — edge-run ใช้ตัดสินว่าเวอร์ชันใหม่ใช้ได้หรือต้องถอยกลับ
 *
 * วิธีติดตั้งขึ้นกับตัวคุมที่รันอยู่:
 *   edge-run (ติดตั้งจากชุด)      เขียน apply.json ให้ edge-run สลับโฟลเดอร์ app
 *   pm2 บน Linux (edge 002)       สลับไฟล์ใน repo เอง แล้วปิดตัวให้ pm2 เปิดรุ่นใหม่ — ตัวเฝ้า scripts/edge-update-watchdog.cjs
 *                                 (โปรเซสแยก) ถอยกลับถ้ารุ่นใหม่ต่อ central ไม่ติด · ไม่ต้องใช้ sudo
 *   อื่น ๆ (edge 001 บน Windows)   แจ้งอย่างเดียว — repo นั้นคือ central production ห้ามสลับไฟล์เอง
 * คนสั่งติดตั้งได้สองทาง: ปุ่มบนหน้าเว็บของ edge หรือปุ่มในหน้า Edge Nodes ของ central (rpc update.apply บนสาย)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { BUILD, stateFile } = require('../shared/instance');
const { nowIso } = require('../shared/time');
const { currentPlatform } = require('../shared/edge-update-manifest');
// sig2 + issuedAt: กันการเล่นซ้ำ manifest เก่าที่เซ็นถูกเพื่อลดเวอร์ชัน (scripts/edge-update-key.cjs)
const { verifyManifestV2, checkManifestOrder } = require('../../scripts/edge-update-key.cjs');

const DIR = stateFile('updates');
const file = (name) => path.join(DIR, name);
const readJson = (name) => {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; }
};
const writeJson = (name, obj) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), `${JSON.stringify(obj, null, 2)}\n`);
};

/** ตัวคุมที่รันอยู่ — 'edge-run' เท่านั้นที่ติดตั้งให้ได้ (ตั้งโดย scripts/edge-run.cjs) */
const RUNNER = process.env.GW_EDGE_RUNNER || 'pm2';
const PLATFORM = currentPlatform();

/*
  สลับไฟล์ในที่ได้ไหม: pm2 บน Linux (pm_id มีเมื่ออยู่ใต้ pm2 — ตายแล้ว pm2 เปิดใหม่ให้) และ state ต้องอยู่นอก repo
  (edge ที่ state อยู่ใน server/ แบบ central ห้าม — การสลับ server/ จะพาข้อมูลไปด้วย)
*/
const REPO = path.resolve(__dirname, '..', '..');
/*
  ของที่แพ็กเกจอัปเดตแบบสลับไฟล์ใน repo (pm2 บน Linux) มีได้ — เกินจากนี้ = ปฏิเสธทั้งแพ็กเกจ
  แพ็กเกจใหม่มีเฉพาะ gateway และเครื่องมือรับผลจากต้นทาง
*/
const IN_PLACE_ENTRIES = ['server', 'scripts', 'dist', 'ecosystem.edge.config.cjs', 'package.json', 'BUILD'];
const IN_PLACE = RUNNER === 'pm2' && process.platform === 'linux' && process.env.pm_id !== undefined
  && path.relative(REPO, DIR).startsWith('..');
const CAN_INSTALL = RUNNER === 'edge-run' || IN_PLACE;
const HEALTH_WAIT_MS = Number(process.env.GW_EDGE_UPDATE_HEALTH_MS) || 5 * 60_000;
/** manifest ล่าสุดที่รับ { issuedAt, sha256, build } — ใช้ปฏิเสธ manifest ที่เก่ากว่า (edge-run อ่านชื่อเดียวกัน) */
const ACCEPTED = 'accepted-manifest.json';

function createEdgeUpdater() {
  let offer = null; // manifest ที่ central เสนอล่าสุด
  let state = 'idle'; // idle | available | downloading | ready | installing | failed
  let error = null;
  let progress = 0;
  let send = null;
  let downloading = null;
  let retryContext = null;
  let retryable = false;
  let retryCount = 0;
  let retryTimer = null;
  let retryAt = null;
  let healthTimer = null;
  let linkGeneration = 0;

  // เพิ่งติดตั้งเสร็จแล้วเปิดขึ้นมาเป็นเวอร์ชันนี้ — ของค้างของรอบก่อนไม่ต้องเสนออีก
  const pending = readJson('pending.json');
  if (pending && pending.build === BUILD) {
    try { fs.rmSync(file('pending.json'), { force: true }); } catch { /* ไม่เป็นไร */ }
  }
  // ตัวเฝ้าของการสลับในที่ใช้ pid นี้ปิด gateway รุ่นใหม่ตอนถอยกลับ
  if (IN_PLACE) { try { writeJson('gateway.pid', process.pid); } catch { /* ไม่มีที่เขียน = ถอยกลับได้แค่ไฟล์ */ } }

  const report = () => send?.({ type: 'update_status', state, build: offer?.build || null, error, retryable, retryAt });

  /*
    ผลติดตั้งครั้งล่าสุด (last-result.json) ถูกเขียนโดยคนอื่น — ตัวเฝ้าของการสลับในที่ หรือ edge-run — หลังจาก
    gateway รุ่นใหม่ต่อสายไปแล้ว จึงตรวจเป็นระยะแล้วส่งเมื่อยังไม่เคยส่ง (ธง reported ในไฟล์)
  */
  function reportLastResult() {
    if (!send) return false;
    const last = readJson('last-result.json');
    if (!last || last.reported) return false;
    const st = last.ok ? 'installed' : last.rolledBack ? 'rolled_back' : 'failed';
    send({ type: 'update_status', state: st, build: last.build, error: last.error || null });
    try { writeJson('last-result.json', { ...last, reported: true }); } catch { /* ไม่เป็นไร */ }
    return true;
  }
  setInterval(reportLastResult, 10_000).unref();

  function setState(next, err = null) {
    state = next;
    error = err;
    report();
  }

  /** โหลดแพ็กเกจลงไฟล์ .part พร้อมนับ sha256 — คืน sha256 */
  async function download(url, token, dest, size) {
    const res = await new Promise((resolve, reject) => {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`central ตอบ ${res.statusCode}`));
          return;
        }
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new Error('หมดเวลาโหลด')));
      req.on('error', reject);
    });
    const h = crypto.createHash('sha256');
    let got = 0;
    res.on('data', (d) => {
      h.update(d);
      got += d.length;
      progress = size ? Math.round((got / size) * 100) : 0;
      if (size && got > size) res.destroy(new Error('แพ็กเกจใหญ่กว่าขนาดที่ระบุ'));
    });
    await pipeline(res, fs.createWriteStream(dest));
    return h.digest('hex');
  }

  /** central เสนอเวอร์ชันใหม่ — httpBase = http://<central>:<port> ของเส้นทางที่ต่อติดอยู่ */
  async function handleOffer(m, { httpBase, token }) {
    if (downloading || state === 'installing') return;
    if (offer?.sha256 !== m?.sha256) retryCount = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
    retryable = false;
    const problem = verifyManifestV2(m);
    if (problem) {
      console.warn(`[Edge update] ไม่รับข้อเสนอจาก central: ${problem}`);
      offer = { build: m?.build || null };
      setState('failed', `แพ็กเกจไม่ผ่านการตรวจลายเซ็น: ${problem}`);
      return;
    }
    if (m.platform !== PLATFORM) return;
    // manifest ที่ออกก่อนตัวที่เคยรับ = การเล่นซ้ำเพื่อลดเวอร์ชัน (ลายเซ็นถูกแต่เก่า) — ไม่รับ
    const stale = checkManifestOrder(m, readJson(ACCEPTED));
    if (stale) {
      console.warn(`[Edge update] ไม่รับข้อเสนอจาก central: ${stale}`);
      offer = { build: m.build };
      setState('failed', stale);
      return;
    }
    // จำ manifest ล่าสุดที่รับ — ตัวที่ออกก่อนหน้านี้จะถูกปฏิเสธตั้งแต่นี้ (edge-run ตรวจซ้ำก่อนติดตั้ง)
    try { writeJson(ACCEPTED, { issuedAt: m.issuedAt, sha256: m.sha256, build: m.build, at: nowIso() }); } catch { /* ไม่มีที่เขียน = ตรวจลำดับไม่ได้รอบหน้า */ }
    offer = m;
    retryContext = { httpBase, token };
    if (m.build === BUILD) { offer = null; setState('idle'); return; }
    if (!CAN_INSTALL) {
      console.log(`[Edge update] มีเวอร์ชันใหม่ ${m.build} (เครื่องนี้ ${BUILD}) — เครื่องนี้ติดตั้งให้เองไม่ได้ ต้องอัปเดตเอง`);
      setState('available');
      return;
    }
    const ready = readJson('pending.json');
    if (ready && ready.sha256 === m.sha256 && fs.existsSync(file(m.file))) {
      // pending.json ที่โหลดไว้โดยรุ่นก่อนอาจไม่มี sig2 — เติมจาก manifest ที่เพิ่งตรวจผ่าน ไม่งั้นติดตั้งไม่ได้
      if (!ready.sig2) { try { writeJson('pending.json', { ...ready, ...m }); } catch { /* ไม่เป็นไร */ } }
      setState('ready');
      return;
    }
    if (downloading) return;

    const dest = file(m.file);
    fs.mkdirSync(DIR, { recursive: true });
    progress = 0;
    setState('downloading');
    console.log(`[Edge update] โหลด ${m.build} (${(m.size / 1e6).toFixed(1)} MB) จาก central`);
    downloading = (async () => {
      try {
        const sha = await download(`${httpBase}${m.path}`, token, `${dest}.part`, m.size);
        if (sha !== m.sha256) throw new Error('sha256 ของไฟล์ที่โหลดไม่ตรงกับ manifest');
        if (fs.statSync(`${dest}.part`).size !== m.size) throw new Error('ขนาดไฟล์ไม่ตรงกับ manifest');
        if (IN_PLACE) {
          const list = spawnSync('tar', ['-tzf', `${dest}.part`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          if (!/(^|\/)scripts\/edge-update-watchdog\.cjs$/m.test(list.stdout || '')) {
            throw new Error('แพ็กเกจรุ่นนี้เก่ากว่าระบบอัปเดตผ่านสาย (ไม่มีตัวเฝ้า) — ติดตั้งแบบนี้ไม่ได้');
          }
        }
        fs.renameSync(`${dest}.part`, dest);
        // ลบแพ็กเกจรุ่นอื่นที่ค้างอยู่
        for (const f of fs.readdirSync(DIR)) if (/^app-.*\.tar\.gz(\.part)?$/.test(f) && f !== m.file) fs.rmSync(file(f), { force: true });
        writeJson('pending.json', { ...m, downloadedAt: new Date().toISOString() });
        console.log(`[Edge update] ${m.build} พร้อมติดตั้ง — กดติดตั้งที่หน้าเว็บของ edge`);
        setState('ready');
      } catch (err) {
        fs.rmSync(`${dest}.part`, { force: true });
        console.warn(`[Edge update] โหลดไม่สำเร็จ: ${err.message}`);
        retryable = true;
        if (send && retryCount < 3) {
          const delay = [5000, 15000, 60000][retryCount++];
          retryAt = new Date(Date.now() + delay).toISOString();
          retryTimer = setTimeout(() => handleOffer(m, { httpBase, token }), delay);
          retryTimer.unref?.();
        }
        setState('failed', `โหลดไม่สำเร็จ: ${err.message}`);
      } finally {
        downloading = null;
      }
    })();
  }

  /**
   * สลับไฟล์ใน repo (pm2 บน Linux): แตกแพ็กเกจเป็น .update-new → ย้ายของเดิมไป .update-prev → ย้ายของใหม่เข้าที่
   * → ปล่อยตัวเฝ้าแบบแยกโปรเซส → ปิดตัวเองให้ pm2 เปิดรุ่นใหม่
   */
  function applyInPlace(ready) {
    const newDir = path.join(REPO, '.update-new');
    const prevDir = path.join(REPO, '.update-prev');
    try {
      const pkg = file(ready.file);
      if (fs.statSync(pkg).size !== ready.size || crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex') !== ready.sha256) {
        throw new Error('ขนาดหรือ SHA-256 ของแพ็กเกจก่อนติดตั้งไม่ตรงกับ manifest');
      }
      fs.rmSync(newDir, { recursive: true, force: true });
      fs.mkdirSync(newDir, { recursive: true });
      const tar = spawnSync('tar', ['-xzf', pkg, '-C', newDir], { encoding: 'utf8' });
      if (tar.status !== 0) throw new Error(`แตกแพ็กเกจไม่ได้: ${(tar.stderr || tar.error?.message || '').trim()}`);
      const newBuild = fs.readFileSync(path.join(newDir, 'BUILD'), 'utf8').trim();
      if (newBuild !== ready.build) throw new Error(`BUILD ในแพ็กเกจ (${newBuild}) ไม่ตรงกับ manifest`);
      const entries = fs.readdirSync(newDir);
      const stray = entries.filter((e) => !IN_PLACE_ENTRIES.includes(e));
      if (stray.length || !entries.includes('server')) throw new Error(`แพ็กเกจมีของที่ไม่คาด: ${stray.join(', ') || 'ไม่มี server/'}`);
      // ตัวเฝ้าต้องอยู่นอก repo — ไฟล์ใน repo กำลังจะถูกย้าย
      const watchdog = file('watchdog.cjs');
      fs.copyFileSync(path.join(newDir, 'scripts', 'edge-update-watchdog.cjs'), watchdog);
      // สคริปต์ .sh ในแพ็กเกจที่สร้างบน Windows ไม่มีสิทธิ์ execute
      for (const f of fs.readdirSync(path.join(newDir, 'scripts'))) if (f.endsWith('.sh')) fs.chmodSync(path.join(newDir, 'scripts', f), 0o755);

      fs.rmSync(prevDir, { recursive: true, force: true });
      fs.mkdirSync(prevDir, { recursive: true });
      for (const e of entries) {
        if (fs.existsSync(path.join(REPO, e))) fs.renameSync(path.join(REPO, e), path.join(prevDir, e));
        fs.renameSync(path.join(newDir, e), path.join(REPO, e));
      }
      fs.rmSync(newDir, { recursive: true, force: true });
      const plan = { repo: REPO, upd: DIR, entries, build: ready.build, from: BUILD, file: ready.file, since: Date.now(), waitMs: HEALTH_WAIT_MS };
      writeJson('plan.json', plan);
      spawn(process.execPath, [watchdog, file('plan.json')], { detached: true, stdio: 'ignore' }).unref();
      console.log(`[Edge update] สลับไฟล์เป็น ${ready.build} แล้ว — ปิดตัวให้ pm2 เปิดรุ่นใหม่ (ตัวเฝ้าถอยกลับเองถ้าไม่ติดใน ${Math.round(HEALTH_WAIT_MS / 1000)} วิ)`);
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      // ยังไม่ได้สลับอะไร หรือสลับไม่ครบ — คืนของที่ย้ายไปแล้ว
      if (fs.existsSync(prevDir)) {
        for (const e of fs.readdirSync(prevDir)) {
          try {
            if (fs.existsSync(path.join(REPO, e))) fs.rmSync(path.join(REPO, e), { recursive: true, force: true });
            fs.renameSync(path.join(prevDir, e), path.join(REPO, e));
          } catch { /* ต้องดูมือ */ }
        }
      }
      fs.rmSync(newDir, { recursive: true, force: true });
      console.warn(`[Edge update] ติดตั้งไม่สำเร็จ: ${err.message}`);
      writeJson('last-result.json', { ok: false, build: ready.build, from: BUILD, rolledBack: false, error: err.message, at: new Date().toISOString() });
      setState('failed', err.message);
    }
  }

  return {
    /** สาย link ต่อติด — จำ send ไว้รายงานสถานะ และบันทึก link-ok ให้ edge-run รู้ว่าเวอร์ชันนี้ต่อ central ได้ */
    linked(sendFn, healthCheck) {
      send = sendFn;
      const generation = ++linkGeneration;
      clearTimeout(healthTimer);
      // ต่อสายได้อย่างเดียวไม่พอ: API และ catalog ต้องอ่านได้ก่อนยืนยันให้ตัวเฝ้าลบรุ่นเก่า
      const confirmHealth = async () => {
        try {
          if (!healthCheck) throw new Error('ไม่มีตัวตรวจ API/catalog');
          await healthCheck();
          if (generation === linkGeneration && send) writeJson('link-ok.json', { build: BUILD, at: Date.now(), api: true, catalog: true });
        } catch {
          if (generation === linkGeneration && send) {
            healthTimer = setTimeout(confirmHealth, 5000);
            healthTimer.unref?.();
          }
        }
      };
      confirmHealth();
      if (!reportLastResult()) report();
      if (retryable && retryContext && !downloading) handleOffer(offer, retryContext);
    },
    unlinked() {
      send = null;
      linkGeneration++;
      clearTimeout(healthTimer);
      clearTimeout(retryTimer);
      retryAt = null;
    },
    handleOffer,
    /** คนกดลองใหม่ได้เฉพาะโหลดล้มเหลว ไม่ข้ามด่านลายเซ็นหรือสั่งติดตั้งซ้ำ */
    retryDownload() {
      if (!retryable || !offer || !retryContext || downloading || state !== 'failed') {
        throw Object.assign(new Error('ยังไม่มีการโหลดที่ล้มเหลวให้ลองใหม่'), { status: 409 });
      }
      retryCount = 0;
      handleOffer(offer, retryContext);
      return { build: offer.build, requested: true };
    },

    /** สถานะให้หน้าเว็บของ edge */
    status() {
      const shown = offer && offer.build ? { build: offer.build, size: offer.size || null, createdAt: offer.createdAt || null } : null;
      return {
        current: BUILD,
        platform: PLATFORM,
        runner: RUNNER,
        canInstall: CAN_INSTALL,
        mode: RUNNER === 'edge-run' ? 'edge-run' : IN_PLACE ? 'in-place' : 'manual',
        offer: shown,
        state,
        error,
        progress,
        retryable,
        retryAt,
        lastResult: readJson('last-result.json'),
      };
    },

    /** คนกดติดตั้ง (หน้าเว็บของ edge หรือ central ผ่านสาย) — edge-run ทำจาก apply.json · pm2 บน Linux สลับไฟล์เอง */
    requestApply(username) {
      if (!CAN_INSTALL) throw Object.assign(new Error('เครื่องนี้ติดตั้งอัปเดตเองไม่ได้ — อัปเดตตามขั้นตอนบนหน้าเว็บของ edge'), { status: 409 });
      const ready = readJson('pending.json');
      if (state !== 'ready' || !ready) throw Object.assign(new Error('ยังไม่มีแพ็กเกจที่พร้อมติดตั้ง'), { status: 409 });
      // pending.json อยู่บนดิสก์มาระยะหนึ่ง — ตรวจลายเซ็นและลำดับซ้ำก่อนสลับไฟล์ (edge-run ทำแบบเดียวกันอีกชั้น)
      const bad = verifyManifestV2(ready) || checkManifestOrder(ready, readJson(ACCEPTED));
      if (bad) {
        setState('failed', bad);
        throw Object.assign(new Error(`แพ็กเกจที่โหลดไว้ใช้ไม่ได้: ${bad}`), { status: 409 });
      }
      fs.rmSync(file('last-result.json'), { force: true });
      if (IN_PLACE) setTimeout(() => applyInPlace(ready), 1000); // ตอบคนสั่งก่อน แล้วค่อยปิดตัว
      else writeJson('apply.json', { build: ready.build, sha256: ready.sha256, file: ready.file, by: username || null, at: new Date().toISOString() });
      console.log(`[Edge update] ${username || '?'} สั่งติดตั้ง ${ready.build}`);
      setState('installing');
      return { build: ready.build };
    },
  };
}

module.exports = { createEdgeUpdater };
