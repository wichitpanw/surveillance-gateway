/**
 * Roles/permissions helper — เดี่ยว source of truth ฝั่ง frontend สำหรับเช็ค role
 * (เดิมกระจายเป็น raw string check `role === 'admin' || role === 'superadmin'`
 * อยู่หลายจุด: AccessControl.jsx, UserModal.jsx, MainSidebar.jsx, App.jsx)
 * ฝั่ง backend (server/server.js) มี ELEVATED_ROLES/isElevatedRole มิเรอร์กันไว้แยกต่างหาก
 * เพราะเป็น Express backend ไฟล์เดียวโดยตั้งใจ — ถ้าเพิ่ม/เปลี่ยน role ต้อง sync คู่กันเอง
 */

export const ROLES = {
  MONITOR: 'monitor',
  OPERATOR: 'operator',
  ADMIN: 'admin',
  SUPERADMIN: 'superadmin',
};

// การกันสิทธิ์จริงย้ายไป RBAC (can + permission set) แล้ว — เหลือ helper เท่าที่ user CRUD
// ยังต้องใช้กับ "ชื่อ role built-in" โดยตรง: isElevated (คุ้มครอง admin คนสุดท้าย + superadmin)
// และ isSuperAdmin ต้องตรงกับ ELEVATED_ROLES ฝั่ง server
export const ELEVATED_ROLES = [ROLES.ADMIN, ROLES.SUPERADMIN];

export function isElevated(role) {
  return ELEVATED_ROLES.includes(role);
}

// ── RBAC: สิทธิ์เป็นข้อมูล ไม่ใช่ชื่อ role ──────────────────────────────────────
// user object (จาก /api/login หรือ /api/me) มี user.permissions = ['menu.cameras', ...]
// can() เช็คสิทธิ์รายข้อ ทำให้ role ที่ผู้ใช้สร้างเอง (ชื่ออะไรก็ได้) ทำงานได้ ไม่ผูกกับชื่อตายตัว
export function can(user, permKey) {
  const perms = user?.permissions;
  return Array.isArray(perms) && perms.includes(permKey);
}

// แหล่งเดียวของรายการเมนู — ทั้ง MainSidebar (แสดงผล) และ App (gating เนื้อหา) อ่านจากนี่
// จึงไม่มีทางที่เมนูกับ router จะหลุดจากกัน section: 'main' = ทุกคนเห็น (แต่ยังผูกกับ permKey)
export const NAV_ITEMS = [
  { tab: 'ai', perm: 'menu.ai', label: 'AI Cameras', section: 'main' },
  { tab: 'ai-stats', perm: 'menu.aistats', label: 'ตัวเก็บสถิติ AI', section: 'main' },
  { tab: 'cameras', perm: 'menu.cameras', label: 'Cameras', section: 'management' },
  // ใช้สิทธิ์เดียวกับ Cameras โดยตั้งใจ — คนที่จัดการกล้องได้ก็ปักหมุดได้อยู่แล้วผ่านหน้ากล้อง
  // การแยก perm ใหม่แปลว่าทุก role ที่มีอยู่ต้องถูกแก้ก่อนจึงจะเห็นหน้านี้
  { tab: 'map-pins', perm: 'menu.cameras', label: 'ปักหมุดกล้อง', section: 'management' },
  { tab: 'logs', perm: 'menu.logs', label: 'System Logs', section: 'management' },
  { tab: 'api-clients', perm: 'menu.apiclients', label: 'API Clients', section: 'admin' },
  { tab: 'users', perm: 'menu.users', label: 'Access Control', section: 'admin' },
  { tab: 'settings', perm: 'menu.settings', label: 'System Settings', section: 'admin' },
];

export function isSuperAdmin(role) {
  return role === ROLES.SUPERADMIN;
}

/** true ถ้า targetUser เป็น role elevated และเป็นคนสุดท้ายที่เหลืออยู่ใน users ทั้งหมด */
export function isLastElevatedUser(users, targetUser) {
  if (!targetUser || !isElevated(targetUser.role)) return false;
  const elevatedCount = (users || []).filter((u) => isElevated(u.role)).length;
  return elevatedCount <= 1;
}

export function roleLabel(role) {
  if (role === ROLES.SUPERADMIN) return 'Superadmin';
  if (role === ROLES.ADMIN) return 'Admin';
  if (role === ROLES.OPERATOR) return 'Operator';
  return 'Monitor';
}
