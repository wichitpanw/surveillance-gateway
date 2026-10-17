const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const ACCEPTED = 'accepted-manifest.json';
const INITIALIZED = 'accepted-manifest.initialized';

// ไฟล์หายจริงเท่านั้นที่แปลว่าไม่มี state; permission/I/O error ต้องไม่กลายเป็น first install
function exists(file) {
  try { fs.statSync(file); return true; } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new Error('อ่านสถานะลำดับ update ไม่ได้');
  }
}
function valid(state) {
  return state && typeof state === 'object'
    && typeof state.issuedAt === 'string' && Number.isFinite(Date.parse(state.issuedAt))
    && typeof state.sha256 === 'string' && /^[0-9a-f]{64}$/.test(state.sha256)
    && typeof state.build === 'string' && /^[0-9a-f]{7,40}$/i.test(state.build);
}
// marker แยกเครื่องใหม่จากเครื่องที่เคยรับ manifest แล้วแต่ accepted file หาย
function readAccepted(dir, { requireExisting = false } = {}) {
  const file = path.join(dir, ACCEPTED);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw new Error('อ่าน accepted manifest ไม่ได้ — ไม่รับ update');
    if (requireExisting || exists(path.join(dir, INITIALIZED))
      || exists(path.join(dir, 'pending.json')) || exists(path.join(dir, 'last-result.json'))) {
      throw new Error('accepted manifest หายหลังเริ่มใช้งาน — ไม่รับ update');
    }
    return null;
  }
  let state;
  try { state = JSON.parse(text); } catch (_) { throw new Error('accepted manifest เสีย — ไม่รับ update'); }
  if (!valid(state)) throw new Error('accepted manifest ไม่ครบหรือไม่ถูกต้อง — ไม่รับ update');
  return state;
}
// เขียนไฟล์ใหม่ให้ครบและ sync ก่อน rename; ถ้าเขียนไม่ได้ต้องไม่รับ offer ต่อ
function writeAccepted(dir, manifest, at) {
  const state = { issuedAt: manifest.issuedAt, sha256: manifest.sha256, build: manifest.build, at };
  if (!valid(state)) throw new Error('accepted manifest ไม่ถูกต้อง');
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `${ACCEPTED}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // เขียน marker ก่อนยอมรับ offer; marker ค้างแต่ accepted หายต้อง fail closed
    const marker = path.join(dir, INITIALIZED);
    if (!exists(marker)) {
      const markerFd = fs.openSync(marker, 'wx', 0o600);
      try { fs.writeFileSync(markerFd, '1\n'); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
    }
    fs.renameSync(temp, path.join(dir, ACCEPTED));
  } catch (_) {
    throw new Error('บันทึก accepted manifest ไม่สำเร็จ — ไม่รับ update');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw new Error('ล้างไฟล์ชั่วคราว update ไม่สำเร็จ'); }
  }
}

module.exports = { readAccepted, writeAccepted };
