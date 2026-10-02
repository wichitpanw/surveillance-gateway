/**
 * ฟัง metadata track ของกล้องหนึ่งตัว แล้วรายงานว่า "กล้องตัวนี้ส่งอะไรมาบ้าง"
 *
 * ตอบคำถามที่เอกสารของผู้ผลิตตอบไม่ได้และเดาไม่ได้: กล้องตัวนี้เปิด AI อะไรอยู่จริง และมัน
 * ส่งออกมาในรูปแบบไหน ต่างยี่ห้อต่างเปิด topic คนละชุด และแม้แต่กล้องยี่ห้อเดียวกันที่ตั้งค่า
 * ต่างกันก็ส่งไม่เหมือนกัน — ตัวอย่างที่เจอจริง: UNV ตัวหนึ่งเปิดนับคน อีกตัวเปิด Cross Line
 * จับรถยนต์ ทั้งคู่เป็น Uniview เหมือนกันแต่ข้อมูลที่ออกมาคนละเรื่อง
 *
 * วิธีใช้ (ต้องรันบน VM เพราะกล้องอยู่ในวงของ VM):
 *
 *   node server/scripts/probe-onvif-metadata.js --ip 203.0.113.106 --user admin --seconds 60
 *
 * รหัสผ่านรับทาง environment ไม่ใช่ argument เพราะ argument ของ process มองเห็นได้จาก
 * process list ของทุกผู้ใช้บนเครื่อง:
 *
 *   CAM_PASS=xxxxx node server/scripts/probe-onvif-metadata.js --ip ...
 *
 * `--dump <ไฟล์>` เก็บ XML ดิบไว้ให้อ่านย้อน เวลาเจอรูปร่างที่ยังไม่รู้จัก
 */
const fs = require('node:fs');
const { OnvifMetadataSession } = require('../gateway/analytics/onvif-metadata-session');
const { ruleNameOf, isCountingTopic, countsFrom } = require('../gateway/analytics/onvif-metadata');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ip = arg('ip');
const user = arg('user', 'admin');
const pass = process.env.CAM_PASS || '';
const rtspPort = Number(arg('rtsp-port', '554'));
const path = arg('path', '/media/video1');
const seconds = Number(arg('seconds', '60'));
const dumpFile = arg('dump');

if (!ip) {
  console.error('ต้องระบุ --ip เช่น  CAM_PASS=xxx node server/scripts/probe-onvif-metadata.js --ip 203.0.113.106 --user admin');
  process.exit(2);
}
if (!pass) console.warn('! ไม่ได้ตั้ง CAM_PASS — จะลองต่อแบบไม่มีรหัสผ่าน');

/** สรุปรายหัวข้อ: เห็นกี่ครั้ง มาจากกฎไหน ฟิลด์อะไรบ้าง และตัวอย่างค่าล่าสุด */
const topics = new Map();

function record(msg) {
  const key = msg.topic || '(ไม่มี topic)';
  if (!topics.has(key)) {
    topics.set(key, { count: 0, rules: new Set(), fields: new Set(), operations: new Set(), sample: null, counting: 0 });
  }
  const t = topics.get(key);
  t.count += 1;
  const rule = ruleNameOf(msg);
  if (rule) t.rules.add(rule);
  if (msg.propertyOperation) t.operations.add(msg.propertyOperation);
  for (const f of Object.keys(msg.data)) t.fields.add(f);
  t.sample = { source: msg.source, data: msg.data, utcTime: msg.rawUtcTime };
  if (isCountingTopic(msg.topic) && countsFrom(msg)) t.counting += 1;
}

const cam = { host: ip, rtspPort, user, pass, path };
const dump = dumpFile ? fs.createWriteStream(dumpFile, { flags: 'a' }) : null;

const session = new OnvifMetadataSession(cam, {
  onLog: (m) => console.log(`  · ${m}`),
  onMessages: (messages, xml) => {
    for (const m of messages) record(m);
    if (dump) dump.write(`${xml}\n\n`);
  },
});

function report() {
  const s = session.stats;
  console.log('\n' + '='.repeat(72));
  console.log(`สรุปผลจาก ${ip} — ฟัง ${seconds} วินาที`);
  console.log('='.repeat(72));
  console.log(`frame ที่รับ ${s.frames} · เอกสาร ${s.documents} · ข้อความ ${s.messages} · แกะไม่ได้ ${s.parseErrors}`);

  if (topics.size === 0) {
    console.log('\nไม่มีข้อความเลยในช่วงที่ฟัง');
    console.log('อาจแปลว่า: กล้องยังไม่เกิดเหตุการณ์ (ลองเดินผ่าน/ให้มีรถวิ่งผ่านเส้น),');
    console.log('หรือกฎยังไม่ได้เปิด, หรือกล้องไม่ส่ง AI ออกทาง metadata track');
    return;
  }

  console.log(`\nพบ ${topics.size} หัวข้อ:\n`);
  for (const [topic, t] of [...topics.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${topic}`);
    console.log(`     จำนวน       ${t.count}${t.counting ? ` (เป็นยอดนับที่ใช้ได้ ${t.counting})` : ''}`);
    if (t.rules.size) console.log(`     กฎ          ${[...t.rules].join(', ')}`);
    if (t.operations.size) console.log(`     operation   ${[...t.operations].join(', ')}`);
    console.log(`     ฟิลด์       ${[...t.fields].join(', ') || '(ไม่มี)'}`);
    console.log(`     ตัวอย่าง    ${JSON.stringify(t.sample)}`);
    console.log('');
  }

  const counting = [...topics.keys()].filter(isCountingTopic);
  console.log('-'.repeat(72));
  console.log(counting.length
    ? `กล้องตัวนี้ให้ยอดนับได้ผ่าน: ${counting.join(', ')}`
    : 'กล้องตัวนี้ไม่ส่งยอดนับ (CountAggregation) มาเลย — AI ที่เปิดอยู่เป็นชนิดเหตุการณ์ ไม่ใช่ตัวนับ');
  if (dumpFile) console.log(`XML ดิบเก็บไว้ที่ ${dumpFile}`);
}

(async () => {
  console.log(`ต่อไปที่ rtsp://${ip}:${rtspPort}${path} ...`);
  try {
    await session.start();
  } catch (err) {
    console.error(`\nต่อไม่สำเร็จ: ${err.message}`);
    session.stop();
    process.exit(1);
  }

  console.log(`กำลังฟัง ${seconds} วินาที — ให้มีคน/รถผ่านเส้นที่ตั้งไว้เพื่อให้กล้องส่งเหตุการณ์ออกมา\n`);
  setTimeout(() => {
    session.stop();
    if (dump) dump.end();
    report();
    process.exit(0);
  }, seconds * 1000);
})();
