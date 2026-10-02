/**
 * คลังแพ็กเกจอัปเดตของ edge ที่ central — docs/EDGE-KIT.md หัวข้อ "อัปเดตผ่านสาย link"
 *
 * scripts/build-edge-kit.ps1 -Publish วางไฟล์ไว้ที่ <state>/edge-updates/<platform>/
 *   manifest.json                  build, platform, file, size, sha256, signature (เซ็นด้วยกุญแจลับที่เครื่องสร้างชุด)
 *   app-<platform>-<build>.tar.gz
 * ชุดที่อยู่ในโฟลเดอร์ = เวอร์ชันที่ต้องการให้ edge ใช้ · edge ที่ build ไม่ตรงจะได้ข้อเสนอผ่านสาย link
 * แล้วโหลดไฟล์ทาง HTTP จาก central (ใช้ token ของสาย link) — edge เป็นคนตัดสินใจติดตั้ง ไม่ใช่ central
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stateFile } = require('../shared/instance');
const { PLATFORMS, verifyManifest } = require('../shared/edge-update-manifest');

const DIR = stateFile('edge-updates');
const cache = new Map(); // platform → { mtimeMs, manifest }

/** manifest ล่าสุดของแพลตฟอร์ม (ตรวจลายเซ็นแล้ว) — ไม่มีหรือเสีย = null */
function latest(platform) {
  if (!PLATFORMS.includes(platform)) return null;
  const file = path.join(DIR, platform, 'manifest.json');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(platform);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.manifest;
  let manifest = null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problem = verifyManifest(m);
    if (problem) console.warn(`[Edge update] ${platform}/manifest.json ใช้ไม่ได้: ${problem}`);
    else if (!fs.existsSync(path.join(DIR, platform, m.file))) console.warn(`[Edge update] ไม่พบ ${platform}/${m.file}`);
    else {
      manifest = m;
      // edge รุ่นตั้งแต่ 2026-09-29 บังคับ sig2 (กันเล่นซ้ำเพื่อลดเวอร์ชัน) — ยังเสนอให้ edge รุ่นเก่าได้ แต่เตือนให้เซ็นใหม่
      if (!m.sig2 || !m.issuedAt) console.warn(`[Edge update] ${platform}/manifest.json ไม่มี sig2 — edge รุ่นใหม่จะไม่รับ (เซ็นใหม่ด้วย edge-update-key.cjs รุ่นปัจจุบัน)`);
    }
  } catch (err) {
    console.warn(`[Edge update] อ่าน ${platform}/manifest.json ไม่ได้: ${err.message}`);
  }
  cache.set(platform, { mtimeMs: st.mtimeMs, manifest });
  return manifest;
}

/*
  edge ใหม่กว่าแพ็กเกจที่เผยแพร่ไหม (เช่น deploy-edge.sh ไปก่อนแล้วยังไม่ได้ -Publish) — ถ้าใช่ห้ามเสนอ ไม่งั้นปุ่มอัปเดต
  กลายเป็นลดเวอร์ชัน · ถาม git ของ central: แพ็กเกจเป็นบรรพบุรุษของ build ของ edge = edge ใหม่กว่า
  ไม่มี git หรือไม่รู้จัก commit นั้น = ถือว่าไม่ใหม่กว่า (เสนอตามเดิม)
*/
const newerCache = new Map();
function edgeIsNewer(published, edgeBuild) {
  const key = `${published}..${edgeBuild}`;
  if (!newerCache.has(key)) {
    let newer = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', published, edgeBuild], { cwd: path.join(__dirname, '..', '..'), stdio: 'ignore', windowsHide: true });
      newer = true;
    } catch { /* ไม่ใช่บรรพบุรุษ หรือไม่มี git */ }
    newerCache.set(key, newer);
  }
  return newerCache.get(key);
}

/** ข้อเสนออัปเดตสำหรับ edge ที่บอก platform/build มา — null = ไม่มีอะไรให้ */
function offerFor({ platform, build }) {
  const m = latest(platform);
  if (!m || !build || m.build === build) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(String(build)) || edgeIsNewer(m.build, build)) return null;
  return { ...m, path: `/api/edge-link/update/${m.platform}/${m.file}` };
}

/** เวอร์ชันที่เผยแพร่อยู่ของทุกแพลตฟอร์ม — ให้หน้า Edge Nodes แสดง */
const published = () => Object.fromEntries(PLATFORMS.map((p) => [p, latest(p)?.build || null]));
const catalog = () => PLATFORMS.map((platform) => latest(platform)).filter(Boolean);

/**
 * route โหลดไฟล์แพ็กเกจ — ต้องอยู่เหนือ app.use('/api', checkAuth) เพราะ edge ไม่มีบัญชีผู้ใช้
 * ยืนยันตัวด้วย token ของสาย link (Authorization: Bearer) แบบเดียวกับตอนต่อ WebSocket
 */
function downloadHandler(edgeSources) {
  return async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const source = m ? await edgeSources.findLinkSource(m[1]) : null;
    if (!source) return res.status(401).json({ error: 'token ของสาย link ไม่ถูกต้อง' });
    const manifest = latest(req.params.platform);
    if (!manifest || manifest.file !== req.params.file) return res.status(404).json({ error: 'ไม่มีแพ็กเกจนี้แล้ว' });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', manifest.size);
    fs.createReadStream(path.join(DIR, manifest.platform, manifest.file)).on('error', () => res.destroy()).pipe(res);
  };
}

module.exports = { DIR, latest, catalog, offerFor, published, downloadHandler };
