// สร้าง docs/system-flow.html: cd docs/system-flow-src && node build-page.mjs  (ไม่มี dependency ภายนอก · แก้เนื้อหาใน build-page.mjs, ไดอะแกรมใน flow-diagrams.mjs)
import fs from 'node:fs';
import * as D from './flow-diagrams.mjs';
import { esc } from './flow-lib.mjs';

const OUT = 'D:/gateway-dashboard/docs/system-flow.html';
const c = (s) => `<code>${esc(s)}</code>`;

const glossary = [
  ['กล้อง IP', 'กล้องที่ต่อสายแลน ส่งภาพเป็นข้อมูลดิจิทัลผ่านเครือข่ายได้ มีหมายเลข IP เหมือนคอมพิวเตอร์ เช่น ' + c('192.168.1.10')],
  ['RTSP', '"ภาษา" สำหรับขอดูภาพสดจากกล้อง (เหมือนกดเล่น/หยุด) หน้าตาที่อยู่ ' + c('rtsp://user:pass@192.168.1.10/stream1') + ' ตัวภาพวิ่งเป็นแพ็กเก็ต RTP'],
  ['ONVIF', 'มาตรฐานกลางให้ถามกล้องยี่ห้อไหนก็ได้ว่า "มีช่องภาพอะไรบ้าง ที่อยู่ RTSP คืออะไร" และสั่งหมุนกล้อง (PTZ) ได้'],
  ['โค้ดวิดีโอ (codec)', 'วิธีบีบอัดวิดีโอให้เล็กลง H.265 เล็กกว่า H.264 แต่เบราว์เซอร์เล่น H.265 ตรง ๆ ไม่ได้ ส่วนโปรแกรม Client ถอดได้ด้วยการ์ดจอ'],
  ['แพ็กเก็ต (packet)', 'ก้อนข้อมูลเล็ก ๆ ที่ข้อมูลทุกอย่างถูกหั่นก่อนส่งผ่านเครือข่าย แต่ละชิ้นมีหัวบอกลำดับ ปลายทางเรียงกลับตามลำดับ'],
  ['TCP', 'วิธีส่งแพ็กเก็ตที่รับประกันว่าครบและเรียงลำดับ ถ้าหายจะส่งซ้ำ ระบบนี้ใช้ TCP ทุกช่วงของภาพ'],
  ['WebSocket', 'สายคุยสองทางที่เปิดค้างไว้ ใช้เป็น "สายคำสั่ง" ระหว่าง Edge – Regional – Central (HTTP ปกติถามแล้วตอบจบ ส่วนนี้ฝั่งไหนจะพูดก่อนก็ได้)'],
  ['go2rtc', 'โปรแกรมตัวกลางรับและแจกจ่ายภาพ (stream core) ทุกเครื่องในระบบมีของตัวเอง ตัวมันเองไม่เก็บภาพ แค่ส่งผ่าน'],
  ['ffmpeg', 'โปรแกรมเอนกประสงค์จัดการวิดีโอ ในระบบนี้ใช้ "ผลัก" ภาพขึ้นไปชั้นบน และใช้แปลงโค้ดเมื่อจำเป็น'],
  ['fMP4', 'ไฟล์วิดีโอ MP4 แบบหั่นเป็นท่อน ๆ เล่นไปส่งไปได้โดยไม่ต้องรอไฟล์ครบ ใช้ส่งภาพสดผ่าน HTTP'],
  ['copy กับ transcode', 'copy = ส่งต่อทั้งก้อนโดยไม่แกะ (เบามาก) · transcode = แกะออกเป็นภาพแล้วบีบใหม่ (กิน CPU/GPU) ระบบนี้พยายาม copy ให้มากที่สุด'],
  ['NAT / firewall', 'ตัวกั้นที่ทำให้เครื่องภายนอกต่อเข้ามาหาเครื่องในไซต์ตรง ๆ ไม่ได้ จึงออกแบบให้ Edge เป็นฝ่ายต่อออกไปหาข้างบน'],
  ['Global ID', 'เลขประจำกล้องที่ออกครั้งเดียวและไม่เปลี่ยน เช่น ' + c('TH-10-101-00001') + ' = ไทย – จังหวัด 10 – Edge 101 – กล้องลำดับที่ 1'],
  ['token / API key', 'กุญแจแสดงตัวตน มีหลายชนิดตามหน้าที่ (ดูตารางท้ายหน้า) เช่น API key ของ Client, token เปิดภาพ 5 นาที'],
];

const hopRows = [
  ['1', 'กล้อง → go2rtc (Edge)', 'RTSP บน TCP · พอร์ต 554 ของกล้อง', 'แพ็กเก็ต RTP', 'H.265 ตามกล้อง · ไม่เปลี่ยน', 'go2rtc ต่อหากล้อง (เมื่อมีคนอ่าน)'],
  ['2', 'go2rtc → ffmpeg (Edge)', 'RTSP · 127.0.0.1 พอร์ต 8555', 'แพ็กเก็ต RTP', 'ไม่เปลี่ยน', 'ffmpeg ต่อ go2rtc ในเครื่อง'],
  ['3', 'ffmpeg (Edge) → go2rtc (Regional)', 'RTSP push บน TCP · พอร์ต 8565', 'แพ็กเก็ต RTP', 'ไม่เปลี่ยน (-c copy)', 'Edge ต่อออก (ทะลุ NAT)'],
  ['4', 'go2rtc → ffmpeg (Regional)', 'RTSP · 127.0.0.1 พอร์ต 8565', 'แพ็กเก็ต RTP', 'ไม่เปลี่ยน', 'ffmpeg ต่อ go2rtc ในเครื่อง'],
  ['5', 'ffmpeg (Regional) → go2rtc (Central)', 'RTSP push บน TCP · พอร์ต 8555', 'แพ็กเก็ต RTP', 'ไม่เปลี่ยน (-c copy)', 'Regional ต่อออก'],
  ['6', 'go2rtc → Gateway (Central)', 'HTTP · 127.0.0.1 พอร์ต 1984', 'fMP4', 'ไม่เปลี่ยน (video=copy)', 'Gateway ขอจาก go2rtc'],
  ['7', 'Gateway → Windows Client', 'HTTP · พอร์ต 5173 + stream token', 'fMP4', 'ไม่เปลี่ยน · Client ถอดรหัสบน GPU', 'Client ขอ'],
  ['8', 'Gateway → เว็บเบราว์เซอร์ (เส้น Live)', 'HTTP · พอร์ต 5173 + stream token', 'fMP4 (MSE)', 'แปลง H.265 → H.264 ที่ Central', 'เบราว์เซอร์ขอ'],
];

const keyRows = [
  ['รหัสผ่านกล้อง', 'Edge เท่านั้น (ฝังใน URL RTSP ในฐานข้อมูลของ Edge)', 'ต่อกล้อง ถามสถานะ ดึงภาพ', 'ไม่ถูกส่งขึ้นชั้นบน · /api/v1 ไม่ส่งออก'],
  ['link token (ntlink_…)', 'Edge ถือ · Regional/Central เก็บแค่ค่าแฮช', 'เปิดสาย WebSocket ขึ้นหาชั้นบน', 'จนกว่าจะเพิกถอน'],
  ['บัญชี RTSP ของ go2rtc ชั้นบน', 'ชั้นบนส่งให้ลูกในคำสั่ง stream.open', 'ใช้ push ภาพเข้าสตรีม _in', 'ต่อเครื่อง'],
  ['API key (sgw_…)', 'Client ถือ · Central/Regional ตรวจ', 'เรียก /api/v1 · กำหนดกล้องที่เห็น สิทธิ์ PTZ/ย้อนหลัง', 'จนกว่าจะเพิกถอน'],
  ['stream token', 'อยู่ใน URL /stream/…', 'เปิดภาพกล้อง 1 ตัวเท่านั้น', 'ราว 5 นาที'],
  ['session token (s1.…)', 'เบราว์เซอร์ที่ login หน้าเว็บ', 'เรียก /api/* ของหน้าเว็บ', '12 ชั่วโมง'],
  ['ลายเซ็น ed25519', 'ชั้นบนเซ็น · Edge ตรวจ', 'แพ็กเกจอัปเดตโปรแกรม Edge', 'ต่อรุ่น'],
];


const P = (t, k, chg = false) => ({ t, k, chg });
const ladderRows = [
  ['1', 'กล้อง (ต้นทาง)', [P('rtsp://', 's'), P('admin:camPass@', 'c'), P('203.0.113.12:554', 'h'), P('/stream1', 'p')],
    'ต้นฉบับ: รหัสผ่านกล้อง + IP หน้างาน — เก็บอยู่ในฐานข้อมูลของ Edge ที่เดียวเท่านั้น'],
  ['2', 'go2rtc ที่ Edge (ต้นทางของสตรีม cam_1790124424406_raw)', [P('rtsp://', 's'), P('admin:camPass@', 'c'), P('203.0.113.12:554', 'h'), P('/stream1', 'p'), P('#backchannel=0', 'f', true)],
    'ที่อยู่เดิมทุกอย่าง แค่เติม #backchannel=0 (บอก go2rtc ไม่ต้องขอช่องเสียงย้อนกลับ ไม่งั้นกล้องบางรุ่นไม่ส่งภาพ) และ go2rtc ตั้งชื่อสตรีมว่า cam_…_raw'],
  ['3', 'ffmpeg ที่ Edge อ่านเข้า', [P('rtsp://', 's'), P('edge:edgePass@', 'c', true), P('127.0.0.1:8555', 'h', true), P('/cam_1790124424406_raw', 'p', true)],
    'ffmpeg ไม่ต่อกล้องเอง — อ่านจาก go2rtc ในเครื่อง รหัสผ่านกล้องกับ IP กล้อง "หายไป" เหลือแค่ชื่อสตรีม และใช้บัญชีของ go2rtc แทน'],
  ['4', 'ffmpeg ที่ Edge ผลักออก ไป Regional', [P('rtsp://', 's'), P('reg:regPass@', 'c', true), P('203.0.113.112:8565', 'h', true), P('/cam_edge_101_9f3a…_in', 'p', true)],
    'ข้ามเครื่อง: ปลายทางเป็น Regional · ชื่อสตรีมเปลี่ยนเป็น cam_edge_<เลข Edge>_<แฮช>_in — ชื่อนี้บอกไม่ได้ว่ากล้องตัวไหน IP อะไร'],
  ['5', 'ffmpeg ที่ Regional อ่านเข้า', [P('rtsp://', 's'), P('reg:regPass@', 'c'), P('127.0.0.1:8565', 'h', true), P('/cam_edge_101_9f3a…_raw', 'p', true)],
    'Regional อ่านต่อจากสตรีมที่เพิ่งรับ push · ท้ายชื่อเปลี่ยนจาก _in เป็น _raw (go2rtc ต่อให้เอง)'],
  ['6', 'ffmpeg ที่ Regional ผลักออก ไป Central', [P('rtsp://', 's'), P('cen:cenPass@', 'c', true), P('203.0.113.80:8555', 'h', true), P('/cam_edge_100_c71e…_in', 'p', true)],
    'ทำเหมือน Edge: ปลายทางเป็น Central · เลขกลางชื่อเปลี่ยนเป็น 100 (เลข Regional) · แฮชคำนวณใหม่จากชื่อที่ Regional ตั้ง ชื่อจึงเปลี่ยนอีกรอบ'],
  ['7', 'Gateway ที่ Central ขอจาก go2rtc', [P('http://', 's', true), P('127.0.0.1:1984', 'h', true), P('/api/stream.mp4', 'p', true), P('?src=cam_edge_100_c71e…_raw&video=copy', 'q', true)],
    'ออกจาก RTSP แล้ว: ขอเป็น HTTP จาก go2rtc ในเครื่อง ได้ข้อมูลเป็น fMP4 · video=copy = ไม่แปลงโค้ด'],
  ['8', 'Windows Client ได้รับ (ผู้ชม)', [P('http://', 's'), P('203.0.113.80:5173', 'h', true), P('/stream/cam_edge_100_c71e…_raw.mp4', 'p', true), P('?t=eyJ…', 'q', true)],
    'ไม่มี RTSP เหลือแล้ว: HTTP พอร์ตเดียว 5173 มี token (?t=) แทนรหัสผ่าน อายุราว 5 นาที ผูกกับกล้องตัวนี้ตัวเดียว'],
];
const urlHtml = (parts) => parts.map((p) => `<span class="u u-${p.k}${p.chg ? ' chg' : ''}">${esc(p.t)}</span>`).join('');
const ladderHtml = `<div class="tablewrap"><table class="ladder"><thead><tr><th>#</th><th>จุดที่เห็น</th><th>ที่อยู่ (URL) ตัวอย่าง</th><th>อะไรเปลี่ยน และทำไม</th></tr></thead><tbody>${ladderRows.map(([n, who, parts, why]) => `<tr><td class="num">${n}</td><td>${esc(who)}</td><td><code class="url">${urlHtml(parts)}</code></td><td>${esc(why)}</td></tr>`).join('')}</tbody></table></div>`;

const table = (head, rows) => `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td${i === 0 ? ' class="num"' : ''}>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const steps = (list) => `<ol class="steps">${list.map(([n, html]) => `<li><span class="n">${n}</span><div>${html}</div></li>`).join('')}</ol>`;
const fig = (svg, cap) => `<figure class="fig">${svg}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;

const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>เส้นทางภาพจากกล้องถึงจอผู้ใช้ — Surveillance Gateway</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&family=Noto+Serif+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --paper: #f5f5f5; --paper-2: #ececec; --ink: #2d3142; --muted: #4f5d75; --soft: #7a8399;
    --rule: rgba(45,49,66,0.12); --accent: #eb6c36; --accent-tint: rgba(235,108,54,0.08); --link: #2e5aa8;
    --sans: 'Geist','Noto Sans Thai',system-ui,sans-serif;
    --serif: 'Instrument Serif','Noto Serif Thai',serif;
    --mono: 'Geist Mono','Noto Sans Thai',ui-monospace,monospace;
  }
  html { scroll-behavior: smooth; }
  body { font-family: var(--sans); background: var(--paper); color: var(--ink); line-height: 1.7; font-size: 15px; padding: 3rem 1.25rem 4rem; }
  .frame { max-width: 1240px; margin: 0 auto; }
  .eyebrow { font-family: var(--mono); font-size: .66rem; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin-bottom: .5rem; }
  h1 { font-family: var(--serif); font-weight: 400; font-size: clamp(1.8rem, 3vw + .8rem, 2.6rem); letter-spacing: -.01em; line-height: 1.25; margin-bottom: 1rem; }
  h2 { font-family: var(--serif); font-weight: 400; font-size: 1.7rem; letter-spacing: -.01em; line-height: 1.3; margin: 3.5rem 0 .5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
  h3 { font-size: 1rem; font-weight: 600; margin: 1.75rem 0 .5rem; }
  p { max-width: 78ch; margin-bottom: .9rem; }
  .lead { font-size: 1.05rem; color: var(--muted); max-width: 80ch; }
  code { font-family: var(--mono); font-size: .86em; background: rgba(45,49,66,0.06); padding: .05em .35em; border-radius: 3px; }
  nav.toc { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.5rem 0 0; }
  nav.toc a { font-size: .82rem; color: var(--ink); text-decoration: none; border: 1px solid var(--rule); background: #fff; border-radius: 6px; padding: .3rem .7rem; }
  nav.toc a:hover { border-color: var(--accent); }
  .tldr { background: #fff; border: 1px solid var(--rule); border-left: 3px solid var(--accent); border-radius: 6px; padding: 1rem 1.25rem; margin: 1.75rem 0 0; max-width: 90ch; }
  .tldr b { font-weight: 600; }
  .glossary { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: .75rem; margin-top: 1rem; }
  .glossary div { background: #fff; border: 1px solid var(--rule); border-radius: 6px; padding: .8rem 1rem; }
  .glossary dt { font-weight: 600; font-size: .92rem; margin-bottom: .2rem; }
  .glossary dd { font-size: .86rem; color: var(--muted); line-height: 1.6; }
  .fig { margin: 1.25rem 0 1rem; overflow-x: auto; }
  .fig svg { display: block; width: 100%; height: auto; min-width: 880px; margin: 0 auto; }
  figcaption { font-size: .8rem; color: var(--soft); margin-top: .35rem; }
  ol.steps { list-style: none; margin: 1rem 0 1.25rem; max-width: 100ch; }
  ol.steps li { display: flex; gap: .85rem; padding: .55rem 0; border-top: 1px solid var(--rule); }
  ol.steps li:first-child { border-top: 0; }
  .n { flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: var(--ink); color: var(--paper); font: 600 .72rem/1.5rem var(--mono); text-align: center; margin-top: .15rem; }
  ol.steps div { flex: 1; }
  table.ladder td:nth-child(3) { min-width: 560px; }
  table.ladder td:nth-child(4) { min-width: 300px; }
  code.url { display: block; background: none; padding: 0; font-size: .74rem; line-height: 1.9; white-space: nowrap; }
  .u { padding: .1em .15em; border-radius: 3px; }
  .u-s { color: var(--soft); } .u-c { color: #8a5a00; } .u-h { color: var(--link); font-weight: 600; } .u-p { color: var(--ink); } .u-f, .u-q { color: var(--muted); }
  .u.chg { background: rgba(235,108,54,0.18); outline: 1px solid rgba(235,108,54,0.45); }
  .callout { background: var(--accent-tint); border: 1px solid rgba(235,108,54,.35); border-radius: 6px; padding: .85rem 1.1rem; margin: 1rem 0; max-width: 100ch; }
  .tablewrap { overflow-x: auto; margin: 1rem 0 1.25rem; }
  table { border-collapse: collapse; width: 100%; font-size: .84rem; background: #fff; border: 1px solid var(--rule); }
  th, td { text-align: left; vertical-align: top; padding: .55rem .75rem; border-bottom: 1px solid var(--rule); }
  th { font-family: var(--mono); font-size: .66rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); background: var(--paper-2); font-weight: 500; white-space: nowrap; }
  td.num { font-weight: 600; white-space: nowrap; }
  footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: .7rem; color: var(--muted); line-height: 1.8; }
  @media print { nav.toc { display: none; } .fig svg { min-width: 0; } h2 { break-after: avoid; } figure, table { break-inside: avoid; } }
</style>
</head>
<body>
<div class="frame">

<p class="eyebrow">Surveillance Gateway · System Flow</p>
<h1>ภาพจากกล้องไปถึงจอผู้ใช้ได้ยังไง — อธิบายสำหรับคนที่ยังไม่รู้อะไรเลย</h1>
<p class="lead">หน้านี้พาตาม "ภาพ 1 เส้น" ตั้งแต่เจ้าหน้าที่กดเพิ่มกล้องที่ Edge ไปจนภาพขึ้นจอ Windows Client ว่าข้อมูลถูกส่งผ่านโปรแกรมอะไร เครื่องไหน ด้วยโปรโตคอลอะไร และถูกแปลงรูปตรงไหนบ้าง อ่านเรียงจากบนลงล่างได้เลย ศัพท์ที่ไม่คุ้นดูที่ส่วนแรก</p>

<div class="tldr"><b>สรุปใน 4 บรรทัด</b><br>
① กล้องอยู่หน้างาน มี <b>Edge</b> เป็นคนดูแลและถือรหัสผ่านกล้องไว้ที่เดียว ·
② Edge <b>ต่อสายขึ้นไป</b>หา Regional (แล้ว Regional ต่อขึ้น Central) ไม่ใช่ให้ข้างบนต่อลงมา เพราะหน้างานมักอยู่หลัง NAT ·
③ <b>ภาพวิ่งเฉพาะตอนมีคนดู</b> และถูกส่งต่อแบบ "คัดลอกแพ็กเก็ตตรง ๆ" ไม่แกะไม่บีบใหม่ ·
④ ปลายทางคือ Windows Client ที่ถอดรหัสภาพบน GPU ของเครื่องผู้ใช้เอง</div>

<nav class="toc" aria-label="สารบัญ">
  <a href="#terms">ศัพท์ 14 คำ</a><a href="#overview">ภาพรวม</a><a href="#s1">1 เพิ่มกล้อง</a><a href="#s2">2 รายชื่อขึ้นไปหา Central</a>
  <a href="#s3">3 ภาพวิ่งผ่านอะไรบ้าง</a><a href="#s4">4 ใครสั่งเริ่ม/หยุด</a><a href="#s5">5 Client กับเว็บ</a><a href="#keys">ใครถือกุญแจอะไร</a>
</nav>

<h2 id="terms">ก่อนเริ่ม: ศัพท์ที่ต้องรู้</h2>
<dl class="glossary">${glossary.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${d}</dd></div>`).join('')}</dl>

<h2 id="overview">ภาพรวม: ห้าขั้นจากกล้องถึงผู้ใช้</h2>
<p>ระบบมี 3 ชั้นตามพื้นที่: <b>Edge</b> (ไซต์/จังหวัด) → <b>Regional</b> (ภาค) → <b>Central</b> (ประเทศ) แต่ละชั้นคือโปรแกรมตัวเดียวกันที่ตั้งค่าบทบาทต่างกัน มี 3 กติกาที่ทำให้ระบบเป็นแบบนี้:</p>
<steps-placeholder-1/>
${fig(D.diagramOverview(), 'เส้นหนาสีเข้ม = ภาพวิดีโอ · เส้นสีน้ำเงิน = สายควบคุมและคำขอ · เส้นประ = ทางเลือก')}

<h2 id="s1">ขั้นที่ 1 — เจ้าหน้าที่เพิ่มกล้องที่ Edge</h2>
<p>ทุกอย่างเริ่มที่ Edge เท่านั้น Regional และ Central ไม่มีปุ่มเพิ่มกล้อง (ระบบปิดทางนี้ไว้ที่ API เลย) เพราะรหัสผ่านกล้องของหน่วยงานต้องอยู่ที่ไซต์ ไม่ควรไปกองอยู่ส่วนกลาง</p>
${fig(D.diagramAddCamera(), 'ตัวเลขในวงกลมคือลำดับที่เกิดขึ้น ตรงกับรายการด้านล่าง')}
${steps([
  [1, 'เจ้าหน้าที่เปิดหน้าเว็บของ Edge (เช่น ' + c('http://<IP ของ Edge>:5173') + ') ไปที่ Cameras → Add Camera ใส่ IP ชื่อผู้ใช้ รหัสผ่านของกล้อง และ <b>ต้องเลือกจังหวัดกับอำเภอ</b> (บังคับ)'],
  [2, 'Edge ถามกล้องผ่าน <b>ONVIF</b> ว่า "มีช่องภาพอะไรบ้าง" กล้องตอบกลับเป็นรายการ profile Edge จึงได้ URL RTSP ของ <b>main</b> (ภาพละเอียดสูง) และ <b>sub</b> (ภาพเล็ก ใช้ตอนดูหลายช่องพร้อมกัน) · ถ้าเพิ่มจาก NVR/VMS/RTSP ที่กรอกเอง วิธีถามจะต่างกันแต่ผลลัพธ์เหมือนกัน'],
  [3, 'Edge บันทึกลงฐานข้อมูล SQLite ของตัวเอง: ชื่อ URL RTSP (<b>มีรหัสผ่านกล้องฝังอยู่ — เก็บที่นี่ที่เดียว</b>) จังหวัด/อำเภอ แล้ว<b>ออก Global ID</b> เช่น ' + c('TH-10-101-00001') + ' ครั้งเดียว ไม่เปลี่ยนอีกตลอดอายุกล้อง'],
  [4, 'Edge สั่ง go2rtc ผ่าน REST ให้ลงทะเบียนสตรีมของกล้อง 4 เส้น: ' + c('<id>') + ' (แปลงเป็น H.264 ไว้ให้เว็บ) ' + c('<id>_sub') + ' ' + c('<id>_raw') + ' (ส่งต่อตามโค้ดเดิมของกล้อง ไม่แปลง) และ ' + c('<id>_sub_raw') + ' · <b>ตอนนี้ยังไม่ได้ต่อกล้องจริง</b> go2rtc จะต่อหากล้องก็ต่อเมื่อมีคนขอดู'],
  [5, 'ทุก 15 วินาที Edge ลองต่อ TCP ไปยังพอร์ตของกล้อง (เหมือนเคาะประตูดูว่ามีคนอยู่ไหม) เพื่อรู้ว่ากล้องยังตอบหรือไม่ ได้สถานะ 3 ค่า: เปิดใช้อยู่ไหม · ติดต่อได้ไหม · กำลังมีคนดึงภาพไหม'],
  [6, 'Edge ส่ง<b>รายชื่อกล้อง</b>ขึ้น Regional ทันทีผ่านสาย WebSocket (ไม่ต้องรอรอบ 5 นาที) — เรื่องในขั้นถัดไป'],
])}

<h2 id="s2">ขั้นที่ 2 — รายชื่อกล้องและสถานะเดินทางขึ้นไปหา Central</h2>
<p>ตรงนี้ยัง<b>ไม่มีภาพวิดีโอ</b>วิ่งเลย มีแต่ข้อมูลข้อความเล็ก ๆ (JSON) ว่ามีกล้องอะไรบ้าง สถานะเป็นยังไง สายนี้คือ WebSocket ที่ Edge เปิดค้างไว้หนึ่งเส้นต่อ Regional หนึ่งตัว</p>
${fig(D.diagramCatalog(), 'ลำดับเวลาไหลจากบนลงล่าง · เส้นประคือคำตอบกลับ · เส้นสีส้มคือข้อความหลัก')}
${steps([
  [1, 'Edge "โทรออก" ไปที่ ' + c('ws://<Regional>:5273/api/edge-link') + ' ส่ง ' + c('hello') + ' (เลข node, รุ่นโปรแกรม, จังหวัดของตัวเอง) พร้อม <b>link token</b> — Edge เป็นฝ่ายเริ่มเสมอ จึงทะลุ NAT ได้โดยไม่ต้องเปิดพอร์ตขาเข้า'],
  [2, 'Regional ตรวจ token และเลข node (Edge ในภาค Regional 100 ต้องใช้เลข 101–199) แล้วตอบ ' + c('welcome') + ' สายนี้เปิดค้างไว้ ส่ง ' + c('heartbeat') + ' ทุก 20 วินาที ถ้าเงียบเกินราว 60–70 วินาทีถือว่าสายตาย แล้ว Edge ต่อใหม่เอง'],
  [3, 'Edge ส่ง ' + c('catalog') + ': ชื่อ Global ID จังหวัด พิกัด และ "มีสตรีมไหม" — <b>ไม่มีรหัสผ่านกล้อง</b> Regional เขียนแถวกล้องแบบ relay ลงฐานข้อมูล แล้วสร้างสตรีมเปล่าชื่อ ' + c('<id>_in') + ' ใน go2rtc ของตัวเองเพื่อรอรับภาพ (ส่งซ้ำทุก 5 นาทีและเมื่อมีการแก้ไข)'],
  [4, 'Regional ทำตัวเป็น "Edge" ของ Central: ส่ง ' + c('catalog') + ' รวมกล้องทั้งภาคขึ้นไป พร้อม Global ID เดิม Central ทำแบบเดียวกัน'],
  [5, 'กล้องหลุดหรือกลับมา → Edge ส่ง ' + c('camera_state') + ' ทันที ไม่รอรอบ'],
  [6, 'Regional ส่งต่อให้ Central — ชั้นบนเห็นสถานะภายในไม่กี่วินาที'],
  [7, 'Windows Client ขอรายชื่อกล้องด้วย ' + c('GET /api/v1/cameras') + ' พร้อม <b>API key</b> (' + c('Authorization: Bearer sgw_…') + ')'],
  [8, 'Central ตอบ JSON รายชื่อกล้อง + สถานะ เฉพาะกล้องที่ key นั้นมีสิทธิ์เห็น · ถ้าสายของ Edge ขาด สถานะกล้องเป็น "ไม่ทราบ" (ไม่ใช่ "ดับ") เพราะ Central แยกไม่ได้ว่ากล้องดับหรือแค่สายขาด'],
])}

<h2 id="s3">ขั้นที่ 3 — ภาพวิ่งผ่านอะไรบ้างจากกล้องถึงจอ</h2>
<p>นี่คือหัวใจของระบบ ภาพ 1 เส้นผ่าน <b>8 จุด</b> เจ็ดช่วง ลูกศรเข้มคือการส่งข้ามเครื่อง ลูกศรอ่อนคือส่งต่อภายในเครื่องเดียวกัน ตัวเลขในวงกลมตรงกับคำอธิบายทางขวา สังเกตว่า<b>ตลอดทางจากกล้องถึง Central ไม่มีการแปลงโค้ดเลย</b> — แพ็กเก็ตถูกคัดลอกต่อ ๆ กันไป</p>
${fig(D.diagramVideoJourney(), 'ชื่อสตรีมที่ลงท้าย _raw = ส่งต่อตามโค้ดเดิมของกล้อง · ลงท้าย _in = สตรีมที่รอรับ push จากชั้นล่าง')}

<h3>ภาพ 1 เฟรมมีชีวิตอย่างไร</h3>
<p>ภาพวิดีโอคือภาพนิ่งหลายสิบภาพต่อวินาที ภาพนิ่งแต่ละภาพ (เฟรม) เดินทางตามขั้นตอนนี้ — ช่วง 3–5 คือช่วงที่เครือข่ายของเราทำงาน</p>
${fig(D.diagramFrame(), 'แพ็กเก็ต RTP ราว 1.5 KB ต่อชิ้นเป็นขนาดทั่วไปที่พอดีกับสายเครือข่าย ไม่ใช่ค่าตายตัว')}

<h3>ตัวอย่างจริง: ที่อยู่ RTSP เปลี่ยนไปยังไงจากกล้องถึงผู้ชม</h3>
<p>กล้องตัวเดียวกัน ตามดูที่อยู่ (URL) ที่ถูกใช้ในแต่ละช่วง <b>ส่วนที่มีกรอบสีส้มคือส่วนที่เปลี่ยนจากแถวก่อนหน้า</b> · สีน้ำเงินตัวหนา = เครื่อง:พอร์ต · สีน้ำตาล = ชื่อผู้ใช้:รหัสผ่านในที่อยู่ (ตัวอย่างนี้เป็นรหัสสมมติ)</p>
${ladderHtml}
<div class="callout"><b>สิ่งที่เห็นจากตาราง</b> · รหัสผ่านและ IP ของกล้องมีแค่ในแถว 1–2 (ที่ Edge) แถวอื่นไม่มีเลย · ชื่อสตรีมเปลี่ยนที่ทุกชั้น (แฮช = SHA-256 ของชื่อในชั้นล่าง ตัดเหลือ 32 ตัวอักษร ตัวอย่างนี้ย่อเหลือ 4) · แถว 4 และ 6 คือสองจุดที่ภาพข้ามจากชั้นหนึ่งไปอีกชั้นด้วย RTSP · ผู้ชมได้ HTTP + token ไม่ใช่ RTSP</div>

<h3>ตารางสรุปทุกช่วง</h3>
${table(['#', 'จาก → ถึง', 'โปรโตคอล · พอร์ต', 'ห่อข้อมูลเป็น', 'โค้ดวิดีโอ', 'ใครเริ่มต่อ'], hopRows)}
<div class="callout"><b>ทำไม Edge ไม่แปลงโค้ด?</b> ถ้าทุกชั้นแกะและบีบใหม่ ภาพจะช้าลงชั้นละหลายร้อยมิลลิวินาที ภาพเสื่อมลงทุกครั้ง และ CPU/GPU ของเครื่องเล็กที่หน้างานจะไม่พอ ระบบจึงคัดลอกแพ็กเก็ตตรง ๆ (<code>-c copy</code>) แล้วให้ปลายทางสุดท้ายเป็นคนถอดรหัสเอง · ตั้งค่านี้ด้วยตัวแปร <code>GATEWAY_RAW_STREAMS=1</code> ซึ่งเปิดไว้แล้วที่ Edge และ Central</div>

<h2 id="s4">ขั้นที่ 4 — ใครสั่งให้ภาพเริ่มวิ่งและหยุดวิ่ง</h2>
<p>ภาพ<b>ไม่วิ่งตลอดเวลา</b> ถ้าไม่มีใครดู ข้อมูลภาพไม่ข้ามเครือข่ายเลย (10,000 กล้องไม่ได้แปลว่า 10,000 สตรีมวิ่งอยู่) ภาพเริ่มวิ่งเมื่อมีคนขอดู แล้ว Central สั่งผ่านสาย WebSocket ลงไปทีละชั้น</p>
${fig(D.diagramOnDemand(), 'เส้นหนาคือภาพวิ่งขึ้น · เส้นสีส้มคือภาพที่ถึงจอ · สั่งปิดทันทีที่ไม่มีคนดูครบ 60 วินาที')}
${steps([
  [1, 'Client ขอ URL ของภาพกล้องตัวที่เลือก (' + c('/api/v1/cameras/:id/streams') + ')'],
  [2, 'Central ตอบ URL แบบ ' + c('…/stream/<id>_raw.mp4?t=…') + ' ที่มี <b>stream token</b> ผูกกับกล้องตัวนี้ อายุราว 5 นาที'],
  [3, 'Client ขอเปิด URL นั้น Central ตรวจ token แล้วพบว่า<b>ภาพยังไม่มา</b> จึงสั่งชั้นล่างให้ส่งภาพมาก่อน (รอได้ไม่เกิน 8 วินาที ถ้าไม่ทันผู้เล่นจะได้จอดำแล้วลองใหม่เอง)'],
  [4, 'Central สั่ง Regional ผ่าน WebSocket: ' + c('stream.open') + ' พร้อมบอกว่าให้ push ไปที่ไหน ชื่ออะไร ด้วยบัญชีไหน'],
  [5, 'Regional ยังไม่มีภาพเหมือนกัน จึงสั่ง Edge ต่อ — ' + c('stream.open') + ' อีกชั้น'],
  [6, 'Edge เปิด ffmpeg อ่านสตรีม ' + c('<id>_raw') + ' ใน go2rtc ของตัวเอง ทำให้ go2rtc <b>เพิ่งมีคนอ่าน</b> จึงต่อ RTSP ไปขอภาพจากกล้อง'],
  [7, 'กล้องส่งวิดีโอ RTP (H.265) กลับมา'],
  [8, 'ffmpeg ที่ Edge ผลักแพ็กเก็ตขึ้นสตรีม ' + c('<id>_in') + ' ของ Regional แบบ ' + c('-c copy')],
  [9, 'Regional เห็นว่ามีภาพเข้า จึงเปิด ffmpeg ของตัวเองผลักต่อขึ้น Central'],
  [10, 'Central เห็นภาพเข้า ห่อเป็น fMP4 ส่งทาง HTTP ที่ผู้เล่นค้างรออยู่ — ภาพขึ้นจอ'],
  [11, 'ผู้ใช้ปิดช่องภาพ ถ้าไม่มีใครอ่านสตรีมนั้นครบ <b>60 วินาที</b> Central สั่ง ' + c('stream.close') + ' (ตัวตรวจรอบทุก 20 วินาที)'],
  [12, 'Regional ปิดต่อถ้าไม่มีผู้ชมในภาคแล้ว → Edge หยุด ffmpeg → go2rtc ตัดการต่อกล้อง กล้องกลับมาเงียบเหมือนเดิม'],
])}

<h2 id="s5">ขั้นที่ 5 — ปลายทางสองแบบ: Client ได้ภาพดิบ เว็บได้ภาพที่แปลงแล้ว</h2>
<p>ที่ Central ภาพกล้องตัวเดียวกันมี <b>2 สตรีม</b>ให้เลือก ผู้ขอเป็นคนเลือกจากชื่อใน URL (ชื่อที่ลงท้าย <code>_raw</code> หรือไม่)</p>
${fig(D.diagramTwoPaths(), 'จุดเดียวในทั้งระบบที่มีการแปลงโค้ดคือเส้นสำหรับเว็บที่ Central')}
<ul style="margin:0 0 1rem 1.25rem;max-width:90ch">
  <li><b>Windows Client</b> เลือกเส้น <code>_raw</code>: รับ H.265 ตรง ๆ แล้วใช้ GPU ของเครื่องตัวเองถอดรหัส (libVLC) ไม่ผ่านการแปลงใด ๆ — เซิร์ฟเวอร์เบา ภาพหน่วงน้อย ดูหลายช่องพร้อมกันได้</li>
  <li><b>เว็บเบราว์เซอร์ (หน้า Live)</b> เลือกเส้นปกติ: เบราว์เซอร์เล่น H.265 ผ่าน MSE ไม่ได้ Central จึงให้ ffmpeg + การ์ดจอแปลงเป็น H.264 ก่อน ทุกช่องที่เปิดดูกิน 1 งานแปลงโค้ด ผู้ชมเว็บพร้อมกันจำนวนมากจึงต้องระวัง</li>
</ul>

<h2 id="keys">ใครถือกุญแจอะไร และข้อควรรู้</h2>
${table(['กุญแจ', 'ใครถือ / ใครตรวจ', 'ใช้ทำอะไร', 'อายุ / หมายเหตุ'], keyRows)}
<h3>ข้อควรรู้</h3>
<ul style="margin:0 0 1rem 1.25rem;max-width:90ch">
  <li><b>ยังไม่มี TLS:</b> สาย <code>ws://</code> <code>rtsp://</code> <code>http://</code> ทุกเส้นวิ่งแบบไม่เข้ารหัส ต้องใช้ผ่าน LAN / VPN / Tailscale เท่านั้น ส่วนแพ็กเกจอัปเดตโปรแกรมกันการปลอมด้วยลายเซ็น ed25519</li>
  <li><b>ระบบไม่บันทึกวิดีโอเอง:</b> ภาพย้อนหลังดึงจากเครื่องบันทึกของกล้อง/NVR/VMS ผ่านสายเดียวกัน ตอนมีคนขอดูเท่านั้น</li>
  <li><b>Central ล่ม:</b> Client ที่ตั้งชี้ Regional ของภาคตัวเองยังดูภาพในภาคได้ (Client ยังไม่สลับให้อัตโนมัติ ต้องเลือกเอง)</li>
  <li><b>สายของ Edge ขาด:</b> กล้องขึ้น "ไม่ทราบสถานะ" และ Edge ต่อกลับเองอัตโนมัติ ไม่ต้องแอดกล้องใหม่ Global ID เดิมคงอยู่</li>
  <li><b>เส้นทางอื่นที่ไม่ได้ลงในหน้านี้:</b> สั่ง PTZ (ผ่านสาย WebSocket เดียวกัน) · ดูย้อนหลัง · เสียงจากกล้อง (เปิดรายกล้องที่ Edge) · AI event + ภาพประกอบ — ดู docs/EDGE-PLAN.md และ docs/CAMERA-AUDIO.md</li>
</ul>

<footer>
  สร้างจากโค้ดจริงของ Gateway build 8fe5eba (2026-10-07) · ไฟล์ต้นทาง: server/vms/edge-link-client.js · edge-link-server.js · edge-source.js · gateway/go2rtc-sync.js · gateway/streams.js · server.js (/stream) · client-windows/…/LibVlcVideoRenderer.cs<br>
  ตัวเลขพอร์ตเป็นค่าของระบบจริงปัจจุบัน (Edge เครื่องแยก 5173/1984/8555 · Regional 5273/1994/8565 · Central 5173/1984/8555)<br>
  powered by Warapon Wichitpan
</footer>
</div>
</body>
</html>`;

const rules = steps([
  [1, '<b>Edge เป็นคนเพิ่มกล้อง</b> — Edge ถือรหัสผ่านกล้อง ชั้นบนไม่เคยเห็นรหัสผ่านเลย'],
  [2, '<b>ลูกต่อขึ้นหาแม่เสมอ</b> — Edge เปิดสายขึ้นไปหา Regional (และ Regional ขึ้นไปหา Central) เพราะหน้างานอยู่หลัง NAT ต่อเข้าไปหาไม่ได้'],
  [3, '<b>ภาพวิ่งเฉพาะตอนมีคนดู</b> — ปกติมีแต่ข้อความเล็ก ๆ วิ่งในสายควบคุม ภาพจริงเริ่มวิ่งเมื่อมีคนกดดู และหยุดเมื่อไม่มีคนดู 60 วินาที'],
]);
fs.writeFileSync(OUT, html.replace('<steps-placeholder-1/>', rules));
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
