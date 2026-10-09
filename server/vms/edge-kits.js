/**
 * ชุดติดตั้ง edge ให้ดาวน์โหลดจากหน้า Edge Nodes ของ central — docs/EDGE-KIT.md
 *
 * scripts/build-edge-kit.ps1 -Publish วางไว้ที่ <state>/edge-kits/
 *   Edge-<platform>-<build>.zip | .tar.gz   ชุดติดตั้งของแพลตฟอร์มเดียว (ตัวติดตั้ง + โปรแกรม) ไม่มี secret
 *     (ก่อน 2026-10-09 ชื่อ GW-Edge-… — ยังรับทั้งสองแบบ ให้ kits.json เก่าและ Regional ที่ยังไม่อัปเดตใช้ได้)
 *   kits.json                                  [{ platform, build, file, size, sha256 }]
 * ไฟล์ใหญ่ (~300 MB) — เบราว์เซอร์ดาวน์โหลดตรงด้วยตั๋วใช้ครั้งเดียว อายุ 5 นาที แทนการโหลดผ่าน fetch
 * ซึ่งต้องถือทั้งไฟล์ไว้ในหน่วยความจำ (checkAuth ใช้ header จึงผูกกับลิงก์ธรรมดาไม่ได้)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateFile } = require('../shared/instance');

const DIR = stateFile('edge-kits');
const TICKET_MS = 5 * 60_000;
const tickets = new Map(); // ticket → { file, until }

/** รายการชุดที่เผยแพร่ — ข้ามรายการที่ไฟล์หายไปแล้ว */
function list() {
  let kits = [];
  try { kits = JSON.parse(fs.readFileSync(path.join(DIR, 'kits.json'), 'utf8')); } catch { return []; }
  return (Array.isArray(kits) ? kits : []).filter((k) => k && /^(?:GW-)?Edge-[\w-]+\.(zip|tar\.gz)$/.test(k.file) && fs.existsSync(path.join(DIR, k.file)));
}

/** ออกตั๋วดาวน์โหลดให้ผู้ใช้ที่ login แล้ว — คืน URL ที่เบราว์เซอร์เปิดได้ตรง */
function issueTicket(file) {
  const kit = list().find((k) => k.file === file);
  if (!kit) return null;
  const now = Date.now();
  for (const [t, v] of tickets) if (v.until < now) tickets.delete(t);
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { file: kit.file, until: now + TICKET_MS });
  return `/edge-kit-download/${ticket}`;
}

/** route ดาวน์โหลดด้วยตั๋ว — อยู่นอก /api (ไม่มี header ของผู้ใช้) ตั๋วใช้ได้ครั้งเดียว */
function downloadHandler(req, res) {
  const t = tickets.get(req.params.ticket);
  tickets.delete(req.params.ticket);
  if (!t || t.until < Date.now()) return res.status(403).send('ลิงก์ดาวน์โหลดหมดอายุ — กดดาวน์โหลดใหม่จากหน้า Edge Nodes');
  const full = path.join(DIR, t.file);
  res.download(full, t.file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}

module.exports = { DIR, list, issueTicket, downloadHandler };
