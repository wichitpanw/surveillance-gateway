const express = require('express');
const cors = require('cors');
const onvif = require('node-onvif');
const { patchNodeOnvif } = require('./onvif_patch');
patchNodeOnvif(onvif);
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const net = require('net');
const { exec, execFile, execSync, spawn } = require('child_process');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// จำนวน GPU ที่มีให้ transcode ใช้จริง — auto-detect จาก `nvidia-smi -L` แทน hardcode ตายตัว
// (บั๊กที่เจอมาแล้ว: Windows มี 2 ตัว, Linux VM หลัง DDA passthrough เหลือแค่ 1 ตัว —
// hardcode ผิดค่าทำให้โค้ดพยายามเรียก GPU index ที่ไม่มีจริงแล้ว error เงียบๆ)
// ENV var GPU_COUNT ยังใช้ override ได้ถ้า auto-detect พลาด, fallback สุดท้ายคือ 1
const detectGpuCount = () => {
  const envOverride = parseInt(process.env.GPU_COUNT, 10);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  try {
    const out = execSync('nvidia-smi -L', { timeout: 5000 }).toString();
    const n = out.split('\n').filter((l) => /^GPU \d+:/.test(l)).length;
    if (n > 0) return n;
  } catch (e) {
    console.warn('[GPU] nvidia-smi -L detection failed, defaulting to 1 GPU:', e.message);
  }
  return 1;
};
const GPU_COUNT = Math.max(1, detectGpuCount());
console.log(`[GPU] GPU_COUNT=${GPU_COUNT}`);

const { nowIso, toBangkokIso } = require('./shared/time');
const { hashPassword, verifyPassword, hashLegacyPasswords, isHashed } = require('./shared/password');
const { redactUrls } = require('./shared/redact');
const sessionToken = require('./shared/session-token');
const loginThrottle = require('./shared/login-throttle');

/*
  ด่านสุดท้ายของ process — เดิมไม่มีเลย promise ที่ reject โดยไม่มีใคร catch (Node ≥15) ทำให้ central ตายทั้งตัว
  - unhandledRejection: log แล้วรันต่อ — ส่วนใหญ่เป็นงานพื้นหลังที่ล้มรอบเดียว (กล้องไม่ตอบ ฯลฯ) ไม่ควรดับทั้งระบบ
  - uncaughtException: สถานะของ process เชื่อไม่ได้แล้ว — log (ตัดรหัสใน URL) แล้วออก ให้ pm2 เปิดใหม่
*/
process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection:', redactUrls(reason?.stack || reason?.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[Process] uncaughtException — ออกให้ pm2 เปิดใหม่:', redactUrls(err?.stack || err?.message || err));
  process.exit(1);
});

const app = express();
/*
  exposedHeaders: custom header ถูกซ่อนจาก JS เสมอเมื่อเรียกข้าม origin เว้นแต่ประกาศไว้ตรงนี้

  /api/v1/cameras/:id/snapshot ส่ง X-Snap-Source มาบอกว่าภาพมาจากทางไหน (ONVIF, ffmpeg,
  ฯลฯ) ซึ่งเป็นข้อมูลที่ client ใช้ตัดสินคุณภาพ/ความสดของภาพ แต่ก่อนหน้านี้ไม่ได้ประกาศไว้
  ผลคือ curl เห็นค่าปกติ ส่วนโปรแกรมที่รันในเบราว์เซอร์ได้ null เสมอ — header ที่มีอยู่จริง
  แต่ผู้ใช้กลุ่มหนึ่งไม่มีทางอ่านได้เลย พบตอนต่อ demo-client/ เข้ามาจากคนละพอร์ต
*/
app.use(cors({ exposedHeaders: ['X-Snap-Source', 'X-Playback-Start'] }));
// POST /api/v1/ai/events รับภาพประกอบหลายภาพต่อคำขอ — ใช้ parser ของตัวเอง (40 MB, gateway/index.js) แทนค่าเริ่ม 100 KB
const jsonBody = express.json();
app.use((req, res, next) => (req.path === '/api/v1/ai/events' ? next() : jsonBody(req, res, next)));

// --- AUTH MIDDLEWARE ---
// cache สิทธิ์ต่อ role — checkAuth รันทุก request จึงห้ามยิง query เพิ่มต่อ request
// ล้างทั้งก้อนเมื่อ role/permission/device เปลี่ยน หรือกล้องถูกลบ (ดู invalidateRoleCache)
const roleAccessCache = new Map(); // role_id -> { perms:Set, deviceIds:Set|null }
const invalidateRoleCache = () => roleAccessCache.clear();
const { CODES: REGION_CODES, byProvince, regionForProvince } = require('./shared/region-groups');
const parseAreaScope = (raw) => {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    return {
      regions: Array.isArray(value.regions) ? value.regions.filter((x) => REGION_CODES.includes(x)) : [],
      provinces: Array.isArray(value.provinces) ? value.provinces.filter((x) => byProvince.has(x)) : [],
    };
  } catch { return { regions: [], provinces: [] }; }
};

const getRoleAccess = (roleId, cb) => {
  if (!roleId) return cb(null, { perms: new Set(), deviceIds: new Set() });
  const hit = roleAccessCache.get(roleId);
  if (hit) return cb(null, hit);
  db.get('SELECT all_devices, area_scope FROM roles WHERE id = ?', [roleId], (err, role) => {
    if (err) return cb(err);
    if (!role) return cb(null, { perms: new Set(), deviceIds: new Set() });
    db.all('SELECT perm_key FROM role_permissions WHERE role_id = ?', [roleId], (pErr, perms) => {
      if (pErr) return cb(pErr);
      const permSet = new Set((perms || []).map((p) => p.perm_key));
      const finish = (deviceIds) => {
        const entry = { perms: permSet, deviceIds };
        roleAccessCache.set(roleId, entry);
        cb(null, entry);
      };
      if (role.all_devices) return finish(null); // null = ไม่จำกัด รวมกล้องที่เพิ่มใหม่
      db.all('SELECT camera_id FROM role_devices WHERE role_id = ?', [roleId], (dErr, devs) => {
        if (dErr) return cb(dErr);
        const ids = new Set((devs || []).map((d) => d.camera_id));
        const area = parseAreaScope(role.area_scope);
        if (!area.regions.length && !area.provinces.length) return finish(ids);
        const regions = new Set(area.regions);
        const provinces = new Set(area.provinces);
        db.all('SELECT id, province_code FROM cameras WHERE province_code IS NOT NULL', (cErr, cams) => {
          if (cErr) return cb(cErr);
          for (const camera of cams || []) {
            if (provinces.has(camera.province_code) || regions.has(regionForProvince(camera.province_code))) ids.add(camera.id);
          }
          finish(ids);
        });
      });
    });
  });
};

/** ผู้ใช้ที่ยังเข้าด้วย header username/password แบบเก่า — log ครั้งเดียวต่อคนต่อ process ไม่ให้ log ท่วม */
const legacyAuthWarned = new Set();

/**
 * ยืนยันตัวตนผู้ใช้หน้าเว็บ
 *
 * ทางหลัก: `Authorization: Bearer s1.…` (session จาก /api/login — shared/session-token.js)
 *   ตรวจ HMAC + ลายนิ้วมือรหัสผ่าน แล้ว query ผู้ใช้หนึ่งครั้ง ไม่มี scrypt ต่อคำขอ
 * ทางเก่า: header username/password — คงไว้ชั่วคราวให้แท็บที่เปิดค้างก่อน deploy ไม่หลุดทันที
 *   (log ไว้ว่าใครยังใช้) ถอดได้เมื่อไม่เห็น log "[Auth] legacy" แล้ว
 */
const checkAuth = (req, res, next) => {
  const session = sessionToken.sessionFromRequest(req);
  if (session) {
    const claims = sessionToken.verifySession(session);
    if (!claims) return res.status(401).json({ error: 'Session expired — please log in again' });
    db.get('SELECT * FROM users WHERE id = ?', [claims.u], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user || !sessionToken.fingerprintMatches(claims, user.password)) {
        return res.status(401).json({ error: 'Session expired — please log in again' });
      }
      completeAuth(req, res, next, user);
    });
    return;
  }
  const { username, password } = req.headers;
  if (!username || !password) return res.status(401).json({ error: 'Authentication required' });
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const lockedSec = loginThrottle.lockedFor(ip, username);
  if (lockedSec > 0) {
    res.set('Retry-After', String(lockedSec));
    return res.status(429).json({ error: 'ลองผิดหลายครั้งเกินไป — รอสักครู่แล้วลองใหม่' });
  }
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user || !(await verifyPassword(password, user.password))) {
      loginThrottle.recordFailure(ip, username);
      saveLog(String(username).slice(0, 64), 'Login Failed', 'Legacy authentication failed');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    loginThrottle.recordSuccess(ip, username);
    if (!legacyAuthWarned.has(user.username)) {
      legacyAuthWarned.add(user.username);
      console.warn(`[Auth] legacy username/password header auth used by "${user.username}" — ให้ผู้ใช้ login ใหม่เพื่อรับ session`);
    }
    completeAuth(req, res, next, user);
  });
};

/** ผ่านการยืนยันแล้ว — เติม role_id ที่ว่าง แล้วแนบสิทธิ์ + ขอบเขตกล้องของ role ให้ route ถัดไป */
const completeAuth = (req, res, next, user) => {
  /*
    role_id ว่างได้บนฐานข้อมูลใหม่: seed superadmin วิ่งหลัง migration ที่ผูก role_id จาก users.role
    เติมให้ทั้งใน req.user (ทุก route ที่อ่าน req.user.role_id เช่น /api/me เห็นค่าเดียวกัน)
    และลงฐานข้อมูลครั้งเดียว — เคยพลาดมาแล้วที่ /api/me ทำให้ edge ที่ติดตั้งสดมีเมนูว่างทั้งแอป
  */
  if (!user.role_id && roleIdFor(user.role)) {
    user.role_id = roleIdFor(user.role);
    db.run('UPDATE users SET role_id = ? WHERE id = ? AND role_id IS NULL', [user.role_id, user.id], () => {});
  }
  req.user = user;
  getRoleAccess(user.role_id, (aErr, access) => {
    if (aErr) return res.status(500).json({ error: aErr.message });
    req.perms = access.perms;
    req.deviceIds = access.deviceIds; // Set หรือ null (null = ไม่จำกัด)
    next();
  });
};

/** ด่านตามสิทธิ์รายข้อ — แทน isAdmin/isManager ที่ผูกกับชื่อ role ตายตัว */
// UI ปัจจุบันยังส่ง role เป็นชื่อ ("admin") ส่วน UI ใหม่จะส่ง role_id มาตรงๆ
// รองรับทั้งสองแบบระหว่างช่วงเปลี่ยนผ่าน — ถ้าไม่ส่ง role_id มาก็อนุมานจากชื่อ role
const roleIdFor = (roleName, explicitRoleId) => explicitRoleId || (roleName ? `r_${roleName}` : null);

const requirePerm = (key) => (req, res, next) => {
  if (req.perms && req.perms.has(key)) return next();
  res.status(403).json({ error: `Permission denied: ${key}` });
};

/**
 * กล้องนี้อยู่ในขอบเขตของ role ผู้เรียกไหม — req.deviceIds เป็น Set (จำกัด) หรือ null (ทุกกล้อง)
 * route ที่แก้/ลบกล้องต้องเช็คด้วย ไม่ใช่แค่ device.manage — operator ที่ดูแลบางกล้องต้องแก้กล้องคนอื่นไม่ได้
 * นอกขอบเขตตอบ 404 เหมือนไม่มีกล้องนี้ (แบบเดียวกับ PTZ/playback) ไม่บอกว่ามีอยู่จริง
 */
const cameraInScope = (req, id) => !(req.deviceIds instanceof Set) || req.deviceIds.has(String(id));
const sendOutOfScope = (res) => res.status(404).json({ error: 'ไม่พบกล้องนี้' });
// isAdmin/isManager (ด่านผูกชื่อ role ตายตัว) ถูกแทนด้วย requirePerm(key) ทั้งหมดแล้ว จึงลบทิ้ง
// ที่ยังเหลือคือ helper สำหรับ user CRUD ซึ่งยังต้องรู้ "ระดับ" ของ role name โดยตรง:
//   - isElevatedRole: กันลด/ลบ admin คนสุดท้าย และคุ้มครองบัญชี superadmin
const ELEVATED_ROLES = ['admin', 'superadmin'];
const isElevatedRole = (role) => ELEVATED_ROLES.includes(role);

// ── RBAC catalogue ───────────────────────────────────────────────────────────
// รายการสิทธิ์ทั้งหมดที่ระบบรู้จัก — ใช้ทั้งตอน seed, ตอน validate ค่าที่ส่งมาจาก UI
// และเป็นเอกสารว่ามีสิทธิ์อะไรบ้าง ถ้าเพิ่ม key ใหม่ต้องเพิ่มที่นี่ที่เดียว
// menu.map ถูกถอดออกเมื่อหน้าแผนที่ย้ายไปอยู่ที่ client — แถวเก่าใน role_permissions ที่ยัง
// อ้างถึงมันไม่ทำให้อะไรพัง เพราะการตัดสินสิทธิ์เทียบกับรายการนี้ ไม่ได้เทียบกับตาราง
const MENU_KEYS = [
  'menu.ai', 'menu.aistats', 'menu.cameras', 'menu.logs', 'menu.users', 'menu.settings', 'menu.apiclients',
  'menu.live',
  // หน้า Public Cam Map ของ Central + สิทธิ์ติ๊ก "กล้อง Public" ให้ API key (vms/public-cams.js)
  'menu.publiccam',
];
const OP_KEYS = [
  'device.manage',    // เพิ่ม/แก้/ลบกล้อง, สแกน, ตั้งค่า AI, ROI
  'device.secrets',   // เห็น rtsp/onvifUser/onvifPass ของกล้องที่ตัวเองเห็น
  'device.ptz',       // หมุน/ซูม/preset กล้อง PTZ จากหน้า Live — กล้องหนึ่งตัวถูกหลายคนดู ใครหมุนก็หมุนให้ทุกคน
  'playback.view',    // ดูภาพบันทึกย้อนหลัง (บันทึกที่ edge) — หลักฐาน จึงแยกจากการดูสด
  'user.manage',      // จัดการผู้ใช้และ role
  'system.settings',  // ตั้งค่าระบบ, แผนที่, Telegram
  'system.maintain',  // backup/restore/resync
  'log.purge',        // ล้าง log
];
const ALL_PERM_KEYS = [...MENU_KEYS, ...OP_KEYS];

// role ตั้งต้น — ชุดสิทธิ์ต้องตรงกับพฤติกรรมของระบบ "ก่อน" ย้ายมา RBAC เป๊ะๆ
// (monitor/operator/admin แก้และลบได้ มีแต่ superadmin ที่ is_system=1)
/*
  เมนูที่ทุก role เห็นได้

  menu.ai อยู่ในนี้เพราะ "กล้องตัวไหนมี AI อะไร" เป็นข้อมูลปฏิบัติการ ไม่ใช่ความลับ —
  คนเฝ้าจอต้องรู้ว่ากล้องที่ตัวเองดูอยู่มีอะไรทำงานอยู่เบื้องหลัง และหน้านี้ไม่แสดง
  รหัสผ่านหรือ RTSP ของกล้องเลย
*/
// menu.live: คนเฝ้าจอคือคนที่ต้องดูภาพสดมากที่สุด — seed วิ่งทุกครั้งที่ start (INSERT OR IGNORE) role ตั้งต้นจึงได้เอง
const BASE_MENUS = ['menu.ai', 'menu.aistats', 'menu.live'];
const SEED_ROLES = [
  {
    id: 'r_monitor', name: 'monitor', label: 'Monitor', is_system: 0, all_devices: 0,
    perms: [...BASE_MENUS],
  },
  {
    id: 'r_operator', name: 'operator', label: 'Operator', is_system: 0, all_devices: 0,
    perms: [...BASE_MENUS, 'menu.cameras', 'menu.logs',
            'device.manage', 'device.secrets', 'device.ptz', 'playback.view'],
  },
  {
    id: 'r_admin', name: 'admin', label: 'Admin', is_system: 0, all_devices: 1,
    perms: [...BASE_MENUS, 'menu.cameras', 'menu.logs',
            'device.manage', 'device.secrets', 'device.ptz', 'playback.view', 'menu.users', 'menu.settings',
            'user.manage', 'system.settings', 'system.maintain', 'log.purge', 'menu.publiccam'],
  },
  {
    id: 'r_superadmin', name: 'superadmin', label: 'Superadmin', is_system: 1, all_devices: 1,
    perms: ALL_PERM_KEYS,
  },
];
const countRemainingAdmins = (db, excludeId, callback) => {
  db.get(
    "SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','superadmin') AND id != ?",
    [excludeId],
    (err, row) => callback(err, row ? row.n : 0)
  );
};

// --- STREAM PROXY (same-origin: local + Tailscale + internet ผ่าน :5173 เท่านั้น) ---
const STREAM_CORE_HOST = '127.0.0.1';
const MTX_HLS_PORT = Number(process.env.MTX_HLS_PORT || 8888);
const { stateFile, HTTP_PORT, GO2RTC_API_PORT, ROLE: GATEWAY_ROLE, REGION: GATEWAY_REGION, NODE_NUMBER, DSS_RELAY_PORT } = require('./shared/instance');
const acceptsChildEdges = GATEWAY_ROLE === 'central' || GATEWAY_ROLE === 'regional';
const linksToParent = GATEWAY_ROLE === 'edge' || GATEWAY_ROLE === 'regional';
// กล้องสาธารณะที่ Central ดึงเอง (vms/public-cams.js) — ไม่มี IP/ONVIF ให้ถาม สถานะมาจาก API ของหน่วยงาน
const { PUBLIC_TYPE, createPublicCams } = require('./vms/public-cams');
/** streaming core ที่ใช้จริง — ต้องตรงกับ GATEWAY_STREAM_CORE ที่ server/gateway/streams.js อ่าน */
const STREAM_CORE = String(process.env.GATEWAY_STREAM_CORE || 'go2rtc').toLowerCase();

/*
 * แปลง path ของ HLS ให้เข้ากับ core ที่ใช้อยู่
 *
 * URL สาธารณะคือ `/hls/<ชื่อสตรีม>/index.m3u8` เสมอ ไม่ว่าเบื้องหลังจะเป็น core ตัวไหน
 * เพราะมันคือสัญญาที่ทั้ง LiveStreamPlayer และ /api/v1 ยึดอยู่ MediaMTX บังเอิญใช้
 * รูปแบบนี้พอดี ส่วน go2rtc ใช้ `/api/stream.m3u8?src=<ชื่อ>` จึงต้องแปลงตรงนี้
 * ที่เดียว แทนที่จะไปแก้ทุกที่ที่ประกอบ URL
 */
/*
  /hls เป็น allowlist ไม่ใช่ตัวแปลง path ทั่วไป (แก้ 2026-09-29)

  ของเดิม: path ที่ไม่เข้าแบบใดเลยถูกส่งต่อเป็น `/api${path}` ของ go2rtc — ใครถือ stream token ใบเดียว
  (หรือ token ของ HLS ชั้นในที่ไม่ผูกชื่อ) ก็เรียก API ทั้งหมดของ go2rtc ผ่าน 5173 ได้ รวม /api/config ที่มี
  RTSP พร้อมรหัสกล้องทุกตัว และ method อะไรก็ได้ (PUT/DELETE สตรีม) ตอนนี้รับแค่สองรูป ที่เหลือ 404 ก่อนถึง core
*/
const HLS_MASTER = /^\/([^/?]+)\/index\.m3u8(?:\?.*)?$/;
const HLS_NESTED = /^\/(?:[^/?]+\/)?hls\/(playlist\.m3u8|segment\.ts|init\.mp4)\?(.*)$/;
const HLS_MTX_FILE = /^\/([^/?]+)\/([A-Za-z0-9_.-]+\.(?:m3u8|ts|mp4|m4s))(?:\?.*)?$/;

/**
 * คำขอ /hls นี้ส่งต่อได้ไหม — คืน { name, upstream } หรือ null (= 404)
 * name: ชื่อสตรีมที่ token ต้องตรง (null = คำขอชั้นในของ go2rtc ที่ path ไม่มีชื่อสตรีมแล้ว ดู stream-token.js)
 * upstream: path ที่ประกอบใหม่ทั้งเส้นจากค่าที่ผ่านการตรวจ ไม่ต่อสตริงจากผู้เรียกตรง ๆ
 */
const matchHlsRequest = (url) => {
  const u = url || '/';
  const decodeName = (raw) => {
    try {
      const name = decodeURIComponent(raw);
      return name && !/[/\\?#\0]/.test(name) ? name : null;
    } catch {
      return null;
    }
  };

  const master = HLS_MASTER.exec(u);
  if (master) {
    const name = decodeName(master[1]);
    if (!name) return null;
    return {
      name,
      upstream: STREAM_CORE === 'go2rtc'
        ? `/api/stream.m3u8?src=${encodeURIComponent(name)}`
        : `/${encodeURIComponent(name)}/index.m3u8`,
    };
  }

  // MediaMTX (core เก่า): ไฟล์ชั้นในอยู่ใต้ชื่อสตรีมเสมอ จึงผูก token กับชื่อได้ทุกคำขอ
  if (STREAM_CORE !== 'go2rtc') {
    const m = HLS_MTX_FILE.exec(u);
    const name = m && decodeName(m[1]);
    return name ? { name, upstream: `/${encodeURIComponent(name)}/${m[2]}` } : null;
  }

  /*
    go2rtc ใส่ URL แบบ "สัมพัทธ์" ไว้ใน master playlist (`hls/playlist.m3u8?id=...`) เบราว์เซอร์จึงต่อเป็น
    /hls/<ชื่อสตรีม>/hls/playlist.m3u8?id=... ทั้งที่ go2rtc เสิร์ฟจริงที่ /api/hls/playlist.m3u8 — ตัดชื่อทิ้ง
    (id ใน query คือ session ของ go2rtc) · ต้องทดสอบผ่านตัวเล่นจริง ไม่ใช่ curl ที่ประกอบ URL เอง
  */
  const nested = HLS_NESTED.exec(u);
  if (!nested) return null;
  const params = new URLSearchParams(nested[2]);
  const id = params.get('id');
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const q = new URLSearchParams({ id });
  const n = params.get('n');
  if (n != null) {
    if (!/^\d{1,10}$/.test(n)) return null;
    q.set('n', n);
  }
  return { name: null, upstream: `/api/hls/${nested[1]}?${q}` };
};

const streamToken = require('./gateway/stream-token');
/*
  ใช้ตัวอ่านสถานะของ core ตัวเดียวกับที่ /api/v1 ใช้ แทนที่จะเขียน HTTP client ซ้ำ

  server.js เคยมีชุด fetchMtx* ของตัวเองที่ยิงไป 127.0.0.1:9997 ตรง ๆ ซึ่งเป็นสาเหตุที่
  ตัวกู้คืนตายเงียบตอนย้ายไป go2rtc — พอ core เปลี่ยน มีคนแก้แค่ที่เดียว resolveCore()
  รู้จักทั้งสอง core อยู่แล้วและถูกใช้งานจริงผ่าน /api/v1/streams ทุกวัน การผูกไว้กับตัวนี้
  แปลว่าครั้งหน้าที่เปลี่ยน core จะไม่มีของตกค้างให้ลืมอีก
*/
const { resolveCore } = require('./gateway/streams');
const streamCoreClient = resolveCore();

/**
 * ยามเฝ้าทางเข้าวิดีโอ
 *
 * `/stream/*.mp4` และ `/hls/*` ต้องอยู่ "เหนือ" app.use('/api', checkAuth) เพราะแท็ก <video>
 * ส่ง Authorization header ไม่ได้ ผลข้างเคียงที่อยู่มานานคือสองเส้นนี้เปิดให้ใครก็ได้ที่รู้ชื่อ
 * path เข้ามาดูภาพ โดยที่ scope ของคีย์และการเพิกถอนคีย์ไม่มีผลอะไรเลย
 *
 * ตอนนี้ทั้งสองเส้นต้องมี token ที่ Gateway เซ็นให้ตอนเรียก /api/v1/cameras/:id/streams
 * ดู server/gateway/stream-token.js สำหรับเหตุผลที่ token อยู่ใน query string ได้แต่ API key ไม่ได้
 *
 * @param {(req) => string|null} resolveName คืนชื่อสตรีมที่ต้องตรงกับใน token
 *        คืน null = ตรวจแค่ลายเซ็นกับอายุ (คำขอชั้นในของ HLS ที่ path ไม่มีชื่อสตรีมแล้ว)
 */
const requireStreamToken = (resolveName) => (req, res, next) => {
  const claims = streamToken.verify(streamToken.fromRequest(req), resolveName(req));
  if (!claims) {
    return res.status(401).json({
      error: 'ต้องมี stream token — ขอได้จาก GET /api/v1/cameras/:id/streams',
    });
  }
  req.streamClientId = claims.k;
  next();
};

/** token ที่ผู้เรียกส่งมา ใช้ส่งต่อให้ URL ชั้นในของ playlist */
const passThroughToken = (req) => {
  try {
    return String(req.query?.t || '');
  } catch {
    return '';
  }
};

/** เติม ?t= ให้ทุกบรรทัดที่เป็น URL ใน m3u8 — บรรทัดขึ้นต้น # คือ metadata ไม่ใช่ URL */
const addTokenToPlaylist = (text, token) =>
  text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      if (/[?&]t=/.test(trimmed)) return line;
      return `${trimmed}${trimmed.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    })
    .join('\n');

const proxyToStreamCore = (targetPort, { rewrite = true } = {}) => (req, res) => {
  // rewrite=true: path ปลายทางมาจาก allowlist ของ /hls (hlsGuard ใส่ req.hlsMatch ไว้) — ไม่มี = ไม่ส่งต่อ
  // rewrite=false สำหรับผู้เรียกที่ประกอบ path ปลายทางมาเองแล้ว (เช่น /stream/:name.mp4)
  const upstreamPath = rewrite ? req.hlsMatch?.upstream : (req.url || '/');
  if (!upstreamPath) return res.status(404).json({ error: 'Not Found' });
  const headers = { ...req.headers, host: `${STREAM_CORE_HOST}:${targetPort}` };
  delete headers['accept-encoding'];

  const proxyReq = http.request({
    hostname: STREAM_CORE_HOST,
    port: targetPort,
    path: upstreamPath,
    method: req.method,
    headers,
  }, (proxyRes) => {
    const outHeaders = { ...proxyRes.headers, 'access-control-allow-origin': '*' };

    /*
      master playlist ของ go2rtc ชี้ไปที่ `hls/playlist.m3u8?id=<opaque>` แบบ relative
      ซึ่งเบราว์เซอร์จะขอต่อโดย **ไม่มี ?t=** ติดไปด้วย ทำให้ชั้นในโดนยามปฏิเสธทันที
      จึงต้องอ่าน body มาเติม token ให้ทุกบรรทัดที่เป็น URL ก่อนส่งต่อ

      m3u8 เป็นข้อความไม่กี่บรรทัด การ buffer จึงไม่ใช่ภาระ — ต่างจากตัววิดีโอที่ต้อง pipe
      ตรงเสมอ ห้ามเผลอเอาเงื่อนไขนี้ไปครอบ response ชนิดอื่น
    */
    const isPlaylist = /\.m3u8(\?|$)/.test(upstreamPath)
      || String(proxyRes.headers['content-type'] || '').includes('mpegurl');
    const token = passThroughToken(req);

    if (isPlaylist && token && proxyRes.statusCode === 200) {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const body = addTokenToPlaylist(Buffer.concat(chunks).toString('utf8'), token);
        delete outHeaders['content-length'];
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(body);
      });
      return;
    }

    res.writeHead(proxyRes.statusCode, outHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.warn(`[Stream proxy :${targetPort}] ${req.method} ${upstreamPath}: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream proxy unreachable', detail: err.message });
    }
  });

  /*
    ผู้ชมหลุด = ต้องปิดขาบนด้วย ไม่ใช่ปล่อยค้าง

    การ pipe ทำให้ขาล่าง (เบราว์เซอร์ ↔ ตัวนี้) ตายเองเมื่อผู้ชมปิดแท็บ แต่ **ขาบน
    (ตัวนี้ ↔ streaming core) ไม่ตายตาม** — `proxyRes.pipe(res)` แค่เลิก pipe เมื่อ
    ปลายทางหาย มันไม่ทำลายต้นทาง คำขอที่ค้างไว้จึงยังเป็น consumer ที่ core นับว่า
    "ยังมีคนดูอยู่" และ core ก็ยังส่งเฟรมเข้าไปในสายที่ไม่มีใครอ่านต่อไปเรื่อย ๆ

    อาการที่เห็นคือ readers ของแต่ละสตรีมมีแต่ขึ้น ไม่เคยลง — วัดแล้วเปิด-ปิดหนึ่งรอบ
    บวกหนึ่งค้างถาวร ทำให้เลขนั้นกลายเป็น "จำนวนครั้งที่เคยเปิด" แทนที่จะเป็นจำนวน
    ผู้ชมจริง และกล้องที่ไม่ได้ตั้ง always_on ก็ไม่มีวันถูกปิดสตรีม เพราะ core เห็นว่า
    ยังมีคนดูตลอดเวลา

    `close` ของ response ยิงทั้งตอนจบปกติและตอนสายขาด — เรียก destroy() กับคำขอที่
    จบไปแล้วไม่มีผลอะไร จึงใช้ event เดียวครอบทั้งสองกรณีได้
  */
  res.on('close', () => proxyReq.destroy());

  req.pipe(proxyReq);
};

/**
 * ด่านแรกของ /hls — GET/HEAD ที่เข้า allowlist (matchHlsRequest) เท่านั้น นอกนั้น 404 ก่อนตรวจ token
 *
 * ชื่อสตรีมที่ token ต้องตรงมาจากผลเดียวกัน: คำขอชั้นนอก (`/<ชื่อ>/index.m3u8`) ผูกชื่อ ส่วนคำขอชั้นใน
 * ของ go2rtc (`hls/playlist.m3u8?id=`) ไม่มีชื่อแล้ว จึงตรวจแค่ลายเซ็น ดูเหตุผลเต็มใน stream-token.js
 */
const hlsGuard = (req, res, next) => {
  const match = (req.method === 'GET' || req.method === 'HEAD') ? matchHlsRequest(req.url) : null;
  if (!match) return res.status(404).json({ error: 'Not Found' });
  req.hlsMatch = match;
  next();
};

app.use(
  '/hls',
  hlsGuard,
  requireStreamToken((req) => req.hlsMatch.name),
  proxyToStreamCore(STREAM_CORE === 'go2rtc' ? GO2RTC_API_PORT : MTX_HLS_PORT),
);

/**
 * สตรีมสด fMP4 สำหรับเล่นในเบราว์เซอร์ — /stream/<ชื่อสตรีม>.mp4
 *
 * ใช้แทน HLS เป็นทางหลักตั้งแต่ย้ายมา go2rtc เพราะ HLS ของ go2rtc (hls/mpegts) มัด
 * segment ออกมาเป็นเสียง mp3 ล้วนโดยไม่มีวิดีโอ ทั้งที่ producer เป็น H.264 ปกติดี
 * ทำให้ hls.js ตายด้วย mediaError — ทดสอบแล้วทั้ง `?video=h264` และ `?audio=` ก็ไม่ช่วย
 * ส่วน /api/stream.mp4 ให้ H.264 ครบถ้วนและหน่วงต่ำกว่ามาก ซึ่งเป็นทางหลักที่ go2rtc
 * ออกแบบมาอยู่แล้ว
 *
 * คง path สาธารณะไว้ที่ 5173 ตัวเดียวเหมือน /hls เพื่อไม่ต้องเปิดพอร์ต 1984 ให้ผู้ใช้
 */
app.get('/stream/:name.mp4', requireStreamToken((req) => req.params.name), (req, res) => {
  if (STREAM_CORE !== 'go2rtc') return res.status(404).json({ error: 'MSE requires go2rtc' });

  /*
    เส้น `_raw` ส่งโคเดคของกล้องออกไปตรง ๆ ไม่แปลง

    `video=h264` ที่ใช้กับเส้นปกติมีไว้เพราะเบราว์เซอร์เล่น H.265 ผ่าน MSE ไม่ได้ ปลายทางที่
    ถอด H.265 เองได้ (client native บน Windows, Edge AI) ไม่ต้องจ่ายค่านั้น — และ 140 จาก
    182 เส้นในคลังกล้องนี้เป็น H.265 การบังคับแปลงจึงคือการเผา NVENC ทิ้งทั้งวัน

    `video=copy` ให้ go2rtc ส่งแทร็กเดิมออกไปโดยไม่เรียก ffmpeg เลย ทดสอบแล้วเมื่อ
    2026-09-08 บน instance แยกพอร์ต 1985: ได้ hevc 704x576 อ่านต่อเนื่อง 20 วินาที
    ได้ 501 เฟรมที่ 25fps ไม่ panic — SIGSEGV ที่เคยเจอเป็นของทาง MSE ไม่ใช่ทางนี้

    แยกด้วยชื่อสตรีมแทนที่จะเป็น query param ของผู้เรียก เพราะ token ผูกกับชื่อสตรีมอยู่แล้ว
    ใครขอเส้น `_raw` ได้แปลว่าถือ token ของเส้นนั้นจริง ถ้าให้เลือกโคเดคผ่าน query จะกลายเป็น
    ว่า token ของเส้นเดียวเปิดพฤติกรรมได้หลายแบบ
  */
  const isRaw = req.params.name.endsWith('_raw');
  const video = isRaw ? 'copy' : 'h264';
  /*
    เสียง: go2rtc ใส่แทร็กเสียงลง mp4 เฉพาะเมื่อขอ — มีแค่ `video=` แล้วเสียงหายแม้ต้นทางมี
    ขอ `&audio` (ไม่ระบุโคเดค) เฉพาะกล้องที่เปิด audio_enabled: เส้นปกติได้ AAC ที่ `#audio=aac` แปลงไว้
    ส่วนเส้น `_raw` go2rtc แปลง PCMA/PCMU ของกล้องเป็น FLAC เอง (`audio=aac` ใช้กับ `_raw` ไม่ได้ — ไม่มี ffmpeg)
    ทดสอบแล้ว 2026-10-06 กับ 203.0.113.12 · เส้น `_raw` มีเสียงของกล้องติดมาเสมอ จึงต้องดูค่าในแถว ไม่ขอทุกตัว
  */
  const forward = (audio = false) => {
    req.url = `/api/stream.mp4?src=${encodeURIComponent(req.params.name)}&video=${video}${audio ? '&audio' : ''}`;
    proxyToStreamCore(GO2RTC_API_PORT, { rewrite: false })(req, res);
  };
  /*
    กล้องจาก edge แบบ link (vms/edge-link-server.js): ภาพไม่ได้ถูกดึงค้างไว้ — สั่ง edge push ก่อนแล้ว
    ค่อยต่อ go2rtc ไม่งั้นผู้เล่นได้จอดำจนหมดเวลา · ทุกผู้เล่นมาทางนี้ (เว็บ, client, /api/v1)
  */
  const base = req.params.name.replace(/_raw$/, '');
  const which = base.endsWith('_sub') ? 'sub' : 'main';
  const cameraKey = which === 'sub' ? base.slice(0, -4) : base;
  db.get("SELECT * FROM cameras WHERE lower(replace(id, ' ', '_')) = ?", [cameraKey], (err, row) => {
    if (err || !row) return forward();
    const audio = Number(row.audio_enabled) === 1;
    if (row.type !== 'edge_relay' || !cameraKey.startsWith('cam_edge_')) return forward(audio);
    edgeSources.ensureLinkStream(row, which).catch(() => {}).finally(() => forward(audio));
  });
});

// --- SERVE STATIC FILES (PRODUCTION) ---
// GATEWAY_DIST_DIR: ให้ instance ทดสอบ (edge/central จำลอง) เสิร์ฟหน้าเว็บที่ build ใหม่ได้ โดยไม่ต้อง build ทับ dist ของ production
const distPath = process.env.GATEWAY_DIST_DIR ? path.resolve(process.env.GATEWAY_DIST_DIR) : path.join(__dirname, '../dist');
app.use(express.static(distPath, {
  // "/" ไม่เสิร์ฟ index.html ตรงนี้ — ปล่อยไป catch-all ท้ายไฟล์ที่เลือกหน้าตามบทบาท (central/edge)
  index: false,
  setHeaders: (res, filepath) => {
    if (['index.html', 'regional.html', 'edge.html'].includes(path.basename(filepath))) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
  }
}));

// --- API ROUTES ---
// (API routes should be defined before the catch-all route)

const dbPath = stateFile('vms.db');
const db = new sqlite3.Database(dbPath);
db.run("PRAGMA journal_mode = WAL"); // 🚀 Enable WAL for better concurrency
db.run("PRAGMA synchronous = NORMAL"); // 🚀 Faster writes in WAL mode

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT, allowedCameras TEXT)`, () => {
    // 💡 สร้างบัญชีเริ่มต้นระดับ superadmin อัตโนมัติหากยังไม่มีในระบบค่ะ
    // seed เป็น plaintext แล้วให้ hashLegacyPasswords แปลงต่อทันที — ตัวเดียวกับที่แปลงแถวจาก DB เก่า
    db.run("INSERT OR IGNORE INTO users (id, username, password, role, allowedCameras) VALUES (?, ?, ?, ?, ?)", ['u_superadmin', 'superadmin', 'superadmin', 'superadmin', '[]'],
      () => { hashLegacyPasswords(db).then(warnIfDefaultAdminPassword); });
    // 💡 Migration: DB เก่าอาจมี allowedCameras = "all" (string) สำหรับ role elevated ซึ่งไม่ตรง
    // shape ที่ frontend คาดหวัง (array) — ปรับให้เป็น '[]' ให้ตรงกัน (elevated role ไม่ใช้ field นี้อยู่แล้ว)
    db.run("UPDATE users SET allowedCameras = '[]' WHERE allowedCameras = '\"all\"'");
  });

  // ── RBAC: role เป็นข้อมูลใน DB ไม่ใช่ค่าคงที่ในโค้ด ────────────────────────────
  // roles.all_devices = 1 หมายถึง "เห็นกล้องทุกตัว รวมกล้องที่เพิ่มในอนาคต" ซึ่งต่างจาก
  // การใส่กล้องทุกตัวลง role_devices (นั่นเป็น snapshot ณ ตอนตั้งค่า กล้องใหม่จะไม่เห็น)
  db.run(`CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    label TEXT,
    is_system INTEGER DEFAULT 0,
    all_devices INTEGER DEFAULT 0,
    created_at TEXT
  )`);
  db.run('ALTER TABLE roles ADD COLUMN area_scope TEXT', () => {});
  db.run(`CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT, perm_key TEXT, PRIMARY KEY (role_id, perm_key)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS role_devices (
    role_id TEXT, camera_id TEXT, PRIMARY KEY (role_id, camera_id)
  )`);
  db.run("ALTER TABLE users ADD COLUMN role_id TEXT", () => {});
  db.run("CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_role_devices_role ON role_devices(role_id)");
  db.run(`CREATE TABLE IF NOT EXISTS cameras (id TEXT PRIMARY KEY, name TEXT, group_name TEXT, brand TEXT, type TEXT, rtsp TEXT, ip TEXT, onvifPort TEXT, rtspPort TEXT, onvifUser TEXT, onvifPass TEXT, lat REAL, lng REAL)`);
  // always_on = ตรึง main stream ให้เปิดค้างไว้ ไม่ต้องรอผู้ชม
  //
  // มาแทน ai_detect ที่เคยทำสองหน้าที่ควบกัน คือ "เปิด AI ให้กล้องนี้" กับ "อย่าปิดสตรีม"
  // การผูกสองความหมายไว้ในคอลัมน์เดียว ทำให้ตอนถอด AI ออก ตรรกะสตรีมพังตามไปโดยไม่มีใครเห็น
  db.run("ALTER TABLE cameras ADD COLUMN always_on INTEGER DEFAULT 0", () => {});
  // enabled = ผู้ดูแลเปิดใช้กล้องนี้ไหม (0 = ไม่ซิงก์เข้า core ไม่เช็คสถานะ) — ดู shared/camera-state.js
  // กล้องจาก edge: central เขียนตามค่าของ edge ทุกรอบ sync (edge เป็นเจ้าของ)
  db.run("ALTER TABLE cameras ADD COLUMN enabled INTEGER DEFAULT 1", () => {});
  // audio_enabled = ส่งเสียงของกล้องนี้ต่อไหม (0 = ภาพอย่างเดียวเหมือนเดิม) — ตั้งที่ edge, ชั้นบนรับตามรอบ sync
  // ปิดเป็นค่าตั้งต้น: AAC เพิ่มงาน ffmpeg ทุกเส้น และกล้องส่วนใหญ่ไม่มีไมค์ (docs/CAMERA-AUDIO.md)
  db.run("ALTER TABLE cameras ADD COLUMN audio_enabled INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE cameras ADD COLUMN stream_type TEXT", (err) => {
    // 💡 ละเว้นข้อผิดพลาดหากมีคอลัมน์ stream_type อยู่แล้วในฐานข้อมูลค่ะ
  });
  /*
    สามคอลัมน์นี้ถูกใช้ทั้งระบบ (INSERT กล้องทุกเส้นทาง, go2rtc sync) แต่ไม่มี migration ไหนสร้างมัน
    เครื่องจริงมีเพราะเพิ่มไว้ด้วยโค้ดรุ่นเก่าที่ถูกลบไปแล้ว — เครื่องใหม่ (เช่น edge ที่ติดตั้งสด)
    จึงเพิ่มกล้องไม่ได้เลย และ go2rtc sync ล้มด้วย "no such column: rtsp_sub" พบตอนจำลอง edge 2026-09-23
  */
  db.run("ALTER TABLE cameras ADD COLUMN rtsp_sub TEXT", () => {});
  db.run("ALTER TABLE cameras ADD COLUMN onvif_main_token TEXT", () => {});
  db.run("ALTER TABLE cameras ADD COLUMN onvif_sub_token TEXT", () => {});
  // เลขช่องของ Uniview คงที่แม้ ONVIF ยังไม่คืน RTSP ใช้จับคู่เพื่อเติมสตรีมในแถวเดิม
  db.run("ALTER TABLE cameras ADD COLUMN nvr_channel INTEGER", () => {});
  /*
    ช่อง AXIS S30 ที่ import ก่อน 2026-10-06 ได้ sub = main (1080p เต็ม) — ตั้งเป็นภาพที่ S30 ย่อ 640×360 ให้
    (ตัวเดียวกับ axisS30SubRtsp ใน vms/axis-s30.js) · แตะเฉพาะแถวที่ sub ยังเท่า main ไม่ทับค่าที่คนตั้งเอง
  */
  db.run(`UPDATE cameras SET rtsp_sub = rtsp || '&resolution=640x360'
          WHERE brand = 'axis' AND type = 'onvif_nvr' AND rtsp LIKE '%/axis-media/media.amp?device=%'
            AND rtsp NOT LIKE '%resolution=%' AND (rtsp_sub IS NULL OR rtsp_sub = rtsp)`, function cb(err) {
    if (!err && this.changes) console.log(`[AXIS S30] ตั้ง sub 640x360 ให้ช่องเดิม ${this.changes} ช่อง`);
  });

  // ── กล้องที่มาจาก VMS (Digifort) ──────────────────────────────────────────────
  //
  // camera_sources = เครื่อง VMS หนึ่งเครื่องต่อหนึ่งแถว ไม่ใช่ตารางกล้องอีกใบ กล้องยังอยู่
  // ในตาราง cameras ตามเดิมทั้งหมด เพื่อให้ RBAC หมุดแผนที่ wall และ /api/v1/* ใช้ได้ทันที
  // โดยไม่ต้องแก้ทางอ่านสักเส้น
  //
  // รหัสผ่านเก็บเป็น ciphertext ด้วย key-vault ตัวเดียวกับ API key (กุญแจอยู่นอกฐานข้อมูล)
  // เพราะรหัสใบนี้เปิดกล้องทุกตัวของทั้ง VMS ไม่ใช่ตัวเดียวเหมือนรหัสของหัวกล้อง
  db.run(`CREATE TABLE IF NOT EXISTS camera_sources (
    id TEXT PRIMARY KEY,
    kind TEXT,
    label TEXT,
    host TEXT,
    port TEXT,
    rtsp_port TEXT,
    username TEXT,
    password_sealed TEXT,
    created_at TEXT,
    last_sync_at TEXT
  )`);
  db.run("ALTER TABLE cameras ADD COLUMN source_id TEXT", () => {});
  // source_ref = ชื่อกล้องฝั่ง VMS ซึ่งเป็นกุญแจเดียวที่ Digifort API ใช้อ้างถึงกล้อง
  db.run("ALTER TABLE cameras ADD COLUMN source_ref TEXT", () => {});
  // กัน import ซ้ำ — แถวที่ไม่ได้มาจาก VMS มีทั้งคู่เป็น NULL ซึ่ง sqlite ถือว่าไม่ชนกันเอง
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_source_ref ON cameras(source_id, source_ref)");
  db.run(`CREATE TABLE IF NOT EXISTS settings (setting_key TEXT PRIMARY KEY, setting_value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, action TEXT, details TEXT, timestamp TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS floor_plans (id TEXT PRIMARY KEY, name TEXT, image_url TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS plan_markers (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, camera_id TEXT, x REAL, y REAL)`);
  // 🚀 สร้างดัชนีคีย์ (Indexes) เพื่อเพิ่มความเร็วในการสืบค้นรายงานและข้อมูลเคลื่อนไหว
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_timestamp_action ON logs(timestamp, action)");
  db.run("CREATE INDEX IF NOT EXISTS idx_plan_markers_plan_camera ON plan_markers(plan_id, camera_id)");

  // ── seed role ตั้งต้น + ย้ายผู้ใช้เดิมมาผูกกับ role ──────────────────────────
  // idempotent ทั้งหมด: INSERT OR IGNORE + UPDATE ... WHERE role_id IS NULL
  // จึงรันซ้ำได้ทุกครั้งที่ backend start โดยไม่ทับค่าที่ผู้ใช้แก้เอง
  for (const r of SEED_ROLES) {
    db.run(
      'INSERT OR IGNORE INTO roles (id, name, label, is_system, all_devices, created_at) VALUES (?,?,?,?,?,?)',
      [r.id, r.name, r.label, r.is_system, r.all_devices, nowIso()]
    );
    for (const p of r.perms) {
      db.run('INSERT OR IGNORE INTO role_permissions (role_id, perm_key) VALUES (?,?)', [r.id, p]);
    }
  }
  // ผูก user เดิมกับ role ตามชื่อ role เดิม (users.role ยังคงอยู่ ใช้เป็นทางถอย)
  db.run("UPDATE users SET role_id = 'r_' || role WHERE role_id IS NULL AND role IN ('monitor','operator','admin','superadmin')");

  // ย้ายสิทธิ์กล้องรายคน (allowedCameras = ชื่อกล้อง) ขึ้นไปเป็นสิทธิ์ของ role (camera_id)
  // ระบบจริงตอนนี้ทุกคนเป็น admin/superadmin และ allowedCameras ว่าง จึงไม่มีอะไรย้าย
  // แต่เขียนไว้เผื่อกู้ DB เก่าที่มีการ assign รายคนไว้ — รวมกล้องของทุก user ใน role เดียวกัน
  // (ทำครั้งเดียว: ข้ามถ้า role_devices มีข้อมูลแล้ว)
  setTimeout(() => {
    db.get('SELECT COUNT(*) AS c FROM role_devices', (err, row) => {
      if (err || (row && row.c > 0)) return;
      db.all("SELECT role, allowedCameras FROM users WHERE allowedCameras IS NOT NULL AND allowedCameras != '[]'", (uErr, rows) => {
        if (uErr || !rows || !rows.length) return;
        const byRole = new Map();
        for (const u of rows) {
          let names = [];
          try { const p = JSON.parse(u.allowedCameras || '[]'); if (Array.isArray(p)) names = p; } catch { /* ข้ามแถวที่ JSON พัง */ }
          if (!names.length) continue;
          if (!byRole.has(u.role)) byRole.set(u.role, new Set());
          names.forEach((n) => byRole.get(u.role).add(n));
        }
        for (const [role, names] of byRole) {
          const roleId = `r_${role}`;
          const list = [...names];
          db.all(
            `SELECT id FROM cameras WHERE name IN (${list.map(() => '?').join(',')})`,
            list,
            (cErr, cams) => {
              if (cErr) return;
              for (const cam of cams || []) {
                db.run('INSERT OR IGNORE INTO role_devices (role_id, camera_id) VALUES (?,?)', [roleId, cam.id]);
              }
              console.log(`[RBAC] migrated ${(cams || []).length} device grants to role ${roleId}`);
            }
          );
        }
      });
    });
  }, 3000);
});

const saveLog = (username, action, details, customTime = null) => {
  const timestamp = customTime || nowIso();
  db.run("INSERT INTO logs (username, action, details, timestamp) VALUES (?, ?, ?, ?)", [username || 'System', action, details, timestamp]);
};

/** AI event → Telegram photo and/or video (filter by camera id + event_kind + media flags). */
// 7-deepstream รัน pipeline.py อยู่ใน container ที่ mount server/ ไว้ที่ /app/server ดังนั้น path
// ที่มันส่งมาทาง /api/internal/notify-alert จะเป็น "/app/server/ai_frames/xxx.jpg" ซึ่งไม่มีอยู่
// จริงบน host — backend เช็ค fs.existsSync() แล้วไม่เจอ ก็ข้ามการส่งไปเงียบๆ (ไม่มี else, ไม่มี log)
// ทำให้หลัง cutover ไป DeepStream (2026-07-18) แจ้งเตือน event หยุดส่งทั้งหมด ทั้งที่ปุ่มทดสอบ
// ยังส่งได้ปกติเพราะมันไม่ได้แตะไฟล์ ของเดิม detect_daemon.py รันบน host เลยไม่เคยเจอปัญหานี้
// แปลง prefix กลับมาเป็น path จริงของ server/ แล้วบังคับให้อยู่ใต้ __dirname เท่านั้น
/** กัน promise ค้างไม่รู้จบ (เช่น ONVIF ผ่าน NVR/WAN ที่ไม่เสถียร) — reject ด้วย timeout เอง */
const withTimeout = (promise, ms, label = 'operation') => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

/** Embed user/pass into RTSP URL if not already present. */
const injectRtspCredentials = (url, user, pass) => {
  if (!url || !String(url).startsWith('rtsp://')) return url || '';
  if (/rtsp:\/\/[^/@]+@/.test(url)) return url;
  const u = encodeURIComponent(user || 'admin');
  const p = encodeURIComponent(pass || '');
  return url.replace('rtsp://', `rtsp://${u}:${p}@`);
};

const profileResolution = (p) => {
  const w = Number(p?.video?.encoder?.resolution?.width) || 0;
  const h = Number(p?.video?.encoder?.resolution?.height) || 0;
  return { width: w, height: h, pixels: w * h };
};

/** Prefer Main over Sub when resolution missing (common on Dahua NVR). */
const profileStreamRank = (p, rtsp) => {
  const name = `${p?.name || ''} ${rtsp || ''}`.toLowerCase();
  if (/subtype=0\b|_mainstream|main.?stream|\/1$|channels\/\d+01\b/.test(name)) return 2;
  if (/subtype=1\b|_substream|sub.?stream|extra.?stream|\/2$|channels\/\d+02\b/.test(name)) return 0;
  if (/subtype=2\b/.test(name)) return 0;
  return 1;
};

const profileRtspRaw = (p) => p?.stream?.rtsp || p?.stream?.udp || '';

/**
 * เลขช่องจริงของ NVR จาก RTSP ที่ NVR ตอบมาเอง (ไม่ใช่ลำดับของ profile ใน GetProfiles ซึ่งสลับไปมา)
 * รูปแบบที่ NVR ใช้ในทางปฏิบัติ: Uniview /unicast/c<ช่อง>/s<สตรีม>/live · Hikvision /Streaming/Channels/<ช่อง>0<สตรีม>
 * · Dahua และตระกูล OEM ?channel=<ช่อง>&subtype=<สตรีม> · ไม่เข้ารูปไหน = null (หน้าเว็บใช้ลำดับแทน)
 */
const nvrChannelNumber = (rtsp) => {
  const url = String(rtsp || '');
  const m = url.match(/\/unicast\/c(\d+)\/s\d+/i)
    || url.match(/\/Streaming\/Channels\/(\d+?)0\d(?:\D|$)/i)
    || url.match(/[?&]channel=(\d+)/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** ตัดรหัสผ่านออกจาก RTSP ก่อนเทียบ — กล้องเดียวกันที่แอดด้วยรหัสต่างรอบกันยังนับเป็นตัวเดิม */
const rtspIdentity = (url) => String(url || '').trim().replace(/^rtsp:\/\/[^/@]*@/i, 'rtsp://').toLowerCase();

/**
 * Group ONVIF profiles by VideoSource token → one channel with main/sub by resolution.
 * No brand RTSP templates.
 */
const groupOnvifProfiles = (profiles, user, pass, videoSources = [], milestoneBridge = false) => {
  const list = Array.isArray(profiles) ? profiles : [];
  const buckets = new Map();

  list.forEach((p, idx) => {
    const srcToken = p?.video?.source?.token;
    // No VideoSource → one group per profile (avoid merging unrelated channels)
    const key = srcToken || `profile_${p?.token || idx}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  });

  const groups = [];
  let gIdx = 0;
  for (const [key, members] of buckets.entries()) {
    const allProfiles = members.map((p, order) => {
      const res = profileResolution(p);
      const raw = profileRtspRaw(p);
      const rtsp = injectRtspCredentials(raw, user, pass);
      return {
        token: p.token || '',
        name: p.name || p.token || `Profile ${gIdx}`,
        rtsp,
        width: res.width,
        height: res.height,
        pixels: res.pixels,
        streamRank: profileStreamRank(p, rtsp),
        encoding: String(p?.video?.encoder?.encoding || '').toUpperCase(),
        sourceToken: p?.video?.source?.token || null,
        sourceName: p?.video?.source?.name || null,
        order,
      };
    });
    const enriched = allProfiles.filter((x) => x.rtsp);

    // NVR ยังคงส่ง Profile ของ channel ที่ไม่มีกล้องต่ออยู่ตอนนี้กลับมาด้วย (แค่ GetStreamUri
    // ไม่มี RTSP ให้) — เดิม filter ทิ้งไปเลยทำให้ scan เห็นแค่กล้องที่ online ตอนนั้น ไม่ครบ
    // ตามจำนวน channel จริงของ NVR (เช่น NVR 8 ช่อง แต่บางตัวมาๆหายๆ) เปลี่ยนเป็นเก็บไว้ในผล
    // ลัพธ์ด้วย ให้เห็นครบ แต่ทำเครื่องหมาย isOnline:false และ main/sub เป็น null (import ไม่ได้
    // จนกว่าจะ scan ใหม่ตอนกล้องกลับมา online)
    const label =
      (milestoneBridge ? allProfiles[0]?.name : null) ||
      allProfiles[0]?.sourceName ||
      members[0]?.video?.source?.name ||
      allProfiles[0]?.name ||
      `Channel ${gIdx + 1}`;

    if (!enriched.length) {
      groups.push({
        id: String(key),
        name: label,
        sourceToken: allProfiles[0]?.sourceToken || null,
        isOnline: false,
        main: null,
        sub: null,
        profiles: [],
      });
      gIdx += 1;
      continue;
    }

    // Sort: resolution first; if all 0 (Dahua), use Main/Sub name/URL hints
    enriched.sort((a, b) => {
      if (b.pixels !== a.pixels) return b.pixels - a.pixels;
      if (b.streamRank !== a.streamRank) return b.streamRank - a.streamRank;
      return a.token.localeCompare(b.token);
    });
    /*
      profile JPEG (MJPEG) ไม่ใช้เป็น main/sub ถ้ามีตัวอื่นให้เลือก — Axis ให้แค่ profile_1_h264 กับ
      profile_1_jpeg ที่ 4K ทั้งคู่ การเลือกตัวละเอียดต่ำสุดเป็น sub จึงได้ MJPEG 4K ซึ่งหนักกว่า main
      (พบกับ AXIS P1488-LE 2026-09-23)
    */
    const video = enriched.filter((x) => x.encoding !== 'JPEG');
    const pool = video.length ? video : enriched;
    const main = pool[0];
    /*
      sub = stream ที่ 2 ของกล้อง คือ profile แรกถัดจาก main ตามลำดับที่กล้องรายงาน — ไม่ใช่ตัวละเอียดต่ำสุด
      กล้องที่มี stream ที่ 3 มักตั้งไว้เล็กและ keyframe ห่าง: Tiandy MODEL-A stream 3 เป็น 352×288 5 fps
      keyframe ทุก 20 วิ ทำให้ Live Wall รอภาพนาน ส่วน stream 2 เป็น 640×360 keyframe 2 วิ (2026-09-25)
      · stream ที่ 3 ขึ้นไปไม่ใช้
    */
    const rest = pool.slice(1).sort((a, b) => a.order - b.order);
    let sub = rest.length ? rest[0] : { ...main };
    /*
      Axis มี profile เดียวต่อ codec แต่ย่อขนาดให้ได้ด้วยพารามิเตอร์ของ VAPIX ต่อท้าย URL — ทดสอบแล้วว่า
      onvif-media/media.amp?…&resolution=640x360 ได้ H.264 640×360 · ใช้เฉพาะเมื่อไม่มี profile เล็กกว่าให้เลือก
    */
    if (sub.token === main.token && /\/(onvif|axis)-media\/media\.amp/i.test(main.rtsp || '')) {
      const sep = main.rtsp.includes('?') ? '&' : '?';
      sub = { ...main, rtsp: `${main.rtsp}${sep}resolution=640x360`, width: 640, height: 360 };
    }

    groups.push({
      id: String(key),
      name: label,
      channel: nvrChannelNumber(main.rtsp),
      sourceToken: main.sourceToken,
      /*
        profile ที่ไม่ผูก VideoSource ไม่ใช่ช่องกล้อง — Uniview NVR มี token:16/0/0/3/1/s0 → /unicast/c0/…
        เป็นสตรีมของตัว NVR เอง (เจอเป็น CH 1 ของ SITE-1-3) · ยังแสดงให้เห็น แต่ไม่เลือกให้อัตโนมัติ
      */
      // Bridge แทนกล้องแต่ละตัวด้วย profile GUID แม้ไม่ส่ง VideoSourceConfiguration
      // จึงใช้ profile นั้นเป็นกล้องได้ ต่างจากสตรีมรวมของ NVR ที่ต้องกันออก
      noVideoSource: !milestoneBridge && !main.sourceToken,
      isOnline: true,
      main: { token: main.token, rtsp: main.rtsp, width: main.width, height: main.height },
      sub: { token: sub.token, rtsp: sub.rtsp, width: sub.width, height: sub.height },
      profiles: enriched.map(({ token, name, rtsp, width, height }) => ({ token, name, rtsp, width, height })),
    });
    gIdx += 1;
  }

  /*
    ช่องที่ออฟไลน์ตอนสแกน: NVR บางรุ่น (Uniview ที่ SITE-1-3) ตัดช่องนั้นออกจาก GetProfiles ทั้งก้อน
    แต่ GetVideoSources ยังรายงานครบทุกช่อง โดยช่องที่ไม่มีภาพเป็น Framerate 0 / 0×0 (ตรวจจาก log ของ
    edge 002, 2026-09-24) — เติมช่องพวกนี้เป็นแถวออฟไลน์ตามข้อมูลจริงของ NVR ไม่แต่ง RTSP ให้
    (ไม่มี profile = ขอ GetStreamUri ไม่ได้) → แอดได้เมื่อสแกนซ้ำตอนกล้องกลับมา
  */
  const seenSources = new Set(groups.map((g) => g.sourceToken).filter(Boolean));
  const sourceOrder = new Map();
  videoSources.forEach((vs, i) => {
    sourceOrder.set(vs.token, i);
    if (seenSources.has(vs.token)) return;
    groups.push({
      id: String(vs.token),
      name: String(vs.token),
      sourceToken: vs.token,
      isOnline: false,
      offlineReason: vs.framerate > 0 ? 'no-profile' : 'no-signal',
      main: null,
      sub: null,
      profiles: [],
    });
  });

  // เรียงตามลำดับช่องที่ NVR รายงานใน GetVideoSources → เลขช่องจาก RTSP → ลำดับเดิม
  // (ลำดับจาก GetProfiles ของ NVR สลับไปมา) · profile ที่ไม่ผูก VideoSource ไว้ท้ายสุด
  const orderOf = (g) => (g.sourceToken && sourceOrder.has(g.sourceToken) ? sourceOrder.get(g.sourceToken) : Infinity);
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (orderOf(a.g) - orderOf(b.g))
      || ((a.g.channel ?? Infinity) - (b.g.channel ?? Infinity))
      || a.i - b.i)
    .map(({ g }) => g);
};

/** แปลงผล GetVideoSources ของ node-onvif เป็น [{ token, framerate, width, height }] ตามลำดับที่อุปกรณ์ตอบ */
const parseVideoSources = (data) => {
  const raw = data?.GetVideoSourcesResponse?.VideoSources;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((vs) => ({
      token: vs?.$?.token != null ? String(vs.$.token) : null,
      framerate: Number(vs?.Framerate) || 0,
      width: Number(vs?.Resolution?.Width) || 0,
      height: Number(vs?.Resolution?.Height) || 0,
    }))
    .filter((vs) => vs.token);
};

/**
 * สร้าง+init OnvifDevice โดยลอง http ก่อนเสมอ (เคสส่วนใหญ่) แล้ว fallback เป็น https ถ้า
 * ต่อไม่ติด — เจอเคสจริง: router forward เฉพาะ HTTPS มาที่พอร์ต ONVIF (เข้าใจผิดว่า HTTP)
 * ทำให้ scan ไม่เจอกล้องเลยทั้งที่ port/user/pass ถูกหมด เพราะ SOAP ไปเป็น plain HTTP บน
 * TLS listener ไม่ได้ (ดู onvif_patch.js: patchOnvifSoapHttps)
 */
const initOnvifDeviceWithFallback = async ({ ip, onvifPort, user, pass }) => {
  const port = onvifPort || 80;
  let lastErr;
  for (const scheme of ['http', 'https']) {
    const device = new onvif.OnvifDevice({
      xaddr: `${scheme}://${ip}:${port}/onvif/device_service`,
      user,
      pass,
    });
    try {
      await device.init();
      return device;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
};

/** Probe ONVIF device → channel groups with real RTSP URIs. */
const probeOnvifChannelGroups = async ({ ip, onvifPort, user, pass, milestoneBridge = false }) => {
  const device = await initOnvifDeviceWithFallback({ ip, onvifPort, user, pass });
  const profiles = device.getProfileList();
  console.log(
    `[NVR ONVIF Scan] ${ip}: ${profiles.length} profile(s) from GetProfiles — ` +
    profiles.map((p) => `${p.token || '?'}${p?.video?.source?.token ? `/src:${p.video.source.token}` : ''}${p?.stream?.rtsp ? '' : ' [no-rtsp]'}`).join(', ')
  );
  // GetVideoSources รายงานทุกช่องของ NVR รวมช่องที่ออฟไลน์ (GetProfiles ไม่รวม) — ล้มก็ยังได้ช่องที่ออนไลน์
  let videoSources = [];
  if (!milestoneBridge) {
    try {
      const vsRes = await device.services.media.getVideoSources();
      videoSources = parseVideoSources(vsRes?.data);
      const dark = videoSources.filter((vs) => !vs.framerate).map((vs) => vs.token);
      console.log(`[NVR ONVIF Scan] ${ip}: GetVideoSources ${videoSources.length} ช่อง · ไม่มีสัญญาณ ${dark.length}${dark.length ? ` (${dark.join(', ')})` : ''}`);
    } catch (e) {
      console.log(`[NVR ONVIF Scan] ${ip}: GetVideoSources failed — ${redactUrls(e.message)}`);
    }
  }
  return groupOnvifProfiles(profiles, user, pass, videoSources, milestoneBridge);
};

/** เครื่องผ่าน WAN/port-forward มี latency สูงและ TLS handshake หลายรอบ (ต่อ profile) — ลอง
 * ซ้ำเองก่อน error กลับไปให้ user กด scan ใหม่เอง (เจอจริง: fail รอบแรกแต่ผ่านรอบสอง) */
const probeOnvifChannelGroupsWithRetry = async (params, attempts = 2) => {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await probeOnvifChannelGroups(params);
    } catch (e) {
      lastErr = e;
      console.warn(`[NVR ONVIF Scan] ${params.ip}: attempt ${i + 1}/${attempts} failed — ${redactUrls(e.message)}`);
    }
  }
  throw lastErr;
};

/**
 * Resolve main (+ optional sub) RTSP for a single ONVIF camera.
 * Returns { rtsp, rtsp_sub, onvif_main_token, onvif_sub_token } or string for legacy callers.
 */
const resolveOnvifStreams = async (c) => {
  const manualRtsp = c.rtsp || c.rtspUrl || '';
  /*
    ช่อง "RTSP sub" ในฟอร์ม (2026-09-25) — ใช้กับกล้อง RTSP ที่กรอกเอง และกล้อง ONVIF ที่ ONVIF ให้มาแค่ profile เดียว
    ไม่กรอก = sub เป็นเส้นเดียวกับ main (ช่องบน Live Wall transcode ภาพเต็มขนาด)
  */
  const userSub = String(c.rtspSubUrl || '').trim() || null;
  /*
    กล้องจาก VMS ไม่มี substream ให้เลย (Digifort relay คืนเส้นเดียว) rtsp_sub ต้องเป็น null
    ไม่ใช่สำเนาของ main เพราะ syncCamerasToGo2rtc() สร้าง path `_sub` ทุกครั้งที่เห็นค่านี้
    แล้ว transcode ภาพเดียวกันซ้ำอีกเส้นต่อกล้องหนึ่งตัว
  */
  if (c.type === DIGIFORT_TYPE) {
    return { rtsp: manualRtsp, rtsp_sub: null, onvif_main_token: null, onvif_sub_token: null };
  }
  // กล้องจาก Dahua DSS: main/sub เป็น URL ตัวกลาง RTSP ในเครื่อง (vms/dss-routes.js ตั้งให้) — ใช้ตามที่เก็บไว้
  if (c.type === DSS_TYPE) {
    return { rtsp: manualRtsp, rtsp_sub: c.rtsp_sub || null, onvif_main_token: null, onvif_sub_token: null };
  }
  if (c.type === 'manual' || c.type === 'onvif_nvr') {
    return {
      rtsp: manualRtsp,
      rtsp_sub: (c.type === 'manual' ? userSub : null) || c.rtsp_sub || manualRtsp,
      onvif_main_token: c.onvif_main_token || null,
      onvif_sub_token: c.onvif_sub_token || null,
    };
  }
  if (c.type !== 'onvif_cam') {
    return {
      rtsp: manualRtsp,
      rtsp_sub: c.rtsp_sub || manualRtsp,
      onvif_main_token: null,
      onvif_sub_token: null,
    };
  }

  const user = c.onvifUser || 'admin';
  const pass = c.onvifPass || '';
  const ip = c.ip;
  const port = c.rtspPort || '554';
  /*
    คอลัมน์ rtsp คือ main เสมอ — เดิม stream_type = 'sub' ทำให้ rtsp เป็น URL ของ sub (main กับ sub เป็นเส้นเดียวกัน
    ภาพเต็มจอได้ภาพเล็ก) และ POST ตั้ง stream_type เป็น 'sub' ให้เองเมื่อผู้เรียกไม่ส่งมา · stream_type ไม่มีที่อื่นใช้แล้ว
  */
  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(pass);

  try {
    const groups = await probeOnvifChannelGroups({
      ip,
      onvifPort: c.onvifPort,
      user,
      pass,
    });
    // Single IPC: ช่องแรกที่มี RTSP จริง (ผลสแกนอาจมีแถวออฟไลน์/แถวไม่ผูก VideoSource ปนอยู่)
    const g = groups.find((x) => x.main?.rtsp && !x.noVideoSource) || groups.find((x) => x.main?.rtsp);
    if (g?.main?.rtsp) {
      const mainUrl = g.main.rtsp;
      // ONVIF มี profile เดียว (sub = สำเนาของ main) — ใช้ RTSP sub ที่ผู้ใช้กรอกถ้ามี · มี stream 2 จริงก็ใช้ของ ONVIF เสมอ
      const singleProfile = !g.sub?.rtsp || g.sub.rtsp === mainUrl;
      if (singleProfile && userSub) {
        return { rtsp: mainUrl, rtsp_sub: userSub, onvif_main_token: g.main.token || null, onvif_sub_token: null };
      }
      const subUrl = g.sub?.rtsp || mainUrl;
      return {
        rtsp: mainUrl,
        rtsp_sub: subUrl,
        onvif_main_token: g.main.token || null,
        onvif_sub_token: g.sub?.token || g.main.token || null,
      };
    }
  } catch (e) {
    console.error(`[ONVIF Probe Error] ${c.ip} probe failed, using fallback templates:`, redactUrls(e.message));
  }

  // Legacy brand fallback only when ONVIF probe fails (single cam)
  let main;
  let sub;
  if (c.brand === 'uniview') {
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/media/video1`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/media/video2`;
  } else if (c.brand === 'tiandy') {
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/1/1`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/1/2`;
  } else if (c.brand === 'hikvision') {
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/Streaming/Channels/101`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/Streaming/Channels/102`;
  } else if (c.brand === 'dahua') {
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/realmonitor?channel=1&subtype=0`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/cam/realmonitor?channel=1&subtype=1`;
  } else if (c.brand === 'axis') {
    /*
      Axis: ONVIF ต้องใช้บัญชี ONVIF แยก (บัญชีเว็บได้ "Sender not authorized") แต่ RTSP ใช้บัญชีเว็บได้
      ONVIF ล้มจึงยังได้ภาพ · sub ย่อขนาดด้วยพารามิเตอร์ของ VAPIX (ทดสอบกับ P1488-LE: 640×360 H.264)
    */
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/axis-media/media.amp`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/axis-media/media.amp?resolution=640x360`;
  } else {
    main = `rtsp://${encUser}:${encPass}@${ip}:${port}/onvif1`;
    sub = `rtsp://${encUser}:${encPass}@${ip}:${port}/onvif2`;
  }
  return {
    rtsp: main,
    rtsp_sub: sub,
    onvif_main_token: null,
    onvif_sub_token: null,
    // URL เดาจากยี่ห้อ ไม่ได้มาจากกล้อง — PUT ใช้ตัดสินว่าจะทับ URL เดิมที่เคยได้จาก ONVIF หรือไม่
    guessed: true,
  };
};

/** @deprecated Prefer resolveOnvifStreams — kept for any leftover single-string callers */
const resolveOnvifRtsp = async (c) => {
  const s = await resolveOnvifStreams(c);
  return s.rtsp;
};

const getCameraRow = (id) => new Promise((resolve, reject) => {
  db.get('SELECT * FROM cameras WHERE id = ?', [id], (err, row) => {
    if (err) return reject(err);
    if (!row) return reject(new Error('Camera not found'));
    resolve(row);
  });
});

const captureOnvifSnapshot = async (camera) => {
  const device = await initOnvifDeviceWithFallback({
    ip: camera.ip,
    onvifPort: camera.onvifPort,
    user: camera.onvifUser,
    pass: camera.onvifPass,
  });
  // main profile (index 0) — ไม่สลับไป sub
  if (device.getProfileList().length > 1) device.changeProfile(0);
  const res = await device.fetchSnapshot();
  if (!res?.body?.length) throw new Error('ONVIF snapshot returned empty body');
  return res.body;
};

const captureTiandyIsapiSnapshot = async (camera) => {
  const user = camera.onvifUser || 'admin';
  const pass = camera.onvifPass || '';
  const port = camera.onvifPort || 80;
  const paths = [
    '/ISAPI/Streaming/channels/101/picture',
    '/cgi-bin/snapshot.cgi?channel=1',
  ];
  let lastErr;
  for (const p of paths) {
    try {
      const r = await axios.get(`http://${camera.ip}:${port}${p}`, {
        auth: { username: user, password: pass },
        responseType: 'arraybuffer',
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      const ct = r.headers['content-type'] || '';
      const buf = Buffer.from(r.data);
      if (buf.length > 0 && (ct.match(/image\//) || buf[0] === 0xFF)) return buf;
      throw new Error(`Unexpected response (${ct || 'no content-type'})`);
    } catch (e) {
      lastErr = e;
      console.error(`[ROI Preview] Tiandy ISAPI ${p} fail:`, e.message);
    }
  }
  throw lastErr || new Error('Tiandy ISAPI snapshot failed');
};

/**
 * ภาพนิ่งจาก Axis ผ่าน VAPIX (digest MD5 — Axis OS ปิด basic ไว้เป็นค่าเริ่มต้น) · ทางสำรองหลัง ffmpeg/RTSP
 * ใช้ได้เฉพาะเมื่อกล้องถูกแอดด้วยบัญชีเว็บ: บัญชี ONVIF ของ Axis ใช้กับ RTSP ได้แต่ CGI ของ VAPIX ตอบ 401
 * (ทดสอบกับ P1488-LE 2026-09-23)
 */
const captureAxisSnapshot = async (camera) => {
  const { authedRequest } = require('./gateway/analytics/http-digest');
  const res = await authedRequest(
    { host: camera.ip, port: Number(camera.onvifPort) || 80, user: camera.onvifUser || 'root', pass: camera.onvifPass || '' },
    '/axis-cgi/jpg/image.cgi',
    { timeoutMs: 15000 },
  );
  if (!res.body?.length || res.body[0] !== 0xFF) throw new Error('Axis ไม่ได้ส่ง JPEG กลับมา');
  return res.body;
};

const captureMainSnapshotBuffer = async (camera) => {
  // กล้องจาก edge แบบ link: ภาพมีเฉพาะตอน edge push เข้ามา — สั่งเปิดก่อนจับภาพ (กล้องอื่นไม่ทำอะไร)
  await edgeSources.ensureLinkStream(camera, 'main').catch(() => {});
  /*
    ลำดับการจับภาพ: ffmpeg ตรงเข้า RTSP ของกล้องก่อน แล้วค่อยถอยไป ISAPI/ONVIF

    ffmpeg ดึงเฟรมสด ๆ จากกล้องเองโดยไม่ผ่าน streaming core — ชื่อเดิมของฟังก์ชันนี้มีคำว่า
    mediamtx อยู่ ทั้งที่ไม่เคยคุยกับ MediaMTX เลยสักครั้ง ส่วน ONVIF ของกล้องหลายรุ่นคืน
    JPEG ที่ค้างอยู่ 1–2 นาที จึงเป็นทางเลือกสุดท้าย ไม่ใช่ทางแรก
  */
  try {
    const buf = await captureFfmpegRtspSnapshot(camera);
    return { buffer: buf, source: 'ffmpeg-rtsp' };
  } catch (e) {
    console.error(`[Main Snap] ffmpeg/RTSP fail (${camera.id}):`, e.message);
    // กล้องสาธารณะมีแต่ HLS — ทางสำรอง VAPIX/ISAPI/ONVIF จะเดา IP จาก URL แล้วยิงไปที่เครื่องหน่วยงาน
    if (camera.type === PUBLIC_TYPE) throw e;
  }
  if (camera.brand === 'axis') {
    try {
      const buf = await captureAxisSnapshot(camera);
      return { buffer: buf, source: 'axis-vapix' };
    } catch (e) {
      console.error(`[Main Snap] Axis VAPIX fail (${camera.ip}):`, e.message);
    }
  }
  if (camera.brand === 'tiandy') {
    try {
      const buf = await captureTiandyIsapiSnapshot(camera);
      return { buffer: buf, source: 'tiandy-isapi' };
    } catch (e) {
      console.error(`[Main Snap] Tiandy ISAPI fail (${camera.ip}):`, e.message);
    }
  }
  try {
    const buf = await captureOnvifSnapshot(camera);
    return { buffer: buf, source: 'onvif' };
  } catch (e) {
    console.error(`[Main Snap] ONVIF fail (${camera.ip}):`, e.message);
    throw e;
  }
};

const isLocalInternalRequest = (req) => {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

// จับภาพตรงจาก RTSP ของกล้องเลย (ไม่ผ่าน MediaMTX) — main path บน MediaMTX ตอนนี้เป็น
// on-demand (H.264 = MediaMTX native pull ตอนมีคน request, H.265 = Node transcode ตอนมีคน
// เรียก /stream/start เท่านั้น) ถ้ายังไม่มีใครดู path จะยังไม่ publish เลย ffmpeg เดี่ยวๆ ตัวนี้
// ถอดรหัส H.265 software-decode เอาแค่เฟรมเดียวได้อยู่แล้วไม่ต้องพึ่ง GPU/publish state ใดๆ
// Grab one JPEG frame from ANY rtsp URL via ffmpeg. Generalized (2026-07-21) so ROI preview can
// prefer the LOCAL MediaMTX relay (rtsp://127.0.0.1:8554/<id>) over a fresh session straight to
// the camera/NVR — the direct route is slow to open and, on NVRs, competes for the limited
// concurrent-session count (the frequent "camera unreachable" ROI-preview failure).
const captureRtspFrameFfmpeg = (rtspUrl, timeoutMs = 8000) => new Promise((resolve, reject) => {
  const url = String(rtspUrl || '').replace(/"/g, '');
  if (!url) return reject(new Error('No RTSP URL'));
  const ffmpegPath = FFMPEG_PATH.replace(/\\\\/g, '\\');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    // เฉพาะ RTSP — กล้อง Public เป็น HLS (https) และ ffmpeg ปฏิเสธทั้งคำสั่งเมื่อเจอ option ที่ demuxer ไม่รู้จัก
    ...(/^rtsps?:/i.test(url) ? ['-rtsp_transport', 'tcp'] : []),
    // Lower analyze/probe than before — a single keyframe doesn't need deep probing, and small
    // values open far faster (matters most for the local relay, already-decoded H264).
    '-analyzeduration', '1000000',
    '-probesize', '1000000',
    '-i', url,
    '-frames:v', '1',
    '-f', 'image2',
    '-q:v', '3',
    'pipe:1',
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  let stderr = '';
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  proc.stdout.on('data', (chunk) => chunks.push(chunk));
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    // stderr ของ ffmpeg มี URL เต็มพร้อม user:pass ของกล้อง — ข้อความนี้ไปถึงทั้ง log และ JSON ที่ตอบหน้าเว็บ
    if (code !== 0 || chunks.length === 0) return reject(new Error(redactUrls(stderr) || `ffmpeg exit ${code}`));
    resolve(Buffer.concat(chunks));
  });
  proc.on('error', (e) => { clearTimeout(timer); reject(new Error(redactUrls(e.message))); });
});

const captureFfmpegRtspSnapshot = (camera) => captureRtspFrameFfmpeg(camera.rtsp, 15000);

const getFilesRecursively = (dir, files = []) => {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        getFilesRecursively(fullPath, files);
      } else {
        if (item.name.match(/\.(jpg|jpeg|png)$/i)) {
          files.push(fullPath);
        }
      }
    }
  } catch (e) {
    // ignore read errors
  }
  return files;
};

// --- CORE API ---
// (ย้าย API เก่าที่ไม่ปลอดภัยไปต่อท้าย Middleware checkAuth ด้านล่างแล้วค่ะ)
/** บัญชีตั้งต้นที่ระบบสร้างเอง (seed) — ยังใช้รหัสนี้อยู่ = ต้องเตือนให้เปลี่ยน */
const DEFAULT_ADMIN_USER = 'superadmin';
const DEFAULT_ADMIN_PASSWORD = 'superadmin';

/**
 * บัญชีตั้งต้นยังใช้รหัสตั้งต้นอยู่ไหม — ใช้ทั้งตอนเริ่มระบบ (log เตือน) และ /api/me (แถบเตือนบนหน้าเว็บ)
 * จำผลต่อค่า hash ใน DB: รหัสที่เปลี่ยนแล้วตรวจไม่ผ่าน verifyPassword จึงไม่ถูกแคชที่นั่น — ไม่จำเอง = scrypt ทุก /api/me
 */
const defaultPwMemo = new Map(); // hash ใน DB -> boolean
const usesDefaultAdminPassword = async (row) => {
  if (!row || row.username !== DEFAULT_ADMIN_USER || !row.password) return false;
  if (defaultPwMemo.has(row.password)) return defaultPwMemo.get(row.password);
  const result = await verifyPassword(DEFAULT_ADMIN_PASSWORD, row.password);
  if (defaultPwMemo.size > 50) defaultPwMemo.clear();
  defaultPwMemo.set(row.password, result);
  return result;
};

/** เตือนใน log ตอนเริ่มระบบถ้า superadmin ยังเป็นรหัสตั้งต้น — ใครรู้ที่อยู่เครื่องก็เข้าได้ทั้งระบบ */
function warnIfDefaultAdminPassword() {
  db.get('SELECT username, password FROM users WHERE username = ?', [DEFAULT_ADMIN_USER], async (err, row) => {
    if (err || !row) return;
    if (await usesDefaultAdminPassword(row)) {
      console.warn(`[Auth] ⚠ บัญชี ${DEFAULT_ADMIN_USER} ยังใช้รหัสผ่านตั้งต้น — เปลี่ยนที่หน้า Users ทันที`);
    }
  });
}

/**
 * เข้าสู่ระบบ — ตอบ session token (shared/session-token.js) ไม่ส่งรหัสผ่านหรือ hash กลับไปอีกแล้ว
 *
 * กันเดารหัส: ผิด 5 ครั้งใน 5 นาทีต่อ IP หรือต่อ username → 429 ต่อไป 5 นาที (shared/login-throttle.js)
 * ทุกครั้งที่ผิดลง log (ตาราง logs) ให้ย้อนดูได้ว่ามีคนลองบัญชีไหนจากที่ไหน
 */
app.post('/api/login', (req, res) => {
  const plain = String(req.body?.password || '');
  const username = String(req.body?.username || '').trim();
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const lockedSec = loginThrottle.lockedFor(ip, username);
  if (lockedSec > 0) {
    res.set('Retry-After', String(lockedSec));
    return res.status(429).json({ success: false, error: `ลองผิดหลายครั้งเกินไป — รอ ${Math.ceil(lockedSec / 60)} นาทีแล้วลองใหม่` });
  }
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (err) return res.status(500).json({ success: false, error: 'Database error' });
    if (!row || !(await verifyPassword(plain, row.password))) {
      const locked = loginThrottle.recordFailure(ip, username);
      saveLog(username.slice(0, 64) || 'unknown', 'Login Failed',
        `เข้าสู่ระบบไม่สำเร็จจาก ${ip}${locked ? ' — ระงับการลองชั่วคราว 5 นาที' : ''}`);
      return res.status(401).json({ success: false });
    }
    loginThrottle.recordSuccess(ip, username);
    // แถวที่ยังเป็น plaintext (เช่นกู้จาก backup เก่าระหว่างรัน) แปลงเป็น hash ตอน login สำเร็จ
    // session ต้องผูกกับ hash ใหม่ ไม่ใช่ plaintext เดิม — ไม่งั้น token แรกหลุดทันทีที่ UPDATE เสร็จ
    let stored = row.password;
    if (!isHashed(stored)) {
      try {
        const hashed = await hashPassword(plain);
        await new Promise((ok) => db.run('UPDATE users SET password = ? WHERE id = ? AND password = ?', [hashed, row.id, row.password], function onDone(uErr) {
          if (!uErr && this.changes) stored = hashed;
          ok();
        }));
      } catch { /* แปลงไม่สำเร็จ — ใช้ค่าเดิม ตัวแปลงตอนเริ่มระบบจะทำให้ภายหลัง */ }
    }
    const session = sessionToken.signSession({ id: row.id, password: stored });
    const mustChangePassword = row.username === DEFAULT_ADMIN_USER && plain === DEFAULT_ADMIN_PASSWORD;
    saveLog(row.username, 'Login', 'ผู้ใช้งานเข้าสู่ระบบสำเร็จ');
    let allowedCameras = [];
    try { allowedCameras = JSON.parse(row.allowedCameras || '[]'); } catch { /* ค่าเก่าที่อ่านไม่ออก = ว่าง */ }
    // แนบสิทธิ์+ขอบเขตกล้องมากับ login เลย เพื่อให้ frontend ใช้ได้ทันทีตั้งแต่ paint แรก
    // ไม่ต้องรอ /api/me รอบต่อไป (ซึ่งใช้เป็นตัว refresh กัน localStorage ค้าง)
    getRoleAccess(row.role_id || roleIdFor(row.role), (aErr, access) => {
      // ไม่ส่ง password (plaintext หรือ hash) กลับไปเด็ดขาด — หน้าเว็บถือแค่ token
      const { password: _omit, ...safe } = row;
      const user = {
        ...safe,
        allowedCameras,
        permissions: aErr ? [] : [...access.perms],
        deviceIds: (aErr || access.deviceIds === null) ? null : [...access.deviceIds],
        allDevices: aErr ? false : access.deviceIds === null,
        mustChangePassword,
      };
      res.json({ success: true, user, token: session.token, expiresAt: session.expiresAt, mustChangePassword });
    });
  });
});

// --- MAP ---
// --- MAP ---
let mapDbInstance = null;
let currentMapDbPath = null;

function getMapDb() {
  let dbPath = path.join(__dirname, 'map_data/osm-2020-02-10-v3.11_asia_thailand.mbtiles');
  const uploadedPath = path.join(__dirname, 'map_data/uploaded_map.mbtiles');
  if (fs.existsSync(uploadedPath)) {
    dbPath = uploadedPath;
  } else {
    const fallbackPath = path.join(__dirname, 'map_data/thailand2026vms.mbtiles');
    if (fs.existsSync(fallbackPath)) {
      dbPath = fallbackPath;
    }
  }

  if (currentMapDbPath !== dbPath) {
    if (mapDbInstance) {
      try { mapDbInstance.close(); } catch(e){}
    }
    mapDbInstance = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    currentMapDbPath = dbPath;
    console.log(`[MAP] Opened database at: ${dbPath}`);
  }
  return mapDbInstance;
}

/*
  ไทล์ vector ของ OpenMapTiles โดยเฉพาะ — คนละเส้นกับ /api/tiles

  /api/tiles เสิร์ฟ "ไฟล์แผนที่ที่ผู้ดูแลเลือกไว้" ซึ่งตอนนี้คือ thailand2026vms.mbtiles ที่เป็น
  ภาพ PNG ล้วน ใช้ทำแผนที่ 3 มิติไม่ได้เลยเพราะไม่มีรูปทรงอาคารให้ยก มีแต่ภาพเมืองที่วาดเสร็จแล้ว

  เส้นนี้จึงตรึงไว้ที่ไฟล์ OpenMapTiles v3.11 เสมอ ไม่ขึ้นกับค่า MAP_TYPE และไม่ขึ้นกับไฟล์ที่
  อัปโหลดทับ เพราะผู้ใช้ของมันคือแผนที่ของ client ซึ่งต้องการเลเยอร์ building กับ
  transportation_name จริง ๆ ไม่ใช่ภาพแทน การไปแก้ให้ /api/tiles คืน vector แทนจะเปลี่ยน
  พื้นหลังของตัวเลือกพิกัดในหน้า Cameras ไปด้วย ทั้งที่นั่นไม่ได้ขออะไรเลย
*/
/*
  เลือกไฟล์ไทล์ vector ที่ใหม่ที่สุดที่มีอยู่

  ไฟล์ชุดแรกของระบบเป็นข้อมูล OSM วันที่ 2020-02-10 ซึ่งเก่าพอที่ถนนและอาคารที่สร้างหลังจากนั้น
  จะไม่มีอยู่บนแผนที่เลย ไฟล์ที่สร้างใหม่ด้วย Planetiler ถูกตั้งชื่อ `thailand-YYYYMMDD.mbtiles`
  และถูกหยิบมาใช้อัตโนมัติเพราะเรียงชื่อแล้วมาทีหลัง

  เลือกจากชื่อไฟล์ ไม่ใช่จาก mtime เพราะการคัดลอกไฟล์ข้ามเครื่องรีเซ็ต mtime ได้ แต่ชื่อที่มี
  วันที่ของข้อมูลอยู่ข้างในติดไปกับไฟล์เสมอ

  ของเดิมไม่ถูกลบ — ถ้าไฟล์ใหม่มีปัญหา ลบไฟล์ใหม่ออกแล้วรีสตาร์ตก็กลับไปใช้ของเดิมได้ทันที
*/
const MAP_DATA_DIR = path.join(__dirname, 'map_data');
const LEGACY_VECTOR_TILES = 'osm-2020-02-10-v3.11_asia_thailand.mbtiles';

function resolveVectorTilesPath() {
  let candidates = [];
  try {
    candidates = fs.readdirSync(MAP_DATA_DIR).filter((f) => /^thailand-\d{8}\.mbtiles$/.test(f));
  } catch {
    // อ่านโฟลเดอร์ไม่ได้ก็ตกไปใช้ไฟล์เดิม ซึ่งจัดการด้านล่าง
  }

  candidates.sort();
  const newest = candidates.length > 0 ? candidates[candidates.length - 1] : LEGACY_VECTOR_TILES;
  return path.join(MAP_DATA_DIR, newest);
}

let openMapTilesDb = null;
const getOpenMapTilesDb = () => {
  if (!openMapTilesDb) {
    const chosen = resolveVectorTilesPath();
    if (!fs.existsSync(chosen)) return null;
    openMapTilesDb = new sqlite3.Database(chosen, sqlite3.OPEN_READONLY);
    console.log(`[MAP] Opened vector tiles at: ${chosen}`);
  }
  return openMapTilesDb;
};

app.get('/api/vector-tiles/:z/:x/:y.pbf', (req, res) => {
  const dbInstance = getOpenMapTilesDb();
  if (!dbInstance) return res.status(404).json({ error: 'ไม่มีไฟล์ไทล์ vector บนเครื่องนี้' });

  const { z, x, y } = req.params;
  dbInstance.get(
    'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
    // mbtiles เก็บแถวแบบ TMS (นับจากล่างขึ้นบน) ส่วนที่ client ขอมาเป็น XYZ — ต้องพลิกเสมอ
    [z, x, Math.pow(2, z) - 1 - y],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(204).end();
      res.set('Content-Type', 'application/x-protobuf');
      res.set('Content-Encoding', 'gzip');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(row.tile_data);
    },
  );
});

app.get('/api/tiles/:z/:x/:y.pbf', (req, res) => {
  const { z, x, y } = req.params;
  const dbInstance = getMapDb();
  dbInstance.get("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?", [z, x, Math.pow(2, z) - 1 - y], (err, row) => {
    if (row) {
      if (row.tile_data[0] === 0x89) res.set('Content-Type', 'image/png');
      else if (row.tile_data[0] === 0xff) res.set('Content-Type', 'image/jpeg');
      else { res.set('Content-Type', 'application/x-protobuf'); res.set('Content-Encoding', 'gzip'); }
      res.send(row.tile_data);
    } else res.status(404).send();
  });
});

/*
  ไทล์ออนไลน์ของ OpenStreetMap ผ่านเซิร์ฟเวอร์เรา แทนที่จะให้เบราว์เซอร์ไปดึงเอง

  ดึงตรงจากเบราว์เซอร์ไม่ได้เพราะ tile.openstreetmap.org ไม่ส่ง `Access-Control-Allow-Origin`
  กลับมาในเส้นทางนี้ MapLibre ซึ่งขอไทล์แบบ cross-origin จึงทิ้งภาพนั้นและได้แผนที่ว่างเปล่า
  โดยไม่มี error ให้เห็นในหน้าเว็บเลย

  ผ่านเราแล้วได้อย่างอื่นติดมาด้วย: กลายเป็น same-origin จึงไม่ต้องยุ่งกับ CORS อีก, ส่ง
  User-Agent ที่ระบุตัวตนได้ตามที่นโยบายของ OSM กำหนด, และแคชลงดิสก์เพื่อไม่ให้ยิงซ้ำไปที่
  เซิร์ฟเวอร์อาสาสมัครของเขาทุกครั้งที่มีคนเลื่อนแผนที่
*/
const OSM_CACHE_DIR = path.join(__dirname, 'map_data', 'osm-cache');
const OSM_UA = 'Surveillance-Gateway/1.0 (LAN CCTV dashboard; contact via system administrator)';

app.get('/api/osm/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  // ตรวจขอบเขตก่อนเสมอ — ค่าที่หลุดกรอบจะกลายเป็น path แปลก ๆ ตอนเขียนแคช
  const max = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 19 || !Number.isInteger(x) || !Number.isInteger(y)
      || x < 0 || y < 0 || x >= max || y >= max) {
    return res.status(400).send();
  }

  const file = path.join(OSM_CACHE_DIR, String(z), String(x), `${y}.png`);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=604800');

  if (fs.existsSync(file)) return res.sendFile(file);

  try {
    const upstream = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': OSM_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(upstream.status).send();
    const buf = Buffer.from(await upstream.arrayBuffer());
    // เขียนแคชแบบไม่ให้ล้มคำขอถ้าดิสก์มีปัญหา — ภาพส่งให้ผู้ใช้ได้อยู่ดี
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    } catch (e) {
      console.warn('[MAP] เขียนแคชไทล์ OSM ไม่ได้:', e.message);
    }
    res.send(buf);
  } catch (e) {
    console.warn(`[MAP] ดึงไทล์ OSM ${z}/${x}/${y} ไม่สำเร็จ:`, e.message);
    res.status(502).send();
  }
});

/*
  ภาพดาวเทียม (Esri World Imagery) + ชั้นถนน/ชื่อสถานที่ของ Esri ทับด้านบน — ผ่านเราด้วยเหตุผล
  เดียวกับ /api/osm: same-origin, แคชลงดิสก์, ไม่ยิงซ้ำทุกครั้งที่เลื่อนแผนที่

  ข้อควรรู้เรื่องสิทธิ์: Esri ให้ใช้ World Imagery แบบนี้ได้โดยไม่ต้องมีคีย์พร้อมแสดง attribution
  แต่การใช้เชิงพาณิชย์ต้องมีบัญชี ArcGIS — ถ้าวันหนึ่งระบบนี้ถูกขายเป็นบริการ ต้องทบทวนตรงนี้
*/
const SAT_LAYERS = {
  imagery: { path: 'World_Imagery', ext: 'jpg', type: 'image/jpeg' },
  roads: { path: 'Reference/World_Transportation', ext: 'png', type: 'image/png' },
  labels: { path: 'Reference/World_Boundaries_and_Places', ext: 'png', type: 'image/png' },
};
const SAT_CACHE_DIR = path.join(__dirname, 'map_data', 'sat-cache');

app.get('/api/sat/:layer/:z/:x/:y', async (req, res) => {
  const layer = SAT_LAYERS[req.params.layer];
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  const max = 2 ** z;
  if (!layer || !Number.isInteger(z) || z < 0 || z > 19 || !Number.isInteger(x) || !Number.isInteger(y)
      || x < 0 || y < 0 || x >= max || y >= max) {
    return res.status(400).send();
  }

  const file = path.join(SAT_CACHE_DIR, req.params.layer, String(z), String(x), `${y}.${layer.ext}`);
  res.set('Content-Type', layer.type);
  res.set('Cache-Control', 'public, max-age=604800');
  if (fs.existsSync(file)) return res.sendFile(file);

  try {
    // Esri เรียงเป็น z/y/x ไม่ใช่ z/x/y
    const upstream = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/${layer.path}/MapServer/tile/${z}/${y}/${x}`, {
      headers: { 'User-Agent': OSM_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return res.status(upstream.status).send();
    const buf = Buffer.from(await upstream.arrayBuffer());
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    } catch (e) {
      console.warn('[MAP] เขียนแคชไทล์ดาวเทียมไม่ได้:', e.message);
    }
    res.send(buf);
  } catch (e) {
    console.warn(`[MAP] ดึงไทล์ดาวเทียม ${req.params.layer} ${z}/${x}/${y} ไม่สำเร็จ:`, e.message);
    res.status(502).send();
  }
});

app.get('/api/map-style.json', (req, res) => {
  const h = req.hostname, il = req.query.theme === 'light';
  db.get("SELECT setting_value FROM settings WHERE setting_key = 'MAP_TYPE'", (err, row) => {
    // ?base= คือปุ่มสลับบนแผนที่ (จำต่อเครื่องใน localStorage) มาก่อนค่าที่ตั้งไว้ของระบบ
    // ค่าเริ่มต้นเป็นดาวเทียมตั้งแต่ 2026-09-23 — ปักหมุดกล้องต้องเห็นหลังคาและทางแยกจริง
    const requested = ['satellite', 'openstreetmap'].includes(req.query.base) ? req.query.base : null;
    const mapType = requested || row?.setting_value || 'satellite';
    if (mapType === 'satellite') {
      const src = (layer) => ({
        type: 'raster',
        tiles: [`${req.protocol}://${req.get('host')}/api/sat/${layer}/{z}/{x}/{y}`],
        tileSize: 256,
        maxzoom: 19,
        ...(layer === 'imagery' ? { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' } : {}),

      });
      return res.json({
        version: 8,
        sources: { 'sat-imagery': src('imagery'), 'sat-roads': src('roads'), 'sat-labels': src('labels') },
        layers: [
          { id: 'sat-background', type: 'background', paint: { 'background-color': '#0b0c0e' } },
          { id: 'sat-imagery', type: 'raster', source: 'sat-imagery', maxzoom: 22 },
          // ถนนจางลงนิดให้ภาพดาวเทียมยังเป็นพระเอก ชื่อสถานที่เต็มความเข้มเพื่อให้อ่านออก
          { id: 'sat-roads', type: 'raster', source: 'sat-roads', maxzoom: 22, paint: { 'raster-opacity': 0.75 } },
          { id: 'sat-labels', type: 'raster', source: 'sat-labels', maxzoom: 22 },
        ],
      });
    }
    if (mapType === 'openstreetmap') {
      /*
        ไทล์มาจาก OpenStreetMap ผ่าน /api/osm ของเราเอง ไม่ใช่ CartoDB อีกแล้ว (2026-08-29)

        CartoDB ยังตอบ 200 อยู่ก็จริง แต่เปลี่ยนไปบังคับใช้ API key แล้ว และวิธีบังคับของเขาคือ
        **พิมพ์ "API KEY REQUIRED" ลงไปในตัวรูปไทล์เลย** ฝั่งเราจึงไม่มีทางรู้จาก HTTP status
        ว่าภาพใช้ไม่ได้ — เห็นก็ต่อเมื่อมองด้วยตา ส่วน tile.openstreetmap.org เป็นของโครงการ
        OpenStreetMap เอง เปิดให้ใช้โดยไม่ต้องมีคีย์ ตรงกับชื่อตัวเลือกนี้อยู่แล้ว

        ข้อแลกเปลี่ยน: OSM มีสไตล์เดียว ไม่มีชุดสีมืดให้เหมือน CartoDB — ธีมมืดจึงสังเคราะห์เอา
        จากไทล์เดิมด้วย paint ของ MapLibre แทนการไปพึ่งผู้ให้บริการรายอื่นที่ต้องใช้คีย์อีก

        โควตาการใช้งานของ OSM ห้ามดึงแบบ bulk แต่แดชบอร์ดที่มีคนดูไม่กี่คนในวงแลนอยู่ในเกณฑ์
        ปกติ · ถ้าวันหนึ่งต้องรับผู้ใช้เยอะกว่านี้ ให้สลับไปโหมด mbtiles ที่มีไทล์ไทยอยู่บนดิสก์แล้ว
      */
      res.json({
        "version": 8,
        "sources": {
          "osm-raster": {
            "type": "raster",
            "tiles": [`http://${h}:${HTTP_PORT}/api/osm/{z}/{x}/{y}.png`],
            "tileSize": 256,
            "maxzoom": 19,
            "attribution": "© OpenStreetMap contributors"
          }
        },
        "layers": [
          {
            "id": "osm-background",
            "type": "background",
            "paint": { "background-color": il ? "#fdfdfc" : "#181715" }
          },
          {
            "id": "osm-layer",
            "type": "raster",
            "source": "osm-raster",
            "minzoom": 0,
            "maxzoom": 22,
            // ธีมมืด: กลับค่าความสว่างแล้วลดความอิ่มสี ได้แผนที่โทนเข้มที่ยังอ่านชื่อถนนออก
            // โดยไม่ต้องมีชุดไทล์ที่สอง (min > max คือการกลับค่าตามสเปกของ MapLibre)
            "paint": il ? {} : {
              "raster-brightness-min": 0.85,
              "raster-brightness-max": 0.12,
              "raster-saturation": -0.55,
              "raster-contrast": 0.1
            }
          }
        ]
      });
    } else if (mapType === 'image') {
      db.get("SELECT setting_value FROM settings WHERE setting_key = 'MAP_IMAGE_PATH'", (err2, imgRow) => {
        const imgPath = imgRow?.setting_value || '/uploads/maps/custom_map.png';
        const lat = 13.7563, lng = 100.5018;
        const offset = 0.05;
        res.json({
          "version": 8,
          "sources": {
            "image-source": {
              "type": "image",
              "url": `http://${h}:${HTTP_PORT}${imgPath}`,
              "coordinates": [
                [lng - offset, lat + offset],
                [lng + offset, lat + offset],
                [lng + offset, lat - offset],
                [lng - offset, lat - offset]
              ]
            }
          },
          "layers": [
            {
              "id": "background-dim",
              "type": "background",
              "paint": { "background-color": il ? "#fdfdfc" : "#181715" }
            },
            {
              "id": "image-layer",
              "type": "raster",
              "source": "image-source",
              "paint": { "raster-opacity": 0.9 }
            }
          ]
        });
      });
    } else {
      const dbInstance = getMapDb();
      // อ่านช่วง zoom จาก metadata ของไฟล์ ไม่ใช่เดาเอา — ไฟล์ไทล์แต่ละใบครอบคนละช่วง
      // (thailand2026vms คือ png z9-17, osm-...asia_thailand คือ pbf z0-14) ถ้าประกาศช่วงกว้าง
      // กว่าที่มีจริง MapLibre จะไล่ขอไทล์ที่ไม่มีแล้วได้ 404 กลายเป็นแผนที่ว่างตอนซูมออกหรือ
      // ซูมลึก แทนที่จะขยายไทล์ที่ระดับลึกสุดขึ้นมาใช้ต่อ
      dbInstance.all(
        "SELECT name, value FROM metadata WHERE name IN ('format','minzoom','maxzoom')",
        (errMetadata, metaRows) => {
        const meta = Object.fromEntries((metaRows || []).map((r) => [r.name, r.value]));
        const isVector = meta.format === 'pbf';
        const zoomOf = (key, fallback) => {
          const n = parseInt(meta[key], 10);
          return Number.isFinite(n) ? n : fallback;
        };
        if (isVector) {
          res.json({
            "version": 8,
            "sources": {
              "openmaptiles": {
                "type": "vector",
                "tiles": [`http://${h}:${HTTP_PORT}/api/tiles/{z}/{x}/{y}.pbf`],
                "minzoom": zoomOf('minzoom', 0),
                "maxzoom": zoomOf('maxzoom', 14)
              }
            },
            "layers": [
              {
                "id": "background",
                "type": "background",
                "paint": { "background-color": il ? "#fdfdfc" : "#181715" }
              },
              {
                "id": "landuse",
                "type": "fill",
                "source": "openmaptiles",
                "source-layer": "landuse",
                "paint": { "fill-color": il ? "#e3ebd5" : "#1b2413" }
              },
              {
                "id": "water",
                "type": "fill",
                "source": "openmaptiles",
                "source-layer": "water",
                "paint": { "fill-color": il ? "#cbdcf8" : "#1b2a47" }
              },
              {
                "id": "waterway",
                "type": "line",
                "source": "openmaptiles",
                "source-layer": "waterway",
                "paint": { "line-color": il ? "#cbdcf8" : "#1b2a47", "line-width": 1 }
              },
              {
                "id": "roads_casing",
                "type": "line",
                "source": "openmaptiles",
                "source-layer": "transportation",
                "paint": {
                  "line-color": il ? "#ffffff" : "#242424",
                  "line-width": {
                    "base": 1.2,
                    "stops": [[10, 1], [13, 2], [15, 4], [20, 15]]
                  }
                }
              },
              {
                "id": "roads",
                "type": "line",
                "source": "openmaptiles",
                "source-layer": "transportation",
                "paint": {
                  "line-color": il ? "#fcfbfa" : "#3a3a3a",
                  "line-width": {
                    "base": 1.2,
                    "stops": [[10, 0.5], [13, 1], [15, 2.5], [20, 10]]
                  }
                }
              },
              {
                "id": "buildings",
                "type": "fill",
                "source": "openmaptiles",
                "source-layer": "building",
                "paint": { "fill-color": il ? "#e8e3d3" : "#2d2d2a", "fill-opacity": 0.6 }
              },
              {
                "id": "places-label",
                "type": "symbol",
                "source": "openmaptiles",
                "source-layer": "place",
                "layout": {
                  "text-field": "{name}",
                  "text-size": 10,
                  "text-max-width": 8
                },
                "paint": {
                  "text-color": il ? "#4a4a45" : "#a8a89f",
                  "text-halo-color": il ? "#ffffff" : "#181715",
                  "text-halo-width": 1
                }
              }
            ]
          });
        } else {
          res.json({
            "version": 8,
            "sources": {
              "google-raster": {
                "type": "raster",
                "tiles": [`http://${h}:${HTTP_PORT}/api/tiles/{z}/{x}/{y}.pbf`],
                "tileSize": 256,
                // ช่วงบน source คือสิ่งที่บอก MapLibre ว่ามีไทล์จริงถึงไหน — เกินจากนี้มันจะ
                // ขยายไทล์ของ maxzoom ขึ้นมาใช้แทนการขอไฟล์ที่ไม่มี
                "minzoom": zoomOf('minzoom', 0),
                "maxzoom": zoomOf('maxzoom', 17)
              }
            },
            "layers": [
              {
                "id": "background",
                "type": "background",
                "paint": { "background-color": il ? "#fdfdfc" : "#181715" }
              },
              {
                // layer ยังกว้าง 0-22 ได้ เพราะ source เป็นตัวคุมว่าไทล์ไหนถูกขอจริง
                "id": "google-layer",
                "type": "raster",
                "source": "google-raster",
                "minzoom": 0,
                "maxzoom": 22
              }
            ]
          });
        }
      });
    }
  });
});

const mapImageUpload = multer({ 
  storage: multer.diskStorage({ 
    destination: (q, f, c) => {
      const dir = path.join(__dirname, '../public/uploads/maps');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      c(null, dir);
    }, 
    filename: (q, f, c) => c(null, 'custom_map' + path.extname(f.originalname)) 
  }) 
});

const mbtilesUpload = multer({ 
  storage: multer.diskStorage({ 
    destination: (q, f, c) => {
      const dir = path.join(__dirname, 'map_data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      c(null, dir);
    }, 
    filename: (q, f, c) => c(null, 'uploaded_map.mbtiles') 
  }) 
});

// หมายเหตุ: route อัปโหลดแผนที่ทั้งสองตัวย้ายลงไปอยู่ใต้ `app.use('/api', checkAuth)` แล้ว
// (เดิมอยู่ตรงนี้ ซึ่งอยู่เหนือ checkAuth — Express ใช้ middleware กับ route ที่ประกาศ "หลัง" มัน
// เท่านั้น ทั้งสองตัวจึงเปิดให้ใครก็ได้ที่ต่อถึงพอร์ตนี้เขียนทับไฟล์แผนที่และแก้ค่า settings ได้
// โดยไม่ต้อง login) ตัว multer instance ยังต้องประกาศไว้ตรงนี้เพราะถูกอ้างถึงตอนลงทะเบียน route

// --- INTERNAL (localhost only) ---
app.get('/api/internal/cameras/:id/main-snapshot', async (req, res) => {
  if (!isLocalInternalRequest(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const camera = await getCameraRow(req.params.id);
    const { buffer, source } = await captureMainSnapshotBuffer(camera);
    console.log(`[Main Snap] ${camera.id} (${camera.ip}) via ${source}, ${buffer.length} bytes`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Snap-Source', source);
    res.type('image/jpeg').send(buffer);
  } catch (e) {
    if (e.message === 'Camera not found') return res.status(404).json({ error: e.message });
    console.error('[Main Snap] error:', redactUrls(e.message));
    res.status(502).json({ error: e.message || 'Cannot capture main snapshot' });
  }
});

/** Localhost-only: AI daemons ask MTX rebuild when publishers die. */
app.post('/api/internal/resync-streams', (req, res) => {
  if (!isLocalInternalRequest(req)) return res.status(403).json({ error: 'Forbidden' });
  lastStreamCoreResyncAt = 0;
  const who = String(req.headers['x-internal-resync'] || 'daemon');
  const ok = forceStreamCoreResync(`daemon:${who}`);
  res.json({ success: true, triggered: ok });
});

// --- API GATEWAY v1 ---
// สัญญาสาธารณะสำหรับระบบภายนอก (Edge AI ที่รันคนละเครื่อง) แยกจาก /api/* เดิมซึ่ง
// เป็นของหน้าเว็บตัวเองและเปลี่ยนได้ตามใจเพราะ deploy พร้อมกัน ส่วน /api/v1/* มี
// ผู้ใช้ที่เรา deploy ให้ไม่ได้ จึงต้องมีเวอร์ชันและต้องนิ่ง
//
// ต้องอยู่ "เหนือ" app.use('/api', checkAuth) ด้วยเหตุผลเดียวกับ /api/internal/*:
// มันมีวิธียืนยันตัวตนของตัวเอง (Authorization: Bearer <api-key>) ถ้าปล่อยให้อยู่
// ใต้ checkAuth ทุก request จะถูกบังคับให้ส่ง username/password ของ "คน" มาด้วย
// ซึ่งเป็นสิ่งที่ API key ถูกสร้างขึ้นมาเพื่อเลิกใช้พอดี
//
// ส่วนหน้าจัดการ key เป็นของคน จึงเรียก checkAuth + requirePerm เองภายในโมดูล
const { createGatewayRouter } = require('./gateway');
const { createGatewayAdminRouter } = require('./gateway/admin');
const { createVmsRouter, DIGIFORT_TYPE } = require('./vms/routes');
const { createDssSessions, DSS_TYPE } = require('./vms/dss-sessions');
const { startDssRelay } = require('./vms/dss-rtsp-relay');
const { createDssRoutes } = require('./vms/dss-routes');
const { createDssPtz } = require('./vms/dss-ptz');
const { readUniviewChannels, mergeUniviewChannels } = require('./vms/uniview');
const { readAxisS30Devices, axisS30Rtsp, axisS30SubRtsp } = require('./vms/axis-s30');
const { syncCamerasToGo2rtc } = require('./gateway/go2rtc-sync');
const { dispatchPtz, PtzError } = require('./gateway/ptz');
const { createAnalyticsPoller } = require('./gateway/analytics/poller');
const { createDiscovery } = require('./gateway/analytics/discovery');
const { createMetadataCollector } = require('./gateway/analytics/metadata-collector');

/*
  global ID + จังหวัด/อำเภอ ของกล้อง (docs/EDGE-PLAN.md เฟส 1) — ต้องพร้อมก่อน Gateway router
  เพราะ /api/v1/cameras อ่านคอลัมน์เหล่านี้ ออก ID ให้กล้องเดิมที่ยังไม่มีครั้งเดียวตอน start
*/
const { createIdentity } = require('./gateway/identity');
const regions = require('./shared/regions');
const identity = createIdentity(db);
identity.ensureSchema()
  .then(() => identity.assignMissing())
  .catch((err) => console.error(`[Identity] เตรียม global ID ไม่สำเร็จ: ${err.message}`));

/*
  กล้องที่ดึงมาจาก edge (docs/EDGE-PLAN.md เฟส 2) — ใช้ร่วมกันสามที่: หน้า import (/api/vms),
  สถานะ edge ใน /api/v1/cameras และการส่ง PTZ ต่อไปที่ edge
*/
const { createEdgeSources, EDGE_TYPE } = require('./vms/edge-source');
/*
  สถานะกล้องสามค่า (enabled / reachable / streaming) — ที่เก็บเดียวของทั้งเครื่อง
  updateCameraStatuses เขียนของกล้องที่เครื่องนี้ต่อเอง, edgeSources เขียน reachable ของกล้องจาก edge
  ส่วน SSE /api/v1/events และ link ขึ้น central สมัครฟังจากที่นี่
*/
const { createCameraState, publicState: publicCameraState } = require('./shared/camera-state');
const cameraState = createCameraState();
let edgeLink = null;
/*
  event ของ AI (shared/ai-events.js) — edge: เกิดที่นี่ · central: สำเนาจาก edge · ตารางเดียวกันทั้งสองบทบาท
*/
const { createAiEvents } = require('./shared/ai-events');
const aiEvents = createAiEvents(db);
const aiEventsReady = aiEvents.start();
aiEventsReady.catch((err) => console.error('[AI events] ' + redactUrls(err.message)));
// รับผล AI ของต้นทางเฉพาะ Edge — ไม่เริ่มโมเดลหรือประมวลผลภาพ
const aiSources = require('./gateway/ai-sources').createAiSources(db, aiEvents);
const aiSourcesReady = aiEventsReady.then(() => aiSources.start());
aiSourcesReady.catch((err) => console.error('[AI sources] ' + redactUrls(err.message)));

// Regional จดการลบ relay ที่ยืนยันจาก Edge เพื่อส่งต่อขึ้น Central ด้วย ID ของ Regional
const cameraDeletions = require('./shared/camera-deletions').createCameraDeletions(db);
const edgeSources = createEdgeSources({
  aiEvents: acceptsChildEdges ? aiEvents : null,
  db,
  cameraState,
  saveLog: (username, action, details) => saveLog(username, action, details),
  resyncStreamCore: () => setTimeout(() => syncCamerasToStreamCore('edge'), 2000),
  onBeforeCamerasRemoved: GATEWAY_ROLE === 'regional'
    ? (ids) => cameraDeletions.record(ids, 'Edge relay', { includeRelay: true }) : null,
  // กล้องที่ลบตาม edge — ล้างของในหน่วยความจำแบบเดียวกับ DELETE /api/cameras
  onCamerasRemoved: (ids) => {
    invalidateRoleCache();
    for (const id of ids) {
      delete camLastStatus[id];
      delete streamHealthState[id];
    }
    edgeLink?.catalogSoon?.();
  },
  onCatalogChanged: async (presentIds) => {
    if (GATEWAY_ROLE === 'regional') await cameraDeletions.forget(presentIds);
    invalidateRoleCache();
    edgeLink?.catalogSoon?.();
  },
});
edgeSources.ensureSchema()
  .then(() => edgeSources.startMonitor())
  .catch((err) => console.error(`[Edge] เตรียมตารางไม่สำเร็จ: ${err.message}`));
/** กล้องที่ไม่มีหัวกล้องให้ถามตรง ๆ — มาผ่าน VMS, ผ่าน edge หรือเป็นกล้อง public ทาง ONVIF/AI/สแกนต้องข้าม */
const isRelayCamera = (type) => type === DIGIFORT_TYPE || type === EDGE_TYPE || type === DSS_TYPE || type === PUBLIC_TYPE;

/*
  กล้องสาธารณะ (docs/PUBLIC-CAMS.md) — Central เท่านั้น: ดึงรายชื่อ/สถานะจาก API ของหน่วยงานทุก 5 นาที
  Regional/Edge สร้างตัวไว้ให้ originOf ทำงาน (ไม่มีแถว public ก็คืน null) แต่ไม่เริ่มดึง
*/
const publicCams = createPublicCams({
  db,
  cameraState,
  resyncStreamCore: () => setTimeout(() => syncCamerasToStreamCore('public-cams'), 1000),
  onCatalogChanged: () => {
    invalidateRoleCache();
    identity.assignMissing().catch(() => {});
  },
});
if (GATEWAY_ROLE === 'central') publicCams.start();

/*
  กล้องจาก Dahua DSS (vms/dss*.js) — แอดที่ edge เหมือน Digifort
  session ของ DSS ต่อแหล่ง + ถามสถานะกล้องทุก 60 วิ · ภาพสดผ่านตัวกลาง RTSP ที่ 127.0.0.1:DSS_RELAY_PORT
  (URL ของ DSS ใช้ได้ครั้งเดียว ตัวกลางขอใหม่ทุกครั้งที่ go2rtc ต่อ)
*/
const dssSessions = createDssSessions({ db, cameraState });
const dssPtz = createDssPtz({ sessions: dssSessions });
if (GATEWAY_ROLE === 'edge') {
  dssSessions.start();
  startDssRelay({
    port: DSS_RELAY_PORT,
    resolve: async (cameraId, stream) => {
      const t = await dssSessions.forCamera(cameraId);
      if (!t) throw new Error(`ไม่พบกล้อง DSS ${cameraId}`);
      return t.client.liveUrls(t.channelId, stream);
    },
  });
}

/* ดูย้อนหลัง — central ส่งต่อไปที่ edge; AXIS S30 และ Uniview NVR อ่านบันทึกจาก recorder โดยตรง */
const FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\\\ffmpeg\\\\bin\\\\ffmpeg.exe' : 'ffmpeg');
const { createPlayback } = require('./gateway/playback');
const { createDevicePlayback } = require('./vms/device-playback');
const playback = createPlayback({
  localSource: GATEWAY_ROLE === 'edge' ? createDevicePlayback({ db, ffmpegPath: FFMPEG_PATH, dssSessions }) : null,
  edgeClientFor: (row) => edgeSources.clientForCamera(row),
});
const regionalPlaybackSource = GATEWAY_ROLE === 'regional'
  ? require('./vms/relay-playback').createRelayPlayback({ playback, getCameraRow })
  : null;

// แจ้งเตือนเมื่อ edge หลุด (central) — log, SSE edge_state, แถบเตือนบนหน้าเว็บ (vms/edge-alerts.js)
const edgeAlerts = acceptsChildEdges
  ? require('./vms/edge-alerts').createEdgeAlerts({ listEdges: () => edgeSources.listEdges(), saveLog })
  : null;
edgeAlerts?.start();

const gateway = createGatewayRouter({
  dssPtz,
  db,
  getCameraRow,
  captureMainSnapshotBuffer,
  initOnvifDevice: initOnvifDeviceWithFallback,
  saveLog,
  originOf: (row) => publicCams.originOf(row) || edgeSources.originOf(row),
  edgeClientFor: (row) => edgeSources.clientForCamera(row),
  cameraState,
  listEdges: () => edgeSources.listEdges(),
  listDeletedCameras: () => cameraDeletions.list(),
  playback,
  aiEvents,
  edgeAlerts,
});
app.use('/api/v1', gateway.router);

/*
  ภาพย้อนหลังในหน้าเว็บ — <video> ส่ง header ไม่ได้ จึงใช้ stream token แบบเดียวกับ /stream/*.mp4
  (ต้องอยู่เหนือ app.use('/api', checkAuth)) · token ผูกชื่อ `rec:<id กล้อง>` ออกที่ GET /api/playback/:id/token
  เบราว์เซอร์ถอด H.265 ไม่ได้ จึงแปลงเป็น H.264 เสมอ
*/
const playbackTokenName = (id) => `rec:${id}`;
const playbackRow = (id) => getCameraRow(id).catch(() => null);
app.get('/playback/:id.mp4', requireStreamToken((req) => playbackTokenName(req.params.id)), async (req, res) => {
  try {
    const camera = await playbackRow(req.params.id);
    if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    await playback.pipeVideo(camera, {
      start: req.query.start, duration: req.query.duration,
      video: req.query.video === 'raw' ? undefined : 'h264',
    }, res);
  } catch (err) {
    playback.sendError(res, err);
  }
});
app.get('/playback/:id/frame.jpg', requireStreamToken((req) => playbackTokenName(req.params.id)), async (req, res) => {
  try {
    const camera = await playbackRow(req.params.id);
    if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    await playback.sendFrame(camera, req.query.at, res);
  } catch (err) {
    playback.sendError(res, err);
  }
});

/*
  อัปเดต edge ผ่านสาย link (docs/EDGE-KIT.md) — central: edge โหลดแพ็กเกจที่นี่ ยืนยันตัวด้วย token ของสาย
  (edge ไม่มีบัญชีผู้ใช้ จึงต้องอยู่เหนือ app.use('/api', checkAuth)) · edge: ตัวรับข้อเสนอ/โหลด/สั่งติดตั้ง
*/
const edgeUpdates = require('./vms/edge-updates');
if (acceptsChildEdges) {
  app.get('/api/edge-link/update-catalog', async (req, res) => {
    const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const source = match ? await edgeSources.findLinkSource(match[1]) : null;
    if (!source || source.remote_role !== 'regional' || GATEWAY_ROLE !== 'central') {
      return res.status(403).json({ error: 'Regional token required' });
    }
    return res.json({ manifests: edgeUpdates.catalog() });
  });
  app.get('/api/edge-link/update/:platform/:file', edgeUpdates.downloadHandler(edgeSources));
}
// ภาพย้อนหลังที่ edge แบบ link อัปโหลดขึ้นมาให้ผู้ชมที่รออยู่ (vms/link-playback.js) — token ของสาย ไม่ใช่บัญชีผู้ใช้
if (acceptsChildEdges) app.post('/api/edge-link/playback/:session', edgeSources.linkPlaybackUpload);
// ชุดติดตั้ง edge ให้ดาวน์โหลดจากหน้า Edge Nodes — ลิงก์ตรงด้วยตั๋วใช้ครั้งเดียว (vms/edge-kits.js) ออกตั๋วใต้ checkAuth
const edgeKits = require('./vms/edge-kits');
if (GATEWAY_ROLE === 'central') {
  const regionalSource = async (req) => {
    const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const source = match ? await edgeSources.findLinkSource(match[1]) : null;
    return source?.remote_role === 'regional' ? source : null;
  };
  app.get('/api/edge-link/kit-catalog', async (req, res) => {
    if (!await regionalSource(req)) return res.status(403).json({ error: 'Regional token required' });
    return res.json({ kits: edgeKits.list() });
  });
  app.get('/api/edge-link/kit/:file', async (req, res) => {
    if (!await regionalSource(req)) return res.status(403).json({ error: 'Regional token required' });
    const kit = edgeKits.list().find((k) => k.file === req.params.file);
    if (!kit) return res.status(404).json({ error: 'ไม่มีชุดติดตั้งนี้' });
    return res.sendFile(path.join(edgeKits.DIR, kit.file));
  });
}
if (acceptsChildEdges) app.get('/edge-kit-download/:ticket', edgeKits.downloadHandler);
const edgeUpdater = linksToParent ? require('./vms/edge-update-client').createEdgeUpdater() : null;
const regionalUpdateMirror = GATEWAY_ROLE === 'regional' ? require('./vms/regional-update-mirror').createRegionalUpdateMirror() : null;

/*
  ดึง metadata ของ AI จากหัวกล้องมาเก็บไว้ที่ Gateway

  นี่คือครึ่งที่สองของหน้าที่ "รวมศูนย์" ตาม V.3 — go2rtc รวม *ภาพ* จากทุกยี่ห้อให้เป็น
  H.264 เหมือนกันหมด ส่วนตัวนี้รวม *ข้อมูล* ที่กล้องแต่ละยี่ห้อคำนวณไว้ในตัวเอง (เช่น
  Tiandy นับคนเข้า-ออกที่หัวกล้อง) ให้ลงตารางกลางในรูปแบบเดียวกัน
*/
const { AI_ENABLED } = require('./shared/instance');
// รับ AI event จากต้นทางผ่าน AI Sources และส่งต่อขึ้น Regional/Central
const analyticsPoller = createAnalyticsPoller(db);
// ปิด AI ไว้ก่อน (shared/instance.js) — ไม่เริ่ม poller ไม่เปิดสายไปกล้อง ตารางยังถูกสร้างตามปกติ
if (AI_ENABLED) analyticsPoller.start().catch((err) => console.error(`[Analytics] เริ่มไม่สำเร็จ: ${err.message}`));
else {
  // คอลัมน์ analytics_* ยังต้องมี (/api/v1/cameras อ่านเสมอ) — ฐานข้อมูลใหม่จะไม่มีถ้าไม่สร้างตรงนี้
  analyticsPoller.ensureSchema().catch((err) => console.error(`[Analytics] สร้างตารางไม่สำเร็จ: ${err.message}`));
  console.log('[AI] ปิดอยู่ (GATEWAY_AI ไม่ใช่ 1) — ไม่เก็บ metadata/ยอดนับจากกล้อง');
}

/*
  ตัวค้นหาว่ากล้องแต่ละตัวเปิด AI อะไรไว้

  แยกจาก poller เพราะทำคนละหน้าที่: poller ดึง "ข้อมูล" ที่ AI ผลิตออกมาเป็นระยะ
  ส่วนตัวนี้ตอบว่า "มี AI อะไรอยู่บ้าง" ซึ่งเป็นคำถามที่ต้องตอบได้ตั้งแต่วินาทีที่แอดกล้อง
  ก่อนจะมีข้อมูลสักแถวเดียวด้วยซ้ำ
*/
const aiDiscovery = createDiscovery(db);
aiDiscovery.ensureSchema().catch((err) => console.error(`[AI] สร้างตารางไม่สำเร็จ: ${err.message}`));

/*
  ตัวเก็บ ONVIF metadata — Gateway เป็นคนเฝ้าสายเอง ไม่ใช่ client

  กล้องอย่าง Uniview ไม่มีรายงานให้ถามย้อนหลัง ยอดออกมาเป็นเหตุการณ์บนสายที่ต้องเปิด
  ค้างไว้เท่านั้น ช่วงที่ไม่มีใครฟังคือช่วงที่หายถาวร — ถ้าปล่อยให้ client เฝ้า หน่วยงานที่
  ปิดแอปไปคืนหนึ่งจะเสียข้อมูลคืนนั้นตลอดกาล และหน่วยงานสองรายที่ดูกล้องตัวเดียวกันจะ
  เปิดสายซ้อนกันไปที่กล้องตัวเดียว

  Gateway จึงเปิดสายเดียวต่อกล้อง เก็บลงตารางกลาง แล้วทุก client ดึงตัวเลขเดียวกันผ่าน
  /api/v1/analytics/counts เหมือนกล้องยี่ห้ออื่นทุกประการ
*/
const metadataCollector = createMetadataCollector(db);
if (AI_ENABLED) {
  metadataCollector
    .start()
    .catch((err) => console.error(`[Metadata] เริ่มไม่สำเร็จ: ${err.message}`));
}

/**
 * สั่งตรวจกล้องหนึ่งตัวแบบไม่รอผล
 *
 * ใช้ตอนแอดหรือแก้กล้อง — การแอดกล้องต้องไม่ช้าลงหรือพังเพราะกล้องไม่ตอบ ONVIF และ
 * ผลจะไปโผล่เองในหน้า AI Cameras เมื่อตรวจเสร็จ
 */
const discoverCameraAi = (cameraId, reason = '') => {
  db.get('SELECT * FROM cameras WHERE id = ?', [cameraId], (err, row) => {
    if (err || !row) return;
    // กล้องจาก VMS ไม่มี IP และไม่มี ONVIF ให้ถาม การเรียกตรงนี้คือการยิงเปล่าครั้งละหนึ่งตัว
    // ซึ่งตอน import ทีละร้อยตัวจะกลายเป็น log ความล้มเหลวร้อยบรรทัดที่ไม่มีใครแก้ได้
    if (isRelayCamera(row.type) || !AI_ENABLED) return;
    aiDiscovery.discover(row)
      .then((r) => {
        console.log(`[AI] ${row.name}: พบกฎ ${r.rules} รายการ${r.countable ? ' (นับคนได้)' : ''}${reason ? ` — ${reason}` : ''}`);
        // กล้องที่เพิ่งพบว่านับคนได้ ต้องเริ่มเฝ้าทันที ไม่ใช่รอรอบทบทวนถัดไปอีกนาที
        metadataCollector.reconcile().catch(() => {});
      })
      .catch((e) => console.warn(`[AI] ${row.name}: ตรวจไม่สำเร็จ — ${redactUrls(e.message)}`));
  });
};
app.use(
  '/api/gateway/clients',
  createGatewayAdminRouter({
    db,
    checkAuth,
    requirePerm,
    invalidateCache: gateway.invalidateApiKeyCache,
    listActiveInstances: gateway.listActiveInstances,
    logAction: (req, action, details) => saveLog(req.user?.username, action, details),
  }),
);

/*
  โปรแกรมไหนกำลังรันอยู่ — หน้า login ต้องรู้ก่อนล็อกอินว่าจะแสดงเป็น Central หรือ Edge
  ไม่มีอะไรลับในนี้ จึงอยู่เหนือ checkAuth
*/
const APP_NAMES = { central: 'Surveillance Gateway Central', regional: 'Surveillance Gateway Regional', edge: 'Surveillance Gateway Edge' };
app.get('/api/instance', (req, res) => {
  res.json({ role: GATEWAY_ROLE, region: GATEWAY_REGION || null, node: NODE_NUMBER, name: APP_NAMES[GATEWAY_ROLE], ai: AI_ENABLED, build: require('./shared/instance').BUILD });
});

// --- PROTECTED ROUTES ---
app.use('/api', checkAuth);

/*
  ระบบตั้งแต่ 2026-09-23: edge แอดกล้อง, central แอด edge (docs/EDGE-PLAN.md)
  central ไม่มีทางถึงวงแลนกล้องและไม่ถือรหัสกล้อง การแอดกล้องตรงที่ central จึงถูกปิดที่ API
  ไม่ใช่แค่ซ่อนปุ่ม — client อื่นที่ยิง API ตรงต้องได้คำตอบเดียวกัน
*/
const edgeOnly = (req, res, next) => {
  if (GATEWAY_ROLE === 'edge') return next();
  res.status(403).json({ error: 'central ไม่แอดกล้องเอง — แอดกล้องที่ edge แล้วเพิ่ม edge ที่หน้า Edge Nodes' });
};
/*
  พิกัดกล้องเป็นของ edge (docs/EDGE-PLAN.md) — sync ทุก 10 นาทีเขียนทับอยู่แล้ว การปักที่ central
  จึงหายเองโดยไม่มีใครรู้ central แค่แสดงแผนที่ (หน้า Camera Map)
*/
const pinAtEdge = (req, res, next) => {
  if (GATEWAY_ROLE === 'edge') return next();
  res.status(403).json({ error: 'ปักหมุดกล้องที่ edge — central แสดงตำแหน่งอย่างเดียว' });
};
const centralOnly = (req, res, next) => {
  if (GATEWAY_ROLE === 'central') return next();
  res.status(403).json({ error: 'edge ไม่รับ edge ตัวอื่น — เพิ่ม edge ที่ central' });
};
const collectorOnly = (req, res, next) => {
  if (acceptsChildEdges) return next();
  res.status(403).json({ error: 'edge ไม่รับ edge ตัวอื่น' });
};
app.use('/api/edges', collectorOnly, edgeSources.createRouter({ requirePerm }));
// หน้า Public Cam Map — กล้อง public มีที่ Central เท่านั้น
app.use('/api/public-cams', (req, res, next) => (GATEWAY_ROLE === 'central'
  ? next() : res.status(403).json({ error: 'กล้อง Public มีที่ Central เท่านั้น' })), publicCams.createRouter({ requirePerm }));

/*
  ภาพย้อนหลังของหน้าเว็บ (ใต้ checkAuth) — กล้องต้องอยู่ในขอบเขตของ role · ตัวภาพวิ่งทาง /playback/* ด้วย token
*/
const playbackAccess = async (req, res) => {
  const camera = await playbackRow(req.params.id);
  if (!camera || (req.deviceIds instanceof Set && !req.deviceIds.has(camera.id))) {
    res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    return null;
  }
  return camera;
};
app.get('/api/playback/:id/ranges', requirePerm('playback.view'), async (req, res) => {
  try {
    const camera = await playbackAccess(req, res);
    if (!camera) return;
    res.json(await playback.ranges(camera, { from: req.query.from, to: req.query.to }));
  } catch (err) {
    playback.sendError(res, err);
  }
});
app.get('/api/playback/:id/token', requirePerm('playback.view'), async (req, res) => {
  const camera = await playbackAccess(req, res);
  if (!camera) return;
  const token = streamToken.sign({
    streamName: playbackTokenName(camera.id),
    clientId: `user:${req.user?.username || ''}`,
    ttlMs: streamToken.HLS_TTL_MS,
  });
  saveLog(req.user?.username, 'PLAYBACK', `เปิดภาพย้อนหลัง ${camera.name || camera.id}`);
  res.json({ token, video: `/playback/${encodeURIComponent(camera.id)}.mp4`, frame: `/playback/${encodeURIComponent(camera.id)}/frame.jpg` });
});

/** ตั้งแหล่งรับ event — จำกัดขอบเขตกล้องและไม่ส่ง credential กลับ */
app.get('/api/ai/sources', edgeOnly, requirePerm('menu.cameras'), async (req, res) => {
  try { await aiSourcesReady; res.json({ cameras: await aiSources.list(req.deviceIds instanceof Set ? req.deviceIds : null) }); }
  catch (err) { res.status(500).json({ error: redactUrls(err.message) }); }
});
app.put('/api/ai/sources/:id', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  try {
    await aiSourcesReady;
    const camera = await aiSources.save(req.params.id, req.body || {});
    saveLog(req.user?.username, 'AI_SOURCE', 'ตั้งแหล่งรับ AI ' + camera.name + ': ' + camera.driver + (camera.enabled ? ' เปิด' : ' ปิด'));
    res.json({ camera });
  } catch (err) { res.status(err.status || 500).json({ error: redactUrls(err.message) }); }
});

/** API ตั้ง inference เดิมยกเลิกแล้ว — ใช้ AI Sources รับผลจากต้นทาง */
app.get('/api/ai/config', edgeOnly, requirePerm('menu.cameras'), (req, res) => {
  res.status(410).json({ error: 'ตั้งแหล่งรับผล AI ที่ AI Sources' });
});
app.put('/api/ai/cameras/:id', edgeOnly, requirePerm('device.manage'), (req, res) => {
  res.status(410).json({ error: 'ตั้งแหล่งรับผล AI ที่ AI Sources' });
});

/** edge ที่หลุดเกิน 2 นาที — แถบเตือนบนหน้าเว็บ central (vms/edge-alerts.js) */
app.get('/api/edge-alerts', collectorOnly, async (req, res) => {
  try {
    res.json({ down: await edgeAlerts.current() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
  event ของ AI สำหรับหน้าเว็บ (ใต้ checkAuth) — ขอบเขตกล้องตาม role · ภาพประกอบ fetch แบบมี header แล้วแปลงเป็น blob
*/
app.get('/api/ai/events', requirePerm('menu.ai'), async (req, res) => {
  try {
    const { from, to, cameraId, type, label, origin, limit, edgeNode, group } = req.query;
    if ((edgeNode !== undefined && !/^\d{1,3}$/.test(String(edgeNode))) ||
        (group !== undefined && (typeof group !== 'string' || group.length > 200))) {
      return res.status(400).json({ error: 'ตัวกรอง Edge หรือกลุ่มไม่ถูกต้อง' });
    }
    let cameraIds = req.deviceIds instanceof Set ? req.deviceIds : null;
    if (edgeNode || group !== undefined) {
      const cams = await new Promise((resolve, reject) => db.all(
        'SELECT c.id,c.type,c.source_ref,c.group_name,s.remote_role AS source_role,s.remote_node AS source_node FROM cameras c LEFT JOIN camera_sources s ON s.id=c.source_id',
        (err, rows) => err ? reject(err) : resolve(rows || [])));
      cameraIds = require('./shared/ai-camera-filters').filterCameraIds(cams, { edgeNode, group }, cameraIds);
    }
    const rows = await aiEvents.list({ from, to, cameraId, type, label, origin, limit, cameraIds });
    const ids = [...new Set(rows.map((r) => r.camera_id))];
    const names = await new Promise((resolve) => {
      if (!ids.length) return resolve(new Map());
      db.all(`SELECT id, name, global_id FROM cameras WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
        (err, cams) => resolve(new Map((cams || []).map((c) => [c.id, c]))));
    });
    res.json({ events: rows.map((r) => ({ ...aiEvents.publicEvent(r), cameraName: names.get(r.camera_id)?.name || null,
      globalId: names.get(r.camera_id)?.global_id || null })) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
app.get('/api/ai/events/:seq/snapshot.jpg', requirePerm('menu.ai'), async (req, res) => {
  try {
    const row = await aiEvents.getRow(req.params.seq);
    if (!row || (req.deviceIds instanceof Set && !req.deviceIds.has(row.camera_id))) return res.status(404).json({ error: 'ไม่พบ event นี้' });
    const file = aiEvents.snapshotFile(row);
    if (!file) return res.status(404).json({ error: 'event นี้ไม่มีภาพ' });
    res.set('Cache-Control', 'private, no-store');
    res.type('image/jpeg').sendFile(file, { dotfiles: 'allow' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/edge-kits', collectorOnly, requirePerm('device.manage'), (req, res) => res.json({ kits: edgeKits.list() }));
app.post('/api/edge-kits/:file/ticket', collectorOnly, requirePerm('device.manage'), (req, res) => {
  const url = edgeKits.issueTicket(req.params.file);
  if (!url) return res.status(404).json({ error: 'ไม่มีชุดติดตั้งนี้แล้ว — รีเฟรชหน้า' });
  saveLog(req.user?.username || 'unknown', 'Edge Kit Download', `ดาวน์โหลดชุดติดตั้ง ${req.params.file}`);
  res.json({ url });
});
// เวอร์ชันของ edge ที่เผยแพร่ไว้ต่อแพลตฟอร์ม — หน้า Edge Nodes แสดงคู่กับ build ของแต่ละ edge
app.get('/api/edge-updates', collectorOnly, (req, res) => res.json({ published: edgeUpdates.published(), mirror: regionalUpdateMirror?.status() || null }));
app.post('/api/edge-update/retry', (req, res, next) => (linksToParent ? next() : res.status(403).json({ error: 'Central ไม่มี parent' })), requirePerm('system.maintain'), (req, res) => {
  try { res.status(202).json(edgeUpdater.retryDownload()); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// หน้าเว็บของ edge: มีเวอร์ชันใหม่ไหม / โหลดถึงไหน / ผลติดตั้งครั้งล่าสุด · ติดตั้ง = ให้ edge-run สลับโปรแกรม
app.get('/api/edge-update', (req, res, next) => (linksToParent ? next() : res.status(403).json({ error: 'Central ไม่มี parent' })), (req, res) => res.json(edgeUpdater.status()));
app.post('/api/edge-update/apply', (req, res, next) => (linksToParent ? next() : res.status(403).json({ error: 'Central ไม่มี parent' })), requirePerm('system.maintain'), (req, res) => {
  try {
    const r = edgeUpdater.requestApply(req.user?.username);
    saveLog(req.user?.username || 'unknown', 'Edge Update', `สั่งติดตั้งเวอร์ชัน ${r.build}`);
    res.status(202).json(r);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// เพิ่มกล้องจาก VMS (Digifort) — อยู่ใต้ checkAuth แล้ว จึงเหลือแค่ตรวจสิทธิ์ device.manage
// ในตัว router เอง เหมือน /api/nvr/channels ของเส้นทาง ONVIF
app.use(
  '/api/vms',
  edgeOnly, // Digifort เป็นแหล่งกล้อง — แอดที่ edge; central รับ edge ผ่าน /api/edges
  createVmsRouter({
    db,
    requirePerm,
    saveLog: (username, action, details) => saveLog(username, action, details),
    resyncStreamCore: () => setTimeout(syncCamerasToStreamCore, 2000),
    edgeSources,
    dssRoutes: createDssRoutes({
      db,
      saveLog: (username, action, details) => saveLog(username, action, details),
      resyncStreamCore: () => setTimeout(syncCamerasToStreamCore, 2000),
      sessions: dssSessions,
    }),
  }),
);


// --- SECURED API ROUTES (Moved for security hardening) ---

// ย้ายมาจากด้านบน checkAuth (ดูหมายเหตุตรงจุดเดิม) — ระดับการป้องกันเท่ากับ POST /api/settings
// ตัวอื่นคือ "ต้อง login" แต่ไม่จำกัดเฉพาะ admin เพื่อไม่ให้พฤติกรรมเปลี่ยนไปมากกว่าที่ตั้งใจแก้
app.post('/api/settings/upload-map-image', requirePerm('system.settings'), mapImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
  const url = `/uploads/maps/${req.file.filename}`;
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)");
  stmt.run('MAP_TYPE', 'image');
  stmt.run('MAP_IMAGE_PATH', url);
  stmt.finalize(() => {
    res.json({ success: true, image_url: url });
  });
});

app.post('/api/settings/upload-mbtiles', requirePerm('system.settings'), (req, res, next) => {
  if (mapDbInstance) {
    try { mapDbInstance.close(); } catch(e){}
    mapDbInstance = null;
    currentMapDbPath = null;
  }
  next();
}, mbtilesUpload.single('mbtiles'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No mbtiles file uploaded' });
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)");
  stmt.run('MAP_TYPE', 'mbtiles');
  stmt.run('MAP_MBTILES_PATH', 'uploaded_map.mbtiles');
  stmt.finalize(() => {
    res.json({ success: true });
  });
});

// Face Recognition removed (2026-07) — API routes/static mounts dropped.


// ฟิลด์ที่มี credential ฝังอยู่ — ตัดออกก่อนส่งให้ role ที่ไม่ใช่ admin/superadmin
// (rtsp/rtsp_sub เป็น URL ที่ฝัง user:pass ของกล้อง, onvifUser/onvifPass เป็นรหัส ONVIF ตรงๆ)
// การเล่นสตรีมฝั่ง frontend ไปผ่าน MediaMTX ไม่ได้ใช้ค่าพวกนี้ — มีแต่หน้า Camera Management/
// CameraModal ที่ใช้ ซึ่งเป็นหน้าเฉพาะ elevated อยู่แล้ว
const CAMERA_SECRET_FIELDS = ['rtsp', 'rtsp_sub', 'onvifUser', 'onvifPass'];
// ส่งออกเฉพาะกล้องในขอบเขตผู้ใช้ และไม่เปิดให้ Edge เรียก
app.get('/api/cameras/export', collectorOnly, requirePerm('menu.cameras'),
  require('./shared/camera-export').createCameraExport({ db, role: GATEWAY_ROLE, cameraState }));

app.get('/api/cameras', (req, res) => {
  db.all("SELECT c.*, s.remote_role AS source_role, s.remote_node AS source_node, s.remote_region AS source_region, s.label AS source_label FROM cameras c LEFT JOIN camera_sources s ON s.id = c.source_id", (err, rows) => {
    if (err || !rows) return res.json([]);
    // แยกสองเรื่องออกจากกัน ไม่ใช่ธงเดียว:
    //   unrestricted = เห็นกล้อง "ทุกตัว" ไหม  -> admin ขึ้นไปเท่านั้น
    //   canSeeSecrets = เห็น rtsp/onvifPass ของกล้องที่ตัวเองเห็นไหม -> operator ขึ้นไป
    // ถ้ารวมเป็นธงเดียวจะได้ผลผิดอย่างใดอย่างหนึ่งเสมอ: operator ที่ถูกตัดรหัสจะกดบันทึก
    // แล้วเขียนรหัสว่างทับของจริง (ฟอร์มแก้กล้องส่งค่ากลับมาทั้งก้อน) ส่วน operator ที่ไม่ถูก
    // จำกัดรายกล้องก็จะเห็นกล้องที่ไม่ได้รับมอบหมาย
    // ขอบเขต + สิทธิ์เห็นรหัสผ่าน มาจาก role ทั้งคู่ (checkAuth เติม req.deviceIds/req.perms)
    // unrestricted = เห็นทุกกล้องรวมที่เพิ่มใหม่ (roles.all_devices=1)
    // canSeeSecrets = เห็น rtsp/onvifPass ของ "กล้องที่ตัวเองเห็น" — สองเรื่องนี้แยกกัน
    const unrestricted = req.deviceIds === null || req.deviceIds === undefined;
    const canSeeSecrets = Boolean(req.perms && req.perms.has('device.secrets'));

    const merged = rows
      .filter(c => unrestricted || req.deviceIds.has(c.id))
      .map(c => {
        const subRtsp = resolveCameraSubRtsp(c);
        const out = {
          ...c,
          codec: codecCache[c.rtsp] || 'h264',
          codec_sub: codecCache[subRtsp] || 'h264'
        };
        if (!canSeeSecrets) for (const f of CAMERA_SECRET_FIELDS) delete out[f];
        return out;
      });
    res.json(merged);
  });
});

// ค่าหน้าจอทั่วไปอ่านได้ทุกคน ส่วนข้อมูล Telegram ให้เฉพาะผู้ดูแลตั้งค่า
const PUBLIC_SETTING_KEYS = ['MAP_TYPE', 'MAP_IMAGE_PATH'];
const PRIVATE_SETTING_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const EDITABLE_SETTING_KEYS = new Set([...PUBLIC_SETTING_KEYS, ...PRIVATE_SETTING_KEYS]);
app.get('/api/settings', (req, res) => {
  const keys = req.perms?.has('system.settings') ? [...EDITABLE_SETTING_KEYS] : PUBLIC_SETTING_KEYS;
  db.all('SELECT setting_key, setting_value FROM settings WHERE setting_key IN (' + keys.map(() => '?').join(',') + ')', keys, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const settings = {};
    for (const row of rows || []) if (keys.includes(row.setting_key)) settings[row.setting_key] = row.setting_value;
    res.json(settings);
  });
});

app.post('/api/settings', requirePerm('system.settings'), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !EDITABLE_SETTING_KEYS.has(key))) {
    return res.status(400).json({ error: 'Unsupported setting' });
  }
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES (?, ?)');
  let writeError = null;
  for (const [key, value] of Object.entries(body)) stmt.run(key, String(value), (err) => { writeError ||= err; });
  stmt.finalize((err) => (err || writeError
    ? res.status(500).json({ error: 'Save settings failed' }) : res.json({ success: true })));
});

/*
  ภาพรวม AI รายกล้อง — ตอบคำถาม "ถ้าออกคีย์ให้หน่วยงานนี้ เขาจะได้ข้อมูล AI อะไรติดไปบ้าง"

  ทุก role เข้าได้ (menu.ai อยู่ใน BASE_MENUS) แต่ยังคงกรองตามขอบเขตกล้องของผู้ใช้เหมือน
  /api/cameras — คนที่เห็นกล้องได้แค่บางตัวก็ควรเห็นภาพรวม AI ได้แค่ของกล้องเหล่านั้น

  ไม่มีรหัสผ่านหรือ RTSP อยู่ในคำตอบนี้เลย จึงไม่ต้องเช็ค device.secrets
*/
app.get('/api/ai-overview', async (req, res) => {
  try {
    const unrestricted = req.deviceIds === null || req.deviceIds === undefined;
    const scope = unrestricted ? null : [...req.deviceIds];
    const rows = await aiDiscovery.overview(scope);

    /*
      แนบสถานะการเก็บของตัวที่เฝ้าสายอยู่

      กล้องกลุ่มนี้ไม่มีข้อมูลย้อนหลังให้ดึงคืน ช่วงที่สายหลุดคือช่วงที่หายถาวร ผู้ดูแลจึง
      ต้องเห็นว่าตอนนี้เก็บอยู่จริงไหม ไม่ใช่รู้ตอนเปิดรายงานแล้วเจอช่องว่างย้อนหลัง
    */
    const byCamera = new Map(metadataCollector.status().map((c) => [c.cameraId, c]));
    res.json(rows.map((r) => ({ ...r, collector: byCamera.get(r.id) || null })));
  } catch (err) {
    console.error('[AI] overview ล้มเหลว:', err.message);
    res.status(500).json({ error: `อ่านภาพรวม AI ไม่สำเร็จ: ${err.message}` });
  }
});

/*
  สถิติ AI ที่ Gateway เก็บได้จริง แยกรายกล้อง × รายชนิด

  ตอบคนละคำถามกับ /api/ai-overview: อันนั้นบอกว่ากล้อง "มีอะไร" อันนี้บอกว่า "เกิดขึ้น
  ไปแล้วเท่าไร" — และครอบทุกชนิด ไม่ใช่เฉพาะการนับ เพราะเหตุการณ์ทุกชนิดมาทางสายเดียวกัน
  และถูกเก็บไว้หมดแล้ว
*/
app.get('/api/ai-stats', (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const since = new Date(Date.now() - hours * 3600_000);
  const from = toBangkokIso(since);

  const unrestricted = req.deviceIds === null || req.deviceIds === undefined;
  const scope = unrestricted ? null : [...req.deviceIds];
  if (scope && scope.length === 0) return res.json({ hours, from, rows: [] });

  const where = scope ? `AND s.camera_id IN (${scope.map(() => '?').join(',')})` : '';
  db.all(
    `SELECT s.camera_id AS cameraId, c.name AS cameraName, c.group_name AS groupName,
            s.topic, s.rule,
            SUM(s.events) AS events, SUM(s.count_in) AS countIn, SUM(s.count_out) AS countOut,
            MAX(s.ts) AS lastBucket, MAX(s.updated_at) AS lastAt
       FROM camera_ai_stats s
       LEFT JOIN cameras c ON c.id = s.camera_id
      WHERE s.ts >= ? ${where}
      GROUP BY s.camera_id, s.topic, s.rule
      ORDER BY events DESC`,
    scope ? [from, ...scope] : [from],
    (err, rows) => {
      // ตาราง camera_ai_stats สร้างตอน metadataCollector.start() ซึ่งรันเฉพาะเมื่อเปิด AI — เครื่องใหม่ที่ปิด AI ยังไม่มีตาราง = ยังไม่มีสถิติ ไม่ใช่ 500
      if (err && /no such table/i.test(err.message)) return res.json({ hours, from, rows: [], collector: metadataCollector.status() });
      if (err) return res.status(500).json({ error: `อ่านสถิติไม่สำเร็จ: ${err.message}` });
      res.json({ hours, from, rows: rows || [], collector: metadataCollector.status() });
    },
  );
});

/*
  ภาพนิ่งของกล้องหนึ่งตัวสำหรับหน้าเว็บ

  หน้าเว็บไม่มีผู้เล่นวิดีโออีกแล้ว — การดูภาพสดย้ายไปอยู่ที่ client ทั้งหมด แต่คนที่เพิ่งกรอก
  RTSP เข้าไปยังต้องรู้ให้ได้ว่ากรอกถูกไหม ซึ่งเป็นคำถามที่ภาพนิ่งภาพเดียวตอบได้ครบพอ ๆ กับ
  วิดีโอ โดยไม่ต้องมี player, ไม่ต้องมี stream token และไม่ทำให้ core ต้องเปิดสตรีมค้างไว้

  ใช้ captureMainSnapshotBuffer ตัวเดียวกับ route ภายในและ /api/v1 — ฟังก์ชันนั้นมีลำดับ
  fallback (ffmpeg-RTSP → ISAPI → ONVIF) ที่ผ่านการแก้บั๊กกับกล้องหลายยี่ห้อมาแล้ว

  ตรวจ scope ของผู้ใช้ก่อนเสมอ ด้วยกติกาเดียวกับ ai-probe ข้างล่าง: ผู้ใช้ที่เห็นได้แค่บางกล้อง
  ต้องไม่ดึงภาพจากกล้องที่ตัวเองไม่มีสิทธิ์เห็น
*/
app.get('/api/cameras/:id/snapshot', async (req, res) => {
  try {
    const camera = await getCameraRow(req.params.id);
    if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องตัวนี้' });
    if (req.deviceIds instanceof Set && !req.deviceIds.has(camera.id)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงกล้องนี้' });
    }

    const { buffer, source } = await captureMainSnapshotBuffer(camera);
    res.set('Cache-Control', 'no-store');
    res.set('X-Snap-Source', source);
    res.type('image/jpeg').send(buffer);
  } catch (e) {
    if (e.message === 'Camera not found') return res.status(404).json({ error: e.message });
    // 502 ไม่ใช่ 500 — ต้นทางตอบไม่ได้ ไม่ใช่ Gateway พัง และข้อความที่กล้องส่งมาคือสิ่งที่
    // คนกรอก RTSP ผิดต้องได้อ่าน
    res.status(502).json({ error: e.message || 'จับภาพจากกล้องไม่สำเร็จ' });
  }
});

/*
  สั่งตรวจกล้องหนึ่งตัวใหม่ทันที

  รอผลจริงต่างจาก hook ตอนแอดกล้อง เพราะผู้ใช้กดปุ่มนี้แล้วยืนรอดูคำตอบอยู่ — การตอบ
  success ทันทีแล้วให้ไปกดโหลดใหม่เองคือการผลักงานกลับไปให้คนทำ
*/
app.post('/api/cameras/:id/ai-probe', requirePerm('device.manage'), (req, res) => {
  db.get('SELECT * FROM cameras WHERE id = ?', [req.params.id], async (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'ไม่พบกล้องตัวนี้' });
    const unrestricted = req.deviceIds === null || req.deviceIds === undefined;
    if (!unrestricted && !req.deviceIds.has(row.id)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงกล้องนี้' });
    }
    try {
      const result = await aiDiscovery.discover(row);
      saveLog(req.user?.username, 'AI Probe', `ตรวจ AI ของกล้อง "${row.name}" — พบกฎ ${result.rules} รายการ`);
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: `ตรวจกล้องไม่สำเร็จ: ${e.message}` });
    }
  });
});

/**
 * บังคับจังหวัดและอำเภอของกล้องที่ Edge เป็นเจ้าของก่อนบันทึก
 * โยน Error เมื่อรหัสไม่ถูก — ผู้เรียกตอบ 400 ก่อนเขียนอะไรลงฐานข้อมูล
 */
const regionFromBody = (c) => {
  return regions.validateRequiredRegion(c?.province_code, c?.district_code);
};

const saveCameraRegion = (ids, region) => {
  if (region === undefined || !ids.length) return Promise.resolve();
  return new Promise((resolve, reject) => db.run(
    `UPDATE cameras SET province_code = ?, district_code = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [region.province, region.district, ...ids],
    function (err) {
      if (err) return reject(err);
      invalidateRoleCache(); // role ที่ให้สิทธิ์ตามพื้นที่ต้องเห็นการย้าย/เพิ่มกล้องทันที
      resolve(this.changes);
    },
  ));
};

/** รายชื่อจังหวัด (ไม่ส่ง parent) หรือรายชื่ออำเภอ/ตำบลใต้รหัสหนึ่ง สำหรับฟอร์มแอดกล้อง */
app.get('/api/regions', (req, res) => {
  const parent = String(req.query.parent || '').replace(/\D/g, '');
  res.json(regions.childrenOf(parent).map((r) => ({ code: r.code, name: r.nameTh, nameEn: r.nameEn })));
});
app.get('/api/region-groups', (_req, res) => {
  res.json({ regions: REGION_CODES, provinces: [...byProvince].map(([code, region]) => ({
    code, region, name: regions.lookup(code)?.nameTh || code,
  })) });
});

/** แก้พื้นที่หลายกล้องที่ Edge เจ้าของในคำสั่งเดียว โดยไม่แตะ Global ID หรือพิกัด */
app.patch('/api/cameras/region', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  let region;
  try { region = regionFromBody(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const requested = req.body?.ids;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000 || requested.some((id) => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'ต้องเลือกกล้อง 1–1000 ตัว' });
  }
  const ids = [...new Set(requested)];
  if (req.deviceIds instanceof Set && ids.some((id) => !req.deviceIds.has(id))) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้กล้องบางตัวที่เลือก' });
  try {
    const rows = await new Promise((resolve, reject) => db.all(`SELECT id, type FROM cameras WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
      (err, data) => err ? reject(err) : resolve(data)));
    if (rows.length !== ids.length) return res.status(404).json({ error: 'มีกล้องที่เลือกถูกลบไปแล้ว กรุณาโหลดรายการใหม่' });
    if (rows.some((c) => c.type === 'edge_relay')) return res.status(403).json({ error: 'ต้องแก้พื้นที่ที่ Edge เจ้าของกล้อง' });
    const changes = await saveCameraRegion(ids, region);
    saveLog(req.user?.username || 'unknown', 'Update Camera Area', `แก้จังหวัด ${region.province} อำเภอ ${region.district} ให้ ${changes} กล้อง`);
    edgeLink?.catalogSoon();
    res.json({ success: true, changes });
  } catch (err) { res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
});

app.post('/api/cameras', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  const c = req.body;
  let region;
  try {
    region = regionFromBody(c);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const streams = await resolveOnvifStreams(c);
  const rtsp = streams.rtsp || c.rtspUrl || c.rtsp;
  const rtspSub = streams.rtsp_sub || rtsp;
  // ตัดสิน id ให้เสร็จก่อนเขียน ไม่สร้างคาไว้ในรายการ argument — ไม่งั้นผู้เรียกที่ไม่ส่ง id
  // มาจะไม่มีทางรู้ว่ากล้องที่เพิ่งเพิ่มคือตัวไหน แล้วสั่งตรวจ AI ต่อไม่ได้
  const newCameraId = c.id || `cam_${Date.now()}`;
  // ไม่มีพิกัด = NULL (ยังไม่ปักหมุด) ไม่ใช่ 0 หรือสตริงว่าง
  const pinLat = Number.isFinite(parseFloat(c.lat)) ? parseFloat(c.lat) : null;
  const pinLng = Number.isFinite(parseFloat(c.lng)) ? parseFloat(c.lng) : null;
  db.run(
    "INSERT INTO cameras (id, name, group_name, brand, type, rtsp, rtsp_sub, ip, onvifPort, rtspPort, onvifUser, onvifPass, lat, lng, stream_type, onvif_main_token, onvif_sub_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      newCameraId,
      c.name,
      c.group_name || c.group || 'Default',
      c.brand || 'generic',
      c.type,
      rtsp,
      rtspSub,
      c.ip,
      c.onvifPort,
      c.rtspPort,
      c.onvifUser,
      c.onvifPass,
      pinLat,
      pinLng,
      c.stream_type || 'sub',
      streams.onvif_main_token || null,
      streams.onvif_sub_token || null,
    ],
    async (err) => {
      // เดิมไม่ดู err — insert ล้มก็ยังตอบ success หน้าเว็บปิดฟอร์มเหมือนบันทึกแล้ว
      if (err) {
        console.error('[Add Camera] insert failed:', err.message);
        return res.status(500).json({ error: `บันทึกกล้องไม่สำเร็จ: ${err.message}` });
      }
      // จังหวัดต้องลงก่อน sync รอบแรก เพราะ global ID ใช้รหัสจังหวัดตอนออกเลขครั้งเดียวแล้วไม่เปลี่ยน
      try { await saveCameraRegion([newCameraId], region); }
      catch { return res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
      notifyCatalogChanged();
      setTimeout(syncCamerasToStreamCore, 2000);
      res.json({ success: true });
      // ตรวจ AI หลังตอบกลับแล้ว ผู้ใช้ไม่ต้องรอ ONVIF ของกล้องที่อาจไม่ตอบ
      discoverCameraAi(newCameraId, 'เพิ่มกล้องใหม่');
    }
  );
});
app.put('/api/cameras/:id', requirePerm('device.manage'), async (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  const c = req.body;
  let region;
  try {
    region = regionFromBody(c);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  /*
    กล้องจาก VMS แก้ได้แค่ชื่อ กลุ่ม และหมุดแผนที่

    เส้นทางวิดีโอของมันเป็น URL relay ที่ระบบสร้างเองจากข้อมูลใน camera_sources ฟอร์มแก้กล้อง
    ไม่มีช่องให้กรอก RTSP อยู่แล้ว การปล่อยให้ UPDATE เขียนคอลัมน์ rtsp ด้วยค่าจาก body จึงมีแต่
    ทางเสีย — ค่าที่ส่งมาว่างเมื่อไหร่ กล้องตัวนั้นดับทันทีโดยไม่มีอะไรบอกว่าทำไม
  */
  const existing = await new Promise((resolve) =>
    db.get('SELECT name, group_name, type, ip, rtsp, rtsp_sub, onvif_main_token, onvif_sub_token, lat, lng FROM cameras WHERE id = ?',
      [req.params.id], (err, row) => resolve(row || null)));
  /*
    กล้องจาก edge: central เป็นเจ้าของแค่กลุ่มที่ใช้แสดงผล ชื่อ พิกัด และจังหวัดเป็นของ edge
    (resync เขียนทับทุก 10 นาทีอยู่แล้ว) — แก้ที่นี่ก็หายเอง จึงรับแค่ group
  */
  if (existing && existing.type === EDGE_TYPE) {
    return db.run(
      'UPDATE cameras SET group_name=? WHERE id=?',
      [c.group_name || c.group || 'Default', req.params.id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, note: 'กล้องจาก edge แก้ได้เฉพาะกลุ่ม — ชื่อ พิกัด และจังหวัดแก้ที่ edge' });
      },
    );
  }
  if (existing && (existing.type === DIGIFORT_TYPE || existing.type === DSS_TYPE)) {
    return db.run(
      'UPDATE cameras SET name=?, group_name=?, lat=?, lng=? WHERE id=?',
      [c.name, c.group_name || c.group || 'Default', c.lat, c.lng, req.params.id],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        try { await saveCameraRegion([req.params.id], region); }
      catch { return res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
        res.json({ success: true });
      },
    );
  }
  /*
    ฟอร์มแก้กล้องไม่มีช่อง sub stream และ ONVIF token — ถ้าไม่เติมจากแถวเดิม การแก้แค่ชื่อช่องของ NVR
    จะทำให้ rtsp_sub กลายเป็น main (Live wall ดึงเส้นหนัก) และ token เป็น NULL (PTZ หาย)
  */
  if (!existing) return sendOutOfScope(res);
  // ผู้แก้ metadata ที่ไม่มีสิทธิ์เห็นรหัส ต้องไม่เปลี่ยนปลายทางหรือเขียนค่าว่างทับบัญชีกล้อง
  if (!req.perms?.has('device.secrets')) {
    return db.run('UPDATE cameras SET name=?, group_name=?, lat=?, lng=? WHERE id=?',
      [c.name ?? existing.name, c.group_name || c.group || existing.group_name,
        'lat' in c ? c.lat : existing.lat, 'lng' in c ? c.lng : existing.lng, req.params.id], async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        try { await saveCameraRegion([req.params.id], region); }
        catch { return res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
        res.json({ success: true });
      });
  }
  const sameNvrStream = existing && existing.type === 'onvif_nvr' && c.type === 'onvif_nvr'
    && rtspIdentity(c.rtspUrl || c.rtsp) === rtspIdentity(existing.rtsp);
  const body = sameNvrStream
    ? {
      ...c,
      rtsp_sub: c.rtsp_sub || existing.rtsp_sub,
      onvif_main_token: c.onvif_main_token || existing.onvif_main_token,
      onvif_sub_token: c.onvif_sub_token || existing.onvif_sub_token,
    }
    : c;
  let streams = await resolveOnvifStreams(body);
  /*
    กล้อง ONVIF ที่ออฟไลน์ตอนกดบันทึก: probe ล้มแล้วได้ URL เดาจากยี่ห้อ ซึ่งจะทับ URL จริงที่เคยได้จาก ONVIF
    — ถ้า IP ไม่เปลี่ยนและเดิมมี URL อยู่แล้ว ให้คง URL/token เดิมไว้
  */
  if (streams.guessed && existing && existing.type === 'onvif_cam' && existing.rtsp && existing.ip === c.ip) {
    streams = {
      rtsp: existing.rtsp,
      rtsp_sub: existing.rtsp_sub,
      onvif_main_token: existing.onvif_main_token,
      onvif_sub_token: existing.onvif_sub_token,
    };
  }
  const rtsp = streams.rtsp || c.rtspUrl || c.rtsp;
  const rtspSub = streams.rtsp_sub || rtsp;
  db.run(
    "UPDATE cameras SET name=?, group_name=?, brand=?, type=?, rtsp=?, rtsp_sub=?, ip=?, onvifPort=?, rtspPort=?, onvifUser=?, onvifPass=?, lat=?, lng=?, stream_type=?, onvif_main_token=?, onvif_sub_token=? WHERE id=?",
    [
      c.name,
      c.group_name || c.group || 'Default',
      c.brand || 'generic',
      c.type,
      rtsp,
      rtspSub,
      c.ip,
      c.onvifPort,
      c.rtspPort,
      c.onvifUser,
      c.onvifPass,
      c.lat,
      c.lng,
      c.stream_type || 'sub',
      streams.onvif_main_token || null,
      streams.onvif_sub_token || null,
      req.params.id,
    ],
    async () => {
      try { await saveCameraRegion([req.params.id], region); }
      catch { return res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
      setTimeout(syncCamerasToStreamCore, 2000);
      res.json({ success: true });
      /*
        แก้กล้องแล้วต้องตรวจ AI ใหม่ ไม่ใช่ถือผลเดิมไว้

        ฟอร์มนี้แก้ IP รหัสผ่าน และพอร์ต ONVIF ได้ทั้งหมด ซึ่งเป็นสามอย่างที่ตัดสินว่าเรา
        ถามกล้องได้หรือไม่ กรณีที่เจอบ่อยที่สุดคือกรอกรหัสผ่านผิดตอนแอด แล้วมาแก้ทีหลัง —
        ถ้าไม่ตรวจใหม่ หน้าจอจะยังขึ้นว่า "ถามกล้องไม่ได้" ต่อไปอีก 24 ชั่วโมงทั้งที่แก้แล้ว
      */
      discoverCameraAi(req.params.id, 'แก้ข้อมูลกล้อง');
    }
  );
});

/**
 * เปิด/ปิดใช้งานกล้อง — ที่ edge เท่านั้น (central รับค่าตาม edge ตอน sync)
 * ปิด = ถอดออกจาก go2rtc ไม่เช็คสถานะ ไม่นับเป็นกล้องดับ แถวและ global ID ยังอยู่ครบ
 */
app.patch('/api/cameras/:id/enabled', edgeOnly, requirePerm('device.manage'), (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  const enabled = req.body?.enabled ? 1 : 0;
  db.get('SELECT id, name FROM cameras WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    db.run('UPDATE cameras SET enabled = ? WHERE id = ?', [enabled, row.id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });
      cameraState.set(row.id, enabled ? { enabled: true } : { enabled: false, reachable: null, streaming: false });
      saveLog(req.user?.username || 'unknown', enabled ? 'Enable Camera' : 'Disable Camera',
        `${enabled ? 'เปิด' : 'ปิด'}ใช้งานกล้อง "${row.name}"`);
      setTimeout(syncCamerasToStreamCore, 500);
      setTimeout(updateCameraStatuses, 1500);
      res.json({ success: true, enabled: Boolean(enabled) });
    });
  });
});

/**
 * เปิด/ปิดส่งเสียงของกล้อง — ที่ edge เท่านั้น (ชั้นบนรับค่าตาม edge ตอน sync เหมือน enabled)
 * เปิด = go2rtc ต่อ `#audio=aac` ให้เส้นที่เบราว์เซอร์เล่น และสาย link ส่งเสียงขึ้น Regional/Central ด้วย
 */
app.patch('/api/cameras/:id/audio', edgeOnly, requirePerm('device.manage'), (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  const audio = req.body?.enabled ? 1 : 0;
  db.get('SELECT id, name FROM cameras WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    db.run('UPDATE cameras SET audio_enabled = ? WHERE id = ?', [audio, row.id], (upErr) => {
      if (upErr) return res.status(500).json({ error: upErr.message });
      saveLog(req.user?.username || 'unknown', audio ? 'Enable Camera Audio' : 'Disable Camera Audio',
        `${audio ? 'เปิด' : 'ปิด'}รับเสียงกล้อง "${row.name}"`);
      setTimeout(syncCamerasToStreamCore, 500);
      // สาย link: ffmpeg ที่ push อยู่ต้องเริ่มใหม่ด้วยค่าเสียงใหม่ และชั้นบนต้องได้ค่าใหม่ทันที ไม่รอรอบ 5 นาที
      edgeLink?.catalogSoon?.();
      res.json({ success: true, audio: Boolean(audio) });
    });
  });
});

/**
 * ตรวจว่ากล้องส่ง track เสียงมาไหม — ถามต้นทางตรง ๆ (ไม่ผ่าน go2rtc ซึ่งตัดเสียงทิ้งตอนปิดอยู่)
 * ตอบ { hasAudio, codec, sampleRate, channels } · ต่อไม่ได้ = 502 พร้อมข้อความที่ตัดรหัสแล้ว
 *
 * ใช้ ffmpeg ไม่ใช่ ffprobe: ชุดติดตั้ง edge (scripts/edge-kit) มีแค่ ffmpeg — ffprobe ไม่มี (ENOENT ที่ Edge 101
 * 2026-10-06) · `ffmpeg -i <url>` ที่ไม่มี output พิมพ์รายการ stream ลง stderr แล้วออกด้วย code 1 เสมอ
 * จึงตัดสินจากบรรทัด `Stream #` ไม่ใช่ exit code
 */
app.post('/api/cameras/:id/audio-probe', edgeOnly, requirePerm('device.manage'), (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  db.get('SELECT id, rtsp FROM cameras WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    if (!row.rtsp) return res.status(409).json({ error: 'กล้องนี้ยังไม่มีที่อยู่สตรีม' });
    const args = ['-hide_banner', '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', row.rtsp];
    execFile(FFMPEG_PATH.replace(/\\\\/g, '\\'), args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      const text = String(stderr || '');
      const streams = text.split(/\r?\n/).filter((l) => /^\s*Stream #\d+:\d+/.test(l));
      if (!streams.length) {
        const why = redactUrls((text.trim() || error?.message || '').split(/\r?\n/).pop());
        return res.status(502).json({ error: `ถามกล้องไม่ได้: ${why}` });
      }
      // เช่น "Stream #0:1: Audio: pcm_alaw, 8000 Hz, mono, s16, 64 kb/s"
      const line = streams.find((l) => /: Audio: /.test(l));
      const m = line ? /: Audio: ([\w-]+)[^,]*(?:,\s*(\d+) Hz)?(?:,\s*(mono|stereo|(\d+) channels))?/.exec(line) : null;
      res.json({
        hasAudio: Boolean(line),
        codec: m?.[1] || null,
        sampleRate: m?.[2] ? Number(m[2]) : null,
        channels: m?.[3] === 'mono' ? 1 : m?.[3] === 'stereo' ? 2 : m?.[4] ? Number(m[4]) : null,
      });
    });
  });
});

/*
  PTZ จากหน้า Live ของเว็บ (session ของคน) — ใช้ตัวคุม PTZ ตัวเดียวกับ /api/v1 (gateway.ptz)
  ดู: menu.live · สั่ง: device.ptz · กล้องนอก scope ของ role = 404 เหมือนไม่มีกล้องนี้
*/
const scopedCameraForUser = async (req) => {
  if (req.deviceIds instanceof Set && !req.deviceIds.has(req.params.id)) return null;
  return getCameraRow(req.params.id).catch(() => null);
};
const sendSessionPtzError = (res, err) => {
  res.status(err instanceof PtzError ? err.status : 500).json({ error: err?.message || 'สั่ง PTZ ไม่สำเร็จ' });
};
app.get('/api/cameras/:id/ptz', requirePerm('menu.live'), async (req, res) => {
  try {
    const camera = await scopedCameraForUser(req);
    if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    const caps = await gateway.ptz.capabilities(camera);
    res.json({ ...caps, allowed: Boolean(req.perms && req.perms.has('device.ptz')) });
  } catch (err) {
    sendSessionPtzError(res, err);
  }
});
app.post('/api/cameras/:id/ptz', requirePerm('device.ptz'), async (req, res) => {
  try {
    const camera = await scopedCameraForUser(req);
    if (!camera) return res.status(404).json({ error: 'ไม่พบกล้องนี้' });
    const result = await dispatchPtz(gateway.ptz, camera, req.body || {}, { actor: req.user?.username || 'unknown', saveLog });
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    sendSessionPtzError(res, err);
  }
});

// อัปเดตเฉพาะหมุดแผนที่ (lat/lng) — ไม่แตะ RTSP/ONVIF/ชื่อ
app.patch('/api/cameras/:id/location', pinAtEdge, requirePerm('device.manage'), (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  /*
    ส่ง lat/lng เป็น null = ถอนหมุด ไม่ใช่คำขอที่ผิดรูป

    "ยังไม่ได้ปักหมุด" ต้องแสดงออกด้วยค่า NULL ในฐานข้อมูลเท่านั้น การเอาพิกัดสมมติ
    (เช่นจุดกลางเมือง) มาแทนทำให้ปลายทางแยกไม่ออกระหว่างกล้องที่อยู่ตรงนั้นจริงกับ
    กล้องที่ยังไม่มีใครปัก — ทั้ง /api/v1 และหน้าแผนที่ของ client รองรับ null อยู่แล้ว
  */
  const clearing = req.body?.lat === null && req.body?.lng === null;
  const lat = parseFloat(req.body?.lat);
  const lng = parseFloat(req.body?.lng);
  if (!clearing) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'lat/lng out of range' });
    }
  }
  db.run(
    'UPDATE cameras SET lat = ?, lng = ? WHERE id = ?',
    [clearing ? null : lat, clearing ? null : lng, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'camera not found' });
      saveLog(req.user.username, 'Update Map Pin', clearing
        ? `ถอนหมุดกล้อง ID "${req.params.id}" 📍`
        : `ย้ายหมุดกล้อง ID "${req.params.id}" → ${lat.toFixed(6)}, ${lng.toFixed(6)} 📍`);
      res.json({ success: true, lat: clearing ? null : lat, lng: clearing ? null : lng });
    }
  );
});

/**
 * ปักหมุดให้กล้องหลายตัวในคำขอเดียว
 *
 * มีไว้เพราะจุดติดตั้งหนึ่งจุดมักมีกล้องหลายตัว และการนำเข้ากล้องจาก VMS ทีละร้อยตัว
 * ทำให้การปักทีละตัวผ่าน PATCH กลายเป็นคำขอหลักร้อยครั้งพร้อม log หลักร้อยบรรทัด
 *
 * lat/lng เป็น null ได้ = ถอนหมุดของทั้งชุด ใช้กฎเดียวกับ PATCH ด้านบน
 */
app.post('/api/cameras/locations', pinAtEdge, requirePerm('device.manage'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || items.length === 0) return res.status(400).json({ error: 'items required' });

  const rows = [];
  for (const item of items) {
    if (!item?.id) return res.status(400).json({ error: 'ทุกรายการต้องมี id' });
    if (!cameraInScope(req, item.id)) return res.status(404).json({ error: `ไม่พบกล้อง ${item.id}` });
    const clearing = item.lat === null && item.lng === null;
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lng);
    if (!clearing) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: `lat/lng ไม่ถูกต้องสำหรับกล้อง ${item.id}` });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: `lat/lng เกินช่วงสำหรับกล้อง ${item.id}` });
      }
    }
    rows.push({ id: item.id, lat: clearing ? null : lat, lng: clearing ? null : lng });
  }

  const stmt = db.prepare('UPDATE cameras SET lat = ?, lng = ? WHERE id = ?');
  let updated = 0;
  let failed = null;
  for (const row of rows) {
    stmt.run([row.lat, row.lng, row.id], function (err) {
      if (err) { if (!failed) failed = err; return; }
      updated += this.changes;
    });
  }
  stmt.finalize((finErr) => {
    const err = failed || finErr;
    if (err) return res.status(500).json({ error: err.message });
    const first = rows[0];
    saveLog(req.user?.username || 'unknown', 'Update Map Pin', first.lat === null
      ? `ถอนหมุดกล้อง ${updated} ตัว 📍`
      : `ปักหมุดกล้อง ${updated} ตัวที่ ${first.lat.toFixed(6)}, ${first.lng.toFixed(6)} 📍`);
    res.json({ success: true, updated });
  });
});
/** edge จดการลบก่อนลบจริง ให้ central ลบตาม — ล้มก็ยังลบต่อ (central เห็นเป็น "หายจาก edge" ให้คนกดลบเอง) */
const recordCameraDeletions = (ids, username) => (GATEWAY_ROLE === 'edge'
  ? cameraDeletions.record(ids, username).catch((err) => console.warn(`[Camera deletions] จดไม่สำเร็จ: ${err.message}`))
  : Promise.resolve());
/** รายการกล้องที่ edge เปลี่ยน — ส่งขึ้น central ทันทีถ้าต่อแบบ link (ไม่ต้องรอรอบ 5 นาที) */
const notifyCatalogChanged = () => { invalidateRoleCache(); edgeLink?.catalogSoon?.(); };

app.delete('/api/cameras/:id', requirePerm('device.manage'), async (req, res) => {
  if (!cameraInScope(req, req.params.id)) return sendOutOfScope(res);
  await recordCameraDeletions([req.params.id], req.user?.username);
  db.run("DELETE FROM cameras WHERE id = ?", [req.params.id], () => {
    invalidateRoleCache(); // role_devices อาจอ้างกล้องที่เพิ่งลบ — ล้าง cache ไม่ให้ค้าง
    delete camLastStatus[req.params.id];
    delete streamHealthState[req.params.id];
    saveLog(req.user?.username || 'unknown', 'Delete Camera', `ลบกล้อง "${req.params.id}"`);
    setTimeout(syncCamerasToStreamCore, 2000);
    notifyCatalogChanged();
    res.json({ success: true });
  });
});
app.post('/api/cameras/bulk-add', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  /*
    ไม่รับ lat/lng — ช่องของ NVR อยู่คนละจุดกัน พิกัดชุดเดียวทำให้ทุกช่องซ้อนกันที่จุดเดียว (เจอกับ SITE-1-3)
    กล้องเข้ามาแบบยังไม่มีหมุด (NULL) แล้วปักในหน้า Map Pins
  */
  const { baseName, group, ip, onvifPort, rtspPort, user, pass, brand, channels: requested } = req.body;
  const univiewImport = req.body.importMode === 'uniview_api';
  const axisImport = req.body.importMode === 'axis_s30';
  if (!Array.isArray(requested) || requested.length === 0) {
    return res.status(400).json({ error: 'channels required' });
  }
  let region;
  try {
    region = regionFromBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const missing = requested.filter((ch) => !(ch?.main?.rtsp || ch?.rtsp)
    && !(axisImport && /^[a-z\d_-]{1,100}$/i.test(String(ch?.sourceId || '')))
    && !(univiewImport && Number.isInteger(ch?.channel) && ch.channel > 0));
  if (missing.length) {
    return res.status(400).json({ error: 'ช่องที่ไม่มี RTSP ต้องมี source ID ของ AXIS หรือเลขช่อง Uniview' });
  }
  if (univiewImport && requested.some((ch) => !Number.isInteger(ch?.channel) || ch.channel < 1)) {
    return res.status(400).json({ error: 'Uniview import requires channel number' });
  }
  let axisDevices;
  if (axisImport) {
    try {
      axisDevices = await readAxisS30Devices({ ip, apiPort: req.body.apiPort, user, pass });
      const validIds = new Set(axisDevices.map((device) => device.sourceId));
      if (requested.some((ch) => !validIds.has(ch.sourceId))) {
        return res.status(400).json({ error: 'AXIS S30 ไม่มี source ID ที่เลือก กรุณาสแกนอีกครั้ง' });
      }
      for (const ch of requested) {
        ch.main = { rtsp: axisS30Rtsp({ ip, rtspPort, user, pass, sourceId: ch.sourceId }), token: ch.sourceId };
        // sub = ภาพเดียวกันที่ S30 ย่อเป็น 640×360 ให้ — ไม่ตั้ง = Live Wall ดึงภาพเต็มขนาดทุกช่อง
        ch.sub = { rtsp: axisS30SubRtsp(ch.main.rtsp), token: ch.sourceId };
      }
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // ข้ามช่องที่มีอยู่แล้ว (RTSP เดียวกัน ไม่สนรหัส) — สแกนซ้ำแล้วกด import ทั้งชุดต้องไม่ได้แถวซ้ำ
  const existingRows = await new Promise((resolve) => db.all(
    'SELECT rtsp, ip, onvifPort, nvr_channel FROM cameras',
    (err, rows) => resolve(err ? [] : rows || []),
  ));
  const existingRtsp = new Set(existingRows.filter((r) => r.rtsp).map((r) => rtspIdentity(r.rtsp)));
  const existingChannels = new Set(existingRows.filter((r) => r.nvr_channel != null)
    .map((r) => `${r.ip}:${r.onvifPort}:${r.nvr_channel}`));
  const channels = requested.filter((ch) => {
    const url = ch.main?.rtsp || ch.rtsp;
    const key = url ? rtspIdentity(url) : null;
    const channelKey = univiewImport ? `${ip}:${onvifPort}:${ch.channel}` : null;
    if ((key && existingRtsp.has(key)) || (channelKey && existingChannels.has(channelKey))) return false;
    if (key) existingRtsp.add(key);
    if (channelKey) existingChannels.add(channelKey);
    return true;
  });
  const skipped = requested.length - channels.length;
  if (!channels.length) {
    return res.json({ success: true, count: 0, skipped, ids: [] });
  }

  const stmt = db.prepare(
    "INSERT INTO cameras (id, name, group_name, brand, type, rtsp, rtsp_sub, ip, onvifPort, rtspPort, onvifUser, onvifPass, lat, lng, stream_type, onvif_main_token, onvif_sub_token, nvr_channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const baseTs = Date.now();
  const addedIds = [];
  let insertErr = null;
  channels.forEach((ch, i) => {
    const mainRtsp = ch.main?.rtsp || ch.rtsp || null;
    const subRtsp = ch.sub?.rtsp || mainRtsp;
    const label = String(ch.name || `${baseName || ''} CH ${i + 1}`).trim();
    const camId = `cam_${baseTs}_${i}_${String(ch.id || i).replace(/[^\w.-]/g, '_').slice(0, 40)}`;
    addedIds.push(camId);
    stmt.run([
      camId, label, String(group || '').trim() || 'Default', brand || 'generic', 'onvif_nvr',
      mainRtsp, subRtsp, ip, axisImport ? req.body.apiPort : onvifPort, rtspPort, user, pass, null, null, 'sub',
      ch.main?.token || null, ch.sub?.token || ch.main?.token || null,
      univiewImport ? ch.channel : null,
    ], (err) => { if (err && !insertErr) insertErr = err; }); // capture the FIRST row error
  });
  // Previously this always answered success even if every insert silently failed (e.g. a locked
  // DB while a slow ONVIF probe held things up) — the UI showed "saved" for a camera that never
  // persisted. Now report the real outcome + log the add so there's a forensic trail.
  stmt.finalize(async (finErr) => {
    const err = insertErr || finErr;
    if (err) {
      console.error('[bulk-add] insert failed:', err.message);
      return res.status(500).json({ error: `บันทึกกล้องไม่สำเร็จ: ${err.message}` });
    }
    try { await saveCameraRegion(addedIds, region); }
      catch { return res.status(500).json({ error: 'บันทึกพื้นที่ไม่สำเร็จ' }); }
    notifyCatalogChanged();
    saveLog(req.user?.username || 'unknown', 'Add Camera',
      `เพิ่มกล้อง ${addedIds.length} ช่อง (${brand || 'generic'} ${ip}): ${addedIds.join(', ')}`);
    setTimeout(syncCamerasToStreamCore, 2000);
    res.json({ success: true, count: channels.length, skipped, ids: addedIds });
    if (univiewImport && channels.some((ch) => !ch.main?.rtsp)) {
      setTimeout(resolvePendingUniviewStreams, 15_000);
    }
    for (const [i, id] of addedIds.entries()) {
      if (channels[i].main?.rtsp) discoverCameraAi(id, 'เพิ่มกล้องแบบหลายช่อง');
    }
  });
});
app.post('/api/cameras/bulk-delete', requirePerm('device.manage'), async (req, res) => {
  if (!Array.isArray(req.body?.ids) || !req.body.ids.length) return res.status(400).json({ error: 'ids required' });
  // ลบได้เฉพาะกล้องในขอบเขตของ role — id นอกขอบเขตถูกข้ามเงียบ ๆ (บอกจำนวนที่ข้ามไว้ในคำตอบ)
  const ids = req.body.ids.map(String).filter((id) => cameraInScope(req, id));
  const skipped = req.body.ids.length - ids.length;
  if (!ids.length) return res.status(404).json({ error: 'ไม่พบกล้องที่เลือก' });
  invalidateRoleCache();
  await recordCameraDeletions(ids, req.user?.username);
  db.run(`DELETE FROM cameras WHERE id IN (${ids.map(() => '?').join(',')})`, ids, () => {
    for (const id of ids) {
      delete camLastStatus[id];
      delete streamHealthState[id];
    }
    saveLog(req.user?.username || 'unknown', 'Delete Camera', `ลบกล้อง ${ids.length} ตัว: ${ids.join(', ')}`);
    setTimeout(syncCamerasToStreamCore, 2000);
    notifyCatalogChanged();
    res.json({ success: true, deleted: ids.length, skipped });
  });
});
app.post('/api/cameras/rename-group', requirePerm('device.manage'), (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'Missing group names' });
  // role ที่จำกัดกล้อง: เปลี่ยนชื่อกลุ่มได้เฉพาะกล้องของตัวเองในกลุ่มนั้น ไม่ลากกล้องของคนอื่นไปด้วย
  const scoped = req.deviceIds instanceof Set;
  const scopeIds = scoped ? [...req.deviceIds] : [];
  if (scoped && !scopeIds.length) return res.json({ success: true, changes: 0 });
  const scopeSql = scoped ? ` AND id IN (${scopeIds.map(() => '?').join(',')})` : '';
  db.run(`UPDATE cameras SET group_name = ? WHERE group_name = ?${scopeSql}`, [newName, oldName, ...scopeIds], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    saveLog(req.user.username, 'Rename Group', `เปลี่ยนชื่อกลุ่มกล้องจาก "${oldName}" เป็น "${newName}" 📁`);
    setTimeout(syncCamerasToStreamCore, 2000);
    res.json({ success: true, changes: this.changes });
  });
});

/**
 * โหลดสิทธิ์ + ขอบเขตกล้องของ role หนึ่ง
 * P1: ยังไม่ถูกใช้บังคับสิทธิ์ ใช้แค่ให้ /api/roles กับ /api/me อ่าน — การบังคับจริงอยู่ P3
 */
const loadRoleAccess = (roleId, cb) => {
  if (!roleId) return cb(null, null);
  db.get('SELECT * FROM roles WHERE id = ?', [roleId], (err, role) => {
    if (err) return cb(err);
    if (!role) return cb(null, null);
    db.all('SELECT perm_key FROM role_permissions WHERE role_id = ?', [roleId], (pErr, perms) => {
      if (pErr) return cb(pErr);
      const permKeys = (perms || []).map((p) => p.perm_key);
      if (role.all_devices) {
        return cb(null, { role, permissions: permKeys, deviceIds: null });
      }
      getRoleAccess(roleId, (aErr, access) => {
        if (aErr) return cb(aErr);
        cb(null, { role, permissions: permKeys, deviceIds: [...access.deviceIds] });
      });
    });
  });
};

/** ผู้ใช้ปัจจุบัน + สิทธิ์ที่คำนวณแล้ว — frontend เรียกตอน mount/focus กัน localStorage ค้าง */
app.get('/api/me', (req, res) => {
  loadRoleAccess(req.user?.role_id, async (err, access) => {
    if (err) return res.status(500).json({ error: err.message });
    // เปลี่ยนรหัสแล้วแถบเตือนต้องหายเองตอน refresh ไม่ต้องรอ login ใหม่
    const mustChangePassword = await usesDefaultAdminPassword(req.user).catch(() => false);
    res.json({
      mustChangePassword,
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      role_id: req.user.role_id || null,
      roleLabel: access?.role?.label || null,
      permissions: access?.permissions || [],
      // null = ไม่จำกัด (เห็นทุกกล้องรวมที่เพิ่มใหม่)
      deviceIds: access ? access.deviceIds : null,
      allDevices: access ? Boolean(access.role.all_devices) : null,
    });
  });
});

app.get('/api/roles', requirePerm('user.manage'), (req, res) => {
  db.all('SELECT * FROM roles ORDER BY is_system DESC, name', (err, roles) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT role_id, perm_key FROM role_permissions', (pErr, perms) => {
      if (pErr) return res.status(500).json({ error: pErr.message });
      db.all('SELECT role_id, camera_id FROM role_devices', (dErr, devs) => {
        if (dErr) return res.status(500).json({ error: dErr.message });
        db.all('SELECT role_id, COUNT(*) AS n FROM users WHERE role_id IS NOT NULL GROUP BY role_id', (uErr, counts) => {
          if (uErr) return res.status(500).json({ error: uErr.message });
          const byRole = (rows, key) => rows.reduce((m, r) => {
            (m[r.role_id] = m[r.role_id] || []).push(r[key]);
            return m;
          }, {});
          const permMap = byRole(perms || [], 'perm_key');
          const devMap = byRole(devs || [], 'camera_id');
          const userCount = (counts || []).reduce((m, r) => ({ ...m, [r.role_id]: r.n }), {});
          res.json((roles || []).map((r) => ({
            ...r,
            is_system: Boolean(r.is_system),
            all_devices: Boolean(r.all_devices),
            permissions: permMap[r.id] || [],
            deviceIds: r.all_devices ? null : (devMap[r.id] || []),
            areaScope: parseAreaScope(r.area_scope),
            userCount: userCount[r.id] || 0,
          })));
        });
      });
    });
  });
});

/** รายการสิทธิ์ทั้งหมดที่ระบบรู้จัก — ให้ UI สร้างช่องติ๊กโดยไม่ต้อง hardcode ซ้ำ */
app.get('/api/permissions', requirePerm('user.manage'), (req, res) => {
  res.json({ menu: MENU_KEYS, operation: OP_KEYS });
});

// ── สร้าง/แก้/ลบ role ─────────────────────────────────────────────────────────
// กันยกระดับสิทธิ์: ผู้สร้าง/แก้ให้สิทธิ์ที่ตัวเองไม่มีไม่ได้ (req.perms คือสิทธิ์ของผู้เรียก)
const sanitizePerms = (list) => {
  const wanted = Array.isArray(list) ? list : [];
  return ALL_PERM_KEYS.filter((k) => wanted.includes(k)); // เฉพาะ key ที่ระบบรู้จัก + ตามลำดับคงที่
};
const sanitizeAreaScope = (value) => {
  const area = parseAreaScope(value);
  return { regions: [...new Set(area.regions)], provinces: [...new Set(area.provinces)] };
};
const scopeCallerLacks = (req, allDevices, deviceIds, area) => req.deviceIds instanceof Set && (
  allDevices || area.regions.length > 0 || area.provinces.length > 0 ||
  (deviceIds || []).some((id) => !req.deviceIds.has(String(id)))
);
const permsCallerLacks = (req, perms) => perms.filter((k) => !req.perms.has(k));

/**
 * role ที่จะผูกให้ผู้ใช้ (POST/PUT /api/users) — ต้องมีอยู่จริง และผู้เรียกต้องถือทุกสิทธิ์ของ role นั้น
 * รวมถึงขอบเขตกล้องต้องไม่กว้างกว่าของตัวเอง · กฎเดียวกับการสร้าง/แก้ role (permsCallerLacks)
 * เดิมตรวจแค่ชื่อ role ส่วน role_id ส่งอะไรมาก็เขียนลง DB — admin ย้ายบัญชีตัวเองอีกบัญชีไป r_superadmin ได้
 * cb(null) = ผ่าน, cb({ status, error }) = ไม่ผ่าน
 */
const checkAssignableRole = (req, roleId, roleName, cb) => {
  if (!roleId || !roleName) return cb({ status: 400, error: 'Invalid role' });
  db.get('SELECT id, name FROM roles WHERE id = ?', [roleId], (err, row) => {
    if (err) return cb({ status: 500, error: err.message });
    if (!row) return cb({ status: 400, error: 'Invalid role_id' });
    if (row.name !== roleName) return cb({ status: 400, error: 'Role and role_id do not match' });
    if (row.name === 'superadmin' && req.user.role !== 'superadmin') {
      return cb({ status: 403, error: 'Access denied: cannot assign superadmin role' });
    }
    getRoleAccess(roleId, (aErr, access) => {
      if (aErr) return cb({ status: 500, error: aErr.message });
      const lack = permsCallerLacks(req, [...access.perms].filter((k) => ALL_PERM_KEYS.includes(k)));
      if (lack.length) return cb({ status: 403, error: `Cannot assign a role with permissions you don't hold: ${lack.join(', ')}` });
      if (req.deviceIds instanceof Set) {
        const wider = access.deviceIds === null || [...access.deviceIds].some((id) => !req.deviceIds.has(id));
        if (wider) return cb({ status: 403, error: 'Cannot assign a role with a wider camera scope than your own' });
      }
      cb(null);
    });
  });
};

/** แก้หรือลบบัญชีผู้อื่นได้เมื่อสิทธิ์และขอบเขตกล้องไม่กว้างกว่าผู้เรียก */
const checkManageableUser = (req, target, cb) => {
  if (target.id === req.user.id) return cb(null);
  const roleId = target.role_id || roleIdFor(target.role);
  getRoleAccess(roleId, (err, access) => {
    if (err) return cb({ status: 500, error: 'Load target permissions failed' });
    if (permsCallerLacks(req, [...access.perms]).length) {
      return cb({ status: 403, error: 'Cannot manage a user with permissions you do not hold' });
    }
    if (req.deviceIds instanceof Set && (access.deviceIds === null
        || [...access.deviceIds].some((id) => !req.deviceIds.has(id)))) {
      return cb({ status: 403, error: 'Cannot manage a user with a wider camera scope than your own' });
    }
    cb(null);
  });
};

// เขียน role_permissions + role_devices ให้ตรงกับที่ส่งมา (ลบเก่าทั้งหมดก่อนใส่ใหม่)
const writeRoleGrants = (roleId, perms, deviceIds, allDevices, cb) => {
  db.serialize(() => {
    db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    for (const k of perms) db.run('INSERT OR IGNORE INTO role_permissions (role_id, perm_key) VALUES (?,?)', [roleId, k]);
    db.run('DELETE FROM role_devices WHERE role_id = ?', [roleId]);
    if (!allDevices) {
      for (const cid of (deviceIds || [])) db.run('INSERT OR IGNORE INTO role_devices (role_id, camera_id) VALUES (?,?)', [roleId, cid]);
    }
    db.run('SELECT 1', [], () => { invalidateRoleCache(); cb(); });
  });
};

app.post('/api/roles', requirePerm('user.manage'), (req, res) => {
  const name = String(req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const label = String(req.body.label || req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Role name required' });
  const perms = sanitizePerms(req.body.permissions);
  const lack = permsCallerLacks(req, perms);
  if (lack.length) return res.status(403).json({ error: `Cannot grant permissions you don't hold: ${lack.join(', ')}` });
  const allDevices = Boolean(req.body.all_devices);
  const area = sanitizeAreaScope(req.body.areaScope);
  if (scopeCallerLacks(req, allDevices, req.body.deviceIds, area)) return res.status(403).json({ error: 'Cannot grant a wider camera scope than your own' });
  const roleId = 'r_' + name;
  db.get('SELECT id FROM roles WHERE id = ? OR name = ?', [roleId, name], (err, exists) => {
    if (err) return res.status(500).json({ error: err.message });
    if (exists) return res.status(409).json({ error: 'Role name already exists' });
    db.run('INSERT INTO roles (id, name, label, is_system, all_devices, area_scope, created_at) VALUES (?,?,?,0,?,?,?)',
      [roleId, name, label, allDevices ? 1 : 0, JSON.stringify(area), nowIso()], (iErr) => {
        if (iErr) return res.status(500).json({ error: iErr.message });
        writeRoleGrants(roleId, perms, req.body.deviceIds, allDevices, () => {
          saveLog(req.user.username, 'Create Role', `สร้าง role "${name}" (${perms.length} สิทธิ์)`);
          res.json({ success: true, id: roleId });
        });
      });
  });
});

app.put('/api/roles/:id', requirePerm('user.manage'), (req, res) => {
  db.get('SELECT * FROM roles WHERE id = ?', [req.params.id], (err, role) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_system) return res.status(403).json({ error: 'System role cannot be edited' });
    const perms = sanitizePerms(req.body.permissions);
    const lack = permsCallerLacks(req, perms);
    if (lack.length) return res.status(403).json({ error: `Cannot grant permissions you don't hold: ${lack.join(', ')}` });
    // กันถอด user.manage ออกจาก role ของตัวเอง (จะแก้ role ต่อไม่ได้ = ล็อกตัวเอง)
    if (req.user.role_id === role.id && !perms.includes('user.manage')) {
      return res.status(403).json({ error: 'Cannot remove user management from your own role' });
    }
    const allDevices = Boolean(req.body.all_devices);
    const area = sanitizeAreaScope(req.body.areaScope);
    if (scopeCallerLacks(req, allDevices, req.body.deviceIds, area)) return res.status(403).json({ error: 'Cannot grant a wider camera scope than your own' });
    const label = String(req.body.label || role.label || '').trim();
    db.run('UPDATE roles SET label = ?, all_devices = ?, area_scope = ? WHERE id = ?',
      [label, allDevices ? 1 : 0, JSON.stringify(area), role.id], (uErr) => {
        if (uErr) return res.status(500).json({ error: uErr.message });
        writeRoleGrants(role.id, perms, req.body.deviceIds, allDevices, () => {
          saveLog(req.user.username, 'Edit Role', `แก้ role "${role.name}" (${perms.length} สิทธิ์)`);
          res.json({ success: true });
        });
      });
  });
});

app.delete('/api/roles/:id', requirePerm('user.manage'), (req, res) => {
  db.get('SELECT * FROM roles WHERE id = ?', [req.params.id], (err, role) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_system) return res.status(403).json({ error: 'System role cannot be deleted' });
    db.get('SELECT COUNT(*) AS n FROM users WHERE role_id = ?', [role.id], (cErr, row) => {
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (row.n > 0) return res.status(409).json({ error: `Role still has ${row.n} user(s)` });
      db.serialize(() => {
        db.run('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
        db.run('DELETE FROM role_devices WHERE role_id = ?', [role.id]);
        db.run('DELETE FROM roles WHERE id = ?', [role.id], (dErr) => {
          if (dErr) return res.status(500).json({ error: dErr.message });
          invalidateRoleCache();
          saveLog(req.user.username, 'Delete Role', `ลบ role "${role.name}"`);
          res.json({ success: true });
        });
      });
    });
  });
});

app.get('/api/users', requirePerm('user.manage'), (req, res) => {
  db.all("SELECT * FROM users", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let filtered = rows || [];
    // 💡 หากผู้ใช้งานปัจจุบันไม่ใช่ superadmin จะไม่แสดงข้อมูลผู้ใช้ระดับ superadmin เด็ดขาดค่ะ
    if (req.user.role !== 'superadmin') {
      filtered = filtered.filter(u => u.role !== 'superadmin');
    }
    // ตัด password ทิ้งก่อนส่งกลับเสมอ — เดิมส่ง plaintext กลับไปเต็มๆ ทำให้ฟอร์ม edit ฝั่งเว็บ
    // เผลอ prefill รหัสผ่านจริงเข้าไปในช่อง password โดยไม่ตั้งใจ
    res.json(filtered.map(({ password, ...u }) => ({ ...u, allowedCameras: JSON.parse(u.allowedCameras || '[]') })));
  });
});
app.post('/api/users', requirePerm('user.manage'), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role;
  if (!username) return res.status(400).json({ success: false, error: 'Username is required' });
  if (username.length > 64) return res.status(400).json({ success: false, error: 'Username is too long' });
  if (!password || password.length < 4) return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
  if (typeof role !== 'string' || !role.trim()) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }
  // 💡 ป้องกันไม่ให้ผู้ใช้สิทธิ์อื่นแต่งตั้งหรือสร้างบัญชีที่เป็น superadmin ค่ะ
  if (role === 'superadmin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Access denied: cannot create superadmin user' });
  }
  const roleId = roleIdFor(role, req.body.role_id);
  checkAssignableRole(req, roleId, role, (roleErr) => {
    if (roleErr) return res.status(roleErr.status).json({ success: false, error: roleErr.error });
    db.get("SELECT id FROM users WHERE username = ?", [username], async (err, existing) => {
      if (err) return res.status(500).json({ success: false, error: err.message });
      if (existing) return res.status(400).json({ success: false, error: 'Username already exists' });
      const hashed = await hashPassword(password);
      db.run("INSERT INTO users (id, username, password, role, role_id, allowedCameras) VALUES (?,?,?,?,?,?)", [req.body.id, username, hashed, role, roleId, JSON.stringify(req.body.allowedCameras || [])], function(err) {
        if (err) res.status(400).json({ success: false, error: 'Username already exists' });
        else res.json({ success: true });
      });
    });
  });
});
app.put('/api/users/:id', requirePerm('user.manage'), (req, res) => {
  // 💡 ป้องกันไม่ให้ผู้ใช้ทั่วไปหรือ admin ปกติทำการดัดแปลงสิทธิ์หรือข้อมูลผู้ใช้ระดับ superadmin ค่ะ
  db.get("SELECT * FROM users WHERE id = ?", [req.params.id], (err, targetUser) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied: cannot modify superadmin user' });
    }
    if (req.body.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied: cannot assign superadmin role' });
    }
    // route นี้ไม่เคยตรวจว่า role ที่ส่งมาเป็นค่าที่รู้จักหรือไม่ (POST /api/users ตรวจ แต่ PUT ไม่ตรวจ)
    // ปล่อยไว้จะเขียน role อะไรก็ได้ลง DB แล้วผู้ใช้คนนั้นจะไม่ตรงกับ ELEVATED/MANAGE_ROLES เลย
    // = เข้าระบบได้แต่ทำอะไรไม่ได้ และไม่มีอะไรบอกว่าทำไม
    if (typeof req.body.role !== 'string' || !req.body.role.trim()) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }

    const isSelf = targetUser.id === req.user.id;
    const demotingFromElevated = isElevatedRole(targetUser.role) && !isElevatedRole(req.body.role);
    const currentRoleId = targetUser.role_id || roleIdFor(targetUser.role);
    const nextRoleId = roleIdFor(req.body.role, req.body.role_id);

    if (nextRoleId === currentRoleId && req.body.role !== targetUser.role) {
      return res.status(400).json({ success: false, error: 'Role and role_id do not match' });
    }

    if (isSelf && (req.body.role !== targetUser.role || nextRoleId !== currentRoleId)) {
      return res.status(403).json({ success: false, error: 'Cannot change your own role' });
    }
    // ย้าย role = มอบสิทธิ์ชุดใหม่ ต้องผ่านกฎเดียวกับการสร้างผู้ใช้ · role เดิมไม่ต้องตรวจซ้ำ (แก้ชื่อ/รหัสได้ตามปกติ)
    const checkRole = (next) => (nextRoleId === currentRoleId ? next() : checkAssignableRole(req, nextRoleId, req.body.role, (roleErr) => (
      roleErr ? res.status(roleErr.status).json({ success: false, error: roleErr.error }) : next()
    )));
    checkManageableUser(req, targetUser, (targetErr) => {
      if (targetErr) return res.status(targetErr.status).json({ success: false, error: targetErr.error });
      checkRole(() => {
        if (demotingFromElevated) {
          countRemainingAdmins(db, targetUser.id, (cErr, remaining) => {
            if (cErr) return res.status(500).json({ success: false, error: cErr.message });
            if (remaining <= 0) {
              return res.status(403).json({ success: false, error: 'Cannot demote the last remaining administrator' });
            }
            applyUserUpdate();
          });
        } else {
          applyUserUpdate();
        }
      });
    });

    async function applyUserUpdate() {
      // password ว่าง = ไม่เปลี่ยนรหัสผ่านเดิม (ฟอร์ม edit ฝั่งเว็บไม่ prefill รหัสผ่านจริงแล้ว
      // ดังนั้นเว้นว่างไว้ต้องหมายถึง "ไม่แก้" ไม่ใช่ "เซ็ตเป็นค่าว่าง")
      const nextPassword = req.body.password ? await hashPassword(String(req.body.password)) : targetUser.password;
      db.run("UPDATE users SET username=?, password=?, role=?, role_id=?, allowedCameras=? WHERE id=?", [req.body.username, nextPassword, req.body.role, nextRoleId, JSON.stringify(req.body.allowedCameras || []), req.params.id], function(err) {
        if (err) return res.status(400).json({ success: false, error: err.message });
        /*
          เปลี่ยนรหัสผ่าน = session ทุกใบของบัญชีนั้นใช้ไม่ได้ทันที (ลายนิ้วมือใน token ไม่ตรง hash ใหม่)
          ถ้าเปลี่ยนของตัวเอง ออก token ใหม่ให้เลย ไม่งั้นกดบันทึกแล้วหลุดออกจากระบบทันที
        */
        if (isSelf && req.body.password) {
          const session = sessionToken.signSession({ id: targetUser.id, password: nextPassword });
          return res.json({ success: true, token: session.token, expiresAt: session.expiresAt });
        }
        res.json({ success: true });
      });
    }
  });
});
app.delete('/api/users/:id', requirePerm('user.manage'), (req, res) => {
  // 💡 ป้องกันไม่ให้ผู้ใช้ระดับอื่นทำการลบบัญชี superadmin ค่ะ
  db.get("SELECT * FROM users WHERE id = ?", [req.params.id], (err, targetUser) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied: cannot delete superadmin user' });
    }
    if (targetUser.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'Cannot delete your own account' });
    }

    const finalizeDelete = () => {
      db.run("DELETE FROM users WHERE id=?", [req.params.id], () => res.json({ success: true }));
    };
    checkManageableUser(req, targetUser, (targetErr) => {
      if (targetErr) return res.status(targetErr.status).json({ success: false, error: targetErr.error });
      if (isElevatedRole(targetUser.role)) {
        countRemainingAdmins(db, targetUser.id, (cErr, remaining) => {
          if (cErr) return res.status(500).json({ success: false, error: cErr.message });
          if (remaining <= 0) {
            return res.status(403).json({ success: false, error: 'Cannot delete the last remaining administrator' });
          }
          finalizeDelete();
        });
      } else {
        finalizeDelete();
      }
    });
  });
});

app.delete('/api/logs/clear', requirePerm('log.purge'), (req, res) => {
  let q = "DELETE FROM logs WHERE 1=1", p = [];
  if (req.query.date) { q += " AND timestamp LIKE ?"; p.push(`${req.query.date}%`); }
  db.run(q, p, () => res.json({ success: true }));
});

// --- CAMERA & NVR ---
// ฟังก์ชันเช็กพอร์ตว่าเปิดอยู่หรือไม่ด้วยการเชื่อมต่อแบบ TCP
const checkPort = (ip, port, timeout = 1000) => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeout);

    socket.connect(port, ip, () => {
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        resolve(true);
      }
    });

    socket.on('error', () => {
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        resolve(false);
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        resolve(false);
      }
    });
  });
};

// ฟังก์ชันสแกนไอพีขนานทั้งหมดในวง Subnet (แบบจัดกลุ่มเพื่อความเสถียรข้ามเครือข่าย)
/**
 * เป็นอุปกรณ์ ONVIF ไหม — ถามด้วย GetSystemDateAndTime ซึ่งมาตรฐาน ONVIF กำหนดให้ตอบได้โดยไม่ต้องมีรหัส
 *
 * เดิมเช็คด้วย OnvifDevice.init() แบบไม่มีรหัส ซึ่งเรียก GetCapabilities/GetProfiles ต่อ กล้องที่บังคับ
 * รหัสทุกคำสั่ง (Axis) ตอบ 401 แล้วถูกตัดทิ้ง สแกนทั้งวงจึงไม่เจอ Axis สักตัว (พบ 2026-09-23 ที่ edge 002)
 */
const probeOnvifUnauthenticated = (ip, port) => new Promise((resolve) => {
  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>'
    + '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>';
  const req = http.request({
    host: ip, port, path: '/onvif/device_service', method: 'POST', timeout: 3000,
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { if (text.length < 8192) text += c; });
    res.on('end', () => resolve(res.statusCode === 200 && /SystemDateAndTime/i.test(text)));
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
  req.end(body);
});

/**
 * เป็นกล้อง Axis ไหม — basicdeviceinfo ของ VAPIX ตอบข้อมูลรุ่นโดยไม่ต้องมีรหัส (AXIS OS 12, ทดสอบ 2026-09-23)
 * คืน { model, firmware } หรือ null · ใช้ตั้งยี่ห้อให้ถูกตั้งแต่ผลสแกน เพราะ Axis ต้องการบัญชี ONVIF แยก
 * ถ้าไม่รู้ว่าเป็น Axis ระบบจะเดา RTSP แบบกล้องทั่วไป (/onvif1) ซึ่ง Axis ไม่มี
 */
const probeAxis = (ip, port = 80) => new Promise((resolve) => {
  const body = JSON.stringify({ apiVersion: '1.0', method: 'getAllUnrestrictedProperties' });
  const req = http.request({
    host: ip, port, path: '/axis-cgi/basicdeviceinfo.cgi', method: 'POST', timeout: 3000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { if (text.length < 16384) text += c; });
    res.on('end', () => {
      try {
        const props = JSON.parse(text)?.data?.propertyList;
        if (res.statusCode === 200 && props && /axis/i.test(props.Brand || '')) {
          return resolve({ model: props.ProdShortName || props.ProdNbr || 'AXIS', firmware: props.Version || null });
        }
      } catch { /* ไม่ใช่ JSON = ไม่ใช่ Axis */ }
      resolve(null);
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(null));
  req.end(body);
});

const scanSubnet = async (subnetPrefix) => {
  const activeIPs = [];
  const portsToCheck = [80, 8080, 8000, 8880];
  const batchSize = 30; // รันตรวจขนานครั้งละ 30 โฮสต์ เพื่อป้องกันตารางเซสชันของเราเตอร์ปลายทางเต็ม
  
  for (let i = 1; i <= 254; i += batchSize) {
    const batch = [];
    for (let j = i; j < i + batchSize && j <= 254; j++) {
      const ip = `${subnetPrefix}${j}`;
      batch.push((async () => {
        // วนตรวจสอบพอร์ตที่เป็นไปได้ของบริการกล้อง
        for (const port of portsToCheck) {
          const open = await checkPort(ip, port, 1200); // 1200ms เพื่อรองรับความล่าช้าในเน็ตเวิร์กที่เชื่อมต่อข้ามวง VPN/L3
          if (open) {
            activeIPs.push({ ip, port: String(port) });
            break; // หากพบพอร์ตบริการเปิดอยู่ ไม่จำเป็นต้องสแกนพอร์ตถัดไปของโฮสต์นี้ค่ะ
          }
        }
      })());
    }
    await Promise.all(batch);
  }
  return activeIPs;
};

app.get('/api/scan', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  try {
    const targetSubnet = req.query.subnet;
    
    if (targetSubnet && targetSubnet.trim() !== '') {
      console.log(`[Network Scan] Starting unicast scan on subnet: ${targetSubnet}`);
      let prefix = targetSubnet.trim();
      if (!prefix.endsWith('.')) {
        prefix += '.';
      }
      
      const activeIPs = await scanSubnet(prefix);
      console.log(`[Network Scan] Found ${activeIPs.length} active hosts on port 80/8080`);
      
      const foundDevices = [];
      const probeTasks = activeIPs.map(async (item) => {
        // ไม่ใช้ init() แบบไม่มีรหัส — กล้องที่บังคับรหัส (Axis) ตอบ 401 แล้วหลุดจากผลสแกน
        if (!(await probeOnvifUnauthenticated(item.ip, item.port))) return;
        const axis = await probeAxis(item.ip, item.port);
        foundDevices.push({
          id: `unicast_${item.ip.replace(/\./g, '_')}`,
          name: axis ? `${axis.model} (${item.ip})` : `ONVIF Device (${item.ip}:${item.port})`,
          ip: item.ip,
          onvifPort: String(item.port),
          ...(axis ? { brand: 'axis', model: axis.model } : {}),
        });
      });
      await Promise.all(probeTasks);
      
      console.log(`[Network Scan] Found ${foundDevices.length} ONVIF devices`);
      return res.json(foundDevices);
    }
    
    // หากไม่มีการระบุวงเครือข่าย ให้ใช้วิธี Multicast Probe แบบดั้งเดิม
    const devices = await onvif.startProbe();
    res.json(devices.map((d, i) => {
      const m = d.xaddrs[0].match(/(?:[0-9]{1,3}\.){3}[0-9]{1,3}/);
      const portMatch = d.xaddrs[0].match(/(?:[0-9]{1,3}\.){3}[0-9]{1,3}:([0-9]+)/);
      const port = portMatch ? portMatch[1] : '80';
      // WS-Discovery บอกชื่อ/ฮาร์ดแวร์ใน scope — Axis ใส่คำว่า AXIS ไว้ ใช้ตั้งยี่ห้อได้เลยไม่ต้องถามซ้ำ
      const isAxis = /axis/i.test(`${d.name || ''} ${d.hardware || ''}`);
      return {
        id: `onvif_${i}`,
        name: isAxis ? `${d.hardware || d.name || 'AXIS'} (${m ? m[0] : '?'})` : `ONVIF Device (${m ? m[0] : '?'})`,
        ip: m ? m[0] : '',
        onvifPort: port,
        ...(isAxis ? { brand: 'axis', model: d.hardware || d.name || null } : {}),
      };
    }));
  } catch (e) { 
    console.error('[Network Scan Error] Scan failed:', e);
    res.status(500).json({ error: 'Scan failed' }); 
  }
});
/**
 * สแกน NVR ซ้ำ = อัปเดต sub ของช่องที่แอดไว้แล้วให้ตรงกับที่ ONVIF รายงานตอนนี้ (main ไม่แตะ)
 *
 * แถว onvif_nvr ไม่มีทางอื่นที่จะได้ sub ใหม่: bulk-add ข้ามช่องที่มีอยู่ และ PUT คง sub เดิมไว้เมื่อ main ไม่เปลี่ยน
 * — ช่องที่แอดก่อน 2026-09-25 ได้ sub จากกติกาเดิม (profile ละเอียดต่ำสุด = stream 3 ถ้ามี) จึงค้างอยู่อย่างนั้น
 * จับคู่ด้วย main ที่ตรงกันเท่านั้น ช่องที่ยังรอ RTSP ปล่อยให้ resolvePendingUniviewStreams เติม
 */
async function refreshExistingNvrSubs(pairs) {
  let updated = 0;
  for (const { row, channel } of pairs) {
    const sub = channel.sub;
    if (!row?.rtsp || !channel.main?.rtsp || !sub?.rtsp) continue;
    if (rtspIdentity(row.rtsp) !== rtspIdentity(channel.main.rtsp)) continue;
    if (row.rtsp_sub && rtspIdentity(row.rtsp_sub) === rtspIdentity(sub.rtsp)) continue;
    const result = await new Promise((resolve) => db.run(
      "UPDATE cameras SET rtsp_sub = ?, onvif_sub_token = ? WHERE id = ? AND type = 'onvif_nvr'",
      [sub.rtsp, sub.token || null, row.id],
      function cb(err) { resolve(err ? { changes: 0 } : this); },
    ));
    updated += result.changes || 0;
  }
  if (updated) {
    console.log(`[NVR Scan] อัปเดต sub ของช่องที่แอดแล้ว ${updated} ช่อง`);
    setTimeout(syncCamerasToStreamCore, 2000);
    notifyCatalogChanged();
  }
  return updated;
}

app.post('/api/nvr/channels', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  const { ip, onvifPort, user, pass, milestoneBridge = false } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const groups = await probeOnvifChannelGroupsWithRetry({
      ip,
      onvifPort: onvifPort || 80,
      user: user || 'admin',
      pass: pass || '',
      milestoneBridge: milestoneBridge === true,
    });
    if (!groups.length) {
      return res.status(502).json({ error: 'ONVIF connected but no media profiles with RTSP URI' });
    }
    /*
      บอกว่าช่องไหนแอดไว้แล้ว (เทียบ RTSP โดยไม่สนรหัส) — สแกน NVR เดิมซ้ำตอนกล้องที่เคยออฟไลน์กลับมา
      จะเลือกให้เฉพาะช่องที่ยังไม่มี ไม่ได้แถวซ้ำ
    */
    const existing = await new Promise((resolve) => db.all(
      'SELECT id, name, rtsp, rtsp_sub FROM cameras WHERE rtsp IS NOT NULL',
      (err, rows) => resolve(err ? [] : rows || []),
    ));
    const byRtsp = new Map(existing.map((r) => [rtspIdentity(r.rtsp), r]));
    const hits = groups.map((g) => ({ channel: g, row: g.main?.rtsp ? byRtsp.get(rtspIdentity(g.main.rtsp)) : null }));
    const subsUpdated = await refreshExistingNvrSubs(hits.filter((h) => h.row));
    res.set('X-Subs-Updated', String(subsUpdated));
    res.json(hits.map(({ channel: g, row: hit }) => (hit ? { ...g, existingId: hit.id, existingName: hit.name } : g)));
  } catch (e) {
    console.error('[NVR ONVIF Scan]', ip, redactUrls(e.stack || e.message));
    res.status(500).json({ error: e.message || 'ONVIF scan failed' });
  }
});
app.post('/api/nvr/axis/channels', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  const { ip, apiPort, user, pass } = req.body || {};
  try {
    const devices = await readAxisS30Devices({ ip, apiPort, user, pass });
    const existing = await new Promise((resolve) => db.all(
      "SELECT id, name, ip, onvif_main_token FROM cameras WHERE brand = 'axis' AND type = 'onvif_nvr'",
      (err, rows) => resolve(err ? [] : rows || []),
    ));
    const bySource = new Map(existing.map((row) => [`${row.ip}:${row.onvif_main_token}`, row]));
    res.json(devices.map((device) => {
      const row = bySource.get(`${ip}:${device.sourceId}`);
      return row ? { ...device, existingId: row.id, existingName: row.name } : device;
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
app.post('/api/nvr/uniview/channels', edgeOnly, requirePerm('device.manage'), async (req, res) => {
  const { ip, onvifPort, apiPort, user, pass } = req.body || {};
  const port = Number(apiPort);
  if (!ip) return res.status(400).json({ error: 'ip required' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'valid Uniview API port required' });
  }
  try {
    const apiChannels = await readUniviewChannels({ ip, apiPort: port, user: user || 'admin', pass: pass || '' });
    let onvifChannels = [];
    try {
      onvifChannels = await probeOnvifChannelGroupsWithRetry({
        ip, onvifPort: onvifPort || 80, user: user || 'admin', pass: pass || '',
      });
    } catch (err) {
      // LAPI ยังให้เลขและชื่อช่องแม้ ONVIF ใช้งานไม่ได้; แสดงเป็นรอภาพไว้ก่อน
      console.warn(`[Uniview NVR Scan] ${ip}: ONVIF ไม่มี RTSP — ${redactUrls(err.message)}`);
    }
    const merged = mergeUniviewChannels(apiChannels, onvifChannels);
    const existing = await new Promise((resolve) => db.all(
      'SELECT id, name, rtsp, rtsp_sub, ip, onvifPort, nvr_channel FROM cameras WHERE rtsp IS NOT NULL OR nvr_channel IS NOT NULL',
      (err, rows) => resolve(err ? [] : rows || []),
    ));
    const byRtsp = new Map(existing.filter((row) => row.rtsp).map((row) => [rtspIdentity(row.rtsp), row]));
    const byChannel = new Map(existing.filter((row) => row.nvr_channel != null)
      .map((row) => [`${row.ip}:${row.onvifPort}:${row.nvr_channel}`, row]));
    const hits = merged.map((channel) => ({
      channel,
      row: byChannel.get(`${ip}:${onvifPort}:${channel.channel}`)
        || (channel.main?.rtsp ? byRtsp.get(rtspIdentity(channel.main.rtsp)) : null),
    }));
    const subsUpdated = await refreshExistingNvrSubs(hits.filter((h) => h.row));
    res.set('X-Subs-Updated', String(subsUpdated));
    res.json(hits.map(({ channel, row: hit }) => (hit ? { ...channel, existingId: hit.id, existingName: hit.name } : channel)));
  } catch (e) {
    console.error('[Uniview NVR Scan]', ip, redactUrls(e.message));
    res.status(502).json({ error: e.message || 'Uniview NVR scan failed' });
  }
});
// ช่อง Uniview ที่เพิ่มตอน offline ยังไม่มี RTSP: ถาม ONVIF ซ้ำเป็นชุดต่อ NVR และเติมแถวเดิม
// เมื่อ NVR คืน URI จริง เพื่อรักษา id/Global ID/หมุด/สิทธิ์ ไม่สร้าง URL จากรูปแบบที่คาดเดา
let resolvingUniviewStreams = false;
async function resolvePendingUniviewStreams() {
  if (GATEWAY_ROLE !== 'edge' || resolvingUniviewStreams) return;
  resolvingUniviewStreams = true;
  try {
    const pending = await new Promise((resolve, reject) => db.all(
      `SELECT id, ip, onvifPort, onvifUser, onvifPass, nvr_channel FROM cameras
       WHERE brand = 'uniview' AND nvr_channel IS NOT NULL AND (rtsp IS NULL OR rtsp = '')`,
      (err, rows) => err ? reject(err) : resolve(rows || []),
    ));
    const groups = new Map();
    for (const row of pending) {
      const key = JSON.stringify([row.ip, row.onvifPort, row.onvifUser, row.onvifPass]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    let updated = 0;
    for (const rows of groups.values()) {
      const first = rows[0];
      try {
        const found = await probeOnvifChannelGroupsWithRetry({
          ip: first.ip, onvifPort: first.onvifPort || 80,
          user: first.onvifUser || 'admin', pass: first.onvifPass || '',
        }, 1);
        const byNumber = new Map(found.filter((ch) => !ch.noVideoSource && ch.main?.rtsp)
          .map((ch) => [ch.channel, ch]));
        for (const row of rows) {
          const ch = byNumber.get(row.nvr_channel);
          if (!ch) continue;
          const result = await new Promise((resolve, reject) => db.run(
            `UPDATE cameras SET rtsp = ?, rtsp_sub = ?, onvif_main_token = ?, onvif_sub_token = ?
             WHERE id = ? AND (rtsp IS NULL OR rtsp = '') AND nvr_channel = ?`,
            [ch.main.rtsp, ch.sub?.rtsp || ch.main.rtsp, ch.main.token || null,
              ch.sub?.token || ch.main.token || null, row.id, row.nvr_channel],
            function cb(err) { return err ? reject(err) : resolve(this); },
          ));
          if (result.changes) {
            updated += 1;
            discoverCameraAi(row.id, 'Uniview ช่องกลับมาออนไลน์');
          }
        }
      } catch (err) {
        console.warn(`[Uniview pending] ${first.ip}: ${redactUrls(err.message)}`);
      }
    }
    if (updated) {
      console.log(`[Uniview pending] เติม RTSP จาก ONVIF ${updated} ช่อง`);
      syncCamerasToStreamCore();
      notifyCatalogChanged();
    }
  } catch (err) {
    console.warn(`[Uniview pending] ${redactUrls(err.message)}`);
  } finally {
    resolvingUniviewStreams = false;
  }
}
// --- VIEWS & PLANS ---
// Floor Plan removed (2026-07) — routes/uploads dropped.

// ฟังก์ชันช่วยแปลงข้อมูลการใช้งาน Disk จากคำสั่ง wmic หรือ PowerShell ของ Windows เป็น Object ที่เหมาะสม
const parseDiskStdout = (stdout) => {
  const lines = stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split(/\s+/);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const val1 = parseInt(parts[0]);
      const val2 = parseInt(parts[1]);
      const free = Math.min(val1, val2);
      const total = Math.max(val1, val2);
      if (total > 0) {
        const used = total - free;
        const totalGB = (total / 1073741824).toFixed(1) + 'G';
        const usedGB = (used / 1073741824).toFixed(1) + 'G';
        const percent = Math.round((used / total) * 100);
        return { total: totalGB, used: usedGB, percent: percent };
      }
    }
  }
  return { total: '0G', used: '0G', percent: 0 };
};

// --- STATS ---
let curCPU = 0, lastIn = 0, lastOut = 0, netIn = 0, netOut = 0;
const getCPUUsage = () => {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0, total = 0;
  cpus.forEach(cpu => {
    user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys;
    idle += cpu.times.idle; irq += cpu.times.irq;
  });
  total = user + nice + sys + idle + irq;
  return { idle, total };
};
// GPU utilization — โพลแยกจากรอบ CPU/net เพราะ nvidia-smi ช้ากว่า และเครื่องที่ไม่มี NVIDIA
// จะให้ค่า null ไปเลย (frontend ซ่อน widget GPU ทิ้ง) แทนที่จะโชว์ 0% หลอกตา
let gpuStats = null;
let gpuPollInFlight = false;
const pollGpuStats = () => {
  if (gpuPollInFlight) return;
  gpuPollInFlight = true;
  exec(
    'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
    { timeout: 5000, windowsHide: true },
    (err, stdout) => {
      gpuPollInFlight = false;
      if (err || !stdout || !stdout.trim()) { gpuStats = null; return; }
      const gpus = stdout.trim().split('\n').map((line) => {
        const p = line.split(',').map((s) => s.trim());
        return {
          name: p[0] || 'GPU',
          util: Number(p[1]) || 0,
          memUsedMB: Number(p[2]) || 0,
          memTotalMB: Number(p[3]) || 0,
          temp: Number(p[4]) || 0,
        };
      });
      gpuStats = gpus.length ? gpus : null;
    }
  );
};
pollGpuStats();
setInterval(pollGpuStats, 3000);

let startStats = getCPUUsage();
setInterval(() => {
  const endStats = getCPUUsage();
  const idleDiff = endStats.idle - startStats.idle;
  const totalDiff = endStats.total - startStats.total;
  curCPU = (100 - Math.floor(100 * idleDiff / totalDiff)).toFixed(1);
  startStats = endStats;

  if (process.platform === 'win32') {
    // ดึงข้อมูลการใช้แบนด์วิดท์เครือข่ายสำหรับ Windows Server
    exec("powershell -Command \"Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes, SentBytes -Sum | Select-Object -Property Property, Sum\"", { windowsHide: true }, (err, stdout) => {
      if (!err && stdout) {
        const lines = stdout.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let rx = 0, tx = 0;
        lines.forEach(line => {
          if (line.startsWith('ReceivedBytes')) {
            rx = parseInt(line.split(/\s+/)[1]) || 0;
          } else if (line.startsWith('SentBytes')) {
            tx = parseInt(line.split(/\s+/)[1]) || 0;
          }
        });
        if (lastIn > 0) {
          // หาร 2 เนื่องจากค่าสะสมนี้วัดห่างกัน 2 วินาที (2000ms) เพื่อหาปริมาณเฉลี่ยต่อวินาที (MB/s)
          netIn = (((rx - lastIn) / 1048576) / 2).toFixed(2);
          netOut = (((tx - lastOut) / 1048576) / 2).toFixed(2);
        }
        lastIn = rx; lastOut = tx;
      }
    });
  } else {
    // ดึงข้อมูลการใช้แบนด์วิดท์เครือข่ายสำหรับ Linux
    exec("cat /proc/net/dev | grep -v '|' | grep -v 'lo' | awk '{inb+=$2; outb+=$10} END {print inb, outb}'", (err, stdout) => {
      if (!err && stdout) {
        const p = stdout.trim().split(/\s+/);
        const ci = parseInt(p[0]), co = parseInt(p[1]);
        if (lastIn > 0) { 
          // หาร 2 สำหรับรอบตรวจสอบ 2 วินาที
          netIn = (((ci - lastIn) / 1048576) / 2).toFixed(2); 
          netOut = (((co - lastOut) / 1048576) / 2).toFixed(2); 
        }
        lastIn = ci; lastOut = co;
      }
    });
  }
}, 2000);

app.get('/api/stats', (req, res) => {
  const tr = os.totalmem(), fr = os.freemem(), ur = tr - fr;
  
  if (process.platform === 'win32') {
    // ดึงข้อมูลพื้นที่ Disk ของ Drive ที่รันโปรเจคอยู่บน Windows
    const drive = path.resolve(__dirname).substring(0, 2);
    exec(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace,Size`, { windowsHide: true }, (err, stdout) => {
      let d = { total: '0G', used: '0G', percent: 0 };
      if (!err && stdout && stdout.includes('Size')) {
        d = parseDiskStdout(stdout);
        res.json({
          cpu: curCPU,
          ram: ((ur / tr) * 100).toFixed(1),
          usedRamGB: (ur / 1073741824).toFixed(2),
          totalRamGB: (tr / 1073741824).toFixed(2),
          disk: d,
          net: { in: netIn, out: netOut },
        gpu: gpuStats,
          gpu: gpuStats,
          streamDegraded: streamHealthSummary.degraded || 0,
          streamOnline: streamHealthSummary.online || 0,
          streamOffline: streamHealthSummary.offline || 0,
          streamTotal: streamHealthSummary.total || 0,
        });
      } else {
        // ลองเรียกใช้ PowerShell สำรองกรณี wmic มีปัญหา
        exec(`powershell -Command "Get-CimInstance -ClassName Win32_LogicalDisk -Filter \\"DeviceID='${drive}'\\" | Select-Object Size, FreeSpace"`, { windowsHide: true }, (err2, stdout2) => {
          if (!err2 && stdout2) {
            d = parseDiskStdout(stdout2);
          }
          res.json({
            cpu: curCPU,
            ram: ((ur / tr) * 100).toFixed(1),
            usedRamGB: (ur / 1073741824).toFixed(2),
            totalRamGB: (tr / 1073741824).toFixed(2),
            disk: d,
            net: { in: netIn, out: netOut },
        gpu: gpuStats,
          gpu: gpuStats,
            streamDegraded: streamHealthSummary.degraded || 0,
            streamOnline: streamHealthSummary.online || 0,
            streamOffline: streamHealthSummary.offline || 0,
            streamTotal: streamHealthSummary.total || 0,
          });
        });
      }
    });
  } else {
    // ดึงข้อมูลพื้นที่ Disk สำหรับ Linux
    exec('df -h / | tail -1', (err, stdout) => {
      let d = { total: '0G', used: '0G', percent: 0 };
      if (!err && stdout) {
        const p = stdout.trim().split(/\s+/);
        if (p.length >= 5) { d.total = p[1]; d.used = p[2]; d.percent = parseInt(p[4]); }
      }
      res.json({
        cpu: curCPU,
        ram: ((ur / tr) * 100).toFixed(1),
        usedRamGB: (ur / 1073741824).toFixed(2),
        totalRamGB: (tr / 1073741824).toFixed(2),
        disk: d,
        net: { in: netIn, out: netOut },
        gpu: gpuStats,
        streamDegraded: streamHealthSummary.degraded || 0,
        streamOnline: streamHealthSummary.online || 0,
        streamOffline: streamHealthSummary.offline || 0,
        streamTotal: streamHealthSummary.total || 0,
      });
    });
  }
});

// --- LOGS ---
app.get('/api/logs', requirePerm('menu.logs'), (req, res) => {
  const { date, type } = req.query;
  let q = "SELECT * FROM logs", p = [];
  if (date || type) {
    q += " WHERE 1=1";
    if (date) { q += " AND timestamp LIKE ?"; p.push(`${date}%`); }
    if (type && type !== 'all') { q += " AND action = ?"; p.push(type); }
  }
  q += " ORDER BY timestamp DESC LIMIT 500";
  db.all(q, p, (err, rows) => res.json(rows || []));
});
app.post('/api/logs', (req, res) => {
  // บังคับใช้ชื่อผู้ใช้จาก session ไม่ใช่จาก body — ไม่งั้นเขียน log สวมชื่อคนอื่นได้
  // ซึ่งทำให้ audit log เชื่อถือไม่ได้ทั้งตาราง
  const { action, details } = req.body;
  saveLog(req.user.username, action, details);
  res.json({ success: true });
});

// ==================== SYSTEM BACKUP & RESTORE APIS ====================
const dbUpload = multer({ storage: multer.diskStorage({
  destination: (q, f, c) => c(null, path.dirname(dbPath)),
  filename: (q, f, c) => c(null, 'vms_restore_temp.db')
}) });

app.get('/api/system/backup', requirePerm('system.maintain'), (req, res) => {
  const dbFile = dbPath;
  if (fs.existsSync(dbFile)) {
    saveLog(req.user.username, 'Backup DB', 'สำรองข้อมูลระบบฐานข้อมูลสำเร็จ 💾');
    res.download(dbFile, `vms-backup-${Date.now()}.db`);
  } else {
    res.status(404).json({ error: 'Database file not found' });
  }
});

app.post('/api/system/restore', requirePerm('system.maintain'), dbUpload.single('backup'), (req, res) => {
  const tempPath = stateFile('vms_restore_temp.db');
  const targetPath = dbPath;
  
  if (!fs.existsSync(tempPath)) {
    return res.status(400).json({ error: 'Uploaded file not found' });
  }
  
  // ลบไฟล์ที่อัปโหลดทิ้งเสมอ ไม่ว่าจะสำเร็จหรือไม่ — ไฟล์นี้คือ DB ทั้งก้อน (มีรหัสกล้อง) ห้ามค้างบนดิสก์
  const dropTemp = () => { try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* ignore */ } };
  db.close((err) => {
    // ปิดไม่สำเร็จ (เช่นมีคำสั่งค้าง) = connection เดิมยังเปิดอยู่และใช้ต่อได้ — ไม่แตะไฟล์ DB เลย
    if (err) {
      dropTemp();
      console.error('[Restore Error] ปิดฐานข้อมูลไม่สำเร็จ:', err.message);
      return res.status(500).json({ error: `ปิดฐานข้อมูลเพื่อกู้คืนไม่สำเร็จ: ${err.message}` });
    }
    try {
      // Snapshot the CURRENT db before overwriting it — a restore replaces EVERY table, so
      // without this a wrong/accidental restore is irreversible and leaves no trace (this is the
      // leading suspect for the 2026-07-21 loss where an evening's user + camera additions
      // vanished with nothing in the logs). The timestamped copy makes it undoable + auditable.
      const stamp = nowIso().replace(/[:.+]/g, '-');
      const snapPath = stateFile(`vms.db.before-restore-${stamp}`);
      if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, snapPath);
      // The old db's -wal/-shm MUST be removed before swapping in a different main file —
      // otherwise SQLite may try to replay the previous database's WAL frames onto the restored
      // file (mismatched db = corruption). The old endpoint left them in place.
      for (const ext of ['-wal', '-shm']) {
        try { if (fs.existsSync(targetPath + ext)) fs.unlinkSync(targetPath + ext); } catch (_) { /* ignore */ }
      }
      fs.copyFileSync(tempPath, targetPath);
      fs.unlinkSync(tempPath);
      console.warn(`[Restore] ${req.user?.username || 'unknown'} restored DB — previous state saved to ${path.basename(snapPath)}`);

      res.json({ success: true, snapshot: path.basename(snapPath) });

      // ปิดโปรเซสเพื่อให้ PM2 ชุบชีวิตขึ้นมาใหม่พร้อมกับไฟล์ DB กู้คืน
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    } catch (e) {
      /*
        db ถูกปิดไปแล้ว — ทุก route ที่แตะฐานข้อมูลจะพังต่อจากนี้ และ module อื่นถือ connection เดิมไว้ เปิดใหม่แทนที่ไม่ได้
        จึงออกให้ pm2 เปิด process ใหม่ (อ่านไฟล์ DB ที่อยู่บนดิสก์ตอนนั้น — ไฟล์เดิม หรือสำเนา before-restore ถ้า copy ค้างครึ่งทาง)
      */
      dropTemp();
      console.error('[Restore Error]', e.message, '— restarting process');
      res.status(500).json({ error: 'Failed to restore database file — ระบบกำลังเริ่มใหม่' });
      setTimeout(() => process.exit(1), 1000);
    }
  });
});
// --- STATUS & WATCHER ---
let camLastStatus = {};
// stream health: TCP ติดแต่ sub ไม่ ready นาน → alert
const STREAM_NOT_READY_MS = Number(process.env.STREAM_NOT_READY_MS || 60000);
const STREAM_ALERT_COOLDOWN_MS = Number(process.env.STREAM_ALERT_COOLDOWN_MS || 300000);
const streamHealthState = {};
let streamHealthSummary = { total: 0, online: 0, degraded: 0, offline: 0, updatedAt: 0 };

app.get('/api/status', (req, res) => res.json(camLastStatus));
// สถานะสามค่าต่อกล้อง (shared/camera-state.js) — /api/status คงรูปเดิมไว้ให้หน้าที่ยังนับ online อยู่
app.get('/api/camera-states', (req, res) => {
  const out = {};
  for (const [id, s] of cameraState.all()) out[id] = publicCameraState(s);
  res.json(out);
});

app.get('/api/system/stream-health', checkAuth, (req, res) => {
  res.json({
    summary: streamHealthSummary,
    cameras: Object.values(streamHealthState),
  });
});

app.post('/api/system/resync-streams', requirePerm('system.maintain'), (req, res) => {
  lastStreamCoreResyncAt = 0;
  const ok = forceStreamCoreResync('manual API');
  res.json({ success: true, triggered: ok });
});

const checkTcpPort = (host, port) => new Promise((resolve) => {
  if (!host || !port) return resolve(false);
  try {
    const socket = net.connect({ host, port, timeout: 2000 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  } catch (e) {
    resolve(false);
  }
});

// TCP probe กล้อง — ภายใต้ go2rtc นี่คือทางหลักที่ตัดสิน online/offline ไม่ใช่ทางสำรอง
// อีกต่อไป เพราะ readyMap ของ MediaMTX เป็น null เสมอ (ดู updateCameraStatuses)
const checkCameraTcp = (rtspUrl) => {
  if (!rtspUrl) return Promise.resolve(false);
  const match = rtspUrl.match(/rtsp:\/\/([^@\n]+@)?([^:\/\n?]+)(:(\d+))?/);
  if (!match) return Promise.resolve(false);
  const host = match[2];
  const port = match[4] ? parseInt(match[4], 10) : 554;
  return checkTcpPort(host, port);
};

// เช็คว่า "ตัวกล้อง" ยังเปิดอยู่บนเน็ตไหม (ไม่ใช่ RTSP stream) — เดิมเช็คแค่ TCP connect เข้า
// พอร์ต ONVIF/HTTP ซึ่งบอกได้แค่ "พอร์ตเปิด" ไม่ได้ยืนยันว่าตัวกล้องตอบ ONVIF จริง (เช่น router
// forward พอร์ตไว้แต่ไม่มีอะไรฟังจริง หรือ service ONVIF บนกล้องค้างแต่ OS ยัง ACK SYN อยู่) —
// เปลี่ยนมาเช็คจาก SOAP handshake จริง (GetCapabilities ผ่าน device.init(), เหมือนที่ใช้ตอน
// scan NVR) ตามที่ user ขอ ("เชคจาก onvif จริงๆ") ยังคง TCP pre-check ไว้ก่อนเพื่อไม่เสีย
// SOAP round-trip กับ IP ที่ไม่มีพอร์ตเปิดเลย (ตายชัดเจนอยู่แล้ว) ใช้แยกแยะ "อุปกรณ์ออนไลน์แต่
// ยังไม่มี stream" ออกจาก "อุปกรณ์ตายจริง" ใน Camera Management
const ONVIF_STATUS_PROBE_TIMEOUT_MS = 4000;
const checkCameraDeviceReachable = async (camera) => {
  if (!camera?.ip) return false;
  const candidatePorts = [
    Number(camera.onvifPort) || 0,
    80,
    443,
  ].filter((p, i, arr) => p > 0 && arr.indexOf(p) === i);
  let tcpReachable = false;
  for (const port of candidatePorts) {
    if (await checkTcpPort(camera.ip, port)) { tcpReachable = true; break; }
  }
  if (!tcpReachable) return false;
  try {
    await withTimeout(
      initOnvifDeviceWithFallback({
        ip: camera.ip,
        onvifPort: camera.onvifPort,
        user: camera.onvifUser,
        pass: camera.onvifPass,
      }),
      ONVIF_STATUS_PROBE_TIMEOUT_MS,
      'ONVIF status probe'
    );
    return true; // GetCapabilities/GetDeviceInformation สำเร็จจริง ไม่ใช่แค่พอร์ตเปิด
  } catch {
    return false;
  }
};

const fetchMtxPathReadyMap = () => new Promise((resolve) => {
  http.get({
    hostname: '127.0.0.1',
    port: 9997,
    path: '/v3/paths/list',
    headers: { 'Accept': 'application/json' }
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      try {
        const resObj = JSON.parse(d);
        const paths = resObj.items || [];
        const map = {};
        for (const p of paths) {
          map[p.name] = Boolean(p.ready);
        }
        resolve(map);
      } catch {
        resolve(null);
      }
    });
  }).on('error', () => resolve(null));
});

const fetchMtxPathReady = (streamName) => new Promise((resolve) => {
  http.get({
    hostname: '127.0.0.1',
    port: 9997,
    path: `/v3/paths/get/${encodeURIComponent(streamName)}`,
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      try { resolve(Boolean(JSON.parse(d).ready)); } catch { resolve(false); }
    });
  }).on('error', () => resolve(false));
});

// รอ path พร้อมเล่นจริง (มี source publish แล้ว) แบบ bounded — ใช้เฉพาะตอน main stream
// on-demand start เพื่อไม่ให้ frontend ยิง HLS request แรกไปชนช่วงที่ยังไม่มีอะไร publish
// (สาเหตุของ error แดง "HLS error. Retrying..." ที่ขึ้นก่อนเสมอ)
const MAIN_STREAM_READY_POLL_MS = Number(process.env.MAIN_STREAM_READY_POLL_MS || 500);
const MAIN_STREAM_READY_MAX_WAIT_MS = Number(process.env.MAIN_STREAM_READY_MAX_WAIT_MS || 8000);
const waitForMtxPathReady = async (streamName) => {
  const deadline = Date.now() + MAIN_STREAM_READY_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await fetchMtxPathReady(streamName)) return true;
    await new Promise((r) => setTimeout(r, MAIN_STREAM_READY_POLL_MS));
  }
  return false;
};

/**
 * นับสตรีมหลักของกล้องที่ core รู้จักอยู่ตอนนี้
 *
 * ใช้เทียบกับจำนวนกล้องใน DB เพื่อจับกรณีที่ core ลืมสตรีมไป ทั้ง MediaMTX และ go2rtc
 * เก็บสตรีมที่เพิ่มผ่าน REST ไว้ในหน่วยความจำ การรีสตาร์ต core จึงล้างทิ้งทั้งหมด และไม่มี
 * ใครบอกเรา — กล้องยังอยู่ใน DB ครบ แต่เปิดดูไม่ได้สักตัวจนกว่าจะมีคน sync ใหม่ด้วยมือ
 *
 * นับเฉพาะ main (ไม่นับ _sub) ให้เทียบกับจำนวนกล้องได้ตรง เพราะกล้องที่ไม่มี substream
 * จะไม่มี path _sub โดยตั้งใจ (ดู go2rtc-sync.js) การนับรวมจึงเทียบกับอะไรไม่ได้เลย
 *
 * @returns {Promise<number>} -1 เมื่อถาม core ไม่ได้ — แยกจาก 0 ซึ่งแปลว่า "ถามได้ แต่ core ไม่มีสตรีมเลย"
 */
const fetchCoreCamPathCount = async () => {
  try {
    const map = await streamCoreClient.listStreams();
    let n = 0;
    for (const name of map.keys()) {
      if (/^cam_/.test(name) && !name.endsWith('_sub')) n += 1;
    }
    return n;
  } catch {
    return -1;
  }
};

let lastStreamCoreResyncAt = 0;
const STREAM_CORE_RESYNC_COOLDOWN_MS = 60000;
const mtxPathSyncState = {}; // pathName -> config hash
let mtxSyncInFlight = false;
let mtxSyncStartedAt = 0;
let mtxSyncPendingReason = null;
let corePathMissingStreak = 0;
let mtxPublisherDownStreak = 0;
const MTX_SYNC_MAX_MS = 8 * 60 * 1000;

const forceStreamCoreResync = (reason = '') => {
  const now = Date.now();
  if (now - lastStreamCoreResyncAt < STREAM_CORE_RESYNC_COOLDOWN_MS) return false;
  lastStreamCoreResyncAt = now;
  // ห้ามล้าง hash ทั้งก้อนทุกครั้ง — ทำให้ upsert วนลบ/สร้างทุก path แล้ว stampede
  // ล้างเฉพาะเมื่อ probe NVENC ใหม่จริงๆ
  if (/nvenc|driver/i.test(String(reason || ''))) {
    for (const k of Object.keys(mtxPathSyncState)) delete mtxPathSyncState[k];
    nvencAvailable = null;
  }
  console.warn(`[Stream core] force re-sync paths${reason ? `: ${reason}` : ''}`);
  if (typeof syncCamerasToStreamCore === 'function') {
    syncCamerasToStreamCore(reason || 'force');
  }
  return true;
};

const updateCameraStatuses = async () => {
  // เช็ค ffmpeg ที่ Node manage อยู่ว่าค้าง (alive แต่ bytesReceived ไม่ขยับ) หรือไม่ ทุกรอบ
  // เดียวกับ interval นี้ (ทุก 15s) ไม่เพิ่ม interval ใหม่ — ดู checkStalledTranscodes ด้านบน
  checkStalledTranscodes().catch((e) => console.warn('[Watchdog] check failed:', e.message));

  db.all('SELECT id, name, type, rtsp, nvr_channel, always_on, enabled, ip, onvifPort, onvifUser, onvifPass FROM cameras', async (err, allCams) => {
    if (err || !allCams) return;

    cameraState.retain(allCams.map((c) => c.id));
    // สตรีมที่ core กำลังดึงอยู่จริง (active) — ใช้แค่ตอบ "streaming" ไม่ใช้ตัดสิน online/offline (ดูคอมเมนต์ readyMap ข้างล่าง)
    let coreStreams = null;
    try { coreStreams = await streamCoreClient.listStreams(); } catch { coreStreams = null; }
    const isStreaming = (id) => {
      if (!coreStreams) return false;
      const sn = String(id || '').toLowerCase().replace(/\s+/g, '_');
      return Boolean(coreStreams.get(sn)?.active || coreStreams.get(`${sn}_sub`)?.active);
    };

    // กล้องที่ปิดใช้งาน: ไม่เช็ค ไม่นับ ไม่ลง log — แค่บอกว่าปิดอยู่
    for (const c of allCams.filter((x) => Number(x.enabled) === 0)) {
      cameraState.set(c.id, { enabled: false, reachable: null, streaming: false });
      camLastStatus[c.id] = 'disabled';
      delete streamHealthState[c.id];
    }
    /*
      กล้อง public (vms/public-cams.js): สถานะมาจาก API ของหน่วยงาน — ไม่ยิง TCP ไปเครื่องหน่วยงานทุก 15 วิ
      ไม่ลง log ออนไลน์/ออฟไลน์ และไม่นับในยอดรวมของระบบ (ยอดนับเป็นของกล้องเราเท่านั้น)
    */
    for (const c of allCams.filter((x) => Number(x.enabled) !== 0 && x.type === PUBLIC_TYPE)) {
      const reported = publicCams.reportedOnline(c.id);
      cameraState.set(c.id, { enabled: true, reachable: reported === undefined ? null : reported, streaming: isStreaming(c.id) });
      camLastStatus[c.id] = reported === true ? 'online' : 'offline';
      delete streamHealthState[c.id];
    }
    const cams = allCams.filter((c) => Number(c.enabled) !== 0 && c.type !== PUBLIC_TYPE);

    // เคลียร์ status ของกล้องที่ถูกลบไปแล้ว — ไม่งั้น camLastStatus/streamHealthState จะค้าง
    // entry เก่าตลอดไป (ไม่มีที่ไหน delete key ทิ้งเลย) ทำให้ onlineCount ฝั่ง frontend
    // (นับจาก object นี้ตรงๆ) นับรวมกล้องที่ลบไปแล้วด้วย จน offlineCount = total - online ติดลบ
    const currentIds = new Set(allCams.map((c) => c.id));
    for (const id of Object.keys(camLastStatus)) {
      if (!currentIds.has(id)) delete camLastStatus[id];
    }
    for (const id of Object.keys(streamHealthState)) {
      if (!currentIds.has(id)) delete streamHealthState[id];
    }

    const withRtsp = cams.filter((c) => c.rtsp).length;
    /*
      กู้คืนสตรีมที่ core ลืมไป

      ทั้ง MediaMTX และ go2rtc เก็บสตรีมที่เพิ่มผ่าน REST ไว้ในหน่วยความจำ การรีสตาร์ต core
      จึงล้างทิ้งหมด กล้องยังครบใน DB แต่เปิดดูไม่ได้สักตัว และไม่มี error ที่ไหนเลย — อาการ
      ที่ผู้ใช้เจอคือ "จู่ ๆ ก็ดูไม่ได้ทั้งระบบ" จนกว่าจะมีคนกด resync เอง

      ก้อนนี้เคยตายเงียบมาตั้งแต่ย้ายมา go2rtc เมื่อ 2026-08-20: ตัวนับเดิมยิงไปที่พอร์ต 9997
      ของ MediaMTX ตรง ๆ พอไม่มีใครฟังก็ ECONNREFUSED แล้วคืน -1 ทุกรอบ เงื่อนไข >= 0 จึง
      ไม่มีวันเป็นจริง ตอนนี้ถามผ่าน resolveCore() ซึ่งรู้จัก core ที่ใช้อยู่จริง

      debounce 2 รอบกัน false zero ตอนที่ sync กำลังทำงานอยู่พอดี — ระหว่าง sync สตรีมถูกลบ
      แล้วใส่กลับ การนับตอนนั้นจะได้เลขต่ำชั่วคราวโดยที่ไม่มีอะไรผิด
    */
    if (withRtsp > 0) {
      const camPathCount = await fetchCoreCamPathCount();
      if (camPathCount >= 0 && camPathCount < withRtsp) {
        corePathMissingStreak += 1;
        if (corePathMissingStreak >= 2) {
          console.warn(
            `[Stream core] สตรีมหลักเหลือ ${camPathCount} เส้น แต่มีกล้อง ${withRtsp} ตัว — สั่ง resync`
          );
          forceStreamCoreResync(`main paths ${camPathCount} < cameras ${withRtsp}`);
          corePathMissingStreak = 0;
        }
      } else {
        corePathMissingStreak = 0;
      }
    }

    /*
      readyMap ยังมาจาก MediaMTX เท่านั้น และภายใต้ go2rtc ยังเป็น null โดยตั้งใจ

      ทางที่ดูเหมือนถูกคือเอา ready ของ go2rtc มาเสียบตรงนี้ให้ครบเหมือนเดิม — **อย่าทำ**
      วัดบน VM จริงเมื่อ 2026-08-23: กล้องที่ always_on = 0 ไม่มีคนดูเลย (readers = 0) และไม่มี
      track สักเส้น (tracks = []) go2rtc ยังรายงาน ready = true อยู่ดี ค่านั้นสะท้อนว่า
      "สตรีมถูกตั้งค่าไว้" ไม่ใช่ "ภาพยังมาอยู่"

      ถ้าเสียบเข้ามา บรรทัด isOn = streamReady || tcpOk ข้างล่างจะเป็นจริงตลอดกาลสำหรับกล้อง
      ทุกตัวที่เคย sync เข้า core ไปแล้ว กล้องที่สายหลุดจริงก็จะยังขึ้นว่า online — เท่ากับ
      ทำลายตัวตรวจจับกล้องล่ม เพื่อแลกกับการที่โค้ดดู "ครบ" ขึ้น

      สัญญาณที่เชื่อได้ตอนนี้จึงมีแค่ checkCameraTcp ซึ่งต่อ TCP ไปที่ RTSP ของกล้องตรง ๆ และ
      ทำงานอยู่แล้ววันนี้ ที่ยังขาดคือการแยก "สตรีมไหลจริง" ออกจาก "กล้องยังตอบ" ซึ่ง go2rtc
      ไม่มีข้อมูลให้เลย — tracks ว่างแม้ตอนมีคนดูอยู่ (วัดแล้วเช่นกัน)

      จะทำต่อต้องพิสูจน์ด้วยกล้องที่ปิดจริงก่อนว่า ready ของ go2rtc เปลี่ยนตามหรือไม่
      อย่าเดาจากชื่อฟิลด์
    */
    const readyMap = STREAM_CORE === 'go2rtc' ? null : await fetchMtxPathReadyMap();
    const now = Date.now();
    let online = 0;
    let degraded = 0;
    let offline = 0;

    // กล้อง always_on ต้องมี publisher จริง — เดิมถูกป้ายว่า "idle" แล้วไม่เคยถูกซ่อม
    // ก้อนนี้ทำงานเฉพาะตอนใช้ MediaMTX เพราะ readyMap เป็น null ภายใต้ go2rtc (ดูเหตุผลข้างบน)
    if (readyMap) {
      const critical = cams.filter((c) => c.rtsp && Number(c.always_on) === 1);
      let publisherDown = 0;
      for (const c of critical) {
        const sn = String(c.id || '').toLowerCase().replace(/\s+/g, '_');
        const mainReady = Boolean(readyMap[sn]);
        const subReady = Boolean(readyMap[`${sn}_sub`]);
        if (!mainReady && !subReady) publisherDown += 1;
      }
      if (critical.length > 0 && publisherDown > 0) {
        mtxPublisherDownStreak += 1;
        // อย่า force resync บ่อยจาก AI ที่ main on-demand (ready=false ตามปกติ)
        // ใช้แค่เตือนใน log — sync ปกติจัดการ path
        if (mtxPublisherDownStreak >= 6) {
          console.warn(
            `[MediaMTX] AI Detect sub offline ${publisherDown}/${critical.length} — skip mass resync (avoid ffmpeg storm)`
          );
          mtxPublisherDownStreak = 0;
        }
      } else {
        mtxPublisherDownStreak = 0;
      }
    }

    await Promise.all(cams.map(async (c) => {
      // NVR ตอบ HTTP ได้ไม่ได้แปลว่าช่อง offline มีภาพ; รอ RTSP จริงก่อนนับว่า online
      if (c.nvr_channel != null && !c.rtsp) {
        cameraState.set(c.id, { enabled: true, reachable: false, streaming: false });
        camLastStatus[c.id] = 'offline';
        streamHealthState[c.id] = {
          id: c.id, name: c.name, status: 'offline', health: 'offline',
          mainReady: false, subReady: false, tcpOk: false, deviceReachable: false,
          notReadySince: null, lastAlertAt: null,
        };
        offline += 1;
        return;
      }
      const sn = String(c.id || '').toLowerCase().replace(/\s+/g, '_');
      const mainReady = readyMap ? Boolean(readyMap[sn]) : null;
      const subReady = readyMap ? Boolean(readyMap[`${sn}_sub`]) : null;
      const streamReady = mainReady === true || subReady === true;
      /*
        กล้องจาก edge: TCP ไปที่ RTSP ของมันคือไปที่ go2rtc ของ edge ซึ่งตอบเสมอตราบที่ edge ยังอยู่
        — วัดได้แค่ "edge ยังอยู่" ไม่ใช่ "กล้องยังอยู่" จึงใช้ค่าที่ edge รายงานมา (edge-source.js)
        null = ยังไม่รู้ (edge ติดต่อไม่ได้) นับเป็นไม่ online แต่ไม่เขียนทับเป็น false
      */
      // กล้องจาก DSS: TCP ไปถึงแค่ตัวกลาง RTSP ในเครื่อง (ตอบเสมอ) — สถานะมาจาก dss-sessions แบบเดียวกับกล้องจาก edge
      const fromEdge = c.type === EDGE_TYPE || c.type === DSS_TYPE;
      const edgeReachable = fromEdge ? (cameraState.get(c.id)?.reachable ?? null) : null;
      const tcpOk = fromEdge ? edgeReachable === true : await checkCameraTcp(c.rtsp);
      // เช็คแยกต่างหากเฉพาะตอน RTSP เอื้อมไม่ถึง — กันยิง TCP รัว 2 ครั้งทุกกล้องทุกรอบโดยไม่จำเป็น
      const deviceReachable = tcpOk || streamReady || fromEdge ? tcpOk || streamReady : await checkCameraDeviceReachable(c);
      cameraState.set(c.id, {
        enabled: true,
        reachable: fromEdge ? edgeReachable : tcpOk || deviceReachable,
        streaming: isStreaming(c.id),
      });
      const needsAlwaysOn = Number(c.always_on) === 1;

      let isOn = false;
      if (readyMap) {
        isOn = streamReady || tcpOk;
      } else {
        isOn = tcpOk;
      }
      const st = isOn ? 'online' : 'offline';
      if (camLastStatus[c.id] && camLastStatus[c.id] !== st) {
        saveLog('System', isOn ? 'Camera Online' : 'Camera Offline', `กล้อง "${c.name}" ${isOn ? 'ออนไลน์' : 'ขาดหาย'}`);
      }
      camLastStatus[c.id] = st;

      const prev = streamHealthState[c.id] || {};
      let notReadySince = prev.notReadySince || null;
      let lastAlertAt = prev.lastAlertAt || null;
      let health = 'ok';

      if (!tcpOk && !streamReady && deviceReachable) {
        // ตัวกล้องยังตอบสนองอยู่ (ONVIF/HTTP) แต่ RTSP/stream เอื้อมไม่ถึง — เช่น port-forward
        // เฉพาะ HTTP ไว้ก่อน ยังไม่ได้ forward RTSP จริง ไม่ควรนับเป็น "ตายสนิท" แบบ offline —
        // นับรวมใน "Online" (อุปกรณ์ยังอยู่) แต่ขึ้น Degraded ด้วยเพื่อสะท้อนว่าดู stream ไม่ได้จริง
        health = 'no_stream';
        if (!notReadySince) notReadySince = now;
        degraded += 1;
        online += 1;
      } else if (!tcpOk && !streamReady) {
        health = 'offline';
        notReadySince = null;
        offline += 1;
      } else if (streamReady) {
        // มีคนดูอยู่ / stream พร้อม
        health = 'ok';
        notReadySince = null;
        online += 1;
      } else if (tcpOk && needsAlwaysOn) {
        // AI Detect: TCP ok แต่ MTX ไม่ publish → degraded (เดิม = idle แล้วไม่ซ่อม)
        health = 'degraded';
        if (!notReadySince) notReadySince = now;
        degraded += 1;
        online += 1;
      } else if (tcpOk) {
        // on-demand idle: TCP ถึงกล้องได้ แต่ยังไม่มี viewer → ไม่ถือว่า degraded
        health = 'idle';
        notReadySince = null;
        online += 1;
      } else {
        health = 'offline';
        notReadySince = null;
        offline += 1;
      }

      streamHealthState[c.id] = {
        id: c.id,
        name: c.name,
        status: st,
        health,
        mainReady,
        subReady,
        tcpOk,
        deviceReachable,
        notReadySince,
        lastAlertAt,
      };
    }));

    streamHealthSummary = {
      total: cams.length,
      online,
      degraded,
      offline,
      updatedAt: now,
    };
  });
};

let nvencAvailable = null;
const detectNvenc = () => new Promise((resolve) => {
  if (nvencAvailable !== null) return resolve(nvencAvailable);
  const ffmpegPath = (typeof FFMPEG_PATH !== 'undefined' ? FFMPEG_PATH : 'ffmpeg').replace(/\\\\/g, '\\');
  // NVENC rejects tiny frames (64x64). Probe ≥320x240.
  // On Windows, exec may set err even when encode works — trust stderr markers too.
  exec(
    `"${ffmpegPath}" -hide_banner -f lavfi -i color=c=black:s=640x360:d=0.3 -frames:v 1 -c:v h264_nvenc -preset p4 -tune ll -pix_fmt yuv420p -f null -`,
    { windowsHide: true, timeout: 20000 },
    (err, _stdout, stderr) => {
      const msg = `${stderr || ''}${_stdout || ''}`;
      const driverTooOld = /Driver does not support the required nvenc API|minimum required Nvidia driver/i.test(msg);
      const tooSmall = /Frame Dimension less than the minimum/i.test(msg);
      const encodedOk = /encoder\s*:\s*Lavc.*h264_nvenc|Video: h264.*h264_nvenc|frame=\s*[1-9]/i.test(msg);
      const openFail = /Could not open encoder|InitializeEncoder failed|Error while opening encoder/i.test(msg);
      nvencAvailable = !driverTooOld && !tooSmall && !openFail && (!err || encodedOk);
      if (nvencAvailable) {
        console.log('[Transcode] h264_nvenc probe OK — Main/Sub H.265 use NVENC');
      } else if (driverTooOld) {
        console.warn('[Transcode] h264_nvenc DRIVER TOO OLD (need ≥570) — fallback libx264.');
      } else if (tooSmall) {
        console.warn('[Transcode] h264_nvenc probe frame too small — use ≥320x240');
      } else {
        console.warn(`[Transcode] h264_nvenc probe fail — fallback libx264 (${msg.slice(-220).replace(/\s+/g, ' ')})`);
      }
      resolve(nvencAvailable);
    },
  );
});

const videoEncodeFlags = (bitrate, opts = {}) => {
  // Caller must pass useNvenc only after detectNvenc snapshot — don't re-read global (race)
  const useNvenc = Boolean(opts.useNvenc);
  const gpuIdx = Number.isFinite(opts.gpuIdx) ? opts.gpuIdx : 0;
  if (useNvenc) {
    // Phase 1: NVENC for Main evidence — keep quality, offload CPU encode
    // p4 + bf 0 = stable low-latency RTSP (avoid presets that silently die)
    return [
      `-c:v h264_nvenc -gpu ${gpuIdx}`,
      '-preset p4 -tune ll -rc vbr',
      `-b:v ${bitrate} -maxrate ${bitrate} -bufsize ${bitrate}`,
      '-profile:v main -pix_fmt yuv420p -g 50 -bf 0',
    ].join(' ');
  }
  return `-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -x264-params repeat-headers=1 -g 25 -b:v ${bitrate}`;
};

// Map เก็บสตรีมที่ Node กำลัง manage อยู่: key = streamName, value = { proc, rtspUrl, codec, isSub, gpuIdx }
// นี่คือกลไกเดียวที่ transcode H.265→H.264 ทั้งระบบ (main + sub) — ไม่มี MediaMTX runOnDemand
// และไม่มี SRS แล้ว ผลลัพธ์ republish กลับเข้า MediaMTX เองเสมอ (RTSP publish)
const activeStreams = new Map();
const MTX_RTSP_PUBLISH_PORT = 8554;
// กล้องที่ always_on=1 ต้องเปิด main stream ค้างไว้ ไม่ใช่ on-demand — ใช้กับกล้องที่มีระบบ
// ภายนอก (เช่น Edge AI) ดึงสตรีมอยู่ตลอด ให้ทุก consumer อ่านจาก streaming core ที่เดียว
// ไม่มีใครหลุดไปต่อ NVR/กล้องตรงเอง recompute ใหม่ทุกครั้งที่ syncCamerasToStreamCore รัน
const alwaysOnMainStreamNames = new Set();

const spawnTranscode = (streamName, rtspUrl, codec, isSub, gpuIdx = 0) => {
  const args = [];
  if (codec === 'h265' && nvencAvailable) {
    // -hwaccel_output_format cuda = เฟรมค้างอยู่บน GPU ตลอดสาย decode→scale→encode ไม่ต้อง
    // วิ่ง GPU→RAM→CPU scale→RAM→GPU ทุกเฟรมเหมือนเดิม (เดิมไม่ได้ใส่ ทำให้ ffmpeg แต่ละตัว
    // กิน CPU 30-50% ทั้งที่ decode/encode เป็น GPU แล้ว — พอมี ~20 สตรีมพร้อมกัน load
    // average ขึ้นไปแตะ 12/12 vCPU) วัดจริงบน VM คลิปทดสอบ 30 วิ: CPU 5.56s → 0.96s
    // ต้องใช้คู่กับ scale_cuda ข้างล่างเสมอ — ถ้าใส่อันนี้แล้วยังใช้ scale ธรรมดา ffmpeg จะ error
    args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuIdx), '-hwaccel_output_format', 'cuda', '-c:v', 'hevc_cuvid');
  }

  args.push(
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '1500000',
    '-probesize', '3000000',
    '-flags', 'low_delay',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl
  );

  if (codec === 'h265') {
    // scale_cuda เมื่อเฟรมอยู่บน GPU (NVENC path ข้างบน), scale ธรรมดาเมื่อ fallback ไป libx264
    // ซึ่ง encode บน CPU เลยต้องการเฟรมใน system memory — สอง flag นี้ต้องสอดคล้องกันเสมอ
    const dims = isSub ? "'max(320,min(640,iw))':-2" : "'max(640,min(1280,iw))':-2";
    args.push('-vf', `${nvencAvailable ? 'scale_cuda' : 'scale'}=${dims}`);

    if (nvencAvailable) {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p1',
        '-gpu', String(gpuIdx)
      );
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency'
      );
    }
    const bitrate = isSub ? '512k' : '3M';
    args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', isSub ? '1M' : '6M');
  } else {
    // H.264: Copy directly (Passthrough)
    args.push('-c:v', 'copy');
  }

  // republish H.264 กลับเข้า MediaMTX เอง (RTSP publish) — frontend เรียกผ่าน mediaHlsUrl
  // ปกติ (ชื่อ path เดียวกับที่ MediaMTX ใช้ native pull ตอนเป็น H.264) ไม่ต้องเพิ่ม routing ใหม่ฝั่ง client
  args.push('-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${MTX_RTSP_PUBLISH_PORT}/${streamName}`);

  const ffmpegPath = FFMPEG_PATH.replace(/\\\\/g, '\\');
  console.log(redactUrls(`[Transcode] Spawning FFmpeg for ${streamName}: "${ffmpegPath}" ${args.join(' ')}`));

  // เก็บ stderr ท้ายๆ ไว้ดูสาเหตุตอน FFmpeg ตาย (เดิม stdio:'ignore' → มองไม่เห็น error เลย)
  // windowsHide: true กัน cmd window โผล่ทุกครั้งที่ spawn/respawn บน Windows
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, windowsHide: true });
  let errTail = '';
  if (proc.stderr) {
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800); });
  }
  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[Transcode] ${streamName} exit ${code} | stderr: ${redactUrls(errTail).replace(/\s+/g, ' ').slice(-400)}`);
    }
  });
  proc.unref();
  return proc;
};

const startStream = (streamName, rtspUrl, codec, isSub, gpuIdx = 0) => {
  // go2rtc แปลง H.265 เป็น H.264 ให้เองแล้วผ่าน `ffmpeg:<url>#video=h264#hardware`
  // (ดู server/gateway/go2rtc-sync.js) การให้ Node ทำซ้ำไม่ได้แค่เปลืองเปล่า — มัน publish
  // ไปที่ rtsp://127.0.0.1:8554 ซึ่งเป็นพอร์ตของ MediaMTX ที่ถอดออกไปแล้ว ffmpeg จึงตาย
  // ด้วย "Connection refused" แล้วถูก spawn ใหม่วนไปเรื่อยๆ กิน CPU/GPU ทิ้งโดยไม่มีใครเห็น
  if (STREAM_CORE === 'go2rtc') return null;

  if (activeStreams.has(streamName)) {
    return activeStreams.get(streamName);
  }

  const entry = {
    proc: null,
    rtspUrl,
    codec,
    isSub,
    gpuIdx,
  };
  activeStreams.set(streamName, entry);

  // Sub = always-on, restart ทุกครั้งที่ตาย (AI/CV daemon ต้องการ feed ตลอด)
  // Main = on-demand, restart ทุกครั้งที่ตายเหมือนกัน แต่ idle-reaper (ดู readers จาก MediaMTX
  // จริง แทนการนับ client เอง) จะเป็นคน stopStream() เมื่อไม่มีคนดูแล้ว — ดู ensureMainStreamReaper
  const FAST_FAIL_MS = 5000;
  const BASE_RETRY_DELAY_MS = 3000;
  const MAX_RETRY_DELAY_MS = 60000;
  entry.consecutiveFastFails = entry.consecutiveFastFails || 0;

  const spawnWithWatch = () => {
    const spawnedAt = Date.now();
    const proc = spawnTranscode(streamName, entry.rtspUrl, entry.codec, entry.isSub, entry.gpuIdx);
    entry.proc = proc;

    proc.on('error', (err) => {
      console.error(`[Transcode Error] ${streamName}:`, redactUrls(err.message));
    });

    proc.on('close', (code) => {
      const aliveMs = Date.now() - spawnedAt;
      console.log(`[Transcode Close] ${streamName} exited with code ${code} after ${aliveMs}ms`);
      if (activeStreams.get(streamName) !== entry || entry.proc !== proc) return;
      entry.proc = null;

      if (aliveMs < FAST_FAIL_MS) {
        entry.consecutiveFastFails += 1;
      } else {
        entry.consecutiveFastFails = 0;
      }

      const delay = Math.min(
        BASE_RETRY_DELAY_MS * Math.pow(2, entry.consecutiveFastFails),
        MAX_RETRY_DELAY_MS
      );
      console.log(`[Transcode] Restarting ${streamName} in ${delay}ms (consecutive fast fails: ${entry.consecutiveFastFails})...`);
      setTimeout(() => {
        if (activeStreams.get(streamName) === entry && !entry.proc) {
          spawnWithWatch();
        }
      }, delay);
    });
  };

  spawnWithWatch();
  return entry;
};

const stopStream = (streamName) => {
  const entry = activeStreams.get(streamName);
  if (entry) {
    console.log(`[Transcode] Stopping stream ${streamName}`);
    if (entry.proc) {
      try {
        entry.proc.kill();
      } catch (e) {
        console.warn(`Failed to kill process for ${streamName}:`, e.message);
      }
    }
    activeStreams.delete(streamName);
  }
};

// Round-robin GPU assignment สำหรับ transcode ใหม่แต่ละตัว (กระจายโหลดข้าม GPU ถ้ามีมากกว่า 1)
let transcodeGpuRoundRobin = 0;
const nextGpuIdx = () => transcodeGpuRoundRobin++ % GPU_COUNT;

// ffmpeg ที่รันอยู่ผูกกับ URL ที่ได้รับตอน spawn — ถ้า DB เปลี่ยน (แก้ IP/รหัสผ่าน/พอร์ต/
// stream path) ตัวที่รันอยู่จะ "ไม่" รับรู้ ต้องหยุดแล้วให้ผู้เรียก start ใหม่ด้วย URL ล่าสุด
// คืน true เมื่อไม่มีตัวรันอยู่แล้ว (พร้อม start ใหม่ได้เลย)
const stopIfSourceChanged = (streamName, nextRtsp) => {
  const existing = activeStreams.get(streamName);
  if (!existing) return true;
  if (existing.rtspUrl === nextRtsp) return false;
  console.log(`[Transcode] ${streamName}: source URL changed in DB — restarting with the new one`);
  stopStream(streamName);
  return true;
};

// Sub H.265 = always-on, Node เป็นคน publish เอง — เรียกซ้ำได้ปลอดภัย (no-op ถ้ารันอยู่แล้ว
// "ด้วย URL เดิม" — ถ้า URL เปลี่ยนจะ restart ให้ ดู stopIfSourceChanged)
const ensureAlwaysOnSubTranscode = (subName, subRtsp) => {
  if (!stopIfSourceChanged(subName, subRtsp)) return;
  startStream(subName, subRtsp, 'h265', true, nextGpuIdx());
};

// Main H.265 = always-on เฉพาะกล้องที่ตั้ง always_on=1 — กัน consumer ภายนอกหลุดไปต่อ
// NVR/กล้องตรงตอน local main ยัง on-demand ไม่พร้อม (สาเหตุ NVR concurrent-session contention ที่เจอจริง
// วันที่ 2026-07-17) เรียกซ้ำได้ปลอดภัย (no-op ถ้ารันอยู่แล้ว) เหมือน ensureAlwaysOnSubTranscode
const ensureAlwaysOnMainTranscode = (mainName, mainRtsp) => {
  if (!stopIfSourceChanged(mainName, mainRtsp)) return;
  startStream(mainName, mainRtsp, 'h265', false, nextGpuIdx());
};

// ---- Staleness watchdog (2026-07-17) ----
// spawnWithWatch (ด้านบน) restart เฉพาะตอน ffmpeg process จบด้วย event 'close' เท่านั้น — ffmpeg ที่
// ค้างอยู่ใน connect/read syscall แบบไม่ตาย (เช่น ค้างใน do_poll ตอนชนกับ NVR concurrent-session limit,
// เหตุการณ์จริงที่เจอ 2026-07-17) จะไม่ถูกตรวจจับ/restart เลย เพราะ MediaMTX เองก็ยังเห็น path เป็น
// ready=true อยู่ (ไม่รู้ว่า upstream หยุดส่งข้อมูลแล้ว) — ต้องเช็ค bytesReceived เองแทน
const mtxPathBytesHistory = new Map(); // streamName -> { bytes, sameSince }
const TRANSCODE_STALL_THRESHOLD_MS = Number(process.env.TRANSCODE_STALL_THRESHOLD_MS || 60000);

const fetchMtxPathBytesMap = () => new Promise((resolve) => {
  http.get({
    hostname: '127.0.0.1',
    port: 9997,
    path: '/v3/paths/list',
    headers: { 'Accept': 'application/json' }
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      try {
        const resObj = JSON.parse(d);
        const paths = resObj.items || [];
        const map = {};
        for (const p of paths) {
          map[p.name] = Number(p.bytesReceived) || 0;
        }
        resolve(map);
      } catch {
        resolve(null);
      }
    });
  }).on('error', () => resolve(null));
});

// เช็ค Node-managed ffmpeg ทุกตัวใน activeStreams: ถ้า bytesReceived ของ path นั้นไม่ขยับต่อเนื่อง
// เกิน threshold ทั้งที่ process ยังไม่ตาย → SIGKILL (ไม่ใช้ SIGTERM เพราะ process ที่ค้างใน syscall
// อาจไม่ตอบสนอง) แล้วปล่อยให้ spawnWithWatch's close-handler restart เองตามปกติ — ไม่เรียก
// stopStream()/activeStreams.delete() เอง เพื่อไม่ไปรบกวน backoff/retry logic ที่มีอยู่แล้ว
const checkStalledTranscodes = async () => {
  if (activeStreams.size === 0) return;
  const bytesMap = await fetchMtxPathBytesMap();
  if (!bytesMap) return;
  const now = Date.now();
  for (const [streamName, entry] of activeStreams.entries()) {
    if (!entry.proc) continue; // ยังไม่ spawn หรือรอ backoff restart อยู่แล้ว
    const bytes = bytesMap[streamName];
    if (bytes === undefined) continue; // path หายจาก MediaMTX ชั่วคราว (เช่น ระหว่าง resync) — ข้ามไปก่อน
    const hist = mtxPathBytesHistory.get(streamName);
    if (!hist || hist.bytes !== bytes) {
      mtxPathBytesHistory.set(streamName, { bytes, sameSince: now });
      continue;
    }
    if (now - hist.sameSince >= TRANSCODE_STALL_THRESHOLD_MS) {
      console.warn(`[Watchdog] Killing stalled transcode for ${streamName}: bytesReceived unchanged for ${Math.round((now - hist.sameSince) / 1000)}s`);
      try { entry.proc.kill('SIGKILL'); } catch {}
      mtxPathBytesHistory.delete(streamName); // กัน kill ซ้ำทันทีตอน process ใหม่เพิ่งเริ่ม bytes ยังต่ำ
    }
  }
};


const hashMtxConfig = (config) => {
  try {
    return JSON.stringify(config);
  } catch {
    return String(Date.now());
  }
};

const upsertMtxPath = (pathName, config) => new Promise((resolve) => {
  const payload = JSON.stringify(config);
  const doAdd = () => {
    const reqAdd = http.request({
      hostname: '127.0.0.1',
      port: 9997,
      path: `/v3/config/paths/add/${encodeURIComponent(pathName)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        mtxPathSyncState[pathName] = hashMtxConfig(config);
      }
      resolve(res.statusCode || 0);
    });
    reqAdd.on('error', (err) => {
      console.error(`[MediaMTX Sync] add ${pathName}:`, redactUrls(err.message));
      resolve(0);
    });
    reqAdd.write(payload);
    reqAdd.end();
  };

  const reqDel = http.request({
    hostname: '127.0.0.1',
    port: 9997,
    path: `/v3/config/paths/delete/${encodeURIComponent(pathName)}`,
    method: 'DELETE',
  }, (resDel) => {
    resDel.resume();
    doAdd();
  });
  reqDel.on('error', () => doAdd());
  reqDel.end();
});

/**
 * MediaMTX is a dumb RTSP-in/HLS-out relay — the *only* thing that decides here is codec:
 *
 * - H.264 source → MediaMTX pulls the camera's RTSP natively (no ffmpeg at all).
 *   Sub = always-on pull (AI/CV daemons need it live regardless of viewers).
 *   Main = on-demand pull (MediaMTX's own built-in on-demand, proven reliable).
 * - H.265 source → path is a plain `publisher` target; Node owns the transcode process
 *   entirely (see spawnTranscode/startStream) and republishes H.264 onto this exact path.
 *   MediaMTX never runs a runOnDemand shell command itself — that mechanism proved
 *   unreliable (H.265 main streams wouldn't trigger off HLS reads) and is not used anymore.
 *   Sub H.265 transcode is started always-on at boot (ensureAlwaysOnSubTranscodes);
 *   Main H.265 transcode is started on-demand via POST /api/cameras/:id/stream/start
 *   and reaped by the idle-reaper after no HLS readers remain.
 */
const buildStreamPathConfig = (pathName, rtspUrl, codec, opts = {}) => {
  const alwaysOn = Boolean(opts.alwaysOn);
  const sanitizedRtsp = String(rtspUrl || '').replace(/"/g, '');

  if (codec === 'h265') {
    return { source: 'publisher' };
  }

  if (alwaysOn) {
    return { source: sanitizedRtsp, sourceOnDemand: false };
  }

  return {
    source: sanitizedRtsp,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: '45s',
    sourceOnDemandCloseAfter: '90s',
  };
};

const deleteMtxPath = (name) => new Promise((resolve) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port: 9997,
    path: `/v3/config/paths/delete/${name}`,
    method: 'DELETE'
  }, (res) => {
    res.resume();
    resolve();
  });
  req.on('error', (err) => {
    console.error(`[MediaMTX Sync] Error deleting path ${name}:`, err.message);
    resolve();
  });
  req.end();
});

const syncCamerasToMediaMtxOnly = async (reason = '') => {
  if (mtxSyncInFlight) return;
  mtxSyncInFlight = true;
  mtxSyncStartedAt = Date.now();

  db.all("SELECT * FROM cameras", async (err, rows) => {
    if (err || !rows) {
      mtxSyncInFlight = false;
      mtxSyncStartedAt = 0;
      return;
    }

    try {
      // 1. ดึงรายการ path ปัจจุบันจาก MediaMTX API
      const mtxList = await new Promise((resolve, reject) => {
        const req = http.get({
          hostname: '127.0.0.1',
          port: 9997,
          path: '/v3/config/paths/list',
          headers: { 'Accept': 'application/json' }
        }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => {
            try {
              if (r.statusCode && (r.statusCode < 200 || r.statusCode >= 300)) {
                reject(new Error(`HTTP status ${r.statusCode}`));
                return;
              }
              resolve(JSON.parse(d));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });

      const currentPaths = mtxList.items || [];
      const currentPathMap = new Map(currentPaths.map(p => [p.name, p]));
      const validPaths = new Set();
      let subAlwaysOnCount = 0;
      let mainOnDemandCount = 0;
      let changedCount = 0;

      await detectNvenc();

      for (const c of rows) {
        if (!c.rtsp) continue;
        const sn = c.id.toLowerCase().replace(/\s+/g, '_');
        const mainName = sn;
        const subName = `${sn}_sub`;
        const mainRtsp = c.rtsp.replace(/"/g, '');
        const subRtsp = resolveCameraSubRtsp(c);

        validPaths.add(mainName);
        validPaths.add(subName);

        // ใช้ cache เท่านั้นตอน sync — ห้าม ffprobe ทั้งฟาร์ม (ค้าง/stampede)
        const mainCodec = codecCache[mainRtsp] || codecCache[c.rtsp] || 'h265';
        const subCodec = codecCache[subRtsp] || 'h264';

        // กล้องที่ตั้ง always_on=1 ต้องเปิด main ค้างด้วย (ไม่ใช่แค่ sub) — ดู
        // ensureAlwaysOnMainTranscode ด้านบนสำหรับเหตุผล (NVR session contention ที่เจอจริง)
        const mainAlwaysOn = Boolean(c.always_on);
        if (mainAlwaysOn) alwaysOnMainStreamNames.add(mainName);
        else alwaysOnMainStreamNames.delete(mainName);

        const mainConfig = buildStreamPathConfig(mainName, mainRtsp, mainCodec, { alwaysOn: mainAlwaysOn });
        const subConfig = buildStreamPathConfig(subName, subRtsp, subCodec, { alwaysOn: true });

        const mainHash = hashMtxConfig(mainConfig);
        if (!currentPathMap.has(mainName) || mtxPathSyncState[mainName] !== mainHash) {
          console.log(`[MediaMTX Sync] ${currentPathMap.has(mainName) ? 'Updating' : 'Adding'} main (${mainCodec === 'h265' ? 'Node-managed' : 'native'} ${mainAlwaysOn ? 'always-on' : 'on-demand'}): ${mainName}`);
          await upsertMtxPath(mainName, mainConfig);
          changedCount += 1;
        }
        mainOnDemandCount += 1;

        const subHash = hashMtxConfig(subConfig);
        if (!currentPathMap.has(subName) || mtxPathSyncState[subName] !== subHash) {
          console.log(`[MediaMTX Sync] ${currentPathMap.has(subName) ? 'Updating' : 'Adding'} sub (${subCodec === 'h265' ? 'Node-managed always-on' : 'native always-on pull'}): ${subName}`);
          await upsertMtxPath(subName, subConfig);
          changedCount += 1;
          // กัน RTSP connect พร้อมกันหลายสิบช่อง
          await new Promise((r) => setTimeout(r, 120));
        }
        subAlwaysOnCount += 1;

        // H.265 sub ต้อง Node เป็นคน publish เอง (always-on) — MediaMTX แค่รอรับที่ path นี้
        if (subCodec === 'h265') {
          ensureAlwaysOnSubTranscode(subName, subRtsp);
        } else {
          // เคสที่ URL เปลี่ยนแล้ว codec ใหม่ยังไม่อยู่ใน cache → subCodec ตกมาเป็น h264 ทำให้
          // ไม่เข้า ensureAlwaysOnSubTranscode ข้างบน ตัว transcode เก่า (URL เก่า) จะค้างอยู่
          stopIfSourceChanged(subName, subRtsp);
        }
        // H.265 main ของกล้อง always_on=1 ก็ต้องเปิดค้างเหมือนกัน (ไม่รอ viewer)
        if (mainCodec === 'h265' && mainAlwaysOn) {
          ensureAlwaysOnMainTranscode(mainName, mainRtsp);
        } else {
          // main แบบ on-demand (สตาร์ทตอนมีคนกดดู) ไม่ได้ผ่าน ensureAlwaysOnMainTranscode
          // เลยต้องเช็ค URL ให้ด้วยตรงนี้ ไม่งั้นคนที่เปิดดูค้างไว้จะได้ภาพจาก URL เก่าต่อไป
          // หยุดเฉยๆ พอ — รอบถัดไปที่มีคนกดดูจะ start ใหม่ด้วย URL ล่าสุดเอง
          stopIfSourceChanged(mainName, mainRtsp);
        }
      }

      // 3. ลบ path ที่ไม่มีใน DB แล้ว
      for (const p of currentPaths) {
        if (p.name === 'all_others') continue;
        if (!validPaths.has(p.name)) {
          console.log(`[MediaMTX Sync] Deleting obsolete path: ${p.name}`);
          await deleteMtxPath(p.name);
          delete mtxPathSyncState[p.name];
          stopStream(p.name); // เผื่อเป็น Node-managed H.265 transcode ของกล้องที่ถูกลบ
        }
      }

      console.log(
        `[MediaMTX Sync] complete — cameras=${rows.length} paths=${validPaths.size} `
        + `sub always-on=${subAlwaysOnCount} main on-demand=${mainOnDemandCount} changed=${changedCount}`
      );
    } catch (e) {
      console.error(`[MediaMTX Sync] Failed to sync paths:`, redactUrls(e.message));
    } finally {
      mtxSyncInFlight = false;
      mtxSyncStartedAt = 0;
    }
  });
};

/**
 * ซิงก์กล้องเข้า streaming core ที่ใช้งานอยู่จริง
 *
 * ทุกจุดที่กล้องเปลี่ยน (เพิ่ม/แก้/ลบ/เปิดปิด AI/resync ด้วยมือ) ต้องเรียกตัวนี้
 * ไม่ใช่เรียก implementation ของ core ใดโดยตรง — ตอนสลับจาก MediaMTX ไป go2rtc
 * เมื่อ 2026-08-20 จุดเรียกที่ยังชี้ตรงไปที่ MediaMTX ทำให้การเพิ่มกล้องไม่เคยไปถึง
 * go2rtc เลย และไม่มี error ที่ไหน กล้องแค่ "ไม่มีภาพ" จนกว่าจะรีสตาร์ต backend
 */
const syncCamerasToStreamCore = (reason = '') => {
  // ทุกเส้นทางที่เพิ่มกล้องผ่านตรงนี้ จึงเป็นที่เดียวที่ออก global ID ให้กล้องใหม่ได้ครบทุกตัว
  identity.assignMissing()
    .then((count) => { if (count > 0) edgeLink?.catalogSoon?.(); })
    .catch((err) => console.warn(`[Identity] ออก global ID ไม่สำเร็จ: ${err.message}`));
  if (STREAM_CORE === 'go2rtc') {
    return syncCamerasToGo2rtc(db, resolveCameraSubRtsp).then((result) => {
      // catalog รอบก่อน sync อาจยังไม่เห็น sub stream ของกล้องใหม่ ส่งซ้ำเฉพาะเมื่อ core เปลี่ยนจริง
      if (result?.ok && result.added + result.updated + result.removed > 0) edgeLink?.catalogSoon?.();
      return result;
    }).catch((err) =>
      console.warn(`[go2rtc Sync] ล้มเหลว (${reason}): ${redactUrls(err.message)}`),
    );
  }
  return syncCamerasToMediaMtxOnly(reason);
};

// เส้นทางเดียวที่ frontend เรียกก่อนเล่น live เสมอ (main หรือ sub) — ถ้ากล้องเป็น H.264
// ก็ไม่ต้องทำอะไร (MediaMTX จัดการ native pull เองอยู่แล้ว) ถ้าเป็น H.265 จะ start (หรือ
// reuse ถ้ามีอยู่แล้ว) Node-managed ffmpeg transcode ตัวเดียวที่ republish กลับเข้า MediaMTX
// ที่ path ชื่อเดียวกับที่ frontend จะเล่นผ่าน mediaHlsUrl พอดี
// เฉพาะ type=main: รอ (bounded, ดู waitForMtxPathReady) ให้ path พร้อมเล่นจริงก่อนตอบกลับ —
// กัน frontend ยิง HLS request แรกไปชนช่วงที่ยังไม่มีอะไร publish (สาเหตุ error แดงที่ขึ้นก่อนเสมอ)
// ไม่แตะ sub (always-on) เลย — ตอบกลับทันทีเหมือนเดิมทุกกรณี
app.post('/api/cameras/:id/stream/start', checkAuth, async (req, res) => {
  try {
    const type = req.query.type === 'main' ? 'main' : 'sub';
    const camera = await getCameraRow(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    // กล้อง public: คนที่เห็นหน้า Public Cam Map ดูได้ทุกตัว ไม่ขึ้นกับขอบเขตกล้องของ role
    const publicViewer = camera.type === PUBLIC_TYPE && req.perms?.has('menu.publiccam');
    if (req.deviceIds instanceof Set && !req.deviceIds.has(camera.id) && !publicViewer) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงกล้องนี้' });
    }
    if (Number(camera.enabled) === 0) return res.status(409).json({ error: 'กล้องนี้ถูกปิดใช้งาน' });

    const sn = String(req.params.id).toLowerCase().replace(/\s+/g, '_');

    /*
      go2rtc: ออก token อย่างเดียว (หน้า Live ของเว็บ — src/components/live/LivePlayer.jsx)

      go2rtc เปิดต้นทางเองเมื่อมีผู้เล่นต่อเข้ามา ไม่ต้องตรวจ codec หรือเริ่ม ffmpeg ให้ — ท่อนข้างล่าง
      (detectCameraCodec + startStream) เป็นของยุค MediaMTX ถ้าปล่อยให้วิ่ง จะ ffprobe กล้องทุกครั้ง
      ที่เปิดภาพ และกล้อง H.265 จะได้ ffmpeg อีกตัวที่ publish ไปหาพอร์ตที่ไม่มีใครฟัง
      กล้องที่ไม่มี substream ไม่มีสตรีม `_sub` ใน go2rtc (go2rtc-sync.js) — ขอ sub จึงได้ main แทน
    */
    if (STREAM_CORE === 'go2rtc') {
      let streamName = type === 'main' ? sn : `${sn}_sub`;
      if (type === 'sub') {
        try {
          const live = await streamCoreClient.listStreams();
          if (!live.has(streamName) && live.has(sn)) streamName = sn;
        } catch { /* core ไม่ตอบ — ใช้ชื่อ sub ไปก่อน ผู้เล่นจะ retry เอง */ }
      }
      const token = streamToken.sign({
        streamName,
        clientId: `user:${req.user?.username || ''}`,
        ttlMs: streamToken.HLS_TTL_MS,
      });
      return res.json({ success: true, streamName, streamToken: token, type: streamName === sn ? 'main' : 'sub' });
    }

    const streamName = type === 'main' ? sn : `${sn}_sub`;
    const rtspUrl = (type === 'main' ? camera.rtsp : resolveCameraSubRtsp(camera)) || '';
    const sanitizedRtsp = rtspUrl.replace(/"/g, '');
    if (!sanitizedRtsp) return res.status(400).json({ error: 'No RTSP URL for camera' });

    let codec = codecCache[sanitizedRtsp];
    if (!codec) {
      codec = await detectCameraCodec(sanitizedRtsp);
      codecCache[sanitizedRtsp] = codec;
      saveCodecCache();
    }

    if (codec === 'h265') {
      let entry = activeStreams.get(streamName);
      if (!entry) {
        entry = startStream(streamName, sanitizedRtsp, codec, type === 'sub', nextGpuIdx());
      }
      if (type === 'main') markMainStreamRequested(streamName);
    }
    // H.264: ไม่ต้องทำอะไร — MediaMTX native pull จัดการอยู่แล้ว, path ชื่อเดียวกันพอดี

    let ready;
    if (type === 'main' && STREAM_CORE !== 'go2rtc') {
      // รอให้ MediaMTX report ready จริงก่อนตอบกลับ (bounded) — ปิดช่องที่ frontend
      // ยิง HLS request แรกไปชนตอนยังไม่มีอะไร publish จนขึ้น error แดงเสมอ ถ้ารอครบ
      // เวลาแล้วยังไม่ ready ก็ตอบ success ไปเหมือนเดิม (retry logic ฝั่ง client เป็น fallback)
      ready = await waitForMtxPathReady(streamName);
    }
    /*
      ภายใต้ go2rtc ข้ามการรอนี้ไปเลย

      waitForMtxPathReady วนถาม 127.0.0.1:9997 ซึ่งเป็น API ของ MediaMTX ที่ถอดออกไปแล้ว —
      ตรวจบน VM แล้วไม่มีอะไรฟังพอร์ตนั้น ทุกรอบจึง ECONNREFUSED แล้ววนจนครบ 8 วินาที
      (MAIN_STREAM_READY_MAX_WAIT_MS) แล้วคืน false เสมอ ผลคือทุกครั้งที่เปิด main stream
      ผู้ใช้รอ 8 วินาทีเปล่า ๆ แล้วยังได้ ready:false กลับไปอีก

      go2rtc จัดการ on-demand ของตัวเอง ผู้เล่นต่อเข้าไปแล้วรอเฟรมแรกได้ตรง ๆ ไม่ต้องมีใคร
      มายืนยันความพร้อมล่วงหน้า — `ready` จึงไม่ถูกส่งกลับในโหมดนี้ ต่างจากการส่ง false
      ซึ่งเป็นการโกหกว่า "ตรวจแล้วไม่พร้อม" ทั้งที่ไม่เคยตรวจได้เลย
    */
    /*
      คืน stream token มาด้วย เพื่อให้หน้าเว็บของเราเองยังเล่นวิดีโอได้หลังปิด /stream กับ /hls

      หน้าเว็บนี้ยืนยันตัวตนแบบ "คน" (username/password header) ไม่มี API key จึงขอ token จาก
      /api/v1/cameras/:id/streams ไม่ได้ — และแท็ก <video> ก็ส่ง header ไม่ได้อยู่ดี route นี้
      ถูกเรียกก่อนเล่นทุกครั้งอยู่แล้ว (ดู LiveStreamPlayer.jsx) จึงเป็นที่ที่ token ควรออกมา
      โดยไม่ต้องเพิ่ม endpoint ใหม่ให้ client ต้องจำเพิ่ม

      ตรวจ scope ของผู้ใช้ก่อนออก token — ผู้ใช้ที่เห็นได้แค่บางกล้องไม่ควรขอ token ของกล้อง
      ที่ตัวเองไม่มีสิทธิ์เห็น (ก่อนหน้านี้ไม่มีการตรวจอะไรเลยเพราะ path วิดีโอเปิดสาธารณะ)
    */
    if (req.deviceIds instanceof Set && !req.deviceIds.has(camera.id)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงกล้องนี้' });
    }
    const token = streamToken.sign({
      streamName,
      clientId: `user:${req.user?.username || ''}`,
      ttlMs: streamToken.HLS_TTL_MS,
    });

    res.json({ success: true, streamName, codec, streamToken: token, ...(type === 'main' ? { ready } : {}) });
  } catch (e) {
    console.error('[Stream Start] Failed:', redactUrls(e.message));
    res.status(500).json({ error: 'Failed to start stream' });
  }
});

// Idle-reaper สำหรับ main stream H.265 (on-demand): ปิด ffmpeg เองเมื่อไม่มีคนดูแล้ว โดยเช็ค
// จาก reader count จริงของ MediaMTX (ไม่ใช้วิธีนับ client เองแบบเดิมที่ผูกกับ SRS webhook)
const MAIN_STREAM_IDLE_MS = 45000;
const MAIN_STREAM_REAP_INTERVAL_MS = 15000;
const mainStreamRequestedAt = new Map(); // streamName -> last POST /stream/start timestamp
const mainStreamIdleSince = new Map(); // streamName -> timestamp เมื่อเริ่มไม่มี reader
const markMainStreamRequested = (streamName) => mainStreamRequestedAt.set(streamName, Date.now());

const reapIdleMainStreams = async () => {
  // ทั้งก้อนนี้เป็นของ MediaMTX (ถาม reader count ที่พอร์ต 9997) ภายใต้ go2rtc มันไม่มีอะไร
  // ให้กวาดอยู่แล้วเพราะ activeStreams ว่างเสมอ — แต่การพึ่ง "ความบังเอิญว่า map ว่าง" แปลว่า
  // วันที่มีใครเผลอใส่ของลง activeStreams ตัวนี้จะเริ่มยิงไปพอร์ตที่ไม่มีใครฟังทุก 15 วินาที
  if (STREAM_CORE === 'go2rtc') return;
  // ข้าม main stream ของกล้อง always_on=1 — ไม่มีวัน teardown แม้ไม่มี HLS reader เพราะ
  // consumer จริงคือระบบภายนอกที่ดึงผ่าน Gateway ไม่ใช่ web viewer
  const mainEntries = [...activeStreams.entries()].filter(([name, e]) => !e.isSub && !alwaysOnMainStreamNames.has(name));
  if (mainEntries.length === 0) return;
  const readyMap = await fetchMtxPathReadyMap().catch(() => null);
  for (const [streamName] of mainEntries) {
    let hasReader = true;
    try {
      const info = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: 9997, path: `/v3/paths/get/${encodeURIComponent(streamName)}` }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      hasReader = Array.isArray(info.readers) && info.readers.length > 0;
    } catch {
      hasReader = true; // ไม่รู้สถานะ → ปลอดภัยไว้ก่อน ไม่ปิด
    }

    // มีคนขอ stream/start ใหม่ในช่วง idle window ก็นับว่ายัง active (กัน race ตอนเพิ่งเปิด)
    const recentlyRequested = (Date.now() - (mainStreamRequestedAt.get(streamName) || 0)) < MAIN_STREAM_IDLE_MS;

    if (hasReader || recentlyRequested) {
      mainStreamIdleSince.delete(streamName);
      continue;
    }
    if (!mainStreamIdleSince.has(streamName)) {
      mainStreamIdleSince.set(streamName, Date.now());
      continue;
    }
    if (Date.now() - mainStreamIdleSince.get(streamName) >= MAIN_STREAM_IDLE_MS) {
      console.log(`[Idle Reaper] No readers for ${streamName} — stopping`);
      stopStream(streamName);
      mainStreamIdleSince.delete(streamName);
      mainStreamRequestedAt.delete(streamName);
    }
  }
};
setInterval(() => { reapIdleMainStreams().catch((e) => console.warn('[Idle Reaper]', e.message)); }, MAIN_STREAM_REAP_INTERVAL_MS);

// รันตรวจจับสถานะทันทีหลังจากเปิดระบบ
setTimeout(updateCameraStatuses, 3000);

// รันตรวจจับสถานะซ้ำในทุกๆ 15 วินาที
setInterval(updateCameraStatuses, 15000);
// มีช่อง Uniview รอภาพอยู่เท่านั้นจึงถาม ONVIF; หนึ่งรอบต่อ 2 นาที และไม่ซ้อนรอบเดิม
setTimeout(resolvePendingUniviewStreams, 20_000);
setInterval(resolvePendingUniviewStreams, 120_000);

// /snapshot (ไฟล์ภาพเก่าบนดิสก์ ไม่ต้อง login) ถอดออก 2026-09-29 — หน้าเว็บ/client ไม่ได้ใช้แล้ว และเปิดภาพกล้องให้ใครก็ได้
app.use('/fonts', express.static(path.join(__dirname, '../public/fonts')));
// ภาพที่ผู้ใช้อัปโหลดเอง — แผนที่แบบรูปภาพเขียนไฟล์ลงที่นี่ (`/api/settings/upload-map-image`)
// และ `/api/map-style.json` ก็ส่ง URL `/uploads/maps/...` ออกไปให้ ทั้งสองฝั่งพร้อมมานานแล้ว
// แต่ไม่เคยมี route มาเสิร์ฟมันเลย แผนที่แบบรูปภาพจึงได้ 404 มาตลอดโดยไม่มีใครสังเกต
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

/*
  ไฟล์อัปเดตของโปรแกรม client บน Windows

  เครื่องที่รัน client อยู่บนเน็ตเวิร์กปฏิบัติการที่ออกอินเทอร์เน็ตไม่ได้ การให้ client ไปดึงอัปเดต
  จาก release host สาธารณะจึงใช้ไม่ได้เลย ส่วน Gateway คือที่อยู่เดียวที่ client ทุกตัวมีอยู่แล้ว
  และคุยด้วยอยู่แล้ว การวางไฟล์ที่ scripts/build-client-release.ps1 สร้างไว้ในโฟลเดอร์นี้จึงเป็น
  วิธีปล่อยอัปเดตทั้งหมด — ไม่ต้องมี service เพิ่ม

  ไม่ต้องยืนยันตัวตน เหมือน /fonts และไฟล์ของหน้าเว็บ ไฟล์ในนี้คือตัวโปรแกรมที่แจกให้ติดตั้งอยู่แล้ว
  ไม่มีข้อมูลกล้องหรือคีย์อยู่ข้างใน และ client ต้องอ่านได้ก่อนจะมีคีย์ด้วยซ้ำ

  falsy ได้ ถ้าโฟลเดอร์ยังไม่มี — express.static จะตอบ 404 ซึ่งเป็นสิ่งที่ ClientUpdater
  ฝั่ง Windows ถือว่า "gateway นี้ไม่ได้ปล่อยอัปเดต" ไม่ใช่ข้อผิดพลาด
*/
app.use('/client-updates', express.static(path.join(__dirname, '../client-updates')));

// เส้นทาง FFmpeg ที่มี NVENC/NVDEC สำหรับ GPU Acceleration (RTX GPU)
// รองรับทั้ง Windows (path เต็ม) และ Linux (ffmpeg อยู่ใน PATH แล้วจาก apt/build)
const FFPROBE_PATH = process.env.FFPROBE_PATH || (process.platform === 'win32' ? 'C:\\\\ffmpeg\\\\bin\\\\ffprobe.exe' : 'ffprobe');


// ===============================================================
// Persistent Codec Cache — บันทึกผล codec detection ลงไฟล์
// เพื่อไม่ต้อง detect ใหม่ทุกครั้งที่ restart (ประหยัดเวลาหลายนาที)
// ===============================================================
const CODEC_CACHE_FILE = stateFile('codec_cache.json');
let codecCache = {};
try {
  if (fs.existsSync(CODEC_CACHE_FILE)) {
    codecCache = JSON.parse(fs.readFileSync(CODEC_CACHE_FILE, 'utf8'));
    console.log(`[Codec Cache] ✅ โหลด ${Object.keys(codecCache).length} รายการจาก disk — ข้ามขั้นตอน detection`);
  } else {
    console.log('[Codec Cache] ไม่พบ cache file — จะ detect codec ใหม่ทั้งหมด');
  }
} catch (e) {
  console.warn('[Codec Cache] อ่าน cache ล้มเหลว เริ่มใหม่:', e.message);
  codecCache = {};
}

// บันทึก codec cache ลง disk หลังจาก detect เสร็จ
const saveCodecCache = () => {
  try {
    fs.writeFileSync(CODEC_CACHE_FILE, JSON.stringify(codecCache, null, 2), 'utf8');
  } catch (e) { console.warn('[Codec Cache] บันทึก cache ล้มเหลว:', e.message); }
};

// ตรวจสอบว่า FFmpeg รองรับ h264_nvenc ไหมตอนเริ่มระบบ (ป้องกัน silent failure)
exec(`"${FFMPEG_PATH.replace(/\\\\/g, '\\')}" -encoders`, { windowsHide: true }, (err, stdout) => {
  if (stdout && stdout.includes('h264_nvenc')) {
    console.log('[GPU] h264_nvenc detected — Hardware transcoding enabled (NVIDIA NVENC) ✅');
  } else {
    console.warn('[GPU] h264_nvenc NOT found in FFmpeg build — H.265 transcoding will fall back to software encoding');
  }
});

const detectCameraCodec = (rtspUrl) => {
  return new Promise((resolve) => {
    const sanitizedRtsp = (rtspUrl || '').replace(/"/g, '');
    const loggedRtsp = sanitizedRtsp.replace(/^rtsp:\/\/[^@]*@/i, 'rtsp://[REDACTED]@');
    const ffprobePath = FFPROBE_PATH.replace(/\\\\/g, '\\');
    // ffprobe ชัดกว่า ffmpeg -t 1 — และอย่า default เป็น h264 เมื่อ probe ล้มเหลว
    // execFile + args array: URL จาก DB ไม่ผ่าน shell (เดิม exec ต่อสตริงเป็นคำสั่ง — URL ที่มี $( ) หรือ & รันคำสั่งได้)
    const args = ['-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '8000000', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', sanitizedRtsp];
    execFile(ffprobePath, args, { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
      if (out.includes('hevc') || out.includes('h265')) {
        console.log(`[Codec Detector] H.265: ${loggedRtsp.slice(0, 80)}`);
        return resolve('h265');
      }
      if (out.includes('h264') || out.includes('avc')) {
        console.log(`[Codec Detector] H.264: ${loggedRtsp.slice(0, 80)}`);
        return resolve('h264');
      }
      // probe fail / unknown — assume h265 safer for WebRTC (will transcode) than wrong passthrough
      console.warn(`[Codec Detector] unknown/fail → treat as h265: ${loggedRtsp.slice(0, 80)} | ${redactUrls((stderr || error?.message || '').replaceAll(sanitizedRtsp, '[RTSP URL]')).slice(0, 120)}`);
      resolve('h265');
    });
  });
};

const getSubstreamUrl = (mainRtsp, brand) => {
  // Deprecated: brand path guessing — only for legacy rows without rtsp_sub
  if (!mainRtsp) return '';
  if (brand === 'uniview') {
    return mainRtsp.replace('/media/video1', '/media/video2');
  } else if (brand === 'tiandy') {
    return mainRtsp.replace(/\/(\d+)\/1(\b|$)/, '/$1/2$2');
  } else if (brand === 'hikvision') {
    return mainRtsp.replace(/\/Streaming\/Channels\/(\d+)01\b/, (_, n) => `/Streaming/Channels/${n}02`);
  } else if (brand === 'dahua') {
    return mainRtsp.replace(/subtype=0/, 'subtype=1');
  } else if (brand === 'axis') {
    if (/[?&]resolution=/.test(mainRtsp)) return mainRtsp;
    return `${mainRtsp}${mainRtsp.includes('?') ? '&' : '?'}resolution=640x360`;
  } else if (brand === 'generic') {
    return mainRtsp.replace('/onvif1', '/onvif2');
  }
  return mainRtsp;
};

/** Prefer stored ONVIF sub URL; never invent for onvif_nvr. */
const resolveCameraSubRtsp = (c) => {
  const mainRtsp = (c.rtsp || '').replace(/"/g, '');
  if (c.rtsp_sub && String(c.rtsp_sub).trim()) {
    return String(c.rtsp_sub).replace(/"/g, '');
  }
  if (c.type === 'onvif_nvr') {
    return mainRtsp;
  }
  /*
    กล้องจาก VMS ไม่มี substream จริง และการคืน main แทนก็ไม่ใช่ทางออก — ผู้เรียกตัวหนึ่งคือ
    syncCamerasToGo2rtc() ซึ่งเอาค่าที่ได้ไปสร้าง path `_sub` อีกเส้น ผลคือ NVENC ถอด-เข้ารหัส
    ภาพเดียวกันสองรอบต่อกล้องหนึ่งตัว ทั้งที่ปลายทางเห็นภาพเท่าเดิม
  */
  // กล้องจาก edge ที่ edge ไม่ให้ sub มา ก็ไม่มี sub — การเดา URL แบบยี่ห้อด้านล่างกับที่อยู่ของ edge
  // จะได้ path ที่ไม่มีอยู่จริง
  if (isRelayCamera(c.type)) {
    return null;
  }
  // Legacy transitional fallback
  return getSubstreamUrl(mainRtsp, c.brand || 'generic').replace(/"/g, '') || mainRtsp;
};


// --- CATCH-ALL FOR SPA ---
app.use((req, res) => {
  if (req.path.includes('.') || req.path.startsWith('/api/')) {
    return res.status(404).send('Not Found');
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  // หน้าเว็บคนละบทบาท: Central, Regional และ Edge ใช้ App เดียวกันแต่เมนูต่างกัน
  res.sendFile(path.join(distPath, GATEWAY_ROLE === 'edge' ? 'edge.html' : GATEWAY_ROLE === 'regional' ? 'regional.html' : 'index.html'));
});

const httpServer = app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🚀 Surveillance Gateway running on http://0.0.0.0:${HTTP_PORT} as ${GATEWAY_ROLE} ${NODE_NUMBER} (stream core: ${STREAM_CORE})`);
  setTimeout(syncCamerasToStreamCore, 3000);
});
/*
  ไม่ตัดคำขอที่ยาว: Node 18+ ตั้ง requestTimeout 300 วินาที — ภาพย้อนหลังที่ edge แบบ link อัปโหลดขึ้นมา
  (POST /api/edge-link/playback/:session) ไหลต่อเนื่องตลอดเวลาที่ผู้ชมดูอยู่ จึงถูกตัดกลางคันที่นาทีที่ 5
  headersTimeout คงไว้ (60 วินาที) กันคนเปิด connection ค้างโดยไม่ส่ง header · keepAlive ใช้ค่าเดิมของ Node
*/
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 60_000;

/*
  สาย link ระหว่าง edge กับ central (docs/EDGE-PLAN.md เฟส 4) — สำหรับ edge ที่ central ต่อเข้าไปไม่ถึง
  central: รอรับ WebSocket ที่ /api/edge-link (vms/edge-link-server.js)
  edge: ต่อขึ้นไปเองถ้าตั้ง GATEWAY_CENTRAL_URL + GATEWAY_CENTRAL_TOKEN (vms/edge-link-client.js)
*/
// สาย link ของ edge (null = ไม่ได้ตั้ง) — การแอด/ลบกล้องเรียก catalogSoon ให้ central เห็นทันที
if (acceptsChildEdges) {
  require('./vms/edge-link-server').attachEdgeLink(httpServer, edgeSources, edgeUpdates);
}
if (linksToParent) {
  edgeLink = require('./vms/edge-link-client').startEdgeLink({
    db,
    cameraState,
    ptz: gateway.ptz,
    getCameraRow,
    ffmpegPath: FFMPEG_PATH,
    name: APP_NAMES[GATEWAY_ROLE],
    updater: edgeUpdater,
    listDeleted: () => cameraDeletions.list(),
    playbackSource: regionalPlaybackSource || playback.localSource,
    aiEvents: linksToParent ? aiEvents : null,
    ensureChildStream: GATEWAY_ROLE === 'regional' ? (row, which) => edgeSources.ensureLinkStream(row, which) : null,
    releaseChildStream: GATEWAY_ROLE === 'regional' ? (row, which) => edgeSources.releaseLinkStream(row, which) : null,
    updateMirror: regionalUpdateMirror,
    listChildNodes: GATEWAY_ROLE === 'regional' ? () => edgeSources.listEdges() : null,
  });
}
