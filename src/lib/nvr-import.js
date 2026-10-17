/** ใช้เฉพาะเลขช่องที่สแกนได้จริง ไม่อ้างลำดับรายการที่ผู้ใช้เลือก */
export function nvrImportIdentity(channel, baseName = '') {
  const number = Number.isInteger(channel.channel) && channel.channel > 0 ? channel.channel : null
  const sourceName = String(channel.name || '').trim()
  const label = number !== null
    ? `CH ${number}${sourceName ? ` (${sourceName})` : ''}`
    : sourceName || 'ช่องไม่ระบุหมายเลข'
  return { channel: number, name: baseName ? `${baseName} ${label}` : sourceName || label }
}
