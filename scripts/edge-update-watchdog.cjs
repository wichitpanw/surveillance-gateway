/**
 * ตัวเฝ้าหลังอัปเดตแบบสลับไฟล์ในที่ (edge ที่รันด้วย pm2 บน Linux — docs/EDGE-KIT.md ข้อ 5)
 *
 * gateway รุ่นเก่าสลับไฟล์ใน repo แล้วปิดตัวเองให้ pm2 เปิดรุ่นใหม่ — ถ้ารุ่นใหม่พังตั้งแต่เปิด มันแก้ตัวเองไม่ได้
 * จึงต้องมีโปรเซสแยกนี้ (ถูกก๊อปไปไว้ที่ <state>/updates/ ก่อนสลับ เพราะไฟล์ใน repo กำลังจะถูกแทน) คอยดู:
 *   รุ่นใหม่ต่อ central ติดภายในเวลา (link-ok.json มี build ใหม่) → ลบของเก่า เขียนผลสำเร็จ
 *   ไม่ติด → ย้ายไฟล์เก่ากลับ เขียนผลถอยกลับ แล้วปิด gateway (pid จาก gateway.pid) ให้ pm2 เปิดรุ่นเดิม
 *
 *   node watchdog.cjs <plan.json>
 * plan: { repo, upd, entries, build, from, since, waitMs }
 */
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prevDir = path.join(plan.repo, '.update-prev');
const failedDir = path.join(plan.repo, '.update-failed');
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
};
const log = (msg) => {
  try { fs.appendFileSync(path.join(plan.upd, 'watchdog.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ไม่เป็นไร */ }
};
const result = (r) => fs.writeFileSync(path.join(plan.upd, 'last-result.json'), `${JSON.stringify({ ...r, at: new Date().toISOString() }, null, 2)}\n`);
const cleanup = (...names) => { for (const n of names) fs.rmSync(path.join(plan.upd, n), { recursive: true, force: true }); };

async function main() {
  log(`เฝ้าเวอร์ชัน ${plan.build} (จาก ${plan.from}) ไม่เกิน ${Math.round(plan.waitMs / 1000)} วินาที`);
  const deadline = Date.now() + plan.waitMs;
  while (Date.now() < deadline) {
    const ok = readJson(path.join(plan.upd, 'link-ok.json'));
    if (ok && ok.build === plan.build && ok.at > plan.since) {
      fs.rmSync(prevDir, { recursive: true, force: true });
      result({ ok: true, build: plan.build, from: plan.from });
      cleanup('pending.json', plan.file || '__none__', 'plan.json');
      log('สำเร็จ');
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  log('ไม่ติดภายในเวลา — ถอยกลับ');
  fs.rmSync(failedDir, { recursive: true, force: true });
  fs.mkdirSync(failedDir, { recursive: true });
  for (const e of plan.entries) {
    const cur = path.join(plan.repo, e);
    const old = path.join(prevDir, e);
    try { if (fs.existsSync(cur)) fs.renameSync(cur, path.join(failedDir, e)); } catch (err) { log(`ย้าย ${e} ใหม่ออกไม่ได้: ${err.message}`); }
    try { if (fs.existsSync(old)) fs.renameSync(old, cur); } catch (err) { log(`คืน ${e} ไม่ได้: ${err.message}`); }
  }
  fs.rmSync(prevDir, { recursive: true, force: true });
  result({ ok: false, build: plan.build, from: plan.from, rolledBack: true, error: `เวอร์ชัน ${plan.build} ต่อ central ไม่ติดภายใน ${Math.round(plan.waitMs / 1000)} วินาที` });
  cleanup('plan.json');
  // ปิด gateway รุ่นใหม่ที่ยังรันอยู่ (ถ้ามี) ให้ pm2 เปิดรุ่นเดิมที่เพิ่งคืนไฟล์
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(plan.upd, 'gateway.pid'), 'utf8').trim()) || 0; } catch { /* ไม่มีไฟล์ */ }
  if (pid) { try { process.kill(pid); log(`ปิด gateway pid ${pid}`); } catch { /* ตายไปแล้ว */ } }
}

main().catch((err) => log(`ผิดพลาด: ${err.message}`));
