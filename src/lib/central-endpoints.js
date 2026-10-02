const DEFAULT_PORT = 5173;
const DEFAULT_RTSP = 8555;

/**
 * URL ของสาย link สำหรับที่อยู่ของ central หนึ่งรายการ (CentralEndpoints)
 * ต่อท้าย ?rtsp= เมื่อพอร์ต RTSP บนเส้นทางนั้นไม่ใช่ 8555 (NAT) — server/vms/edge-link-client.js อ่านค่านี้
 */
export const linkUrlOf = (e) =>
  `ws://${e.host}:${e.port || DEFAULT_PORT}/api/edge-link${Number(e.rtspPort) && Number(e.rtspPort) !== DEFAULT_RTSP ? `?rtsp=${e.rtspPort}` : ''}`;

/** host:port จาก URL ของสาย link สำหรับแสดงผล — URL เพี้ยนก็คืนข้อความเดิม */
export const hostOfUrl = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
};
