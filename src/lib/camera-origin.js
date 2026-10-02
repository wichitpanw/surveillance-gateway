/** แยก Regional ที่ส่งต่อออกจาก Edge เจ้าของกล้องตาม Global ID เดิม */
export function cameraOriginLabel(camera) {
  if (camera.type !== 'edge_relay') return '';
  const owner = /^TH-\d{2}-(\d{3})-\d+$/.exec(String(camera.global_id || ''))?.[1];
  if (camera.source_role === 'regional') return `Regional ${camera.source_node || '—'} : Edge ${owner || 'ไม่ระบุ'}`;
  const edge = owner || camera.source_node || /^cam_edge_(\d{3})_/.exec(String(camera.id || ''))?.[1];
  return `Edge ${edge || 'ไม่ระบุ'}`;
}
