// PM2 ecosystem ของ Surveillance Gateway Edge — ใช้ไฟล์เดียวทั้ง Windows และ Linux
//
// edge กับ central คือโค้ดชุดเดียวกัน ต่างกันที่ env ตรงนี้ (server/shared/instance.js)
//
//   Windows (edge 001 บนเครื่อง central HOST):
//     powershell -ExecutionPolicy Bypass -File scripts\setup-edge.ps1
//     pm2 start ecosystem.edge.config.cjs
//   Linux (Ubuntu 24 — docs/EDGE-LINUX.md):
//     scripts/setup-edge.sh --node 002 --public-host <IP Tailscale> [--central-url … --central-token …]
//     sudo scripts/setup-edge.sh --install-service      (systemd รัน pm2-runtime จากไฟล์นี้ตอนบูต)
//
// ค่าของเครื่องแต่ละเครื่องอยู่ใน <stateDir>/edge.json (นอก git) ไม่ใช่ในไฟล์นี้ — เดิมต้องแก้บล็อก EDGE
// ในไฟล์ที่อยู่ใน git ซึ่งแปลว่า token ของสาย link ต้องถูก commit หรือทุกเครื่องมีไฟล์นี้ไม่เหมือนกัน
// edge.json ทับค่าเริ่มต้นข้างล่างทีละ key · GW_EDGE_CONFIG ชี้ไปไฟล์อื่นได้
//
// ถ้า edge อยู่เครื่องเดียวกับ central พอร์ตต้องไม่ชนกัน (central ใช้ 5173 / 1984 / 8555 / 8556)

const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';

const DEFAULTS = isWindows
  ? {
      // edge 001 ที่อยู่ร่วมเครื่องกับ central — ค่าเดิมทั้งหมด ไม่มี edge.json ก็ทำงานเหมือนเดิม
      node: '001',
      province: '10',
      port: 5273,
      go2rtcApi: 1994,
      go2rtcRtsp: 8565,
      publicHost: '203.0.113.80',
      stateDir: 'D:\\gateway-edge',
      centralUrl: '',
      centralToken: '',
    }
  : {
      // เครื่อง edge แยก ใช้พอร์ตมาตรฐานได้ · node และ publicHost ต้องมาจาก edge.json (setup-edge.sh เขียนให้)
      node: '',
      province: '10',
      port: 5173,
      go2rtcApi: 1984,
      go2rtcRtsp: 8555,
      publicHost: '',
      stateDir: '/var/lib/gw-edge',
      centralUrl: '',
      centralToken: '',
    };

const configFile = process.env.GW_EDGE_CONFIG || path.join(DEFAULTS.stateDir, 'edge.json');
let local = {};
try {
  local = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw new Error(`อ่าน ${configFile} ไม่ได้: ${err.message}`);
}

/*
  ค่าของเครื่องนี้
    node          เลข edge 3 หลัก ห้ามซ้ำทั้งประเทศ (ตารางใน docs/EDGE-PLAN.md) · central = 000
    province      จังหวัดใน global ID ของกล้องที่ยังไม่เลือกจังหวัด (มอก. 1099, 10 = กรุงเทพฯ)
    publicHost    ที่ central/client ต่อมาถึง edge (IP จริงหรือ Tailscale) — ห้าม 127.0.0.1 · ใช้ในแบบ pull
    centralUrls   [ws://<central>:5173/api/edge-link, …] — ตั้งคู่กับ centralToken = edge ต่อขึ้นไปเอง (link) · ว่าง = pull
                  หลายอันได้: ลองตามลำดับ ใช้อันที่ต่อติด · ต่อท้าย ?rtsp=<พอร์ต> ถ้าพอร์ต RTSP ของ central บนเส้นทางนั้นไม่ใช่ 8555
                  (centralUrl แบบข้อความเดียวของเดิมยังใช้ได้)
    centralToken  token จากหน้า Edge Nodes ของ central (แสดงครั้งเดียว) — เป็นความลับ อยู่ใน edge.json เท่านั้น
    go2rtcBin     ไฟล์ go2rtc ที่ใช้ (ไม่ใส่ = ตัวใน repo บน Windows, <stateDir>/bin/go2rtc บน Linux)
    ffmpeg        ไฟล์ ffmpeg ที่ gateway ใช้ push ภาพขึ้น central (ไม่ใส่ = C:\ffmpeg\bin\ffmpeg.exe / ffmpeg ใน PATH)
                  สองค่านี้ชุดติดตั้ง flash drive ใส่ให้ (docs/EDGE-KIT.md)
    ระบบรับผล AI จากต้นทาง ไม่มี inference worker; ตั้งแหล่งรับที่หน้า AI Sources
*/
const EDGE = { ...DEFAULTS, ...local };
const gatewayRole = EDGE.role === 'regional' ? 'regional' : 'edge';
if (gatewayRole === 'regional' && !EDGE.region) throw new Error(`Regional ต้องตั้ง region ใน ${configFile}`);
const centralUrls = [
  // ข้อความเดียวก็รับ — PowerShell 5.1 แปลง array ที่มีตัวเดียวเป็นข้อความได้ง่าย
  ...(Array.isArray(EDGE.centralUrls) ? EDGE.centralUrls : String(EDGE.centralUrls || '').split(',')),
  ...String(EDGE.centralUrl || '').split(','),
].map((u) => String(u).trim()).filter((u, i, all) => u && all.indexOf(u) === i);
if (!/^\d{3}$/.test(String(EDGE.node))) {
  throw new Error(`ไม่ได้ตั้งเลข edge (node 3 หลัก) — ตั้งใน ${configFile} หรือรัน scripts/setup-edge.sh --node <เลข>`);
}

/*
  ที่เก็บ log — pm2 คำนวณ path ของ log ฝั่ง CLI จาก PM2_HOME ของ shell ที่สั่ง ไม่ใช่ของ daemon
  shell admin ที่ไม่ได้ตั้ง PM2_HOME จึงเคยทำให้ log ของ edge ไปอยู่ C:\Users\Administrator\.pm2\logs
  ทั้งที่ daemon อยู่ D:\gw-pm2\home (audit 2026-09-29) — Windows ตรึงไว้ที่เดียวกับ scripts/start-gateway.cmd
  Linux (pm2-runtime ของ systemd) และเครื่อง Windows ที่ไม่มี D:\gw-pm2\home ใช้ค่าเริ่มต้นของ pm2 เหมือนเดิม
  (edge จากชุด flash drive รันด้วย edge-run.cjs ซึ่งเขียน log เองที่ <stateDir>/logs ไม่อ่านค่าเหล่านี้)
  ทุก app มีเวลาหน้าแต่ละบรรทัด
*/
const PM2_HOME_WIN = 'D:\\gw-pm2\\home';
const LOG_DIR = isWindows && fs.existsSync(PM2_HOME_WIN) ? path.join(PM2_HOME_WIN, 'logs') : '';
const logs = (name) => ({
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  ...(LOG_DIR ? { out_file: path.join(LOG_DIR, `${name}-out.log`), error_file: path.join(LOG_DIR, `${name}-error.log`) } : {}),
});

module.exports = {
  apps: [
    {
      name: '1-go2rtc-edge',
      // Windows ใช้ตัวใน repo · Linux ใช้ตัวที่ setup-edge.sh โหลดให้ตรงสถาปัตยกรรมเครื่อง
      script: EDGE.go2rtcBin || (isWindows ? path.join(__dirname, 'go2rtc', 'go2rtc.exe') : path.join(EDGE.stateDir, 'bin', 'go2rtc')),
      cwd: EDGE.stateDir,
      args: '-config go2rtc.yaml',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      ...logs('1-go2rtc-edge'),
    },
    {
      name: '3-edge-gateway',
      script: 'server.js',
      cwd: path.join(__dirname, 'server'),
      watch: false,
      autorestart: true,
      restart_delay: 2000,
      ...logs('3-edge-gateway'),
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Bangkok',
        GATEWAY_ROLE: gatewayRole,
        ...(gatewayRole === 'regional' ? { GATEWAY_REGION: String(EDGE.region) } : {}),
        GATEWAY_NODE_NUMBER: String(EDGE.node),
        GATEWAY_DEFAULT_PROVINCE: String(EDGE.province),
        GATEWAY_PORT: String(EDGE.port),
        GATEWAY_STATE_DIR: EDGE.stateDir,
        GO2RTC_API_PORT: String(EDGE.go2rtcApi),
        GO2RTC_RTSP_PORT: String(EDGE.go2rtcRtsp),
        GATEWAY_STREAM_CORE: 'go2rtc',
        GATEWAY_PUBLIC_HOST: EDGE.publicHost,
        // edge ส่งต่อ codec ของกล้องเอง (passthrough) ให้ central — transcode เป็นงานของ central
        GATEWAY_RAW_STREAMS: '1',
        GATEWAY_CENTRAL_URL: centralUrls.join(','),
        GATEWAY_CENTRAL_TOKEN: EDGE.centralToken,
        ...(EDGE.ffmpeg ? { FFMPEG_PATH: EDGE.ffmpeg } : {}),
      },
    },
  ],
};
