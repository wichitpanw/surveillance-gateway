import { C, SANS, MONO, SERIF, esc, node, zone, route, badge, labelH, labelV, legend, svgWrap, sequence, rt, segW, g4, tw } from './flow-lib.mjs';

const m = (s) => [s, 'm']; // mono
const EX = {"1":"rtsp://admin:••••@203.0.113.12:554/stream1","2":"rtsp://edge:••••@127.0.0.1:8555/cam_1790124424406_raw","3":"rtsp://reg:••••@203.0.113.112:8565/cam_edge_101_9f3a…_in","4":"rtsp://reg:••••@127.0.0.1:8565/cam_edge_101_9f3a…_raw","5":"rtsp://cen:••••@203.0.113.80:8555/cam_edge_100_c71e…_in","6":"http://127.0.0.1:1984/api/stream.mp4?src=cam_edge_100_c71e…_raw&video=copy","7":"http://203.0.113.80:5173/stream/cam_edge_100_c71e…_raw.mp4?t=eyJ…"};

/* ============================================================ A. ภาพรวม */
export function diagramOverview() {
  const W = 1200; const H = 340;
  const NW = 128; const NH = 100; const NY = 68;
  const xs = [40, 288, 536, 784, 1032];
  const nodes = [
    { x: xs[0], kind: 'external', tag: 'CAMERA', name: 'กล้อง / NVR', subs: ['ภาพ + เสียง', [m('RTSP · ONVIF')], 'อยู่หน้างาน'] },
    { x: xs[1], kind: 'focal', tag: 'EDGE', name: 'Edge Gateway', subs: ['ประจำไซต์', 'ถือรหัสผ่านกล้อง', [m('node 101 :5173')]] },
    { x: xs[2], kind: 'backend', tag: 'REGIONAL', name: 'Regional', subs: ['รวมทั้งภาค', 'รับ-ส่งต่อภาพ', [m('node 100 :5273')]] },
    { x: xs[3], kind: 'backend', tag: 'CENTRAL', name: 'Central', subs: ['รวมทั้งประเทศ', 'ออก API key ผู้ใช้', [m('node 000 :5173')]] },
    { x: xs[4], kind: 'focal', tag: 'CLIENT', name: 'Windows Client', subs: ['ผู้ใช้ดูภาพ', 'ถอดรหัสด้วย GPU', 'ต่อด้วย API key'] },
  ];
  const heads = ['หน้างาน', 'ระดับไซต์/จังหวัด', 'ระดับภาค', 'ระดับประเทศ', 'ผู้ใช้'];
  let body = '';
  heads.forEach((t, i) => { body += rt(t, xs[i] + NW / 2, 48, { fill: C.soft }); });

  // ตัวเชื่อม: สองเส้นต่อช่อง (ควบคุม y=200 · ภาพ y=232)
  const cY = 100; const vY = 132;
  let paths = '';
  let labels = '';
  const gaps = [
    { a: xs[0] + NW, b: xs[1], ctrl: { from: 'b', segs: ['ONVIF ถาม/สั่ง'] }, vid: { from: 'a', segs: ['RTSP ภาพ'] } },
    { a: xs[1] + NW, b: xs[2], ctrl: { from: 'a', segs: ['WebSocket'] }, vid: { from: 'a', segs: ['RTSP push'] } },
    { a: xs[2] + NW, b: xs[3], ctrl: { from: 'a', segs: ['WebSocket'] }, vid: { from: 'a', segs: ['RTSP push'] } },
    { a: xs[3] + NW, b: xs[4], ctrl: { from: 'b', segs: ['HTTP ขอดู'] }, vid: { from: 'a', segs: ['HTTP fMP4'] } },
  ];
  gaps.forEach((g) => {
    const cx = (g.a + g.b) / 2;
    paths += route(g.ctrl.from === 'a' ? [[g.a, cY], [g.b, cY]] : [[g.b, cY], [g.a, cY]], 'ctrl');
    paths += route([[g.a, vY], [g.b, vY]], 'video');
    labels += labelH({ segs: g.ctrl.segs, cx, ly: cY, fill: C.link }).svg;
    labels += labelH({ segs: g.vid.segs, cx, ly: vY, fill: C.ink }).svg;
  });
  // ทางตรง Client → Regional (เมื่อสาย Central ขาด)
  const rcx = xs[2] + NW / 2; const ccx = xs[4] + NW / 2;
  paths += route([[ccx, NY + NH], [ccx, 232], [rcx, 232], [rcx, NY + NH]], 'optional');
  const lab = labelH({ segs: ['ในภาค: Client ต่อ Regional ตรง ๆ ได้ (ใช้ต่อเมื่อสายไป Central ขาด)'], cx: (rcx + ccx) / 2, ly: 232 });
  labels += lab.svg;

  const nodeSvg = nodes.map((n) => node({ ...n, y: NY, w: NW, h: NH })).join('');
  body += paths + labels + nodeSvg;
  body += legend({
    y: 292, w: W,
    items: [{ line: 'video', text: 'ภาพวิดีโอ' }, { line: 'ctrl', text: 'สายควบคุม / คำขอ' }, { line: 'optional', text: 'ทางเลือก' }, { box: 'focal', text: 'จุดเริ่ม (Edge) และจุดจบ (Client)' }],
  });
  return svgWrap({
    slug: 'flow-overview', title: 'ภาพรวมระบบ: กล้อง → Edge → Regional → Central → Client',
    desc: 'ภาพจากกล้องวิ่งผ่าน Edge, Regional และ Central ไปถึง Windows Client โดยมีสายควบคุมแยกต่างหาก และ Client ต่อ Regional ตรงได้', w: W, h: H, body,
  });
}

/* ============================================================ B. Edge เพิ่มกล้อง */
export function diagramAddCamera() {
  const W = 960; const H = 600;
  let paths = ''; let labels = '';
  // 1 ผู้ใช้ → Edge
  paths += route([[200, 272], [320, 272]], 'ctrl');
  labels += labelH({ segs: ['กรอกข้อมูล'], cx: 260, ly: 272, num: 1, fill: C.link }).svg;
  // 2 Edge → กล้อง (ONVIF)
  paths += route([[520, 224], [576, 224], [576, 80], [720, 80]], 'ctrl');
  labels += labelH({ segs: ['ถามกล้อง (ONVIF)'], cx: 652, ly: 80, num: 2, fill: C.link }).svg;
  // 5 Edge → กล้อง (เช็ค TCP) ประ
  paths += route([[520, 256], [600, 256], [600, 128], [720, 128]], 'optional');
  labels += labelH({ segs: ['เช็คสถานะ'], cx: 664, ly: 128, num: 5 }).svg;
  // 3 Edge → SQLite
  paths += route([[520, 288], [720, 288]], 'muted');
  labels += labelH({ segs: ['บันทึก + ออก ID'], cx: 640, ly: 288, num: 3 }).svg;
  // 4 Edge → go2rtc
  paths += route([[520, 320], [580, 320], [580, 440], [720, 440]], 'muted');
  labels += labelH({ segs: ['สร้างสตรีม'], cx: 652, ly: 440, num: 4 }).svg;
  // 6 Edge → Regional
  paths += route([[420, 352], [420, 416]], 'ctrl');
  labels += labelV({ segs: ['แจ้งขึ้น Regional'], lx: 420, cy: 384, num: 6, fill: C.link }).svg;

  const nodes = [
    { x: 40, y: 224, w: 160, h: 100, kind: 'input', tag: 'PERSON', name: 'เจ้าหน้าที่', subs: ['เปิดหน้าเว็บ Edge', 'Cameras → Add Camera', 'เลือกจังหวัด/อำเภอ'] },
    { x: 320, y: 192, w: 200, h: 160, kind: 'focal', tag: 'EDGE', name: 'Edge Gateway', subs: ['Node.js + Express :5173', 'รับคำสั่งจากหน้าเว็บ', 'คุยกับกล้องทุกอย่างที่นี่', 'ตรวจสถานะทุก 15 วินาที'] },
    { x: 720, y: 48, w: 200, h: 112, kind: 'external', tag: 'CAMERA', name: 'กล้อง IP', subs: ['ONVIF ตอบว่ามีช่องภาพอะไร', 'ให้ URL RTSP (main / sub)'] },
    { x: 720, y: 224, w: 200, h: 112, kind: 'store', tag: 'SQLITE', name: 'ฐานข้อมูล vms.db', subs: ['ชื่อ · RTSP (มีรหัสผ่าน)', 'จังหวัด · Global ID'] },
    { x: 720, y: 384, w: 200, h: 112, kind: 'backend', tag: 'GO2RTC', name: 'go2rtc (ตัวกลางภาพ)', subs: ['ลงทะเบียน 4 สตรีมต่อกล้อง', 'ต่อกล้องเมื่อมีคนดูเท่านั้น'] },
    { x: 320, y: 416, w: 200, h: 112, kind: 'external', tag: 'PARENT', name: 'Regional', subs: ['ผู้ดูแลภาค', 'รับ catalog ผ่าน WebSocket'] },
  ];
  const body = paths + labels + nodes.map((n) => node(n)).join('')
    + legend({ y: 560, w: W, items: [{ line: 'ctrl', text: 'คำสั่ง / คำขอ' }, { line: 'muted', text: 'เขียนข้อมูล' }, { line: 'optional', text: 'ทำเป็นรอบ' }, { box: 'focal', text: 'Edge เป็นจุดเริ่มทั้งหมด' }] });
  return svgWrap({
    slug: 'flow-add-camera', title: 'ขั้นที่ 1: เจ้าหน้าที่เพิ่มกล้องที่ Edge',
    desc: 'Edge ถามกล้องผ่าน ONVIF ได้ URL RTSP บันทึกลงฐานข้อมูลพร้อมออก Global ID ลงทะเบียนสตรีมใน go2rtc ตรวจสถานะเป็นรอบ แล้วแจ้งรายชื่อกล้องขึ้น Regional',
    w: W, h: H, body,
  });
}

/* ============================================================ C. catalog / สถานะ */
export function diagramCatalog() {
  const W = 1200;
  const heads = [
    { x: 140, w: 160, tag: 'EDGE', name: 'Edge 101', kind: 'focal' },
    { x: 440, w: 160, tag: 'REGIONAL', name: 'Regional 100' },
    { x: 740, w: 160, tag: 'CENTRAL', name: 'Central 000' },
    { x: 1040, w: 160, tag: 'CLIENT', name: 'Windows Client', kind: 'input' },
  ];
  const items = [
    { type: 'msg', y: 132, from: 0, to: 1, num: 1, segs: [m('hello'), ' — Edge โทรขึ้นไปเปิดสาย'] },
    { type: 'msg', y: 168, from: 1, to: 0, num: 2, ret: true, segs: [m('welcome'), ' — รับสาย'] },
    { type: 'msg', y: 204, from: 0, to: 1, num: 3, accent: true, segs: [m('catalog'), ' — กล้อง + Global ID'] },
    { type: 'note', y: 224, at: 1, lines: ['บันทึกแถวกล้อง (relay)', 'สร้างสตรีม _in รอรับภาพ'] },
    { type: 'msg', y: 304, from: 1, to: 2, num: 4, segs: [m('catalog'), ' — รวมทั้งภาค'] },
    { type: 'note', y: 324, at: 2, lines: ['บันทึกแถวกล้อง (relay)', 'สร้างสตรีม _in รอรับภาพ'] },
    { type: 'msg', y: 404, from: 0, to: 1, num: 5, segs: [m('camera_state'), ' — กล้องหลุด'] },
    { type: 'msg', y: 440, from: 1, to: 2, num: 6, segs: [m('camera_state'), ' — ส่งต่อ'] },
    { type: 'msg', y: 488, from: 3, to: 2, num: 7, segs: [m('GET /api/v1/cameras')] },
    { type: 'msg', y: 524, from: 2, to: 3, num: 8, ret: true, segs: ['รายชื่อ + สถานะ (JSON)'] },
    { type: 'note', y: 548, at: 0, lines: [[m('heartbeat'), ' ทุก 20 วิ'], 'เงียบเกิน ~70 วิ = สายตาย'] },
  ];
  return sequence({
    slug: 'flow-catalog', title: 'ขั้นที่ 2: รายชื่อกล้องและสถานะเดินทางขึ้นไปหา Central',
    desc: 'Edge เปิด WebSocket ขึ้นหา Regional ส่ง catalog และสถานะกล้อง Regional ส่งต่อให้ Central แล้ว Windows Client ขอรายชื่อกล้องจาก Central ผ่าน HTTP',
    w: W, heads, bottom: 612, items,
    legendItems: [{ line: 'ctrl', text: 'ข้อความควบคุม / คำขอ' }, { line: 'ret', text: 'คำตอบ' }, { line: 'accent', text: 'ข้อความหลัก (รายชื่อกล้อง)' }, { box: 'store', text: 'สิ่งที่เครื่องนั้นทำเอง' }],
  });
}

/* ============================================================ D. ภาพวิ่งผ่านอะไรบ้าง (แนวตั้ง มีคำอธิบายขวา) */
export function diagramVideoJourney() {
  const W = 1200;
  const NX = 80; const NW = 240; const NH = 76;
  // y ของแต่ละ node
  const ys = { cam: 48, e1: 200, e2: 328, r1: 504, r2: 632, c1: 808, c2: 936, cl: 1112 };
  const defs = [
    { id: 'cam', kind: 'external', tag: 'CAMERA', name: 'กล้อง IP', subs: ['H.265 + เสียง PCMA'] },
    { id: 'e1', kind: 'backend', tag: 'GO2RTC', name: 'go2rtc ที่ Edge', subs: [[m('<id>_raw'), ' (ไม่แกะรหัส)']] },
    { id: 'e2', kind: 'backend', tag: 'FFMPEG', name: 'ffmpeg ที่ Edge', subs: [[m('-c copy'), ' ส่งต่อทั้งก้อน']] },
    { id: 'r1', kind: 'backend', tag: 'GO2RTC', name: 'go2rtc ที่ Regional', subs: [[m('<id>_in'), ' → ', m('_raw')]] },
    { id: 'r2', kind: 'backend', tag: 'FFMPEG', name: 'ffmpeg ที่ Regional', subs: [[m('-c copy'), ' ส่งต่อทั้งก้อน']] },
    { id: 'c1', kind: 'backend', tag: 'GO2RTC', name: 'go2rtc ที่ Central', subs: [[m('<id>_in'), ' → ', m('_raw')]] },
    { id: 'c2', kind: 'backend', tag: 'GATEWAY', name: 'Gateway ที่ Central', subs: [[m(':5173'), ' ตรวจ token']] },
    { id: 'cl', kind: 'focal', tag: 'CLIENT', name: 'Windows Client', subs: ['libVLC ถอดรหัสบน GPU'] },
  ];
  const zones = [
    zone({ x: 48, y: ys.e1 - 32, w: 304, h: ys.e2 + NH + 16 - (ys.e1 - 32), label: 'เครื่อง Edge' }),
    zone({ x: 48, y: ys.r1 - 32, w: 304, h: ys.r2 + NH + 16 - (ys.r1 - 32), label: 'เครื่อง Regional' }),
    zone({ x: 48, y: ys.c1 - 32, w: 304, h: ys.c2 + NH + 16 - (ys.c1 - 32), label: 'เครื่อง Central' }),
  ].join('');
  const cx = NX + NW / 2;
  const hops = [
    { from: 'cam', to: 'e1', kind: 'video' },
    { from: 'e1', to: 'e2', kind: 'muted' },
    { from: 'e2', to: 'r1', kind: 'video' },
    { from: 'r1', to: 'r2', kind: 'muted' },
    { from: 'r2', to: 'c1', kind: 'video' },
    { from: 'c1', to: 'c2', kind: 'muted' },
    { from: 'c2', to: 'cl', kind: 'video' },
  ];
  let paths = '';
  hops.forEach((h) => { paths += route([[cx, ys[h.from] + NH], [cx, ys[h.to]]], h.kind); });
  const nodeSvg = defs.map((d) => node({ x: NX, y: ys[d.id], w: NW, h: NH, kind: d.kind, tag: d.tag, name: d.name, subs: d.subs })).join('');

  // คำอธิบายขวา: ผูกกับแต่ละลูกศร
  const TX = 400;
  const notes = [
    { n: 1, hop: 0, title: 'RTSP ผ่าน TCP · port 554 ของกล้อง', lines: [
      'go2rtc ที่ Edge ต่อไปขอภาพจากกล้อง "เฉพาะตอนมีคนอ่านสตรีม" ภาพ 1 เฟรมถูกกล้องบีบเป็น H.265 แล้วหั่นเป็น',
      'แพ็กเก็ต RTP ชิ้นละไม่เกินราว 1.5 KB (เสียงอีกสายหนึ่ง) วิ่งผ่าน TCP ที่รับประกันว่าครบและเรียงลำดับ',
      'go2rtc "ไม่แกะ" ข้อมูลออกมาเป็นภาพ — แค่รับแล้วเก็บเป็นสตรีมชื่อ <id>_raw'] },
    { n: 2, hop: 1, title: 'RTSP ภายในเครื่อง (127.0.0.1)', lines: [
      'ffmpeg ที่ Edge อ่านจาก go2rtc ของเครื่องเดียวกัน ไม่ได้ต่อกล้องซ้ำ',
      'กล้องจึงถูกดึงสายเดียวต่อสตรีม ไม่ว่าจะมีคนดูกี่คน (กล้องรับ session ได้จำกัด)'] },
    { n: 3, hop: 2, title: 'RTSP push ผ่าน TCP · Regional port 8565', lines: [
      'ffmpeg "ผลัก" ภาพขึ้นไปที่สตรีม <id>_in ของ go2rtc ฝั่ง Regional ด้วยบัญชี RTSP ที่ Regional ส่งมาให้ตอนสั่งเปิด',
      '-c copy = คัดลอกแพ็กเก็ตตรง ๆ ไม่ถอดรหัสและไม่บีบใหม่ ใช้ CPU แทบไม่เสีย  ·  Edge เป็นฝ่ายต่อออก จึงทะลุ NAT ได้'] },
    { n: 4, hop: 3, title: 'RTSP ภายในเครื่อง Regional', lines: [
      'go2rtc ที่ Regional ต่อสตรีม <id>_in (ที่เพิ่งรับ push) ออกเป็น <id>_raw ให้ ffmpeg ตัวถัดไปอ่าน',
      'ถ้ามี Client ต่อ Regional ตรง ๆ ในภาค ก็อ่านจากสตรีมเดียวกันนี้ได้เลย ไม่ต้องดึงจากกล้องเพิ่ม'] },
    { n: 5, hop: 4, title: 'RTSP push ผ่าน TCP · Central port 8555', lines: [
      'ทำซ้ำช่วงที่ 3 อีกครั้ง: Regional ทำตัวเป็น "Edge" ของ Central — ffmpeg -c copy ผลักขึ้นสตรีม <id>_in ของ Central',
      'ภาพยังเป็น H.265 ชุดเดิมจากกล้องทุกประการ ไม่ถูกแปลงเลยตลอดสามเครื่อง'] },
    { n: 6, hop: 5, title: 'HTTP ภายในเครื่อง · go2rtc API port 1984', lines: [
      'Gateway ขอ /api/stream.mp4?src=<id>_raw&video=copy จาก go2rtc (ฟังเฉพาะ 127.0.0.1 ภายนอกต่อไม่ได้)',
      'go2rtc ประกอบแพ็กเกต RTP กลับเป็นเฟรม แล้วห่อใหม่เป็น fMP4 (กล่อง moof+mdat ทีละท่อน) — ยังไม่เปลี่ยนโค้ดวิดีโอ'] },
    { n: 7, hop: 6, title: 'HTTP port 5173 · /stream/<id>_raw.mp4?t=…', lines: [
      'Client ได้ URL + stream token (อายุราว 5 นาที ผูกกับกล้องตัวนั้น) จากการเรียก /api/v1/cameras/:id/streams',
      'Gateway ตรวจ token แล้วส่ง fMP4 ต่อเนื่องไปยัง libVLC ซึ่งถอดรหัส H.265 ด้วย GPU ของเครื่องผู้ใช้แล้ววาดลงจอ'] },
  ];
  let callouts = '';
  notes.forEach((n) => {
    const y1 = ys[hops[n.hop].from] + NH; const y2 = ys[hops[n.hop].to];
    const mid = (y1 + y2) / 2;
    const top = mid - 8 * (n.lines.length + 2) - 4;
    callouts += badge(n.n, TX - 20, Math.round(top + 4));
    callouts += `<text x="${TX}" y="${Math.round(top + 8)}" fill="${C.ink}" font-size="12" font-weight="600" font-family="${SANS}">${esc(n.title)}</text>`;
    n.lines.forEach((l) => { if (TX + tw(l) > 1160) throw new Error('คำอธิบายยาวเกิน: ' + l.slice(0, 40)); });
    n.lines.forEach((l, i) => { callouts += `<text x="${TX}" y="${Math.round(top + 28 + 16 * i)}" fill="${C.muted}" font-size="12" font-family="${SANS}">${esc(l)}</text>`; });
    // เส้นนำจากลูกศรไปคำอธิบาย (ประ)
    callouts += rt(['ตัวอย่าง  ', [EX[n.n], 'm']], TX, Math.round(top + 32 + 16 * n.lines.length), { anchor: 'start', fill: C.link });
    if (TX + segW(['ตัวอย่าง  ', [EX[n.n], 'm']]) > 1160) throw new Error('ตัวอย่าง URL ยาวเกิน: ' + EX[n.n]);
    callouts += `<line x1="${cx + 8}" y1="${mid}" x2="${TX - 36}" y2="${mid}" stroke="rgba(45,49,66,0.18)" stroke-width="0.8" stroke-dasharray="2,3"/>`;
  });
  const H = ys.cl + NH + 84;
  const body = zones + paths + nodeSvg + callouts + legend({ y: H - 48, w: W, items: [{ line: 'video', text: 'ภาพวิ่งข้ามเครื่อง/ข้ามเครือข่าย' }, { line: 'muted', text: 'ส่งต่อภายในเครื่องเดียวกัน' }, { box: 'focal', text: 'ปลายทาง' }] });
  return svgWrap({
    slug: 'flow-video', title: 'ขั้นที่ 3: ภาพ 1 เส้นวิ่งผ่านโปรแกรมอะไรบ้างจากกล้องถึงจอ',
    desc: 'ภาพ RTSP H.265 จากกล้องเข้า go2rtc ที่ Edge ถูก ffmpeg ผลักขึ้น Regional และ Central โดยไม่แปลงโค้ด จากนั้น Gateway ที่ Central ส่งเป็น fMP4 ทาง HTTP ให้ Windows Client ถอดรหัสบน GPU',
    w: W, h: H, body,
  });
}

/* ============================================================ E. ชีวิตของ 1 เฟรม */
export function diagramFrame() {
  const W = 1200; const H = 268;
  const NW = 160; const NH = 120; const NY = 80; const GAP = 32;
  const stages = [
    { kind: 'external', tag: 'CAMERA', name: '1 จับภาพ', subs: ['เซนเซอร์เก็บแสง', 'ได้ภาพนิ่ง 1 ภาพ', 'เช่น 25 ภาพต่อวินาที'] },
    { kind: 'external', tag: 'CAMERA', name: '2 บีบอัด', subs: ['ชิปในกล้อง encode', 'เป็น H.265', 'เล็กลงมาก'] },
    { kind: 'external', tag: 'CAMERA', name: '3 หั่นเป็นแพ็กเก็ต', subs: ['RTP ชิ้นละ ≤ 1.5 KB', 'ใส่ลำดับ + เวลา', 'ส่งผ่าน TCP'] },
    { kind: 'focal', tag: 'EDGE → CENTRAL', name: '4 ส่งต่อ 3 ทอด', subs: ['go2rtc + ffmpeg', 'คัดลอกแพ็กเก็ตตรง ๆ', 'ไม่แกะ ไม่บีบใหม่'] },
    { kind: 'backend', tag: 'CENTRAL', name: '5 ห่อใหม่เป็น MP4', subs: ['ประกอบกลับเป็นเฟรม', 'ใส่กล่อง fMP4', 'ส่งทาง HTTP'] },
    { kind: 'input', tag: 'CLIENT', name: '6 ถอดรหัส + แสดง', subs: ['libVLC รับ fMP4', 'GPU ถอด H.265', 'วาดลงจอ'] },
  ];
  let body = ''; let paths = '';
  stages.forEach((s, i) => {
    const x = 40 + i * (NW + GAP);
    if (i < stages.length - 1) paths += route([[x + NW, NY + NH / 2], [x + NW + GAP, NY + NH / 2]], 'video');
  });
  const nodeSvg = stages.map((s, i) => node({ x: 40 + i * (NW + GAP), y: NY, w: NW, h: NH, kind: s.kind, tag: s.tag, name: s.name, subs: s.subs })).join('');
  body += paths + nodeSvg;
  const cap = (t, x) => `<text x="${x}" y="60" fill="${C.soft}" font-size="12" font-family="${SANS}" text-anchor="middle">${t}</text>`;
  body += cap('ในตัวกล้อง', 40 + (3 * NW + 2 * GAP) / 2);
  body += cap('บนเครือข่ายและเซิร์ฟเวอร์', 40 + 3 * (NW + GAP) + (2 * NW + GAP) / 2);
  body += cap('ในเครื่องผู้ใช้', 40 + 5 * (NW + GAP) + NW / 2);
  body += legend({ y: 232, w: W, items: [{ line: 'video', text: 'ข้อมูลภาพ' }, { box: 'focal', text: 'ช่วงที่ "ไม่เปลี่ยนรูป" ตลอดสามเครื่อง' }] });
  return svgWrap({
    slug: 'flow-frame', title: 'ชีวิตของภาพ 1 เฟรม',
    desc: 'ภาพหนึ่งเฟรมถูกกล้องบีบเป็น H.265 หั่นเป็นแพ็กเก็ต RTP ส่งต่อโดยไม่แกะผ่านสามเครื่อง ถูกห่อเป็น fMP4 ที่ Central แล้ว Client ถอดรหัสบน GPU',
    w: W, h: H, body,
  });
}

/* ============================================================ F. ใครสั่งให้ภาพเริ่มวิ่ง/หยุด */
export function diagramOnDemand() {
  const W = 1200;
  const heads = [
    { x: 100, w: 136, tag: 'CLIENT', name: 'Client', kind: 'input' },
    { x: 340, w: 136, tag: 'CENTRAL', name: 'Central' },
    { x: 580, w: 136, tag: 'REGIONAL', name: 'Regional' },
    { x: 820, w: 136, tag: 'EDGE', name: 'Edge', kind: 'focal' },
    { x: 1060, w: 136, tag: 'CAMERA', name: 'กล้อง', kind: 'external' },
  ];
  const items = [
    { type: 'msg', y: 128, from: 0, to: 1, num: 1, segs: [m('GET …/:id/streams')] },
    { type: 'msg', y: 164, from: 1, to: 0, num: 2, ret: true, segs: ['URL + token 5 นาที'] },
    { type: 'msg', y: 200, from: 0, to: 1, num: 3, segs: [m('GET /stream/…_raw.mp4')] },
    { type: 'note', y: 216, at: 1, lines: ['ภาพยังไม่มา → ขอชั้นล่าง', 'แล้วรอได้ไม่เกิน 8 วินาที'] },
    { type: 'msg', y: 296, from: 1, to: 2, num: 4, segs: [m('stream.open'), ' (WS)'] },
    { type: 'msg', y: 332, from: 2, to: 3, num: 5, segs: [m('stream.open'), ' (WS)'] },
    { type: 'note', y: 348, at: 3, lines: ['เปิด ffmpeg อ่าน go2rtc', 'ของตัวเอง แล้วผลักขึ้นไป'] },
    { type: 'msg', y: 420, from: 3, to: 4, num: 6, segs: [m('RTSP'), ' ขอภาพ'] },
    { type: 'msg', y: 456, from: 4, to: 3, num: 7, ret: true, segs: ['วิดีโอ RTP (H.265)'] },
    { type: 'msg', y: 492, from: 3, to: 2, num: 8, kind: 'video', segs: ['push ', m('-c copy')] },
    { type: 'msg', y: 528, from: 2, to: 1, num: 9, kind: 'video', segs: ['push ', m('-c copy')] },
    { type: 'msg', y: 564, from: 1, to: 0, num: 10, accent: true, segs: [m('fMP4'), ' ไหลต่อเนื่อง'] },
    { type: 'note', y: 584, at: 1, lines: ['ไม่มีคนดูครบ 60 วินาที', 'Central สั่งเลิกส่ง'] },
    { type: 'msg', y: 656, from: 1, to: 2, num: 11, segs: [m('stream.close')] },
    { type: 'msg', y: 692, from: 2, to: 3, num: 12, segs: [m('stream.close')] },
    { type: 'note', y: 708, at: 3, lines: ['หยุด ffmpeg · go2rtc', 'ตัดการต่อกล้อง'] },
  ];
  return sequence({
    slug: 'flow-ondemand', title: 'ขั้นที่ 4: ใครสั่งให้ภาพเริ่มวิ่งและหยุดวิ่ง',
    desc: 'เมื่อ Client ขอเปิดภาพ Central สั่งผ่าน WebSocket ลงไปที่ Regional และ Edge ให้ผลักภาพขึ้นมา และสั่งหยุดเมื่อไม่มีคนดูครบ 60 วินาที',
    w: W, heads, bottom: 776, items,
    legendItems: [{ line: 'ctrl', text: 'คำสั่ง' }, { line: 'ret', text: 'คำตอบ / ข้อมูลกลับ' }, { line: 'video', text: 'ภาพวิ่งขึ้น' }, { line: 'accent', text: 'ภาพถึงจอ' }],
  });
}

/* ============================================================ G. Client vs เว็บ */
export function diagramTwoPaths() {
  const W = 1200; const H = 604;
  let paths = ''; let labels = '';
  paths += route([[240, 240], [600, 240]], 'video');
  labels += labelH({ segs: ['ส่งตรง ไม่แปลงโค้ด (H.265 เดิม)'], cx: 420, ly: 240, fill: C.ink }).svg;
  paths += route([[140, 336], [140, 432], [320, 432]], 'muted');
  labels += labelH({ segs: ['ส่งให้แปลงโค้ด'], cx: 228, ly: 432 }).svg;
  paths += route([[520, 432], [560, 432], [560, 304], [600, 304]], 'muted');
  labels += labelV({ segs: ['H.264'], lx: 560, cy: 376, fill: C.muted }).svg;
  paths += route([[800, 240], [880, 240], [880, 120], [960, 120]], 'video');
  paths += route([[800, 304], [880, 304], [880, 456], [960, 456]], 'muted');
  const nodes = [
    { x: 40, y: 208, w: 200, h: 128, kind: 'backend', tag: 'GO2RTC', name: 'go2rtc ที่ Central', subs: ['ภาพจากกล้องมาถึงที่นี่', 'เป็น H.265 (ส่วนใหญ่)'] },
    { x: 320, y: 384, w: 200, h: 100, kind: 'focal', tag: 'NVENC', name: 'ffmpeg + การ์ดจอ', subs: ['ถอดรหัส H.265', 'บีบใหม่เป็น H.264'] },
    { x: 600, y: 208, w: 200, h: 128, kind: 'backend', tag: 'GATEWAY', name: 'Gateway :5173', subs: ['ตรวจ stream token', 'ส่งต่อเป็น fMP4 ทาง HTTP'] },
    { x: 960, y: 64, w: 200, h: 112, kind: 'input', tag: 'CLIENT', name: 'Windows Client', subs: ['ขอ URL ที่ลงท้าย _raw', 'GPU ถอด H.265 เอง'] },
    { x: 960, y: 400, w: 200, h: 112, kind: 'input', tag: 'BROWSER', name: 'เว็บเบราว์เซอร์ (Live)', subs: ['ขอ URL ปกติ ไม่มี _raw', 'เล่นผ่าน MSE ได้เฉพาะ H.264'] },
  ];
  const note = `<text x="40" y="528" fill="${C.muted}" font-size="14" font-style="italic" font-family="${SERIF}">ทำไมเว็บต้องแปลง: go2rtc 1.9.14 พังเมื่อส่ง H.265 เข้า MSE จึงบังคับให้เส้นของเว็บเป็น H.264 เสมอ</text>`;
  const body = paths + labels + nodes.map((n) => node(n)).join('') + note
    + legend({ y: 556, w: W, items: [{ line: 'video', text: 'ภาพที่ไม่ถูกแปลง' }, { line: 'muted', text: 'ภาพที่ผ่านการแปลงโค้ด' }, { box: 'focal', text: 'จุดเดียวที่แปลงโค้ด' }] });
  return svgWrap({
    slug: 'flow-twopaths', title: 'ขั้นที่ 5: ปลายทางสองแบบ — Client ได้ภาพดิบ เว็บได้ภาพที่แปลงแล้ว',
    desc: 'ที่ Central ภาพเดียวกันแยกเป็นสองทาง Windows Client ได้ H.265 ตรงจาก go2rtc ส่วนเว็บเบราว์เซอร์ได้ H.264 ที่ผ่าน ffmpeg และการ์ดจอแปลงโค้ด',
    w: W, h: H, body,
  });
}
