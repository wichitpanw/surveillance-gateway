import React, { useState, useEffect, useCallback } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'

// 🏗️ shadcn/ui components
import { TooltipProvider } from "@/components/ui/tooltip"

// 🏗️ Blocks Components
import Login01 from '@/components/login-01'
import AppShell from '@/components/shell/AppShell'
import { APPS } from '@/lib/app-config'
import { API_CAMERA_PROVIDERS, DEFAULT_API_CAMERA_PROVIDER } from '@/lib/camera-api-providers'

// 🏗️ Modular Components
import Dashboard from './components/Dashboard'
import EdgeNodes from './components/EdgeNodes'
import EdgeUpdateBanner from './components/EdgeUpdateBanner'
import CameraMap from './components/CameraMap'
import LiveWall from './components/LiveWall'
import Playback from './components/Playback'
import AiEvents from './components/AiEvents'
import AiSources from '@/components/AiSources'
import EdgeAlertBanner from './components/EdgeAlertBanner'
import CameraManagement from './components/CameraManagement'
import ApiClients from './components/ApiClients'
import AccessControl from './components/AccessControl'
import EventLogs from './components/EventLogs'
import SystemSettings from './components/SystemSettings'
import MapPins from '@/components/MapPins'
import { Toaster } from '@/components/ui/toaster'
import { AppDialogHost } from '@/components/ui/app-dialog-host'
import { toast } from '@/lib/toast'
import { can } from '@/lib/roles'
import { appConfirm } from '@/lib/appDialog'
import { apiUrl, getJsonHeaders, apiFetch, saveSession, clearSession, loadSessionUser, handleAuthExpired } from '@/lib/api'

// 🪟 Modals
import CameraModal from './components/modals/CameraModal'
import ScanModal from './components/modals/ScanModal'
import UserModal from './components/modals/UserModal'
import RoleModal from './components/modals/RoleModal'
import ImagePreviewModal from './components/modals/ImagePreviewModal'
import FullScreenMapPicker from './components/modals/FullScreenMapPicker'
import EditMapPinModal from './components/modals/EditMapPinModal'
import RenameGroupModal from './components/modals/RenameGroupModal'

// ==========================================
// SECTION 1: CONSTANTS & CONFIGURATION
// ==========================================
const MAP_CENTER = { lat: 13.7563, lng: 100.5018 }

/**
 * role: 'central' | 'regional' | 'edge' — มาจาก entry ของแต่ละหน้า สามโปรแกรมใช้ App ตัวเดียวกัน
 * ต่างกันที่ชื่อ เมนู และหน้าที่ (src/lib/app-config.js)
 */
function App({ role = 'central' }) {
  const app = APPS[role] || APPS.central
  const [serverIP] = useState(window.location.hostname)
  // --- STATE MANAGEMENT ---
  // ผู้ใช้จาก localStorage ใช้ได้เฉพาะเมื่อมี session token — ก้อนเก่าที่เก็บ password ไว้ถูกล้างแล้วให้ login ใหม่
  const [loggedInUser, setLoggedInUser] = useState(() => loadSessionUser())
  // หน้าแรกคือ Cameras ไม่ใช่แผนที่อีกต่อไป — 5173 เป็นแพลตฟอร์มบริหารจัดการล้วน
  // ส่วนการดูภาพย้ายไปอยู่ที่ client ทั้งหมด
  const [currentTab, setCurrentTab] = useState(app.home)
  // AI Events → Playback: กล้องและเวลาที่จะเปิด (Playback เคลียร์เองหลังใช้)
  const [playbackTarget, setPlaybackTarget] = useState(null)
  // commit ที่ central รันอยู่ — หน้า Edge Nodes ใช้เตือนเมื่อ edge รันคนละ commit
  const [instanceInfo, setInstanceInfo] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('vms_theme') || 'dark')
  const [cameras, setCameras] = useState([])
  const [users, setUsers] = useState([])
  const [cameraStatus, setCameraStatus] = useState({})
  const [systemStats, setSystemStats] = useState({ cpu: 0, ram: 0, usedRamGB: 0, totalRamGB: 0, disk: 0 })
  const [logs, setLogs] = useState([])
  const [logFilters, setLogFilters] = useState({ 
    date: new Date().toLocaleDateString('en-CA'), 
    type: 'all' 
  })
  const [systemSettings, setSystemSettings] = useState({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' })
  const [isLoading, setIsLoading] = useState(false)
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [loginError, setLoginError] = useState('')

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    localStorage.setItem('vms_theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, []);

  // สถานะพับ/กางกลุ่มกล้องในหน้า Camera Management และ AI Management
  const [expandedAssetGroups, setExpandedAssetGroups] = useState({})



  // Camera Management States
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState('add')
  const [formData, setFormData] = useState({ id: '', name: '', group: 'Default', type: 'manual', apiProvider: DEFAULT_API_CAMERA_PROVIDER, rtspUrl: '', ip: '', onvifPort: '80', apiPort: '80', rtspPort: '554', onvifUser: 'admin', onvifPass: '', lat: null, lng: null, oldName: '', brand: 'generic', stream_type: 'main', rtspSubUrl: '' })
  const [isMapFullPickerOpen, setIsMapFullPickerOpen] = useState(false)
  const [mapPinEditCam, setMapPinEditCam] = useState(null)
  const [mapPinCoords, setMapPinCoords] = useState({ lat: MAP_CENTER.lat, lng: MAP_CENTER.lng })
  const [isMapPinEditOpen, setIsMapPinEditOpen] = useState(false)
  const [isMapPinSaving, setIsMapPinSaving] = useState(false)
  const [isScanModalOpen, setIsScanModalOpen] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [scannedDevices, setScannedDevices] = useState([])
  const [subnetPrefix, setSubnetPrefix] = useState('')
  const [nvrChannels, setNvrChannels] = useState([])
  const [vmsCameras, setVmsCameras] = useState([])
  const [vmsSources, setVmsSources] = useState([])
  const [selectedChannels, setSelectedChannels] = useState([])
  const [selectedCamerasForDelete, setSelectedCamerasForDelete] = useState([])

  // User Modal States
  const [isUserModalOpen, setIsUserModalOpen] = useState(false)
  const [userModalMode, setUserModalMode] = useState('add')
  // RBAC: รายการ role + catalogue สิทธิ์ + state ของ RoleModal
  const [roles, setRoles] = useState([])
  const [permCatalogue, setPermCatalogue] = useState({ menu: [], operation: [] })
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false)
  const [roleModalMode, setRoleModalMode] = useState('add')
  const [roleModalRole, setRoleModalRole] = useState(null)
  const [userFormData, setUserFormData] = useState({ id: '', username: '', password: '', role: 'monitor', allowedCameras: [] })

  // Rename Group Modal States
  const [isRenameGroupModalOpen, setIsRenameGroupModalOpen] = useState(false)
  const [renameGroupOldName, setRenameGroupOldName] = useState('')

  const [selectedEventImage, setSelectedEventImage] = useState(null)

  // --- DERIVED DATA ---
  // `|| []` เดิมกันได้แค่ null/undefined ไม่ได้กันกรณี cameras กลายเป็น object (เช่น error body
  // ที่หลุดเข้ามาทาง setCameras) ซึ่งทำให้ .filter ไม่มีอยู่จริง → throw ตอน render → จอขาว
  // ต้นเหตุแก้ที่ fetchList แล้ว ตรงนี้เป็นเกราะชั้นสองไม่ให้ทั้งแอปตายเพราะข้อมูลรูปร่างผิด
  const visibleCameras = (Array.isArray(cameras) ? cameras : []).filter(c => {
    if (!loggedInUser) return false;
    // ขอบเขตกล้องมาจาก role (deviceIds เป็น camera_id) — allDevices/null = เห็นทุกตัว
    // ต้องตรงกับ /api/cameras ฝั่ง server ที่กรองด้วย req.deviceIds เหมือนกัน
    // (deviceIds ยังไม่มาก่อน /api/me กลับ = เห็นแค่ที่ backend ส่งมาให้อยู่แล้ว จึงปลอดภัย)
    if (loggedInUser.allDevices || loggedInUser.deviceIds == null) return true;
    return loggedInUser.deviceIds.includes(c.id);
  });

  const groupedCameras = visibleCameras.reduce((acc, cam) => {
    const group = cam.group_name || 'Default';
    if (!acc[group]) acc[group] = [];
    acc[group].push(cam);
    return acc;
  }, Object.create(null));


  // --- HANDLERS ---
  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setLoginError('');
    try {
      const res = await fetch(apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        // เก็บแค่ token + ข้อมูลผู้ใช้ ไม่เก็บรหัสผ่าน · ล้างรหัสในฟอร์มทิ้งทันที
        saveSession(data.token, data.user);
        setLoginForm((f) => ({ ...f, password: '' }));
        setLoggedInUser(data.user);
      } else if (res.status === 429) {
        setLoginError(data.error || 'ลองผิดหลายครั้งเกินไป — รอสักครู่แล้วลองใหม่');
      } else {
        setLoginError('Invalid credentials');
      }
    } catch { setLoginError('Server connection error'); }
    setIsLoading(false);
  }

  const getHeaders = useCallback(() => getJsonHeaders(), []);

  // ดึง list จาก API แบบตรวจให้ครบก่อนคืนค่า — เดิมทุกจุดหลัง save/delete เขียนเป็น
  // `const updated = await (await fetch(...)).json(); setCameras(updated)` ซึ่ง "ไม่" เช็ค res.ok
  // ถ้า server ตอบ error ที่ body เป็น JSON (เช่น 401 ตอน session หมดอายุ → {"error": ...})
  // ค่าที่ได้จะเป็น object ไม่ใช่ array แล้ว setCameras(object) ทำให้ visibleCameras เรียก
  // .filter() บน object → throw ตอน render → จอขาวทั้งแอป (ตอนโหลดครั้งแรกไม่พังเพราะจุดนั้น
  // เช็ค res.ok อยู่แล้ว อาการเลยโผล่เฉพาะหลังกดบันทึก/ลบ)
  // คืน null เมื่อล้มเหลว เพื่อให้ผู้เรียกเลือกได้ว่าจะคงข้อมูลเดิมไว้ ดีกว่าล้างเป็น []
  const fetchList = useCallback(async (url) => {
    try {
      const res = await apiFetch(url, { headers: getHeaders() });
      if (res.status === 401) {
        handleAuthExpired();
        return null;
      }
      if (!res.ok) {
        console.warn(`[fetchList] ${url} -> HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.warn(`[fetchList] ${url} -> expected array, got ${typeof data}`);
        return null;
      }
      return data;
    } catch (e) {
      console.warn(`[fetchList] ${url} failed:`, e.message);
      return null;
    }
  }, [getHeaders]);

  useEffect(() => {
    const onAuthExpired = () => setLoggedInUser(null);
    window.addEventListener('cctv:auth-expired', onAuthExpired);
    return () => window.removeEventListener('cctv:auth-expired', onAuthExpired);
  }, []);

  // รีเฟรชสิทธิ์จาก /api/me ตอน mount และตอนสลับแท็บกลับมา — user object ใน localStorage
  // ใช้แค่ paint แรก ถ้าแอดมินแก้ role ระหว่างที่ผู้ใช้ล็อกอินอยู่ ค่าจะไม่ค้าง (401 = logout)
  useEffect(() => {
    if (!loggedInUser) return;
    let cancelled = false;
    const refreshMe = async () => {
      try {
        const res = await apiFetch('/api/me', { headers: getHeaders() });
        if (cancelled) return;
        if (res.status === 401) {
          handleAuthExpired();
          return;
        }
        if (!res.ok) return;
        const me = await res.json();
        setLoggedInUser((prev) => {
          if (!prev) return prev;
          const next = { ...prev, ...me };
          saveSession(null, next);
          return next;
        });
      } catch { /* ออฟไลน์ชั่วคราว — คงค่าที่ cache ไว้ */ }
    };
    refreshMe();
    const onFocus = () => refreshMe();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
    // ผูกกับ username เท่านั้น ไม่ผูกทั้ง object ไม่งั้น setLoggedInUser จะวนลูป
  }, [loggedInUser?.username, getHeaders]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLog = (username, action, details) => {
    if (!loggedInUser) return;
    apiFetch(`/api/logs`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username, action, details })
    }).catch(() => { /* ออกจากระบบแล้วไม่ให้คำตอบ log เก่ากระทบบัญชีใหม่ */ });
  }

  const handleLogout = () => {
    saveLog(loggedInUser.username, 'Logout', 'ออกจากระบบ 🚪');
    setLoggedInUser(null);
    clearSession();
    setLoginForm({ username: '', password: '' });
  }

  const handleClearLogs = async () => {
    const targetDate = logFilters.date; // 📅 ดึงวันที่ที่เรากำลังเปิดดูอยู่ค่ะ
    const ok = await appConfirm({
      title: 'Clear Logs',
      description: `ล้างประวัติของวันที่ ${targetDate}? การกระทำนี้ย้อนกลับไม่ได้`,
      confirmText: 'Clear',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/logs/clear?date=${targetDate}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      if (res.ok) {
        setLogs([]); // 💡 ล้างหน้าจอทันที
        saveLog(loggedInUser.username, 'Clear Logs', `ล้างประวัติเหตุการณ์ของวันที่ ${targetDate} 🧹`);
      }
    } catch (e) { console.error("Failed to clear logs", e); }
  }

  const handleSaveCamera = async () => {
    setIsLoading(true);
    try {
      const isEdit = modalMode === 'edit';
      const url = isEdit ? `/api/cameras/${formData.id}` : `/api/cameras`;
      const res = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ ...formData, name: (formData.name || '').trim(), group: (formData.group || '').trim() || 'Default' })
      });
      if (res.ok) {
        const updated = await fetchList(`/api/cameras`);
        if (updated) setCameras(updated);
        setIsModalOpen(false);
        saveLog(loggedInUser.username, isEdit ? 'Edit Camera' : 'Add Camera', `${isEdit ? 'แก้ไข' : 'เพิ่ม'}กล้อง "${formData.name}" 📹`);
      } else {
        // เดิมเงียบ — กดแล้วฟอร์มค้างไม่บอกเหตุผล (เช่น จังหวัดไม่ถูกต้อง, บันทึก DB ไม่ได้)
        const errBody = await res.json().catch(() => ({}));
        toast({ title: errBody.error || `บันทึกกล้องไม่สำเร็จ (${res.status})`, variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: e.message || 'บันทึกกล้องไม่สำเร็จ', variant: 'destructive' });
    }
    setIsLoading(false);
  }

  const handleToggleSelectCamera = (id) => {
    setSelectedCamerasForDelete(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  const handleBulkDelete = async () => {
    const ok = await appConfirm({
      title: 'Delete Cameras',
      description: `ลบกล้องที่เลือก ${selectedCamerasForDelete.length} ตัว?`,
      confirmText: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/cameras/bulk-delete`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ ids: selectedCamerasForDelete })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || `ลบกล้องไม่สำเร็จ (${res.status})`);
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      setSelectedCamerasForDelete([]);
      saveLog(loggedInUser.username, 'Delete Camera', `ลบกล้องออก ${selectedCamerasForDelete.length} ตัว 🗑️`);
    } catch (err) {
      if (err.name !== 'AbortError') toast({ title: err.message || 'ลบกล้องไม่สำเร็จ', variant: 'destructive' });
    }
    setIsLoading(false);
  }

  const handleDeleteGroup = async (groupName, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const ok = await appConfirm({
      title: 'Delete Group',
      description: `ลบกล้องทั้งหมดในกลุ่ม "${groupName}"?`,
      confirmText: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    const groupCams = cameras.filter(c => c.group_name === groupName);
    const ids = groupCams.map(c => c.id);
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/cameras/bulk-delete`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ ids })
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || `ลบกล้องไม่สำเร็จ (${res.status})`);
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      saveLog(loggedInUser.username, 'Delete Group', `ลบกล้องยกกลุ่ม "${groupName}" (${ids.length} ตัว) 🗑️`);
    } catch (err) {
      if (err.name !== 'AbortError') toast({ title: err.message || 'ลบกลุ่มไม่สำเร็จ', variant: 'destructive' });
    }
    setIsLoading(false);
  }

  // 📁 เรียกเปิดหน้าต่างป๊อปอัพเปลี่ยนชื่อกลุ่มกล้อง
  const triggerRenameGroup = (oldName) => {
    setRenameGroupOldName(oldName);
    setIsRenameGroupModalOpen(true);
  }

  // 📁 จัดการบันทึกการเปลี่ยนชื่อกลุ่มกล้อง
  const handleRenameGroup = async (newName) => {
    if (!newName || newName.trim() === '' || newName === renameGroupOldName) {
      setIsRenameGroupModalOpen(false);
      return;
    }

    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/cameras/rename-group`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ oldName: renameGroupOldName, newName: newName.trim() })
      });
      if (res.ok) {
        const updated = await fetchList(`/api/cameras`);
        if (updated) setCameras(updated);
        saveLog(loggedInUser?.username, 'Rename Group', `เปลี่ยนชื่อกลุ่มกล้องจาก "${renameGroupOldName}" เป็น "${newName.trim()}" 📁`);
      }
    } catch (e) {
      console.error(e);
    }
    setIsLoading(false);
    setIsRenameGroupModalOpen(false);
  }

  const handleStartScan = async () => {
    setIsScanModalOpen(true);
    setIsScanning(true);
    setScannedDevices([]);
    try {
      const url = subnetPrefix
        ? `/api/scan?subnet=${encodeURIComponent(subnetPrefix)}`
        : `/api/scan`;
      const res = await apiFetch(url, {
        headers: getHeaders()
      });
      if (res.ok) setScannedDevices(await res.json());
    } catch { /* เงียบไว้ ปล่อยให้ UI คงสถานะเดิม */ }
    setIsScanning(false);
  }

  const selectScannedDevice = (device) => {
    setFormData({
      ...formData,
      type: 'onvif_cam',
      name: device.name,
      ip: device.ip,
      onvifPort: device.onvifPort || '80',
      // ยี่ห้อจากผลสแกนก่อน (backend ถามกล้องเอง เช่น Axis ผ่าน VAPIX) แล้วค่อยเดาจากชื่อ
      brand: device.brand ||
             (device.name.toLowerCase().includes('tiandy') ? 'tiandy' :
             device.name.toLowerCase().includes('dahua') ? 'dahua' :
             device.name.toLowerCase().includes('hik') ? 'hikvision' :
             device.name.toLowerCase().includes('axis') ? 'axis' : 'generic')
    });
    setIsScanModalOpen(false);
    setIsModalOpen(true);
    setModalMode('add');
  }

  const handleFetchNvrChannels = async () => {
    setIsLoading(true);
    try {
      if (formData.type === 'vms' && formData.vmsKind === 'milestone'
        && (!formData.ip.trim() || !formData.onvifUser.trim() || !formData.onvifPass)) {
        toast({ title: 'กรอกที่อยู่ Bridge, Username และ Password ก่อนสแกน', variant: 'destructive' });
        return;
      }
      const apiProvider = formData.type === 'api'
        ? API_CAMERA_PROVIDERS[formData.apiProvider || DEFAULT_API_CAMERA_PROVIDER] : null;
      if (formData.type === 'api' && !apiProvider) throw new Error('API Provider นี้ยังไม่รองรับ');
      const res = await apiFetch(apiProvider?.scanPath || `/api/nvr/channels`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
           ip: formData.ip,
           onvifPort: formData.onvifPort,
           ...(apiProvider ? { apiPort: formData.apiPort } : {}),
           user: formData.onvifUser,
           pass: formData.onvifPass,
           brand: apiProvider?.brand || formData.brand,
           milestoneBridge: formData.type === 'vms' && formData.vmsKind === 'milestone',
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'Failed to connect to NVR (ONVIF)', variant: 'destructive' });
        setNvrChannels([]);
        setSelectedChannels([]);
        return;
      }
      const channels = Array.isArray(data) ? data : [];
      setNvrChannels(channels);
      // ผู้ให้บริการที่รองรับช่อง offline ให้เพิ่มเป็นแถวรอภาพได้; Edge เติม RTSP ภายหลัง
      // ช่องที่แอดไว้แล้ว (existingId) ไม่เลือกให้ — สแกนซ้ำเพื่อเก็บช่องที่เคยออฟไลน์จะได้เฉพาะตัวที่ยังขาด
      // แถวที่ไม่ผูก VideoSource (เช่น สตรีมรวมของ NVR Uniview /unicast/c0) ไม่ใช่กล้อง — ไม่เลือกให้
      setSelectedChannels(channels.filter(c => !c.existingId && (!c.noVideoSource || (formData.type === 'vms' && formData.vmsKind === 'milestone'))
        && (apiProvider?.importMode === 'axis_s30' ? c.isOnline && !!c.sourceId
          : apiProvider?.offlineImport ? Number.isInteger(c.channel) && c.channel > 0 : c.isOnline && c.main?.rtsp)).map(c => c.id));
      if (!channels.length) toast({ title: 'ONVIF connected but no channels found', variant: 'destructive' });
    } catch (e) {
      toast({ title: e.message || 'Failed to connect to NVR', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  /*
    ถามรายชื่อกล้องจาก VMS

    ยิงครั้งเดียวต่อการกดหนึ่งครั้ง ไม่มี retry ในโค้ดเส้นนี้: Digifort บล็อกบัญชีเมื่อใส่รหัสผิด
    ครบสามครั้ง และบัญชีที่ถูกบล็อกทำให้กล้องทุกตัวที่ดึงผ่านมันดับพร้อมกัน
  */
  const handleFetchVmsCameras = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/vms/probe`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          kind: formData.vmsKind || 'digifort',
          host: formData.ip,
          port: formData.vmsPort || (formData.vmsKind === 'edge' ? '5173' : formData.vmsKind === 'dss' ? '443' : '8601'),
          user: formData.onvifUser,
          pass: formData.onvifPass,
          key: formData.edgeKey,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'ติดต่อ VMS ไม่ได้', variant: 'destructive' });
        setVmsCameras([]);
        setSelectedChannels([]);
        return;
      }
      const list = Array.isArray(data.cameras) ? data.cameras : [];
      setVmsCameras(list);
      // ติ๊กให้เฉพาะตัวที่ VMS บอกว่ากำลังทำงานจริง ตัวที่เหลือยังเลือกเองได้ถ้าตั้งใจ
      setSelectedChannels(list.filter(c => c.working).map(c => c.ref));
      if (!list.length) toast({ title: 'ต่อ VMS ได้ แต่ไม่มีกล้องในระบบ', variant: 'destructive' });
    } catch (e) {
      toast({ title: e.message || 'ติดต่อ VMS ไม่ได้', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  const handleImportVms = async () => {
    setIsLoading(true);
    try {
      if (!selectedChannels.length) {
        toast({ title: 'เลือกอย่างน้อย 1 กล้อง', variant: 'destructive' });
        return;
      }
      const res = await apiFetch(`/api/vms/import`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          kind: formData.vmsKind || 'digifort',
          host: formData.ip,
          port: formData.vmsPort || (formData.vmsKind === 'edge' ? '5173' : formData.vmsKind === 'dss' ? '443' : '8601'),
          rtspPort: formData.rtspPort || '554',
          user: formData.onvifUser,
          pass: formData.onvifPass,
          key: formData.edgeKey,
          group: formData.group,
          refs: selectedChannels,
          province_code: formData.province_code,
          district_code: formData.district_code,
          // ไม่ส่งพิกัด — กล้องเข้ามาเป็นชุดและอยู่คนละที่ ค่า default ของฟอร์มคือจุดกลางแผนที่
          // ซึ่งไม่ใช่ที่ตั้งของกล้องตัวไหนเลย ให้ไปปักในหน้า "ปักหมุดกล้อง"
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'Import failed', variant: 'destructive' });
        return;
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      setIsModalOpen(false);
      setVmsCameras([]);
      setSelectedChannels([]);
      toast({ title: `เพิ่มกล้อง ${data.added} ตัวจาก VMS${data.skipped ? ` (ข้ามที่มีอยู่แล้ว ${data.skipped} ตัว)` : ''}` });
    } catch (e) {
      toast({ title: e.message || 'Import failed', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  /*
    ทบทวนรายชื่อกล้องกับ VMS ตามคำสั่งของคน ไม่ใช่ตามเวลา

    ระบบไม่ลบกล้องเองไม่ว่ากรณีใด เพราะ VMS ที่ตอบไม่ครบชั่วคราวจะกลายเป็นการลบกล้องทั้งชุด
    พร้อมหมุดแผนที่และสิทธิ์ที่ผูกไว้ — สิ่งที่ทำได้คือบอกคนว่าอะไรไม่ตรงกันแล้วให้คนตัดสิน
  */
  const handleVmsResync = async () => {
    if (!vmsSources.length) return;
    setIsLoading(true);
    try {
      const lines = [];
      for (const source of vmsSources) {
        const res = await apiFetch(`/api/vms/sources/${source.id}/resync`, { method: 'POST', headers: getHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lines.push(`${source.host}: ${data.error || 'ทบทวนไม่สำเร็จ'}`);
          continue;
        }
        lines.push(`${source.host}: ในระบบ ${data.imported} ตัว · หายจาก VMS ${data.missing.length} · ยังไม่ได้ import ${data.newCameras.length}`);
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      toast({ title: 'Re-sync VMS', description: lines.join(' | ') });
    } catch (e) {
      toast({ title: e.message || 'ทบทวน VMS ไม่สำเร็จ', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  const handleBulkSaveNvr = async () => {
    setIsLoading(true);
    try {
      if (formData.type === 'vms' && formData.vmsKind === 'milestone'
        && (!formData.ip.trim() || !formData.onvifUser.trim() || !formData.onvifPass)) {
        toast({ title: 'กรอกที่อยู่ Bridge, Username และ Password ก่อนนำเข้า', variant: 'destructive' });
        return;
      }
      const selected = nvrChannels.filter(c => selectedChannels.includes(c.id));
      if (!selected.length) {
        toast({ title: 'เลือกอย่างน้อย 1 ช่อง', variant: 'destructive' });
        return;
      }
      const apiProvider = formData.type === 'api'
        ? API_CAMERA_PROVIDERS[formData.apiProvider || DEFAULT_API_CAMERA_PROVIDER] : null;
      if (formData.type === 'api' && !apiProvider) throw new Error('API Provider นี้ยังไม่รองรับ');
      if (selected.some(c => !c?.main?.rtsp && !(apiProvider?.importMode === 'axis_s30' && c.sourceId)
        && !(apiProvider?.offlineImport && Number.isInteger(c.channel) && c.channel > 0))) {
        toast({ title: 'ช่องที่เลือกไม่มีแหล่งภาพ — Scan Channels ใหม่', variant: 'destructive' });
        return;
      }
      const baseName = (formData.name || '').trim();
      const group = (formData.group || '').trim() || 'Default';
      const res = await apiFetch(`/api/cameras/bulk-add`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
           baseName,
           group,
           ip: formData.ip,
           onvifPort: formData.onvifPort,
           ...(apiProvider ? { apiPort: formData.apiPort } : {}),
           rtspPort: formData.rtspPort,
           user: formData.onvifUser,
           pass: formData.onvifPass,
           brand: apiProvider?.brand || formData.brand,
           importMode: formData.type === 'vms' && formData.vmsKind === 'milestone'
             ? 'milestone_bridge' : apiProvider?.importMode || 'onvif_nvr',
           // province_code/district_code ไปกับชุดด้วย — เดิมไม่ได้ส่ง จังหวัดที่เลือกในฟอร์มจึงหายทั้งชุด
           province_code: formData.province_code || null,
           district_code: formData.district_code || null,
           channels: selected.map((c, i) => {
             // เลขช่องจริงของ NVR (จาก RTSP ที่ NVR ตอบ) — ลำดับในรายการไม่ใช่เลขช่อง
             const chNo = c.channel || i + 1;
             return {
               id: c.id,
               channel: chNo,
               ...(apiProvider?.importMode === 'axis_s30' ? { sourceId: c.sourceId } : {}),
               // มีชื่อ base ให้ -> ต่อท้ายด้วยชื่อ channel จาก ONVIF (ถ้ามี)
               // ไม่มีชื่อ base -> ใช้ชื่อ channel จาก ONVIF ตรงๆเลย ไม่ต้องพิมพ์เอง
               name: baseName
                 ? `${baseName} CH ${chNo}${c.name ? ` (${c.name})` : ''}`
                 : (c.name || `CH ${chNo}`),
               main: c.main,
               sub: c.sub || c.main,
             };
           }),
           // ไม่ส่งพิกัด — ช่องของ NVR อยู่คนละที่กัน ปักทีหลังในหน้า Map Pins (เหมือน import จาก VMS)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'Import failed', variant: 'destructive' });
        return;
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      setIsModalOpen(false);
      setNvrChannels([]);
      setSelectedChannels([]);
      const added = data.count ?? selected.length;
      toast({ title: `เพิ่มกล้อง ${added} ช่อง${data.skipped ? ` (ข้ามที่มีอยู่แล้ว ${data.skipped} ช่อง)` : ''} — ยังไม่มีหมุด ปักได้ที่หน้า Map Pins` });
      saveLog(loggedInUser.username, 'Bulk Add', `เพิ่มกล้องจาก NVR ONVIF "${baseName || formData.ip}" รวม ${added} ช่อง 📹`);
    } catch (e) {
      toast({ title: e.message || 'Import failed', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  const handleSaveUser = async () => {
    setIsLoading(true);
    try {
      const isEdit = userModalMode === 'edit';
      const payload = { ...userFormData, id: userFormData.id || `user_${Date.now()}` };
      const url = isEdit ? `/api/users/${payload.id}` : `/api/users`;
      const res = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        // เปลี่ยนรหัสผ่านของตัวเอง: session เดิมใช้ไม่ได้แล้ว server ออก token ใหม่มาให้ — เก็บก่อนยิงคำขอถัดไป
        const saved = await res.json().catch(() => ({}));
        if (saved.token) {
          saveSession(saved.token, null);
          setLoggedInUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
        }
        const updated = await fetchList(`/api/users`);
        if (updated) setUsers(updated);
        setIsUserModalOpen(false);
        toast({ title: isEdit ? 'แก้ไขผู้ใช้งานสำเร็จ' : 'เพิ่มผู้ใช้งานสำเร็จ' });
        saveLog(loggedInUser.username, isEdit ? 'Edit User' : 'Add User', `${isEdit ? 'แก้ไข' : 'เพิ่ม'}ผู้ใช้งาน "${userFormData.username}" 👤`);
      } else {
        const errBody = await res.json().catch(() => ({}));
        toast({ title: errBody.error || `บันทึกไม่สำเร็จ (${res.status})`, variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: e.message || 'บันทึกไม่สำเร็จ', variant: 'destructive' });
    }
    setIsLoading(false);
  }

  // รับ user object ตรงๆ จากแถวในตาราง (ไม่ผ่าน userFormData/modal อีกต่อไป — ลบทำได้จากตารางโดยตรง)
  const handleDeleteUser = async (targetUser) => {
    const ok = await appConfirm({
      title: 'Delete User',
      description: `ลบผู้ใช้งาน "${targetUser.username}"?`,
      confirmText: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/users/${targetUser.id}`, { method: 'DELETE', headers: getHeaders() });
      if (res.ok) {
        const updated = await fetchList(`/api/users`);
        if (updated) setUsers(updated);
        toast({ title: 'ลบผู้ใช้งานสำเร็จ' });
        saveLog(loggedInUser.username, 'Delete User', `ลบผู้ใช้งาน "${targetUser.username}" 🗑️`);
      } else {
        const errBody = await res.json().catch(() => ({}));
        toast({ title: errBody.error || `ลบไม่สำเร็จ (${res.status})`, variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: e.message || 'ลบไม่สำเร็จ', variant: 'destructive' });
    }
    setIsLoading(false);
  }

  const refreshRoles = async () => {
    const data = await fetchList(`/api/roles`);
    if (data) setRoles(data);
  };

  const openRoleModal = (mode, role) => {
    setRoleModalMode(mode);
    setRoleModalRole(role);
    setIsRoleModalOpen(true);
  };

  const handleDeleteRole = async (role) => {
    const ok = await appConfirm({
      title: 'Delete Role',
      description: `ลบ role "${role.label || role.name}"?`,
      confirmText: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/roles/${role.id}`, { method: 'DELETE', headers: getHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `ลบไม่สำเร็จ (${res.status})`);
      toast({ title: 'ลบ role สำเร็จ' });
      refreshRoles();
    } catch (e) {
      toast({ title: e.message, variant: 'destructive' });
    }
  };

  const openAddModal = () => {
    setModalMode('add');
    // กล้องใหม่ยังไม่มีหมุด (null) — จุดกลางแผนที่ไม่ใช่ที่ตั้งของกล้องตัวไหน ปักเองในฟอร์มหรือหน้า Map Pins
    setFormData({ id: '', name: '', group: 'Default', type: 'manual', apiProvider: DEFAULT_API_CAMERA_PROVIDER, rtspUrl: '', ip: '', onvifPort: '80', apiPort: '80', rtspPort: '554', onvifUser: 'admin', onvifPass: '', lat: null, lng: null, oldName: '', brand: 'generic', stream_type: 'main', rtspSubUrl: '' });
    setIsModalOpen(true);
  }

  const openEditModal = (cam) => {
    setModalMode('edit');
    setFormData({
      id: cam.id,
      name: cam.name,
      group: cam.group_name,
      type: cam.type || 'manual',
      rtspUrl: cam.rtsp,
      /*
        แสดงเฉพาะ sub ที่ผู้ใช้กรอกเอง: กล้อง RTSP ที่ sub ไม่ใช่เส้นเดียวกับ main และกล้อง ONVIF ที่ไม่มี token ของ sub
        (sub จาก ONVIF มี token เสมอ) — ไม่เอา sub ที่ได้จาก ONVIF มาใส่ช่องนี้
      */
      rtspSubUrl: cam.rtsp_sub && cam.rtsp_sub !== cam.rtsp
        && (cam.type === 'manual' || (cam.type === 'onvif_cam' && !cam.onvif_sub_token)) ? cam.rtsp_sub : '',
      ip: cam.ip,
      onvifPort: cam.onvifPort || '80',
      rtspPort: cam.rtspPort || '554',
      onvifUser: cam.onvifUser || 'admin',
      onvifPass: cam.onvifPass || '',
      // กล้องที่ยังไม่ปักต้องคงเป็น null — เดิมเติมจุดกลางให้ แล้วกด Confirm = ปักหมุดโดยไม่ตั้งใจ
      lat: Number.isFinite(parseFloat(cam.lat)) ? parseFloat(cam.lat) : null,
      lng: Number.isFinite(parseFloat(cam.lng)) ? parseFloat(cam.lng) : null,
      oldName: cam.name,
      brand: cam.brand || 'generic',
      stream_type: cam.stream_type || 'main',
      province_code: cam.province_code || null,
      district_code: cam.district_code || null,
    });
    setIsModalOpen(true);
  }

  const openMapPinEdit = (cam) => {
    if (!cam?.id) {
      toast({ title: 'ไม่พบข้อมูลกล้อง', variant: 'destructive' });
      return;
    }
    setMapPinEditCam(cam);
    setMapPinCoords({
      lat: Number.isFinite(parseFloat(cam.lat)) ? parseFloat(cam.lat) : MAP_CENTER.lat,
      lng: Number.isFinite(parseFloat(cam.lng)) ? parseFloat(cam.lng) : MAP_CENTER.lng,
    });
    setIsMapPinEditOpen(true);
  };

  const closeMapPinEdit = () => {
    if (isMapPinSaving) return;
    setIsMapPinEditOpen(false);
    setMapPinEditCam(null);
  };

  const handleSaveMapPin = async () => {
    if (!mapPinEditCam?.id) return;
    const lat = parseFloat(mapPinCoords.lat);
    const lng = parseFloat(mapPinCoords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      toast({ title: 'พิกัดไม่ถูกต้อง', variant: 'destructive' });
      return;
    }
    setIsMapPinSaving(true);
    try {
      const res = await apiFetch(`/api/cameras/${mapPinEditCam.id}/location`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ lat, lng }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'บันทึกหมุดไม่สำเร็จ', variant: 'destructive' });
        return;
      }
      const updated = await fetchList(`/api/cameras`);
      if (updated) setCameras(updated);
      toast({ title: `อัปเดตหมุด: ${mapPinEditCam.name}` });
      setIsMapPinEditOpen(false);
      setMapPinEditCam(null);
    } catch (e) {
      toast({ title: e.message || 'บันทึกหมุดไม่สำเร็จ', variant: 'destructive' });
    } finally {
      setIsMapPinSaving(false);
    }
  };


  // --- EFFECTS ---
  useEffect(() => {
    if (!loggedInUser) return;
    const fetchInitialData = async () => {
      const fetchData = async (url, setter) => {
        try {
          const res = await apiFetch(url, { headers: getHeaders() });
          if (res.status === 401) return;
          if (res.ok) {
            const data = await res.json();
            setter(data);
            return data;
          }
        } catch (e) { console.error(`Fetch failed for ${url}`, e); }
      };

      fetchData(`/api/cameras`, setCameras);
      fetchData(`/api/instance`, setInstanceInfo);
      // /api/vms อยู่หลัง edgeOnly — central ได้ 403 ทุกครั้ง ไม่ต้องถาม
      if (app.role === 'edge') fetchData(`/api/vms/sources`, (data) => { if (Array.isArray(data)) setVmsSources(data); });
      fetchData(`/api/users`, setUsers);
      fetchData(`/api/roles`, (data) => { if (Array.isArray(data)) setRoles(data); });
      fetchData(`/api/permissions`, (data) => { if (data) setPermCatalogue(data); });
      fetchData(`/api/settings`, (data) => {
        if (data) setSystemSettings(data);
      });
    }
    fetchInitialData();
  }, [loggedInUser, serverIP]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loggedInUser) return;
    const checkStatus = async () => {
      try {
        const res = await apiFetch(`/api/status`, { headers: getHeaders() });
        if (res.ok) setCameraStatus(await res.json());
      } catch { /* เงียบไว้ ปล่อยให้ UI คงสถานะเดิม */ }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 15000); // 💡 ปรับจาก 10 เป็น 15 วินาทีเพื่อลดภาระเครื่องค่ะ
    return () => clearInterval(interval);
  }, [loggedInUser, serverIP]);

  /*
    โพลล์เฉพาะสิ่งที่มีคนมองอยู่
    - /api/stats: แถบ HardwareMonitor บน header เห็นทุกหน้า จึงโพลล์ตลอด แต่หยุดเมื่อแท็บเบราว์เซอร์ถูกซ่อน
      (ฝั่ง Windows ยิง wmic/PowerShell ต่อคำขอ — แท็บที่เปิดทิ้งไว้หลายสิบแท็บคือ process หลายสิบตัวทุก 10 วินาที)
    - /api/logs: เฉพาะหน้า Logs และ Dashboard (มีรายการล่าสุด) และต้องมีสิทธิ์ menu.logs (ไม่มีก็ได้ 403 ทุกรอบ)
  */
  const logsVisible = (currentTab === 'logs' || currentTab === 'dashboard') && can(loggedInUser, 'menu.logs');
  useEffect(() => {
    if (!loggedInUser) return;
    const fetchPeriodicData = async () => {
      if (document.hidden) return;
      try {
        const statsRes = await apiFetch(`/api/stats`, { headers: getHeaders() });
        if (statsRes.status === 401) return handleAuthExpired();
        if (statsRes.ok) setSystemStats(await statsRes.json());

        if (logsVisible) {
          const logQuery = new URLSearchParams(logFilters).toString();
          const logRes = await apiFetch(`/api/logs?${logQuery}`, { headers: getHeaders() });
          if (logRes.ok) setLogs(await logRes.json());
        }
      } catch (e) { console.error("Periodic fetch failed", e); }
    }
    fetchPeriodicData();
    const interval = setInterval(fetchPeriodicData, 10000); // 💡 ปรับจาก 2 เป็น 10 วินาทีเพื่อความนิ่งค่ะ
    // กลับมาที่แท็บ = ดึงทันที ไม่ต้องรอรอบถัดไป
    const onVisible = () => { if (!document.hidden) fetchPeriodicData(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [loggedInUser, logsVisible, logFilters, serverIP]); // eslint-disable-line react-hooks/exhaustive-deps


  // --- RENDER ---
  if (!loggedInUser) {
    return (
      <Login01 
        loginForm={loginForm} 
        setLoginForm={setLoginForm} 
        handleLogin={handleLogin} 
        isLoading={isLoading} 
        loginError={loginError} 
        theme={theme}
        toggleTheme={toggleTheme}
        appName={app.name}
        showClient={app.role === 'central'}
      />
    )
  }

  return (
    <TooltipProvider>
      <AppShell
        app={app}
        user={loggedInUser}
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        theme={theme}
        toggleTheme={toggleTheme}
        onLogout={handleLogout}
        systemStats={systemStats}
      >
        {/* บัญชีตั้งต้นยังใช้รหัสตั้งต้น — เตือนค้างไว้จนกว่าจะเปลี่ยน (server ตอบ mustChangePassword จาก login และ /api/me) */}
        {loggedInUser.mustChangePassword && (
          <div role="alert" className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            บัญชีนี้ยังใช้รหัสผ่านตั้งต้น — ใครรู้ที่อยู่เครื่องก็เข้าได้ทั้งระบบ เปลี่ยนรหัสผ่านที่หน้า Users ทันที
          </div>
        )}
        {app.role !== 'central' && <EdgeUpdateBanner gatewayRole={app.role} canInstall={can(loggedInUser, 'system.maintain')} />}
        {app.role !== 'edge' && <EdgeAlertBanner gatewayRole={app.role} onOpenEdges={() => setCurrentTab('edges')} />}
        {currentTab === 'dashboard' && <Dashboard app={app} cameras={visibleCameras} cameraStatus={cameraStatus} systemStats={systemStats} logs={can(loggedInUser, 'menu.logs') ? logs : []} onOpen={setCurrentTab} />}
        {currentTab === 'edges' && app.role !== 'edge' && can(loggedInUser, 'menu.cameras') && <EdgeNodes gatewayRole={app.role} canManage={can(loggedInUser, 'device.manage')} centralBuild={instanceInfo?.build} onCamerasChanged={async () => { const updated = await fetchList(`/api/cameras`); if (updated) setCameras(updated); }} />}
        {currentTab === 'cameras' && can(loggedInUser, 'menu.cameras') && <CameraManagement onCamerasChanged={async () => { const updated = await fetchList('/api/cameras'); if (updated) setCameras(updated); }} readOnly={app.role !== 'edge'} canLive={app.role !== 'edge'} theme={theme} handleBulkDelete={handleBulkDelete} selectedCamerasForDelete={selectedCamerasForDelete} handleStartScan={handleStartScan} openAddModal={openAddModal} groupedCameras={groupedCameras} expandedAssetGroups={expandedAssetGroups} setExpandedAssetGroups={setExpandedAssetGroups} handleDeleteGroup={handleDeleteGroup} handleToggleSelectCamera={handleToggleSelectCamera} cameraStatus={cameraStatus} openEditModal={openEditModal} openMapPinEdit={openMapPinEdit} handleRenameGroup={triggerRenameGroup} vmsSourceCount={vmsSources.length} handleVmsResync={handleVmsResync} isLoading={isLoading} unpinnedCount={cameras.filter(c => !Number.isFinite(parseFloat(c.lat)) || !Number.isFinite(parseFloat(c.lng))).length} onGoToMapPins={() => setCurrentTab('map-pins')} />}
        {currentTab === 'live' && app.role !== 'edge' && can(loggedInUser, 'menu.live') && <LiveWall cameras={visibleCameras} cameraStatus={cameraStatus} />}
        {currentTab === 'playback' && app.role !== 'edge' && can(loggedInUser, 'playback.view') && <Playback cameras={visibleCameras} target={playbackTarget} onTargetUsed={() => setPlaybackTarget(null)} />}
        {currentTab === 'ai-events' && app.role !== 'edge' && can(loggedInUser, 'menu.ai') && <AiEvents cameras={visibleCameras} onOpenPlayback={can(loggedInUser, 'playback.view') ? (cameraId, ms) => { setPlaybackTarget({ cameraId, ms }); setCurrentTab('playback') } : null} />}
        {currentTab === 'ai-sources' && app.role === 'edge' && can(loggedInUser, 'menu.cameras') && <AiSources canManage={can(loggedInUser, 'device.manage')} />}
        {currentTab === 'camera-map' && app.role !== 'edge' && can(loggedInUser, 'menu.cameras') && <CameraMap cameras={visibleCameras} cameraStatus={cameraStatus} theme={theme} />}
        {currentTab === 'map-pins' && app.role === 'edge' && can(loggedInUser, 'menu.cameras') && <MapPins cameras={cameras} theme={theme} onCamerasChanged={async () => { const updated = await fetchList(`/api/cameras`); if (updated) setCameras(updated); }} />}
        {currentTab === 'logs' && can(loggedInUser, 'menu.logs') && <EventLogs canPurgeLogs={can(loggedInUser, 'log.purge')} theme={theme} logFilters={logFilters} setLogFilters={setLogFilters} handleClearLogs={handleClearLogs} logs={logs} serverIP={serverIP} setSelectedEventImage={setSelectedEventImage} />}
        {currentTab === 'settings' && can(loggedInUser, 'menu.settings') && <SystemSettings theme={theme} systemSettings={systemSettings} setSystemSettings={setSystemSettings} cameras={cameras} isLoading={isLoading} setIsLoading={setIsLoading} serverIP={serverIP} />}
        {currentTab === 'api-clients' && can(loggedInUser, 'menu.apiclients') && <ApiClients groupedCameras={groupedCameras} />}
        {currentTab === 'users' && can(loggedInUser, 'menu.users') && <AccessControl theme={theme} users={users} loggedInUser={loggedInUser} setUserModalMode={setUserModalMode} setUserFormData={setUserFormData} setIsUserModalOpen={setIsUserModalOpen} handleDeleteUser={handleDeleteUser} roles={roles} onOpenRoleModal={openRoleModal} onDeleteRole={handleDeleteRole} />}
      </AppShell>


        <CameraModal isModalOpen={isModalOpen} modalMode={modalMode} formData={formData} setFormData={setFormData} handleSaveCamera={handleSaveCamera} handleBulkSaveNvr={handleBulkSaveNvr} handleFetchNvrChannels={handleFetchNvrChannels} setIsModalOpen={setIsModalOpen} isLoading={isLoading} nvrChannels={nvrChannels} setNvrChannels={setNvrChannels} vmsCameras={vmsCameras} handleFetchVmsCameras={handleFetchVmsCameras} handleImportVms={handleImportVms} selectedChannels={selectedChannels} setSelectedChannels={setSelectedChannels} theme={theme} setIsMapFullPickerOpen={setIsMapFullPickerOpen} cameras={cameras} />
        <ScanModal isScanModalOpen={isScanModalOpen} setIsScanModalOpen={setIsScanModalOpen} isScanning={isScanning} handleStartScan={handleStartScan} scannedDevices={scannedDevices} selectScannedDevice={selectScannedDevice} subnetPrefix={subnetPrefix} setSubnetPrefix={setSubnetPrefix} />
        <UserModal isUserModalOpen={isUserModalOpen} userModalMode={userModalMode} userFormData={userFormData} setUserFormData={setUserFormData} loggedInUser={loggedInUser} users={users} cameras={cameras} handleSaveUser={handleSaveUser} setIsUserModalOpen={setIsUserModalOpen} isLoading={isLoading} theme={theme} groupedCameras={groupedCameras} roles={roles} />
        <RoleModal open={isRoleModalOpen} onClose={() => setIsRoleModalOpen(false)} mode={roleModalMode} role={roleModalRole} roles={roles} catalogue={permCatalogue} groupedCameras={groupedCameras} onSaved={refreshRoles} />
        <ImagePreviewModal selectedEventImage={selectedEventImage} setSelectedEventImage={setSelectedEventImage} />
        <FullScreenMapPicker isMapFullPickerOpen={isMapFullPickerOpen} setIsMapFullPickerOpen={setIsMapFullPickerOpen} formData={formData} setFormData={setFormData} theme={theme} />
        <EditMapPinModal
          open={isMapPinEditOpen}
          onClose={closeMapPinEdit}
          camera={mapPinEditCam}
          lat={mapPinCoords.lat}
          lng={mapPinCoords.lng}
          onCoordsChange={(lat, lng) => setMapPinCoords({ lat, lng })}
          onSave={handleSaveMapPin}
          isSaving={isMapPinSaving}
          theme={theme}
        />
        <RenameGroupModal isOpen={isRenameGroupModalOpen} onClose={() => setIsRenameGroupModalOpen(false)} oldName={renameGroupOldName} onRename={handleRenameGroup} isLoading={isLoading} />
        <Toaster />
        <AppDialogHost />
    </TooltipProvider>
  )
}

export default App;
