export function roleScopeLabel(role) {
  if (!role) return 'ยังไม่ได้กำหนดสิทธิ์';
  if (role.all_devices) return 'กล้องทั้งหมด';

  const regionCount = role.areaScope?.regions?.length || 0;
  const provinceCount = role.areaScope?.provinces?.length || 0;
  const deviceCount = role.deviceIds?.length || 0;
  const parts = [];
  if (regionCount) parts.push(`${regionCount} ภาค`);
  if (provinceCount) parts.push(`${provinceCount} จังหวัด`);
  if (deviceCount) parts.push(`${deviceCount} กล้องรายตัว`);
  return parts.length ? parts.join(' · ') : 'ยังไม่ได้กำหนดกล้อง';
}
