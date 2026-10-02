// PM2 ecosystem ของ Central API Gateway บน Windows host (HOST)
//
// เครื่องนี้กลับมาเป็นที่รันจริงเมื่อ 2026-08-28 หลังย้ายกลับจาก Ubuntu VM (203.0.113.81)
// เพื่อคืน RTX GPU ตัวที่ DDA ให้ VM อยู่กลับมาที่โฮสต์
//
// ที่อยู่ของบริการคือ 203.0.113.80 ซึ่งเป็น IP ของโฮสต์เอง · 203.0.113.81 (IP ที่ยกมาจาก VM
// ตอน cutover) ถูกเลิกใช้เมื่อ 2026-08-31 เพราะยังไม่มี client รายไหนใช้งานจริง จึงแจ้งให้
// ย้ายเองได้ทัน — ห้ามเอา .81 กลับมาเป็นค่า default ที่ไหนอีก
//
// เดิมล้อ ecosystem ของ Linux VM (ลบแล้ว 2026-09-28) ต่างกันแค่ path ของ go2rtc และ GPU_COUNT

const path = require('path');

/*
  path ทุกตัวอิงที่อยู่ของไฟล์นี้ ไม่ใช่โฟลเดอร์ที่สั่ง pm2 — เดิมเป็น './go2rtc' / './server'
  สั่ง `pm2 start` จาก C:\Windows\system32 (ค่าเริ่มของ shell admin) แล้ว pm2 หา server.js ไม่เจอ
  ทั้งที่เพิ่ง delete แอปไป = central ล่มจนกว่าจะสั่งใหม่จากโฟลเดอร์ repo (เกิดจริง 2026-09-29)
*/
const repo = __dirname;

module.exports = {
  apps: [
    {
      // Streaming core — รับ ingest จากกล้องทุกยี่ห้อแล้วเสิร์ฟ RTSP :8555 / HLS+MSE+WebRTC :1984
      // กล้องถูกซิงก์เข้ามาโดย 2-vms-backend ผ่าน REST API ไม่ได้อ่านจาก go2rtc.yaml
      name: '0-go2rtc',
      script: path.join(repo, 'go2rtc', 'go2rtc.exe'),
      cwd: path.join(repo, 'go2rtc'),
      args: '-config go2rtc.yaml',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      // เวลาหน้าทุกบรรทัดของ log (pm2 ไม่ใส่ให้เอง)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: '2-vms-backend',
      script: path.join(repo, 'server', 'server.js'),
      cwd: path.join(repo, 'server'),
      watch: false,
      autorestart: true,
      restart_delay: 2000, // รอ 2 วินาทีให้ go2rtc เริ่มก่อน
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        // เขตเวลาของ process เท่านั้น — ค่าเวลาที่เขียนลงฐานข้อมูลไม่ได้พึ่งตัวนี้
        // server/shared/time.js ตรึง +07:00 ไว้เองโดยเจตนา ตั้งตรงนี้เพื่อให้ log,
        // ชื่อไฟล์ และ error ที่ไลบรารีอื่นสร้าง เป็นเวลาไทยตาม
        TZ: 'Asia/Bangkok',
        // streaming core ที่ใช้จริง — อ่านโดยทั้ง /hls proxy, gateway/streams.js และ
        // ตัวซิงก์กล้อง ทั้งสามต้องเห็นค่าเดียวกัน ไม่งั้นกล้องจะถูกซิงก์เข้า core หนึ่ง
        // แต่ Gateway ไปถามอีก core หนึ่งแล้วได้ 404 ทุกสตรีมโดยไม่มี error ที่ไหนเลย
        // โปรแกรมของเครื่องนี้คือ Surveillance Gateway Central (แอด edge) — edge รันแยกด้วย ecosystem.edge.config.cjs
        GATEWAY_ROLE: 'central',
        GATEWAY_STREAM_CORE: 'go2rtc',
        // ที่อยู่ที่ client ภายนอกใช้ต่อได้จริง — ห้ามให้ /api/v1 คืน 127.0.0.1 ออกไป
        GATEWAY_PUBLIC_HOST: '203.0.113.80',
        // โฮสต์มี GPU สองใบหลังได้ตัวที่ DDA ไปคืนมา
        //
        // ค่านี้มีผลเฉพาะเส้นทาง spawnTranscode ของยุค MediaMTX (server.js:2909) ซึ่งตายไป
        // แล้วภายใต้ go2rtc — ตั้งให้ตรงความจริงไว้เผื่อวันที่ต้อง rollback ไม่ใช่เพราะใช้อยู่
        GPU_COUNT: '2',
        // สร้างเส้น `<path>_raw` คู่ขนานกับเส้น transcode ให้ทุกกล้อง — H.265 ดิบจากกล้อง
        // ส่งต่อโดยไม่ผ่าน ffmpeg สำหรับ client ที่ถอดรหัสเองได้ (ตัว native บน Windows,
        // Edge AI) ปิดได้ด้วยการลบบรรทัดนี้แล้วรีสตาร์ต backend ถ้ากล้องรุ่นไหนรับ session
        // พร้อมกันไม่ไหว เพราะเส้นนี้เป็นการต่อไปกล้องเพิ่มอีกชุดเมื่อมีคนดูทั้งสองทาง
        GATEWAY_RAW_STREAMS: '1',
      },
    },
  ],
};
