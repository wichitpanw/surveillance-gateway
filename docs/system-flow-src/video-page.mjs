// สร้างหน้าแอนิเมชันสำหรับวิดีโอนำเสนอ (1920×1080) จากไดอะแกรมชุดเดียวกับ system-flow.html
// ใช้: node video-page.mjs <ไฟล์ปลายทาง.html>   แล้ว node render-video.mjs <html> <mp4>
// หน้าไม่มี timer — window.renderAt(t) วาดสภาพ ณ วินาที t แบบกำหนดแน่นอน ให้ตัวถ่ายเฟรมเรียกทีละเฟรม
import fs from 'node:fs';
import * as D from './flow-diagrams.mjs';
import { esc } from './flow-lib.mjs';

const out = process.argv[2];
if (!out) throw new Error('ระบุไฟล์ปลายทาง: node video-page.mjs <out.html>');

// marker id ซ้ำกันข้าม SVG ทำให้ลูกศรหายเมื่อ SVG แรกถูกซ่อน — ใส่ prefix ต่อภาพ
const uniq = (svg, p) => svg.replace(/id="(arrow[\w-]*)"/g, `id="${p}-$1"`).replace(/url\(#(arrow[\w-]*)\)/g, `url(#${p}-$1)`);
const svgs = {
  overview: uniq(D.diagramOverview(), 'a'),
  add: uniq(D.diagramAddCamera(), 'b'),
  catalog: uniq(D.diagramCatalog(), 'c'),
  video: uniq(D.diagramVideoJourney(), 'd'),
  frame: uniq(D.diagramFrame(), 'e'),
  ondemand: uniq(D.diagramOnDemand(), 'f'),
  twopaths: uniq(D.diagramTwoPaths(), 'g'),
};

// ---------------------------------------------------------------- เนื้อหาแต่ละฉาก
// box = [x0,y0,x1,y1] ในพิกัดของไดอะแกรม · view = {cx,cy,s} (ไม่ใส่ = พอดีกรอบ) · reveal = y ที่เปิดให้เห็นถึง
const ys = { cam: 48, e1: 200, e2: 328, r1: 504, r2: 632, c1: 808, c2: 936, cl: 1112 };
const hop = (a, b) => [40, ys[a] - 12, 1180, ys[b] + 76 + 12];
const hopView = (a, b, s = 1.5) => ({ cx: 600, cy: (ys[a] + ys[b] + 76) / 2, s });
const stage = (i) => [32 + i * 192, 68, 32 + i * 192 + 176, 212];

const SCENES = [
  { id: 'title', kind: 'title', dur: 7 },
  {
    id: 'overview', kind: 'svg', svg: 'overview', w: 1200, h: 340, title: 'ภาพรวม — 3 ชั้น จากกล้องถึงผู้ใช้',
    steps: [
      { dur: 6, cap: 'ระบบมี 3 ชั้นตามพื้นที่: Edge (ไซต์/จังหวัด) → Regional (ภาค) → Central (ประเทศ) แล้วจึงถึงผู้ใช้' },
      { dur: 6, box: [28, 28, 428, 180], cap: 'Edge อยู่หน้างาน ดูแลกล้อง และถือรหัสผ่านกล้องไว้ที่เดียว — ชั้นบนไม่เคยเห็นรหัสผ่าน' },
      { dur: 6, box: [404, 72, 932, 180], cap: 'ลูกต่อขึ้นหาแม่เสมอ: สายควบคุม (WebSocket) และภาพ (RTSP) ถูกเปิดจากฝั่งล่างขึ้นไป จึงทะลุ NAT ได้' },
      { dur: 6, box: [904, 28, 1172, 180], cap: 'ผู้ใช้ดูผ่าน Windows Client ด้วย API key — ภาพมาถึงเป็น HTTP fMP4' },
      { dur: 6, box: [584, 160, 1112, 244], cap: 'ถ้าสายไป Central ขาด Client ในภาคต่อ Regional ตรง ๆ ได้ ภาพในภาคยังดูได้ตามปกติ' },
    ],
  },
  {
    id: 'add', kind: 'svg', svg: 'add', w: 960, h: 600, follow: 1.6, title: 'ขั้นที่ 1 — เจ้าหน้าที่เพิ่มกล้องที่ Edge',
    steps: [
      { dur: 4, cap: 'ทุกอย่างเริ่มที่ Edge — Regional และ Central ไม่มีปุ่มเพิ่มกล้องเลย' },
      { dur: 5, num: 1, box: [28, 212, 332, 336], cap: 'เจ้าหน้าที่เปิดหน้าเว็บ Edge → Add Camera ใส่ IP ชื่อผู้ใช้ รหัสผ่าน และเลือกจังหวัด/อำเภอ' },
      { dur: 5, num: 2, box: [512, 36, 932, 236], cap: 'Edge ถามกล้องผ่าน ONVIF ว่ามีช่องภาพอะไร ได้ที่อยู่ RTSP ของภาพหลัก (main) และภาพรอง (sub)' },
      { dur: 5, num: 3, box: [512, 212, 932, 348], cap: 'บันทึกลงฐานข้อมูลของ Edge และออก Global ID เช่น TH-10-101-00001 — ไม่เปลี่ยนตลอดอายุกล้อง' },
      { dur: 5, num: 4, box: [512, 308, 932, 508], cap: 'ลงทะเบียน 4 สตรีมใน go2rtc — ยังไม่ดึงภาพจริงจนกว่าจะมีคนขอดู' },
      { dur: 5, num: 5, box: [512, 92, 932, 268], cap: 'ทุก 15 วินาที Edge เคาะประตูกล้อง (TCP) เพื่อรู้ว่ากล้องยังตอบไหม' },
      { dur: 5, num: 6, box: [308, 344, 564, 540], cap: 'ส่งรายชื่อกล้องขึ้น Regional ทันทีผ่านสาย WebSocket' },
    ],
  },
  {
    id: 'catalog', kind: 'svg', svg: 'catalog', w: 1200, h: 680, follow: 1.45, pin: 88, title: 'ขั้นที่ 2 — รายชื่อกล้องและสถานะเดินทางขึ้นไป',
    steps: [
      { dur: 5, reveal: 96, cap: 'ตรงนี้ยังไม่มีภาพวิดีโอ — มีแต่ข้อความเล็ก ๆ ว่ามีกล้องอะไร สถานะเป็นยังไง' },
      { dur: 6, reveal: 180, box: [120, 100, 460, 176], cap: 'Edge โทรขึ้นไปเปิดสาย WebSocket (hello + link token) — Regional ตรวจแล้วรับสาย (welcome)' },
      { dur: 6, reveal: 280, box: [120, 176, 600, 276], cap: 'Edge ส่งรายชื่อกล้อง (catalog) — Regional บันทึก และเตรียมสตรีม _in รอรับภาพ' },
      { dur: 6, reveal: 380, box: [420, 276, 900, 376], cap: 'Regional ส่งต่อขึ้น Central ด้วยวิธีเดียวกัน — ใช้ Global ID เดิม ไม่ออกใหม่' },
      { dur: 5, reveal: 452, box: [120, 380, 760, 448], cap: 'กล้องหลุดหรือกลับมา: สถานะวิ่งขึ้นไปถึง Central ภายในไม่กี่วินาที' },
      { dur: 6, reveal: 680, box: [720, 460, 1060, 532], cap: 'Client ขอรายชื่อกล้องด้วย API key — ได้ชื่อและสถานะ ไม่มีรหัสผ่านกล้องติดมา' },
    ],
  },
  {
    id: 'video', kind: 'svg', svg: 'video', w: 1200, h: 1272, title: 'ขั้นที่ 3 — ภาพวิ่งผ่านอะไรบ้าง',
    steps: [
      { dur: 6, cap: 'ภาพ 1 เส้นผ่าน 8 จุด 3 เครื่อง ตั้งแต่กล้องจนถึงจอผู้ใช้' },
      { dur: 6, num: 1, box: hop('cam', 'e1'), view: hopView('cam', 'e1'), cap: 'go2rtc ที่ Edge ดึงภาพจากกล้องด้วย RTSP — เฉพาะตอนมีคนดู (ที่อยู่มีรหัสผ่านกล้อง)' },
      { dur: 6, num: 2, box: hop('e1', 'e2'), view: hopView('e1', 'e2'), cap: 'ffmpeg อ่านจาก go2rtc ในเครื่องเดียวกัน — กล้องถูกดึงแค่สายเดียว ไม่ว่ามีคนดูกี่คน' },
      { dur: 6, num: 3, box: hop('e2', 'r1'), view: hopView('e2', 'r1'), cap: 'ffmpeg ผลักภาพขึ้น Regional (RTSP push) แบบคัดลอกแพ็กเก็ต — ไม่แปลงโค้ด' },
      { dur: 6, num: 4, box: hop('r1', 'r2'), view: hopView('r1', 'r2'), cap: 'Regional ต่อสตรีม _in → _raw ให้ ffmpeg ตัวถัดไปอ่าน' },
      { dur: 6, num: 5, box: hop('r2', 'c1'), view: hopView('r2', 'c1'), cap: 'ผลักต่อขึ้น Central — ภาพยังเป็น H.265 ชุดเดิมจากกล้องทุกประการ' },
      { dur: 6, num: 6, box: hop('c1', 'c2'), view: hopView('c1', 'c2'), cap: 'Gateway ขอจาก go2rtc ทาง HTTP — เปลี่ยนจาก RTSP เป็นไฟล์ fMP4 ทีละท่อน' },
      { dur: 6, num: 7, box: hop('c2', 'cl'), view: hopView('c2', 'cl'), cap: 'ส่งถึง Windows Client ผ่านพอร์ต 5173 พร้อม token — GPU ของเครื่องผู้ใช้ถอดรหัสแล้วแสดงผล' },
    ],
  },
  {
    id: 'ladder', kind: 'ladder', title: 'ที่อยู่ (URL) เปลี่ยนไปยังไง — กล้องตัวเดียวกัน',
    steps: [
      { dur: 5, cap: 'กล้อง (ต้นทาง): รหัสผ่านกล้อง + IP หน้างาน เก็บที่ Edge ที่เดียว' },
      { dur: 4.5, cap: 'go2rtc ที่ Edge ใช้ที่อยู่เดิม แค่เติม #backchannel=0' },
      { dur: 4.5, cap: 'ffmpeg อ่านจาก go2rtc ในเครื่อง — รหัสผ่านและ IP กล้องหายไปจากที่อยู่แล้ว' },
      { dur: 4.5, cap: 'ผลักข้ามไป Regional: ชื่อสตรีมกลายเป็น cam_edge_101_<แฮช>_in บอกไม่ได้ว่ากล้องตัวไหน' },
      { dur: 4.5, cap: 'Regional อ่านต่อ: ท้ายชื่อเปลี่ยนจาก _in เป็น _raw' },
      { dur: 4.5, cap: 'ผลักข้ามไป Central: ชื่อเปลี่ยนอีกรอบเป็น cam_edge_100_<แฮชใหม่>_in' },
      { dur: 4.5, cap: 'Gateway ขอจาก go2rtc: ออกจาก RTSP เป็น HTTP · video=copy ไม่แปลงโค้ด' },
      { dur: 6, cap: 'ผู้ชมได้ HTTP พอร์ตเดียว พร้อม token อายุราว 5 นาที — ไม่เห็น IP และรหัสผ่านกล้องเลย' },
    ],
  },
  {
    id: 'frame', kind: 'svg', svg: 'frame', w: 1200, h: 268, follow: 2, title: 'ชีวิตของภาพ 1 เฟรม',
    steps: [
      { dur: 4.5, box: stage(0), cap: 'กล้องจับภาพ — ภาพนิ่งหลายสิบภาพต่อวินาทีรวมกันเป็นวิดีโอ' },
      { dur: 4.5, box: stage(1), cap: 'ชิปในกล้องบีบอัดเป็น H.265 ให้เล็กลงมาก' },
      { dur: 4.5, box: stage(2), cap: 'หั่นเป็นแพ็กเก็ต RTP ชิ้นเล็ก ใส่ลำดับและเวลา ส่งผ่าน TCP' },
      { dur: 5, box: stage(3), cap: 'Edge → Regional → Central: คัดลอกแพ็กเก็ตต่อกันไป ไม่แกะ ไม่บีบใหม่' },
      { dur: 4.5, box: stage(4), cap: 'Central ประกอบกลับเป็นเฟรม แล้วห่อใหม่เป็น fMP4 ส่งทาง HTTP' },
      { dur: 4.5, box: stage(5), cap: 'Windows Client ถอดรหัสด้วยการ์ดจอ แล้ววาดลงจอ' },
    ],
  },
  {
    id: 'ondemand', kind: 'svg', svg: 'ondemand', w: 1200, h: 844, follow: 1.5, pin: 88, title: 'ขั้นที่ 4 — ใครสั่งให้ภาพเริ่มวิ่งและหยุด',
    steps: [
      { dur: 4, reveal: 92, cap: 'ภาพไม่วิ่งตลอดเวลา — ไม่มีคนดู ข้อมูลภาพไม่ข้ามเครือข่ายเลย' },
      { dur: 6, reveal: 208, box: [80, 96, 360, 208], cap: 'ผู้ใช้กดดู: Client ขอ URL + token แล้วเปิดภาพที่ Central' },
      { dur: 5, reveal: 272, box: [200, 208, 480, 272], cap: 'Central ยังไม่มีภาพ จึงขอให้ชั้นล่างส่งขึ้นมา (รอได้ไม่เกิน 8 วินาที)' },
      { dur: 6, reveal: 396, box: [320, 268, 940, 404], cap: 'สั่ง stream.open ผ่าน WebSocket ลงไปทีละชั้นจนถึง Edge' },
      { dur: 5, reveal: 464, box: [800, 396, 1080, 464], cap: 'Edge ขอภาพจากกล้อง — กล้องเริ่มส่งวิดีโอ' },
      { dur: 6, reveal: 572, box: [80, 468, 840, 572], accent: true, cap: 'ภาพถูกผลักขึ้น Regional → Central แล้วไหลถึงจอผู้ใช้' },
      { dur: 7, reveal: 844, box: [200, 576, 940, 764], cap: 'ปิดจอแล้วไม่มีคนดูครบ 60 วินาที → สั่งหยุดย้อนลงไป Edge ตัดการต่อกล้อง' },
    ],
  },
  {
    id: 'twopaths', kind: 'svg', svg: 'twopaths', w: 1200, h: 604, title: 'ขั้นที่ 5 — Client กับเว็บ ได้ภาพคนละแบบ',
    steps: [
      { dur: 5, cap: 'ที่ Central ภาพเดียวกันแยกเป็นสองทาง ตามชนิดของผู้ชม' },
      { dur: 6, box: [28, 52, 1172, 348], cap: 'Windows Client: รับ H.265 ตรง ๆ ไม่แปลง — การ์ดจอเครื่องผู้ใช้ถอดเอง เซิร์ฟเวอร์เบา' },
      { dur: 7, box: [28, 196, 1172, 520], cap: 'เว็บเบราว์เซอร์: ต้องแปลงเป็น H.264 ก่อนด้วย ffmpeg + การ์ดจอ — จุดเดียวในระบบที่แปลงโค้ด' },
    ],
  },
  { id: 'end', kind: 'end', dur: 9 },
];

// ---------------------------------------------------------------- ตาราง URL (ฉาก ladder)
const P = (t, k, chg = false) => ({ t, k, chg });
const LADDER = [
  ['กล้อง', [P('rtsp://', 's'), P('admin:camPass@', 'c'), P('203.0.113.12:554', 'h'), P('/stream1', 'p')]],
  ['go2rtc ที่ Edge', [P('rtsp://', 's'), P('admin:camPass@', 'c'), P('203.0.113.12:554', 'h'), P('/stream1', 'p'), P('#backchannel=0', 'f', true)]],
  ['ffmpeg ที่ Edge อ่าน', [P('rtsp://', 's'), P('edge:edgePass@', 'c', true), P('127.0.0.1:8555', 'h', true), P('/cam_1790124424406_raw', 'p', true)]],
  ['ผลักไป Regional', [P('rtsp://', 's'), P('reg:regPass@', 'c', true), P('203.0.113.112:8565', 'h', true), P('/cam_edge_101_9f3a…_in', 'p', true)]],
  ['ffmpeg ที่ Regional อ่าน', [P('rtsp://', 's'), P('reg:regPass@', 'c'), P('127.0.0.1:8565', 'h', true), P('/cam_edge_101_9f3a…_raw', 'p', true)]],
  ['ผลักไป Central', [P('rtsp://', 's'), P('cen:cenPass@', 'c', true), P('203.0.113.80:8555', 'h', true), P('/cam_edge_100_c71e…_in', 'p', true)]],
  ['Gateway ขอ go2rtc', [P('http://', 's', true), P('127.0.0.1:1984', 'h', true), P('/api/stream.mp4', 'p', true), P('?src=cam_edge_100_c71e…_raw&video=copy', 'q', true)]],
  ['Windows Client ได้รับ', [P('http://', 's'), P('203.0.113.80:5173', 'h', true), P('/stream/cam_edge_100_c71e…_raw.mp4', 'p', true), P('?t=eyJ…', 'q', true)]],
];
const ladderHtml = `<table class="ladder">${LADDER.map(([who, parts], i) => `<tr data-row="${i}"><td class="ln">${i + 1}</td><td class="who">${esc(who)}</td><td class="url">${parts.map((p) => `<span class="u u-${p.k}${p.chg ? ' chg' : ''}">${esc(p.t)}</span>`).join('')}</td></tr>`).join('')}</table>`;

// ---------------------------------------------------------------- หน้า
const sceneHtml = SCENES.map((s) => {
  if (s.kind === 'title') {
    return `<section class="scene" id="sc-title"><div class="titlecard">
      <p class="eyebrow">SURVEILLANCE GATEWAY · SYSTEM FLOW</p>
      <h1>ภาพจากกล้องไปถึงจอผู้ใช้<br>ได้ยังไง</h1>
      <p class="sub">Edge → Regional → Central → Windows Client</p>
      <p class="meta">Gateway build 8fe5eba · 2026-10-07</p>
      <p class="credit">powered by Warapon Wichitpan</p></div></section>`;
  }
  if (s.kind === 'end') {
    return `<section class="scene" id="sc-end"><div class="endcard">
      <h2>สรุป</h2>
      <ol>
        <li><b>Edge เป็นคนเพิ่มกล้อง</b> และถือรหัสผ่านกล้องไว้ที่เดียว</li>
        <li><b>ลูกต่อขึ้นหาแม่เสมอ</b> — Edge → Regional → Central จึงทะลุ NAT ได้</li>
        <li><b>ภาพวิ่งเฉพาะตอนมีคนดู</b> และส่งต่อแบบคัดลอก ไม่แปลงโค้ด</li>
        <li><b>Windows Client ถอดรหัสบน GPU</b> ของเครื่องผู้ใช้เอง</li>
      </ol>
      <p class="more">รายละเอียดเต็ม: docs/system-flow.html</p>
      <p class="credit">powered by Warapon Wichitpan</p></div></section>`;
  }
  const body = s.kind === 'ladder' ? `<div class="ladderwrap">${ladderHtml}</div>` : `<div class="vp"><div class="cam">${svgs[s.svg]}</div></div>`;
  return `<section class="scene" id="sc-${s.id}"><header><h2>${esc(s.title)}</h2><span class="count"></span></header>${body}</section>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><title>System Flow — video</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&family=Noto+Serif+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--paper:#f5f5f5;--ink:#2d3142;--muted:#4f5d75;--soft:#7a8399;--accent:#eb6c36;--link:#2e5aa8;
    --sans:'Geist','Noto Sans Thai',sans-serif;--serif:'Instrument Serif','Noto Serif Thai',serif;--mono:'Geist Mono','Noto Sans Thai',monospace}
  html,body{width:1920px;height:1080px;overflow:hidden;background:var(--paper);font-family:var(--sans);color:var(--ink)}
  .scene{position:absolute;inset:0;opacity:0;visibility:hidden}
  header{position:absolute;left:80px;right:80px;top:44px;height:72px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(45,49,66,.12)}
  header h2{font-family:var(--serif);font-weight:400;font-size:46px;letter-spacing:-.01em}
  .count{font-family:var(--mono);font-size:20px;color:var(--soft);letter-spacing:.12em}
  .vp{position:absolute;left:80px;top:140px;width:1760px;height:740px;overflow:hidden}
  .cam{position:absolute;left:0;top:0;transform-origin:0 0}
  .cam svg{display:block;max-width:none!important}
  .pin{position:absolute;left:0;top:0;width:1760px;overflow:hidden;background:var(--paper);border-bottom:1px solid rgba(45,49,66,.12);opacity:0}
  .pin svg{display:block;max-width:none!important;transform-origin:0 0}
  #cap{position:absolute;left:80px;right:80px;bottom:44px;min-height:132px;display:flex;align-items:center;gap:28px;background:#fff;border:1px solid rgba(45,49,66,.12);border-left:6px solid var(--accent);border-radius:8px;padding:22px 36px;opacity:0}
  #cap .n{flex:none;width:56px;height:56px;border-radius:50%;background:var(--ink);color:var(--paper);font:600 26px/56px var(--mono);text-align:center}
  #cap .n:empty{display:none}
  #cap .t{font-size:36px;line-height:1.45;font-weight:500}
  .titlecard,.endcard{position:absolute;left:160px;right:160px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}
  .eyebrow{font-family:var(--mono);font-size:24px;letter-spacing:.2em;color:var(--muted);margin-bottom:28px}
  .titlecard h1{font-family:var(--serif);font-weight:400;font-size:112px;line-height:1.2;letter-spacing:-.01em}
  .titlecard .sub{font-size:40px;color:var(--muted);margin-top:36px}
  .titlecard .meta{font-family:var(--mono);font-size:22px;color:var(--soft);margin-top:20px}
  .credit{position:absolute;bottom:60px;left:0;font-family:var(--mono);font-size:20px;color:var(--soft);letter-spacing:.06em}
  .titlecard::before{content:"";position:absolute;left:-40px;top:300px;bottom:300px;width:8px;background:var(--accent);border-radius:4px}
  .endcard h2{font-family:var(--serif);font-weight:400;font-size:84px;margin-bottom:40px}
  .endcard ol{list-style:none;counter-reset:k}
  .endcard li{counter-increment:k;font-size:40px;line-height:1.5;margin:14px 0;display:flex;gap:28px;align-items:center;opacity:0}
  .endcard li::before{content:counter(k);flex:none;width:60px;height:60px;border-radius:50%;background:var(--ink);color:var(--paper);font:600 28px/60px var(--mono);text-align:center}
  .endcard .more{font-family:var(--mono);font-size:24px;color:var(--link);margin-top:40px}
  .ladderwrap{position:absolute;left:80px;right:80px;top:150px}
  table.ladder{width:100%;border-collapse:collapse;background:#fff;border:1px solid rgba(45,49,66,.12)}
  table.ladder td{padding:16px 20px;border-bottom:1px solid rgba(45,49,66,.10);vertical-align:middle}
  table.ladder tr{opacity:.08}
  table.ladder tr.on{opacity:.55} table.ladder tr.cur{opacity:1;background:rgba(235,108,54,.06)}
  .ln{font:600 22px var(--mono);width:52px;color:var(--soft)} .who{font-size:24px;width:300px}
  .url{font-family:var(--mono);font-size:23px;white-space:nowrap}
  .u{padding:2px 3px;border-radius:4px}
  .u-s{color:var(--soft)} .u-c{color:#8a5a00} .u-h{color:var(--link);font-weight:600} .u-p{color:var(--ink)} .u-f,.u-q{color:var(--muted)}
  tr.cur .u.chg{background:rgba(235,108,54,.20);outline:2px solid rgba(235,108,54,.55)}
</style></head>
<body>
${sceneHtml}
<div id="cap"><span class="n"></span><span class="t"></span></div>
<script>
const SCENES = ${JSON.stringify(SCENES)};
const FADE = 0.6, MOVE = 0.9;
for (const s of SCENES) if (s.steps) s.dur = s.steps.reduce((a, x) => a + x.dur, 0);
const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);
window.TOTAL = TOTAL;
const ease = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const lerp = (a, b, p) => a + (b - a) * p;
const VW = 1760, VH = 740;

// เตรียมชั้นซ้อนของแต่ละ SVG: ม่านเผยลงล่าง (reveal) + สปอตไลต์ + กรอบเน้น
const NS = 'http://www.w3.org/2000/svg';
const layers = {};
for (const s of SCENES) {
  if (s.kind !== 'svg') continue;
  const svg = document.querySelector('#sc-' + s.id + ' svg');
  svg.setAttribute('width', s.w); svg.setAttribute('height', s.h);
  const clean = svg.cloneNode(true);
  clean.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  layers[s.id] = {
    curtain: mk('rect', { x: 0, y: s.h, width: s.w, height: 0, fill: '#f5f5f5' }),
    shade: mk('path', { fill: 'rgba(245,245,245,0.80)', 'fill-rule': 'evenodd', d: '' }),
    ring: mk('rect', { fill: 'none', stroke: '#eb6c36', 'stroke-width': 3, rx: 10, opacity: 0 }),
    clean,
    svg,
  };
  // แถวหัว (lifeline) ตรึงไว้บนสุดเมื่อกล้องเลื่อนลง — โคลนก่อนใส่ชั้นซ้อน จึงไม่มีสปอตไลต์ทับ
  if (s.pin) {
    const pin = document.createElement('div');
    pin.className = 'pin';
    const c = layers[s.id].clean;
    pin.appendChild(c);
    svg.parentNode.parentNode.appendChild(pin);
    layers[s.id].pin = pin;
  }
}

function fitView(s) { const k = Math.min(VW / s.w, VH / s.h); return { cx: s.w / 2, cy: s.h / 2, s: k }; }
function stepState(s, i) {
  const st = s.steps[i];
  let view = st.view || fitView(s);
  if (!st.view && st.box && s.follow) view = { cx: (st.box[0] + st.box[2]) / 2, cy: (st.box[1] + st.box[3]) / 2, s: s.follow };
  return { view, box: st.box || null, reveal: st.reveal ?? s.h };
}
function interp(a, b, p) {
  const box = a.box && b.box ? a.box.map((v, k) => lerp(v, b.box[k], p)) : (p < 0.5 ? a.box : b.box);
  const boxAlpha = a.box && b.box ? 1 : (a.box ? 1 - p : (b.box ? p : 0));
  return { view: { cx: lerp(a.view.cx, b.view.cx, p), cy: lerp(a.view.cy, b.view.cy, p), s: lerp(a.view.s, b.view.s, p) },
    box: box || a.box || b.box, boxAlpha, reveal: lerp(a.reveal, b.reveal, p) };
}

function setCap(n, text, alpha) {
  const cap = document.getElementById('cap');
  cap.querySelector('.n').textContent = n ?? '';
  cap.querySelector('.t').textContent = text || '';
  cap.style.opacity = alpha;
}

window.renderAt = function renderAt(t) {
  let acc = 0, idx = 0;
  while (idx < SCENES.length - 1 && t >= acc + SCENES[idx].dur) { acc += SCENES[idx].dur; idx += 1; }
  const s = SCENES[idx];
  const lt = t - acc;
  const alpha = Math.min(1, idx === 0 ? 1 : lt / FADE, idx === SCENES.length - 1 ? 1 : (s.dur - lt) / FADE);
  document.querySelectorAll('.scene').forEach((el) => { el.style.opacity = 0; el.style.visibility = 'hidden'; });
  const el = document.getElementById('sc-' + s.id);
  el.style.opacity = Math.max(0, alpha); el.style.visibility = 'visible';
  setCap('', '', 0);
  if (!s.steps) {
    if (s.kind === 'end') el.querySelectorAll('li').forEach((li, i) => { li.style.opacity = Math.max(0, Math.min(1, (lt - 0.8 - i * 0.9) / 0.6)); });
    return;
  }
  let sa = 0, si = 0;
  while (si < s.steps.length - 1 && lt >= sa + s.steps[si].dur) { sa += s.steps[si].dur; si += 1; }
  const st = s.steps[si];
  const sl = lt - sa;
  el.querySelector('.count').textContent = (si + 1) + ' / ' + s.steps.length;
  const capA = Math.min(alpha, Math.min(1, sl / 0.35), si === s.steps.length - 1 ? 1 : Math.min(1, (st.dur - sl) / 0.25));
  setCap(st.num ?? '', st.cap, Math.max(0, capA));

  if (s.kind === 'ladder') {
    el.querySelectorAll('tr').forEach((tr, i) => { tr.className = i < si ? 'on' : (i === si ? 'cur' : ''); tr.style.opacity = i === si ? Math.min(1, 0.08 + sl / 0.5) : ''; });
    return;
  }
  const L = layers[s.id];
  const prev = si === 0 ? stepState(s, 0) : stepState(s, si - 1);
  const cur = stepState(s, si);
  const g = interp(prev, cur, ease(sl / MOVE));
  // กล้อง: จุดสนใจอยู่กลางกรอบ แต่ไม่เลื่อนเลยขอบภาพ
  const k = g.view.s;
  let tx = VW / 2 - g.view.cx * k, ty = VH / 2 - g.view.cy * k;
  const cw = s.w * k, ch = s.h * k;
  tx = cw <= VW ? (VW - cw) / 2 : Math.min(0, Math.max(VW - cw, tx));
  ty = ch <= VH ? (VH - ch) / 2 : Math.min(0, Math.max(VH - ch, ty));
  el.querySelector('.cam').style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')';
  if (L.pin) {
    L.pin.style.height = (s.pin * k) + 'px';
    L.pin.firstChild.style.transform = 'translate(' + tx + 'px,0) scale(' + k + ')';
    L.pin.style.opacity = Math.max(0, Math.min(1, (-ty - 8) / 40));
  }
  // ม่านเผย (ไดอะแกรมลำดับเวลา)
  L.curtain.setAttribute('y', g.reveal); L.curtain.setAttribute('height', Math.max(0, s.h - g.reveal));
  // สปอตไลต์
  if (g.box && g.boxAlpha > 0) {
    const [x0, y0, x1, y1] = g.box;
    L.shade.setAttribute('d', 'M0,0H' + s.w + 'V' + s.h + 'H0Z M' + x0 + ',' + y0 + 'V' + y1 + 'H' + x1 + 'V' + y0 + 'Z');
    L.shade.setAttribute('opacity', g.boxAlpha);
    L.ring.setAttribute('x', x0); L.ring.setAttribute('y', y0); L.ring.setAttribute('width', x1 - x0); L.ring.setAttribute('height', y1 - y0);
    L.ring.setAttribute('stroke-width', 3 / k); L.ring.setAttribute('opacity', g.boxAlpha);
  } else { L.shade.setAttribute('d', ''); L.ring.setAttribute('opacity', 0); }
};
window.renderAt(0);
</script></body></html>`;

fs.writeFileSync(out, html);
console.log('wrote', out, 'total', SCENES.reduce((a, s) => a + (s.steps ? s.steps.reduce((x, y) => x + y.dur, 0) : s.dur), 0), 's');
