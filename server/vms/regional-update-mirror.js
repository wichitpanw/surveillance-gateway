/** Regional เก็บแพ็กเกจที่ Central เซ็นไว้เพื่อแจกต่อให้ Edge จังหวัด */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { stateFile } = require('../shared/instance');
const { PLATFORMS } = require('../shared/edge-update-manifest');
const { nowIso } = require('../shared/time');
const { verifyManifestV2, checkManifestOrder } = require('../../scripts/edge-update-key.cjs');

const DIR = stateFile('edge-updates');
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function request(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Central ตอบ HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Central ไม่ตอบภายในเวลาที่กำหนด')));
    req.on('error', reject);
  });
}

/** อ่าน catalog ขนาดจำกัด ไม่ให้ข้อมูลจากสายกินหน่วยความจำไม่สิ้นสุด */
async function readCatalog(httpBase, token, route, field) {
  const res = await request(`${httpBase}${route}`, token, 15_000);
  const parts = [];
  let size = 0;
  for await (const part of res) {
    size += part.length;
    if (size > MAX_CATALOG_BYTES) {
      res.destroy();
      throw new Error('catalog ของแพ็กเกจใหญ่เกิน 2 MB');
    }
    parts.push(part);
  }
  const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!Array.isArray(data[field])) throw new Error('Central ส่ง catalog ไม่ถูกต้อง');
  return data[field];
}

/** โหลดแพ็กเกจลง .part แล้วตรวจขนาดและ SHA-256 ก่อนย้ายเข้าโฟลเดอร์ที่แจกได้ */
async function fetchPackage(httpBase, token, manifest, folder, route) {
  const target = path.join(folder, manifest.file);
  const part = `${target}.part`;
  const url = `${httpBase}${route}`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    const res = await request(url, token, 5 * 60_000);
    await pipeline(res, new Transform({
      transform(chunk, _encoding, cb) {
        size += chunk.length;
        if (size > manifest.size) return cb(new Error('แพ็กเกจใหญ่กว่าที่ manifest ระบุ'));
        hash.update(chunk);
        cb(null, chunk);
      },
    }), fs.createWriteStream(part));
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('SHA-256 หรือขนาดแพ็กเกจไม่ตรงกับ manifest');
    fs.renameSync(part, target);
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* เก็บกวาดรอบหน้า */ }
    throw err;
  }
}

/** ตรวจไฟล์ชุดติดตั้งที่อยู่แล้วก่อนประกาศให้ดาวน์โหลด */
const verifiedFiles = new Map();
async function matchesLocal(target, metadata) {
  try {
    const stat = fs.statSync(target);
    if (stat.size !== metadata.size) return false;
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${metadata.sha256}`;
    if (verifiedFiles.get(target) === fingerprint) return true;
    const hash = crypto.createHash('sha256');
    for await (const part of fs.createReadStream(target)) hash.update(part);
    if (hash.digest('hex') !== metadata.sha256) return false;
    verifiedFiles.set(target, fingerprint);
    return true;
  } catch { return false; }
}

function createRegionalUpdateMirror() {
  let running = false;
  let status = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, parentPublished: {}, error: null };

  /** ตรวจลายเซ็นและลำดับ manifest ก่อนเผยแพร่; manifest เขียนเป็นรายการสุดท้าย */
  async function sync(httpBase, token) {
    if (running) return;
    running = true;
    status = { ...status, state: 'syncing', lastAttemptAt: nowIso(), error: null };
    const errors = [];
    try {
      const manifests = await readCatalog(httpBase, token, '/api/edge-link/update-catalog', 'manifests');
      status.parentPublished = Object.fromEntries(manifests.map((m) => [m.platform, m.build]));
      for (const platform of PLATFORMS) if (!manifests.some((m) => m.platform === platform)) errors.push(`Central ยังไม่มีแพ็กเกจ ${platform}`);
      for (const m of manifests) {
        try {
          if (!PLATFORMS.includes(m?.platform) || path.basename(String(m?.file || '')) !== m.file) {
            throw new Error('ชื่อแพลตฟอร์มหรือไฟล์ไม่ถูกต้อง');
          }
          const problem = verifyManifestV2(m);
          if (problem) throw new Error(`ลายเซ็น manifest ไม่ผ่าน: ${problem}`);
          const folder = path.join(DIR, m.platform);
          const manifestFile = path.join(folder, 'manifest.json');
          let previous = null;
          try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* ยังไม่มีแพ็กเกจ */ }
          const stale = checkManifestOrder(m, previous);
          if (stale) throw new Error(stale);
          if (previous?.sha256 === m.sha256 && await matchesLocal(path.join(folder, m.file), m)) continue;
          fs.mkdirSync(folder, { recursive: true });
          await fetchPackage(httpBase, token, m, folder,
            `/api/edge-link/update/${encodeURIComponent(m.platform)}/${encodeURIComponent(m.file)}`);
          fs.writeFileSync(`${manifestFile}.part`, `${JSON.stringify(m, null, 2)}\n`);
          fs.renameSync(`${manifestFile}.part`, manifestFile);
          console.log(`[Regional update] พร้อมแจก ${m.platform} build ${m.build} ให้ Edge จังหวัด`);
        } catch (err) {
          errors.push(`${m?.platform || '?'}: ${err.message}`);
          console.warn(`[Regional update] ${m?.platform || '?'}: ${err.message}`);
        }
      }
      const kits = await readCatalog(httpBase, token, '/api/edge-link/kit-catalog', 'kits');
      const kitDir = stateFile('edge-kits');
      const available = [];
      fs.mkdirSync(kitDir, { recursive: true });
      for (const kit of kits) {
        try {
          if (!/^(?:GW-)?Edge-[\w-]+\.(zip|tar\.gz)$/.test(String(kit?.file || '')) ||
              !PLATFORMS.includes(kit.platform) || !/^[0-9a-f]{64}$/i.test(String(kit.sha256 || '')) ||
              !Number.isSafeInteger(kit.size) || kit.size <= 0) throw new Error('metadata ของชุดติดตั้งไม่ถูกต้อง');
          const target = path.join(kitDir, kit.file);
          if (!await matchesLocal(target, kit)) {
            await fetchPackage(httpBase, token, kit, kitDir, `/api/edge-link/kit/${encodeURIComponent(kit.file)}`);
          }
          available.push(kit);
        } catch (err) {
          errors.push(`ชุดติดตั้ง ${kit?.platform || '?'}: ${err.message}`);
          console.warn(`[Regional update] ชุดติดตั้ง ${kit?.file || '?'}: ${err.message}`);
        }
      }
      fs.writeFileSync(path.join(kitDir, 'kits.json'), `${JSON.stringify(available, null, 2)}\n`);
    } catch (err) {
      errors.push(err.message);
      console.warn(`[Regional update] ดึงรายการแพ็กเกจจาก Central ไม่ได้: ${err.message}`);
    } finally {
      running = false;
      status = { ...status, state: errors.length ? 'failed' : 'ok', error: errors.join(' · ') || null,
        lastSuccessAt: errors.length ? status.lastSuccessAt : nowIso() };
    }
  }

  return { sync, status: () => ({ ...status, parentPublished: { ...status.parentPublished } }) };
}

module.exports = { createRegionalUpdateMirror };
