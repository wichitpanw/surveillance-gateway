/**
 * ดึงภาพ Alarm ที่บันทึกในอุปกรณ์ Tiandy โดยจับคู่ช่องและเวลาของเหตุแบบตรงกัน
 * ไม่ใช้ภาพ Manual หรือ snapshot ปัจจุบันแทนหลักฐานย้อนหลัง
 */
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { spawn } = require('node:child_process');
const { authedRequest } = require('./http-digest');
const { cameraTime } = require('./tiandy-perimeter');
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const LIMIT = 300 * 1024;

/** กล้องทดลองใช้ Z กับเวลาหน้าปัดไทยทั้ง AlarmInfo และ picture search */
function searchTime(ts, mode, offset = 0) {
  const value = new Date(Date.parse(ts) + offset + (mode === 'bangkok-wall' ? 7 * 3600000 : 0));
  if (!Number.isFinite(value.getTime())) throw new Error('เวลาเหตุไม่ถูกต้อง');
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** ตรวจ XML และเลือกเฉพาะภาพ Alarm ของช่อง/วินาทีเดียวกัน; หลายไฟล์จะไม่เดา */
function matchPictures(xml, event) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Picture search ไม่ใช่ XML ที่สมบูรณ์');
  const root = parser.parse(xml).CMSearchResult;
  if (!root) throw new Error('อุปกรณ์ไม่ตอบ CMSearchResult');
  const items = root.matchList?.matchElement;
  const list = items ? (Array.isArray(items) ? items : [items]) : [];
  const files = new Set();
  for (const item of list) {
    if (String(item.type).toLowerCase() !== 'alarm' || Number(item.chanNo) !== event.attrs.channel - 1) continue;
    if (Math.floor(Date.parse(cameraTime(item.timeSpan?.startTime, event.attrs.timeMode)) / 1000) !== Math.floor(Date.parse(event.ts) / 1000)) continue;
    const name = String(item.fileName || '');
    if (!/^[A-Za-z0-9_-]{1,100}\.jpe?g$/i.test(name)) throw new Error('ชื่อไฟล์ภาพเหตุไม่ถูกต้อง');
    files.add(name);
  }
  if (files.size > 1) throw new Error('พบหลายภาพ Alarm ในวินาทีเดียวกัน จับคู่ภาพเหตุไม่ได้');
  const count = Number(root.numOfMatches);
  if (!Number.isInteger(count) || count < 0 || list.length > 40) throw new Error('จำนวนภาพตอบกลับไม่ถูกต้อง');
  return { file: [...files][0] || null, count, returned: list.length };
}

/** ตรวจ JPEG ด้วย decoder และย่อในหน่วยความจำ ไม่มีไฟล์วิดีโอหรือ inference */
function convertJpeg(input, width, quality, executable) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'image2pipe', '-i', 'pipe:0',
      '-frames:v', '1', '-vf', 'scale=min(' + width + '\\,iw):-2', '-threads', '1', '-q:v', String(quality),
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let size = 0;
    const chunks = [];
    let finished = false;
    const finish = (err, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (err) { proc.kill(); reject(err); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('ย่อภาพเหตุเกินเวลาที่กำหนด')), 10000);
    proc.on('error', () => finish(new Error('เปิด FFmpeg สำหรับย่อภาพเหตุไม่ได้')));
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(new Error('ภาพหลังย่อใหญ่เกินกำหนด'));
      else chunks.push(chunk);
    });
    proc.stderr.resume();
    proc.on('close', (code) => {
      if (code !== 0) return finish(new Error('ถอดรหัส JPEG ของเหตุไม่ได้'));
      const output = Buffer.concat(chunks);
      if (output.length < 4 || output[0] !== 0xff || output[1] !== 0xd8) return finish(new Error('ภาพเหตุไม่ใช่ JPEG'));
      finish(null, output);
    });
    proc.stdin.end(input);
  });
}

/** จำกัดภาพส่งต่อ 300 KB โดยคงภาพเหตุเดิมและไม่เปิดสตรีม */
async function compactJpeg(input, { ffmpegPath = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:/ffmpeg/bin/ffmpeg.exe' : 'ffmpeg') } = {}) {
  if (!Buffer.isBuffer(input) || input.length < 4 || input.length > 8 * 1024 * 1024 || input[0] !== 0xff || input[1] !== 0xd8) throw new Error('ภาพ Alarm ไม่ใช่ JPEG หรือใหญ่เกิน 8 MB');
  const executable = String(ffmpegPath).replace(/\\\\/g, '\\');
  for (const [width, quality] of [[1280, 5], [960, 8], [640, 12]]) {
    const jpeg = await convertJpeg(input, width, quality, executable);
    if (jpeg.length <= LIMIT) return jpeg;
  }
  throw new Error('ย่อภาพเหตุให้ไม่เกิน 300 KB ไม่สำเร็จ');
}

/** ค้นภาพที่เวลาตรงกัน; ถ้าผลลัพธ์เต็มหน้าจะไม่เลือกจากรายการที่อาจไม่ครบ */
async function readEventImage(cam, event, { request = authedRequest, compress = compactJpeg } = {}) {
  const mode = event.attrs.timeMode || 'bangkok-wall';
  const body = '<CMSearchDescription><timeSpanList><timeSpan><startTime>' + searchTime(event.ts, mode, -5000) +
    '</startTime><endTime>' + searchTime(event.ts, mode, 5000) + '</endTime></timeSpan></timeSpanList>' +
    '<contentTypeList><contentType>picture</contentType></contentTypeList><RecTypeList><recType>ALL</recType></RecTypeList>' +
    '<streamType>main</streamType><maxResults>40</maxResults><searchResultPostion>1</searchResultPostion>' +
    '<channelID>' + (event.attrs.channel - 1) + '</channelID><queryType>0</queryType></CMSearchDescription>';
  const result = await request(cam, '/ISAPI/ContentMgmt/search', { method: 'POST', body, maxBytes: 1024 * 1024 });
  const match = matchPictures(result.text, event);
  if (match.count >= 40 || match.returned >= 40) throw new Error('ผลค้นภาพเต็มหน้า จับคู่ภาพเหตุไม่ได้');
  if (!match.file) return null;
  const downloaded = await request(cam, '/ISAPI/Record/DownLoad/' + match.file, { maxBytes: 8 * 1024 * 1024 });
  const jpeg = await compress(downloaded.body);
  return { snapshot: jpeg.toString('base64'), file: match.file };
}
module.exports = { searchTime, matchPictures, compactJpeg, readEventImage };
