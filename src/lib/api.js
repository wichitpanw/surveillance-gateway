/** API helpers — always use current browser origin (works on localhost + LAN IP). */

const USER_KEY = 'cctv_user';
const SESSION_KEY = 'cctv_session';
let sessionRevision = 0;

/** เปลี่ยนบัญชีหรือล้าง session ต้องทิ้ง state ของหน้าจอเดิมทั้งก้อน */
function resetSessionView() {
  sessionRevision += 1;
  window.dispatchEvent(new CustomEvent('cctv:session-reset'));
}

/**
 * ผู้ใช้ที่ล็อกอินอยู่ (ข้อมูลแสดงผล + สิทธิ์) — ไม่มีรหัสผ่านอยู่ในนี้แล้ว
 * หน้าเว็บรุ่นก่อน 2026-09-29 เก็บ password จริงไว้ในก้อนนี้ อ่านเจอเมื่อไหร่ลบทิ้งทันที
 */
export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw);
    if (user && 'password' in user) {
      delete user.password;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    }
    return user;
  } catch {
    return null;
  }
}

/** session token จาก /api/login (ส่งเป็น Bearer) — ไม่มี = ยังไม่ได้ล็อกอิน */
export function getSessionToken() {
  try {
    return localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

/** เก็บ session หลัง login (หรือหลังเปลี่ยนรหัสตัวเองแล้ว server ออก token ใหม่) — ตัด password ออกเสมอ */
export function saveSession(token, user) {
  if (token) localStorage.setItem(SESSION_KEY, token);
  if (user) {
    const { password: _omit, ...safe } = user;
    localStorage.setItem(USER_KEY, JSON.stringify(safe));
  }
  if (token && user) resetSessionView();
}

/** ออกจากระบบ / session หมดอายุ — ล้างทั้ง token และข้อมูลผู้ใช้ */
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  resetSessionView();
}

/**
 * ผู้ใช้จากรุ่นเก่าที่มีแต่ password ไม่มี token — บังคับ login ใหม่ตอนโหลดหน้า
 * คืน user ที่ใช้ต่อได้ หรือ null
 */
export function loadSessionUser() {
  const user = getStoredUser();
  if (!user) return null;
  if (!getSessionToken()) {
    clearSession();
    return null;
  }
  return user;
}

export function getAuthHeaders() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
  };
}

export function apiUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${window.location.origin}${p}`;
}

/** 401 จากคำขอใดก็ตามที่ไม่ใช่ /api/login = session ใช้ไม่ได้แล้ว — ล้างแล้วให้ App กลับหน้า login */
export function handleAuthExpired() {
  clearSession();
  window.dispatchEvent(new CustomEvent('cctv:auth-expired'));
}

/** คำตอบจากบัญชีเก่าห้ามเขียน state หรือล้าง session ของบัญชีใหม่ */
export async function apiFetch(path, options = {}) {
  const revision = sessionRevision;
  const token = getSessionToken();
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = {
    ...(isForm ? getAuthHeaders() : getJsonHeaders()),
    ...(options.headers || {}),
  };
  const assertCurrentSession = () => {
    if (revision !== sessionRevision || token !== getSessionToken()) {
      throw new DOMException('Session changed', 'AbortError');
    }
  };
  const res = await fetch(apiUrl(path), { ...options, headers });
  assertCurrentSession();
  if (res.status === 401 && !path.includes('/login')) {
    handleAuthExpired();
    throw new DOMException('Session expired', 'AbortError');
  }
  for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
    const read = res[method].bind(res);
    res[method] = async (...args) => {
      assertCurrentSession();
      const body = await read(...args);
      assertCurrentSession();
      return body;
    };
  }
  return res;
}
