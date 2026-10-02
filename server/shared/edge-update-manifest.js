/**
 * แพ็กเกจอัปเดตของ edge (docs/EDGE-KIT.md หัวข้อ "อัปเดตผ่านสาย link") — ส่วนที่ central, edge และสคริปต์สร้างชุดใช้ร่วมกัน
 *
 * แพ็กเกจ = app-<platform>-<build>.tar.gz (เนื้อในคือโฟลเดอร์ app/ ของชุดติดตั้ง) + manifest ที่เซ็นด้วย ed25519
 * สาย link ยังไม่มี TLS — ใครดักกลางทางได้ก็เปลี่ยนไฟล์ได้ edge จึงเชื่อแค่ manifest ที่ลายเซ็นตรงกับ public key
 * ที่มากับชุดติดตั้ง (scripts/edge-kit/edge-update.pub.pem) และไฟล์ที่ sha256 ตรงกับ manifest นั้น
 * กุญแจลับอยู่นอก git ที่เครื่องสร้างชุด (scripts/edge-update-key.cjs)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBKEY_PATH = path.join(__dirname, '..', '..', 'scripts', 'edge-kit', 'edge-update.pub.pem');
const PLATFORMS = ['windows-x64', 'linux-arm64', 'linux-x64'];

/** แพลตฟอร์มของเครื่องนี้ในชื่อเดียวกับโฟลเดอร์ของชุดติดตั้ง — null = ไม่มีแพ็กเกจให้ */
function currentPlatform() {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  const p = os && arch ? `${os}-${arch}` : null;
  return PLATFORMS.includes(p) ? p : null;
}

/** ข้อความที่ถูกเซ็น — ลำดับ key ตายตัว ไม่พึ่งลำดับใน JSON ที่รับมา */
const payloadOf = (m) => JSON.stringify({
  build: String(m.build), platform: String(m.platform), file: String(m.file), size: Number(m.size), sha256: String(m.sha256),
});

function signManifest(m, privateKeyPem) {
  return crypto.sign(null, Buffer.from(payloadOf(m)), privateKeyPem).toString('base64');
}

/** ตรวจลายเซ็นของ manifest — คืนข้อความปัญหา หรือ null ถ้าผ่าน */
function verifyManifest(m, publicKeyPem = null) {
  if (!m || typeof m !== 'object') return 'manifest ว่าง';
  if (!/^[0-9a-f]{7,40}$/i.test(String(m.build))) return 'build ไม่ถูกรูปแบบ';
  if (!PLATFORMS.includes(m.platform)) return `ไม่รู้จักแพลตฟอร์ม ${m.platform}`;
  if (!/^app-[a-z0-9-]+-[0-9a-f]+\.tar\.gz$/i.test(String(m.file))) return 'ชื่อไฟล์ไม่ถูกรูปแบบ';
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) return 'sha256 ไม่ถูกรูปแบบ';
  let pem = publicKeyPem;
  if (!pem) {
    try { pem = fs.readFileSync(PUBKEY_PATH, 'utf8'); } catch { return `ไม่พบ public key (${PUBKEY_PATH})`; }
  }
  try {
    const ok = crypto.verify(null, Buffer.from(payloadOf(m)), pem, Buffer.from(String(m.signature || ''), 'base64'));
    return ok ? null : 'ลายเซ็นไม่ถูกต้อง';
  } catch (err) {
    return `ตรวจลายเซ็นไม่ได้: ${err.message}`;
  }
}

/** sha256 ของไฟล์ (stream — แพ็กเกจหลายสิบ MB) */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { PUBKEY_PATH, PLATFORMS, currentPlatform, payloadOf, signManifest, verifyManifest, sha256File };
