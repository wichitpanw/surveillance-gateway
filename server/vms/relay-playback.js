/**
 * Regional ส่งภาพย้อนหลังจาก Edge จังหวัดขึ้น Central แบบสตรีม ไม่มีไฟล์พักกลางทาง
 * อินเทอร์เฟซตรงกับ device-playback ที่ edge-link-client เรียกใช้
 */
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

function createRelayPlayback({ playback, getCameraRow }) {
  /** หาแถว relay เฉพาะกล้องที่ Regional รับจาก Edge */
  async function camera(cameraId) {
    const row = await getCameraRow(cameraId);
    if (!row || row.type !== 'edge_relay') {
      throw Object.assign(new Error('ไม่พบกล้องจาก Edge จังหวัด'), { status: 404 });
    }
    return row;
  }

  /** ขอช่วงบันทึกจาก Edge จังหวัด */
  async function ranges(cameraId, from, to) {
    return playback.ranges(await camera(cameraId), { from, to });
  }

  /** ขอภาพนิ่งจาก Edge จังหวัด */
  async function frame(cameraId, at) {
    return playback.frameBuffer(await camera(cameraId), at);
  }

  /**
   * ใช้ PassThrough เป็น response ของ playback ชั้นล่างและ stdout ของ upload ชั้นบน
   * backpressure ของ Node จำกัดหน่วยความจำ; destroy จะไล่ปิดสายไปถึง Edge
   */
  async function openPlayback(cameraId, query) {
    const row = await camera(cameraId);
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    const headers = new Map();
    const proc = new EventEmitter();
    proc.stdout = stream;
    proc.exitCode = null;
    proc.signalCode = null;
    const exited = (code) => {
      if (proc.exitCode !== null) return;
      proc.exitCode = code;
      proc.emit('close', code);
    };
    stream.on('end', () => exited(0));
    stream.on('error', () => exited(1));
    stream.on('close', () => { if (!stream.readableEnded) exited(1); });
    let readyResolve;
    let readyReject;
    let settled = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const fail = (error) => {
      if (!settled) { settled = true; readyReject(error); }
      stream.destroy();
    };
    stream.on('close', () => {
      if (!settled) fail(Object.assign(new Error('สายภาพย้อนหลังจาก Edge จังหวัดปิดก่อนส่งข้อมูล'), { status: 502 }));
    });
    stream.status = (code) => {
      if (code >= 400) return stream;
      queueMicrotask(() => {
        if (!settled) { settled = true; readyResolve(); }
      });
      return stream;
    };
    stream.set = (name, value) => { headers.set(String(name).toLowerCase(), String(value)); return stream; };
    stream.json = (body) => {
      fail(Object.assign(new Error(body?.error || 'Edge จังหวัดส่งภาพย้อนหลังไม่ได้'), { status: 502 }));
      return stream;
    };
    const work = playback.pipeVideo(row, query, stream);
    work.catch(fail);
    await ready;
    return {
      startIso: headers.get('x-playback-start') || query.start,
      proc,
      kill: () => stream.destroy(),
    };
  }

  return { ranges, frame, openPlayback };
}

module.exports = { createRelayPlayback };
