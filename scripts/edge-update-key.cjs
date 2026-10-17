/**
 * กุญแจเซ็นแพ็กเกจอัปเดตของ edge (ed25519) — docs/EDGE-KIT.md
 *
 *   node scripts/edge-update-key.cjs --keygen [--key D:\gw-edge-kits\signing\edge-update-key.pem]
 *     สร้างกุญแจคู่ใหม่ · กุญแจลับไปที่ --key (นอก git ห้ามหาย ห้ามรั่ว) · public key ไปที่
 *     scripts/edge-kit/edge-update.pub.pem (อยู่ใน git และไปกับชุดติดตั้ง) · ไม่ทับกุญแจที่มีอยู่
 *
 *   node scripts/edge-update-key.cjs --sign <app-…tar.gz> --build <build> --platform <platform> [--key …]
 *     เขียน <ไฟล์>.manifest.json ที่มี size, sha256 และลายเซ็นสองชุด:
 *       signature  ลายเซ็นเดิม (build, platform, file, size, sha256) — edge รุ่นก่อน 2026-09-29 ตรวจอันนี้ ห้ามเปลี่ยนเนื้อหา
 *       sig2       ลายเซ็นที่ครอบ issuedAt ด้วย — edge รุ่นใหม่บังคับ และไม่รับ manifest ที่ issuedAt เก่ากว่าที่เคยรับ
 *                  (กันการเล่นซ้ำ manifest เก่าที่เซ็นถูกต้องเพื่อลดเวอร์ชัน — สาย link ยังไม่มี TLS)
 *
 * ไฟล์นี้ require ได้ (ไม่รัน main) — edge-update-client.js ใช้ verifyManifestV2 / checkManifestOrder
 *
 * เปลี่ยนกุญแจ = edge ทุกตัวที่ติดตั้งไว้แล้วจะไม่เชื่อแพ็กเกจใหม่ จนกว่าจะอัปเดตด้วย flash drive ชุดที่มี public key ใหม่
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PUBKEY_PATH, signManifest, verifyManifest, sha256File } = require('../server/shared/edge-update-manifest');
const { nowIso } = require('../server/shared/time');

/** ข้อความที่ sig2 เซ็น — ลำดับ key ตายตัว · v:2 กันไม่ให้ลายเซ็นชุดนี้ถูกนำไปใช้เป็น signature เดิม */
const payloadV2Of = (m) => JSON.stringify({
  v: 2, build: String(m.build), platform: String(m.platform), file: String(m.file),
  size: Number(m.size), sha256: String(m.sha256), issuedAt: String(m.issuedAt),
});

/** เซ็น sig2 ของ manifest (ต้องมี issuedAt แล้ว) */
function signManifestV2(m, privateKeyPem) {
  return crypto.sign(null, Buffer.from(payloadV2Of(m)), privateKeyPem).toString('base64');
}

/** ตรวจ signature เดิม + sig2 — คืนข้อความปัญหา หรือ null ถ้าผ่าน · ไม่มี sig2 = ไม่ผ่าน (manifest รุ่นเก่า เล่นซ้ำได้) */
function verifyManifestV2(m, publicKeyPem = null) {
  const problem = verifyManifest(m, publicKeyPem);
  if (problem) return problem;
  if (!m.sig2 || !m.issuedAt) return 'manifest ไม่มี sig2/issuedAt (เซ็นด้วยสคริปต์รุ่นเก่า) — edge รุ่นนี้ไม่รับ';
  if (!Number.isFinite(Date.parse(String(m.issuedAt)))) return 'issuedAt ไม่ถูกรูปแบบ';
  let pem = publicKeyPem;
  if (!pem) {
    try { pem = fs.readFileSync(PUBKEY_PATH, 'utf8'); } catch { return `ไม่พบ public key (${PUBKEY_PATH})`; }
  }
  try {
    const ok = crypto.verify(null, Buffer.from(payloadV2Of(m)), pem, Buffer.from(String(m.sig2), 'base64'));
    return ok ? null : 'sig2 ไม่ถูกต้อง';
  } catch (err) {
    return `ตรวจ sig2 ไม่ได้: ${err.message}`;
  }
}

/**
 * manifest นี้ใหม่กว่าหรือเท่ากับที่เคยรับไหม — last = { issuedAt, sha256 } ที่ edge เก็บไว้ (null = ยังไม่เคยรับ)
 * เก่ากว่า = ปฏิเสธ (การเล่นซ้ำเพื่อลดเวอร์ชัน) · เวลาเท่ากันแต่คนละไฟล์ = ปฏิเสธ · ตัวเดิมซ้ำ = ผ่าน (central เสนอซ้ำตอนต่อสายใหม่)
 */
function checkManifestOrder(m, last) {
  if (last === null || last === undefined) return null;
  if (!last.issuedAt || !/^[0-9a-f]{64}$/.test(String(last.sha256))) return 'accepted manifest ไม่ครบหรือไม่ถูกต้อง — ไม่ลดเวอร์ชัน';
  const now = Date.parse(String(m.issuedAt));
  const prev = Date.parse(String(last.issuedAt));
  if (!Number.isFinite(prev)) return 'accepted manifest issuedAt ไม่ถูกต้อง — ไม่ลดเวอร์ชัน';
  if (now < prev) return `manifest ออกเมื่อ ${m.issuedAt} เก่ากว่าที่เคยรับ (${last.issuedAt}) — ไม่ลดเวอร์ชัน`;
  if (now === prev && last.sha256 && last.sha256 !== m.sha256) return 'manifest เวลาเดียวกับที่เคยรับแต่คนละแพ็กเกจ';
  return null;
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const keyPath = arg('--key') || 'D:\gw-edge-kits\signing\edge-update-key.pem';
  if (process.argv.includes('--keygen')) {
    if (fs.existsSync(keyPath)) throw new Error(`มีกุญแจอยู่แล้วที่ ${keyPath} — ไม่ทับ (ลบเองถ้าตั้งใจเปลี่ยนกุญแจ)`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(PUBKEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
    console.log(`กุญแจลับ: ${keyPath}  ← สำรองไว้ที่ปลอดภัย`);
    console.log(`public key: ${PUBKEY_PATH}  ← commit ไฟล์นี้`);
    return;
  }

  const file = arg('--sign');
  if (file) {
    const build = arg('--build');
    const platform = arg('--platform');
    if (!build || !platform) throw new Error('ต้องมี --build และ --platform');
    const privateKey = fs.readFileSync(keyPath, 'utf8');
    const m = { build, platform, file: path.basename(file), size: fs.statSync(file).size, sha256: await sha256File(file) };
    m.signature = signManifest(m, privateKey);
    // issuedAt = ลำดับของการเผยแพร่ (ไม่ใช่ของ commit) — ถอยเวอร์ชันโดยตั้งใจ = เซ็นรุ่นเก่าใหม่ ได้ issuedAt ใหม่
    m.issuedAt = nowIso();
    m.sig2 = signManifestV2(m, privateKey);
    // เซ็นแล้วตรวจกับ public key ใน repo ทันที — กุญแจลับกับ public key คนละคู่จะรู้ตั้งแต่ตอนสร้าง ไม่ใช่ที่หน้างาน
    const problem = verifyManifestV2(m);
    if (problem) throw new Error(`เซ็นแล้วตรวจไม่ผ่าน (${problem}) — กุญแจลับไม่ตรงกับ ${PUBKEY_PATH}?`);
    fs.writeFileSync(`${file}.manifest.json`, `${JSON.stringify({ ...m, createdAt: m.issuedAt }, null, 2)}\n`);
    console.log(`เซ็น ${m.file} (${(m.size / 1e6).toFixed(1)} MB) แล้ว`);
    return;
  }

  console.error('ใช้: --keygen [--key <path>] | --sign <file> --build <b> --platform <p> [--key <path>]');
  process.exit(2);
}

module.exports = { payloadV2Of, signManifestV2, verifyManifestV2, checkManifestOrder };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
