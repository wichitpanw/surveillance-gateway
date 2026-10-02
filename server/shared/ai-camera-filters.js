/** หา Edge เจ้าของกล้องจากเส้นทางส่งต่อ โดยไม่ตีความ Global ID ใหม่ */
function ownerEdge(camera) {
  if (camera.type !== 'edge_relay') return '';
  const id = camera.source_role === 'regional' ? camera.source_ref : camera.id;
  const node = /^cam_edge_(\d+)_/.exec(String(id || ''))?.[1] ||
    (camera.source_role !== 'regional' ? camera.source_node : null);
  return node == null ? '' : String(Number(node));
}
/** รวมตัวกรองกับสิทธิ์ก่อนค้นและจำกัดจำนวน event */
function filterCameraIds(cameras, { edgeNode, group }, scope = null) {
  return new Set(cameras.filter((c) => (!scope || scope.has(c.id)) &&
    (!edgeNode || ownerEdge(c) === String(Number(edgeNode))) &&
    (group == null || (c.group_name || 'Default') === group)).map((c) => c.id));
}
module.exports = { ownerEdge, filterCameraIds };
