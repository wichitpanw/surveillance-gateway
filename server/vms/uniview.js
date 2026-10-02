/** อ่านชื่อและสถานะช่องจาก Uniview LAPI โดยไม่ขอหรือสร้าง URL ภาพเอง */
const { digestRequest } = require('../gateway/analytics/http-digest');

const CHANNEL_PATH = '/LAPI/V1.0/Channels/System/ChannelDetailInfos';

async function readUniviewChannels({ ip, apiPort, user, pass }) {
  const raw = await digestRequest(
    { host: ip, port: apiPort, user, pass },
    CHANNEL_PATH,
    { timeoutMs: 12000 },
  );
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('Uniview LAPI ส่งข้อมูลที่ไม่ใช่ JSON');
  }
  const response = body?.Response;
  if (response?.ResponseCode !== 0) {
    throw new Error(`Uniview LAPI ตอบ ResponseCode=${response?.ResponseCode ?? 'missing'}`);
  }
  const details = response?.Data?.DetailInfos;
  if (!Array.isArray(details)) throw new Error('Uniview LAPI ไม่มีรายการ DetailInfos');
  return details
    .map((item) => ({
      channel: Number(item.ID),
      name: String(item.Name || '').trim(),
      status: Number(item.Status),
    }))
    .filter((item) => Number.isInteger(item.channel) && item.channel > 0 && item.status !== 2);
}

/** จับคู่ด้วยเลขช่องจาก RTSP ที่ ONVIF ตอบจริง; ช่องที่ไม่มี RTSP เพิ่มเป็นแถวรอภาพได้ */
function mergeUniviewChannels(apiChannels, onvifChannels) {
  const byNumber = new Map();
  for (const channel of onvifChannels) {
    if (channel.noVideoSource || !channel.main?.rtsp || !Number.isInteger(channel.channel)) continue;
    if (!byNumber.has(channel.channel)) byNumber.set(channel.channel, channel);
  }
  return apiChannels.map((item) => {
    const onvif = byNumber.get(item.channel);
    return {
      id: `uniview_${item.channel}`,
      channel: item.channel,
      name: item.name || `CH ${item.channel}`,
      isOnline: item.status === 1,
      offlineReason: item.status === 0 ? 'no-signal' : !onvif ? 'no-onvif-stream' : null,
      main: item.status === 1 ? onvif?.main || null : null,
      sub: item.status === 1 ? onvif?.sub || null : null,
    };
  });
}

module.exports = { readUniviewChannels, mergeUniviewChannels };
