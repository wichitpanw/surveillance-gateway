/** ตรวจและคง URL บริการ ONVIF ที่อุปกรณ์ประกาศ โดยไม่ยอมรับ credential ใน URL */
function parseOnvifXaddrs(value) {
  if (value == null || value === '') return [];
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new Error('ONVIF XAddrs ต้องเป็นรายการ URL'); }
  }
  if (!Array.isArray(input) || input.length > 16) throw new Error('ONVIF XAddrs ต้องเป็นรายการไม่เกิน 16 URL');
  const result = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20]/.test(raw)) throw new Error('ONVIF XAddr ไม่ถูกต้อง');
    let url;
    try { url = new URL(raw); } catch { throw new Error('ONVIF XAddr ไม่ถูกต้อง'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('ONVIF XAddr ต้องเป็น HTTP/HTTPS และไม่มีรหัสผ่านหรือ fragment');
    }
    if (!result.includes(url.href)) result.push(url.href);
  }
  return result;
}

/** แปลง XAddrs จาก multicast เป็น endpoint ที่ยังเก็บ scheme/path/query และตัวเลือกสำรอง */
function discoveredOnvifDevice(device, index) {
  const xaddrs = [];
  for (const value of device.xaddrs || []) {
    try { xaddrs.push(...parseOnvifXaddrs([value])); } catch { /* ข้าม endpoint ที่ไม่ใช่บริการ HTTP/HTTPS */ }
  }
  const unique = [...new Set(xaddrs)].slice(0, 16);
  if (!unique.length) return null;
  const first = new URL(unique[0]);
  const ip = first.hostname.replace(/^\[|\]$/g, '');
  const isAxis = /axis/i.test(`${device.name || ''} ${device.hardware || ''}`);
  return {
    id: `onvif_${index}`,
    name: isAxis ? `${device.hardware || device.name || 'AXIS'} (${ip})` : `ONVIF Device (${ip})`,
    ip, onvifPort: first.port || (first.protocol === 'https:' ? '443' : '80'),
    onvif_xaddrs: unique,
    ...(isAxis ? { brand: 'axis', model: device.hardware || device.name || null } : {}),
  };
}

/** เรียง endpoint จริงก่อนทาง legacy; เมื่อคนแก้ host/port ในฟอร์มให้ใช้ค่าที่แก้แทนข้อมูลเก่า */
function onvifEndpointCandidates({ ip, onvifPort, onvifXaddrs }) {
  const host = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!host || /[\s/@?#]/.test(host)) throw new Error('ONVIF host ไม่ถูกต้อง');
  const address = host.includes(':') ? `[${host}]` : host;
  const announced = parseOnvifXaddrs(onvifXaddrs);
  const first = announced.length ? new URL(announced[0]) : null;
  const firstPort = first ? first.port || (first.protocol === 'https:' ? '443' : '80') : '80';
  const port = String(onvifPort || firstPort);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('ONVIF port ไม่ถูกต้อง');
  const edited = first && (first.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== host.toLowerCase() || Number(firstPort) !== Number(port));
  const candidates = announced.map((raw) => {
    if (!edited) return raw;
    const endpoint = new URL(raw);
    endpoint.hostname = address;
    endpoint.port = port;
    return endpoint.href;
  });
  for (const scheme of ['http', 'https']) candidates.push(new URL(`${scheme}://${address}:${port}/onvif/device_service`).href);
  return [...new Set(candidates)];
}

/** บันทึกเฉพาะรายการ URL ที่ตรวจแล้ว; ไม่มี endpoint ให้ใช้ flow เดิม */
function storedOnvifXaddrs(value) {
  const urls = parseOnvifXaddrs(value);
  return urls.length ? JSON.stringify(urls) : null;
}

module.exports = { parseOnvifXaddrs, discoveredOnvifDevice, onvifEndpointCandidates, storedOnvifXaddrs };