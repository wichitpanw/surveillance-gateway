import React, { createContext, useContext, useState, useCallback } from 'react';

/**
 * EN/TH toggle — mirrors the existing theme-toggle pattern (localStorage + a single global
 * flag), not a full i18n framework. Technical terms and headings (ROI, AI Detect, DeepStream,
 * section titles like "Camera Management") stay English in both languages by convention: they
 * simply aren't put in `dict` below and are written directly as English JSX text at the call
 * site. `dict` only holds the copy that actually reads better translated — helper text,
 * confirmations, empty states, form hints.
 */
const STORAGE_KEY = 'vms_language';

const dict = {
  // MainSidebar
  hideMenu: { en: 'Hide Menu', th: 'ซ่อนเมนู' },
  showMenu: { en: 'Show Menu', th: 'แสดงเมนู' },
  signOut: { en: 'Sign Out', th: 'ออกจากระบบ' },
  confirmLogoutTitle: { en: 'Confirm Termination', th: 'ยืนยันการออกจากระบบ' },
  confirmLogoutDesc: {
    en: 'End the current VMS session? You will be signed out immediately.',
    th: 'คุณต้องการออกจากระบบ VMS ใช่หรือไม่? เซสชั่นปัจจุบันของคุณจะถูกยกเลิกทันที',
  },
  terminateSession: { en: 'Terminate Session', th: 'ยืนยันออกจากระบบ' },
  abort: { en: 'Abort', th: 'ยกเลิก' },
  poweredBy: { en: 'powered by', th: 'พัฒนาโดย' },

  // Camera Management
  cameraMgmtDek: { en: 'Add, scan, and manage your security cameras on the network.', th: 'เพิ่ม, สแกน และจัดการกล้องวงจรปิดบนเครือข่ายของคุณ' },
  searchCameras: { en: 'Search by camera name, group, or IP address…', th: 'ค้นหาจากชื่อกล้อง, กลุ่ม หรือ IP…' },
  searchResults: { en: 'result', th: 'ผลลัพธ์' },
  noCamerasFound: { en: 'No cameras found', th: 'ไม่พบกล้อง' },
  noCamerasFoundHint: { en: 'Try searching by a different name, group, or IP', th: 'ลองค้นหาด้วยชื่อ, กลุ่ม หรือ IP อื่น' },
  networkScan: { en: 'Network Scan', th: 'สแกนเครือข่าย' },
  addCamera: { en: 'Add Camera', th: 'เพิ่มกล้อง' },
  deleteSelected: { en: 'Delete', th: 'ลบ' },
  renameGroup: { en: 'Rename Group', th: 'เปลี่ยนชื่อกลุ่ม' },
  deleteGroup: { en: 'Delete Group', th: 'ลบกลุ่ม' },
  editMapPin: { en: 'Edit Map Pin', th: 'แก้ไขหมุดบนแผนที่' },
  configure: { en: 'Configure', th: 'ตั้งค่า' },
  onlineLabel: { en: 'Online', th: 'ออนไลน์' },
  totalCameras: { en: 'Total Cameras', th: 'กล้องทั้งหมด' },
  noStreamTooltip: {
    en: 'Device responds to ONVIF/HTTP but the RTSP stream is unreachable — check the RTSP port-forward',
    th: 'อุปกรณ์ตอบสนอง ONVIF/HTTP แต่ยังต่อ RTSP stream ไม่ได้ — เช็ค port-forward ของ RTSP',
  },
  confirmBulkDeleteTitle: { en: 'Confirm Bulk Deletion', th: 'ยืนยันการลบหลายรายการ' },
  confirmGroupDeleteTitle: { en: 'Confirm Group Removal', th: 'ยืนยันการลบกลุ่ม' },
  confirmConfigureTitle: { en: 'Configuration Authorization', th: 'ยืนยันการเข้าสู่โหมดตั้งค่า' },
  enterSetup: { en: 'Enter Setup', th: 'เข้าสู่การตั้งค่า' },
  terminateAsset: { en: 'Terminate Asset', th: 'ยืนยันลบ' },

  // Common / reused across modals
  cancel: { en: 'Cancel', th: 'ยกเลิก' },
  save: { en: 'Save', th: 'บันทึก' },
  saving: { en: 'Saving…', th: 'กำลังบันทึก…' },
  delete: { en: 'Delete', th: 'ลบ' },
  edit: { en: 'Edit', th: 'แก้ไข' },
  close: { en: 'Close', th: 'ปิด' },
  confirm: { en: 'Confirm', th: 'ยืนยัน' },
  loading: { en: 'Loading…', th: 'กำลังโหลด…' },
  actions: { en: 'Actions', th: 'การจัดการ' },
  aiActiveLabel: { en: 'AI Active', th: 'เปิด AI' },
  totalLabel: { en: 'Total', th: 'ทั้งหมด' },

  // AI Analytics Dashboard
  aiDashboardDek: {
    en: 'AI Detection (Person/Vehicle) — choose a System or Camera FTP source per camera',
    th: 'AI Detection (Person/Vehicle) — เลือก source System หรือ Camera FTP ต่อกล้อง',
  },
  noAiCamerasFound: { en: 'No cameras found in the VMS', th: 'ไม่พบข้อมูลกล้องในระบบ VMS' },
  noAiCamerasFoundHint: { en: 'Add cameras from the Cameras tab first', th: 'กรุณาเพิ่มกล้องที่แถบ Cameras ก่อนทำรายการ' },
  aiFilterAll: { en: 'All', th: 'ทั้งหมด' },
  aiFilterActive: { en: 'AI On', th: 'เปิด AI' },
  aiFilterInactive: { en: 'AI Off', th: 'ยังไม่เปิด AI' },
  aiFilterNoMatch: { en: 'No cameras match this filter', th: 'ไม่มีกล้องตรงกับตัวกรองนี้' },
  aiFilterShowAll: { en: 'Show all cameras', th: 'แสดงกล้องทั้งหมด' },
  colCameraIp: { en: 'Camera Name / IP Address', th: 'ชื่อกล้อง / ที่อยู่ IP' },
  colConnection: { en: 'Connection', th: 'การเชื่อมต่อ' },
  configureDetectionBtn: { en: 'Configure Detection', th: 'ตั้งค่า AI Detection' },
  aiDetectionBtn: { en: 'AI Detection', th: 'เปิด AI Detection' },
  disableDetectBtn: { en: 'Disable Detect', th: 'ปิด AI Detection' },
  cameraLabel: { en: 'Camera', th: 'กล้อง' },
  chooseModeHint: {
    en: 'Intrusion detects person or vehicle in defined ROI zones (or whole frame if no ROI drawn)',
    th: 'Intrusion ตรวจจับคน/รถในเขตพื้นที่ ROI (หรือทั้งเฟรมหากไม่ได้วาด ROI)',
  },
  aiTypeLabel: { en: 'AI Type', th: 'ประเภท AI' },
  saveEnablesHint: { en: 'Saving turns AI Detection on immediately', th: 'Save จะเปิด AI Detection ให้ทันที' },
  modeChooseOne: { en: 'Mode (choose 1)', th: 'Mode (เลือก 1)' },
  captureNotifyLabel: { en: 'Capture & Notify', th: 'Capture & แจ้งเตือน' },
  snapshotPhotoLabel: { en: 'Snapshot (Photo)', th: 'Snapshot (ภาพนิ่ง)' },
  videoClipHint: { en: 'Video Clip is only available when Source = System', th: 'Video Clip ใช้ได้เฉพาะ Source = System' },
  scheduleHint: {
    en: 'Paint Active = capture window · unpainted = analysis paused · defaults to 24/7',
    th: 'ทาสี Active = ช่วงที่จับ · นอกตาราง = หยุดวิเคราะห์จริง · เริ่มต้น 24/7',
  },
  detectionRoiPolygon: { en: 'Detection ROI Polygon (click to add points)', th: 'Detection ROI Polygon (คลิกลากทีละจุด)' },
  recapture: { en: 'Recapture', th: 'จับภาพใหม่' },
  closeShape: { en: 'Close Shape', th: 'ปิดรูป' },
  clearLabel: { en: 'Clear', th: 'ล้าง' },
  roiDrawHint: {
    en: 'Click each point on the image · first red dot = start · click near the start or press "Close Shape" at ≥3 points · no drawing = full frame',
    th: 'คลิกทีละจุดบนภาพ · จุดแดงแรก = จุดเริ่ม · คลิกใกล้จุดเริ่มหรือกด "ปิดรูป" เมื่อมี ≥3 จุด · ไม่วาด = เต็มเฟรม',
  },
  capturingLabel: { en: 'Capturing…', th: 'กำลังจับภาพ…' },
  noImageYetHint: { en: 'No image yet — tap Recapture', th: 'ยังไม่มีภาพ — กดจับภาพใหม่' },
  fullFrameNoPolygon: { en: 'Full frame (no polygon drawn)', th: 'เต็มเฟรม (ยังไม่วาด polygon)' },
  pointsClosedSuffix: { en: 'points · closed', th: 'จุด · ปิดรูปแล้ว' },
  pointsOpenSuffix: { en: 'points · not closed', th: 'จุด · ยังไม่ปิดรูป' },
  saveEnableBtn: { en: 'Save & Enable', th: 'บันทึกและเปิดใช้งาน' },

  // Intelligence Gallery
  events: { en: 'events', th: 'เหตุการณ์' },
  refresh: { en: 'Refresh', th: 'รีเฟรช' },
  selectLabel: { en: 'Select', th: 'เลือก' },
  clearByDate: { en: 'Clear by Date', th: 'ล้างตามวัน' },
  clearAll: { en: 'Clear All', th: 'ล้างทั้งหมด' },
  allCameras: { en: 'All Cameras', th: 'ทุกกล้อง' },
  confirmDeleteTitle: { en: 'Confirm Deletion', th: 'ยืนยันการลบ' },
  clearFailed: { en: 'Clear failed', th: 'ล้างไม่สำเร็จ' },
  clearAllConfirm: { en: 'Clear the entire Intelligence Gallery history? This cannot be undone.', th: 'ล้างประวัติ Intelligence Gallery ทั้งหมด? กู้คืนไม่ได้' },
  notCheckedYet: { en: 'No events checked yet', th: 'ยังไม่ได้ติ๊กเลือกเหตุการณ์' },
  invalidDateFormat: { en: 'Date must be YYYY-MM-DD', th: 'วันที่ต้องเป็น YYYY-MM-DD' },
  clearByDayFailed: { en: 'Clear by date failed', th: 'ล้างตามวันไม่สำเร็จ' },
  clearDateRangeTooltip: { en: 'Clear date range', th: 'ล้างช่วงวัน' },
  selectedCountSuffix: { en: 'selected', th: 'เลือกอยู่' },
  deselectAll: { en: 'Deselect All', th: 'ยกเลิกทั้งหมด' },
  selectVisible: { en: 'Select Visible', th: 'เลือกที่เห็น' },
  deleteSelectedBtn: { en: 'Delete Selected', th: 'ลบที่เลือก' },
  loadingLabel: { en: 'Loading', th: 'กำลังโหลด' },
  noAiEvents: { en: 'No AI events', th: 'ไม่มีเหตุการณ์ AI' },
  gallerySearchPlaceholder: { en: 'Search camera, type, detail…', th: 'ค้นหากล้อง, ชนิด, รายละเอียด…' },
  clipAll: { en: 'All', th: 'ทั้งหมด' },
  clipOnly: { en: 'Clip', th: 'มีคลิป' },
  clipNone: { en: 'Snapshot', th: 'ภาพนิ่ง' },
  prevLabel: { en: 'Prev', th: 'ก่อนหน้า' },
  nextLabel: { en: 'Next', th: 'ถัดไป' },
  clearEventsByDayTitle: { en: 'Clear Events by Day', th: 'ล้างเหตุการณ์ตามวัน' },
  clearByDayDesc: {
    en: 'Deletes by Asia/Bangkok calendar date (matches what the Gallery displays)',
    th: 'ลบตามวันปฏิทิน Asia/Bangkok (ตรงกับเวลาที่โชว์ใน Gallery)',
  },
  deletingLabel: { en: 'Deleting…', th: 'กำลังลบ…' },
  deleteTodayBtn: { en: 'Delete This Day', th: 'ลบวันนี้' },

  // Command Center
  blinkTooltip: { en: 'Blink map markers on new AI events', th: 'กระพริบ marker บนแผนที่เมื่อมี AI event ใหม่' },
  channelStatus: { en: 'Channel Status', th: 'สถานะช่องสัญญาณ' },
  aiFeed: { en: 'AI Feed', th: 'ฟีด AI' },
  latestN: { en: 'Latest', th: 'ล่าสุด' },
  filterLabel: { en: 'Filter', th: 'ตัวกรอง' },
  alertLabel: { en: 'Alert', th: 'แจ้งเตือน' },
  noAiEventsFilterHint: { en: 'No AI events — open Filter to choose Feature / Object', th: 'No AI events — เปิด Filter เลือก Feature / Object' },
  filterAiFeedTitle: { en: 'Filter AI Feed', th: 'ตัวกรอง AI Feed' },
  objectAppliesTo: { en: 'Applies to Intrusion / Motion', th: 'ใช้กับ Intrusion / Motion' },
  done: { en: 'Done', th: 'เสร็จสิ้น' },

  // Access Control
  accessControlDek: { en: 'Manage administrative roles and monitoring permissions.', th: 'จัดการสิทธิ์ผู้ดูแลระบบและสิทธิ์การเฝ้าระวัง' },
  cantDeleteSelf: { en: "Can't delete your own account", th: 'ลบบัญชีตัวเองไม่ได้' },
  needAtLeastOneAdmin: { en: 'At least 1 admin/superadmin must remain', th: 'ต้องมี admin/superadmin เหลืออย่างน้อย 1 คน' },
  noUsersRegistered: { en: 'No users registered', th: 'ยังไม่มีผู้ใช้งานในระบบ' },

  // System Settings
  backupFailed: { en: 'Backup failed', th: 'สำรองข้อมูลล้มเหลว' },
  restoreSystemTitle: { en: 'Restore System', th: 'กู้คืนระบบ' },
  restoreSystemDesc: {
    en: 'Restoring will overwrite all camera, user, layout, and settings data, then auto-restart the backend.\n\nAre you sure?',
    th: 'การกู้คืนจะเขียนทับข้อมูลกล้อง ผู้ใช้งาน แผนผัง และการตั้งค่าทั้งหมด แล้วรีสตาร์ทหลังบ้านอัตโนมัติ\n\nคุณแน่ใจหรือไม่?',
  },
  restore: { en: 'Restore', th: 'กู้คืน' },
  restoreSuccess: { en: 'Restore successful — reloading in 3 seconds', th: 'กู้คืนสำเร็จ — ระบบจะรีโหลดใน 3 วินาที' },
  restoreFailed: { en: 'Restore failed', th: 'กู้คืนล้มเหลว' },
  testSendSuccess: { en: 'Test sent — check Telegram', th: 'ส่งทดสอบสำเร็จ — ตรวจ Telegram' },
  testSendFailed: { en: 'Test send failed', th: 'ส่งทดสอบไม่สำเร็จ' },
  mapProviderDek: {
    en: 'Choose the map engine for the Live Map page, and upload an image or MBTiles map.',
    th: 'เลือกเครื่องมือดึงแผนที่สำหรับหน้า Live Map และทำการอัปโหลดแผนที่แบบภาพหรือไฟล์ MBTiles',
  },
  mapSwitchSuccess: { en: 'Switched map type to', th: 'สลับประเภทแผนที่เป็น' },
  mapSwitchSuccessSuffix: { en: 'successfully', th: 'สำเร็จ' },
  mapSwitchFailed: { en: 'Map type switch failed', th: 'สลับประเภทแผนที่ล้มเหลว' },
  mapOsmOption: { en: 'OpenStreetMap (Online — always up to date)', th: 'OpenStreetMap (Online - อัปเดตล่าสุด)' },
  mapMbtilesOption: { en: 'Offline MBTiles Database (Vector or Raster)', th: 'Offline MBTiles Database (Vector หรือ Raster)' },
  mapImageOption: { en: 'Offline Custom Image File (map image file)', th: 'Offline Custom Image File (ไฟล์รูปภาพแผนที่)' },
  mbtilesUploadSuccess: { en: 'MBTiles map uploaded successfully', th: 'อัปโหลดแผนที่ MBTiles สำเร็จ' },
  mbtilesUploadFailed: { en: 'MBTiles upload failed', th: 'อัปโหลดแผนที่ล้มเหลว' },
  uploadFailed: { en: 'Upload failed', th: 'อัปโหลดล้มเหลว' },
  mapImageUploadSuccess: { en: 'Map image uploaded successfully', th: 'อัปโหลดรูปภาพแผนที่สำเร็จ' },
  mapImageUploadFailed: { en: 'Map image upload failed', th: 'อัปโหลดรูปภาพล้มเหลว' },
  osmAutoConnectHint: {
    en: 'The system connects to OpenStreetMap (Online) automatically — no upload needed.',
    th: 'ระบบจะเชื่อมต่อแผนที่ OpenStreetMap (Online) โดยอัตโนมัติ ไม่จำเป็นต้องอัปโหลดข้อมูลเพิ่มเติม',
  },

  // Event Logs
  noLogsToExport: { en: 'No event history to export', th: 'ไม่มีประวัติเหตุการณ์ที่จะส่งออก' },

  // Map View
  areaDensitySelected: {
    en: 'Found {n} camera(s) in this area. Open a camera from its marker on the map to view it.',
    th: 'พบกล้อง {n} จุดในพื้นที่นี้ กดที่หมุดบนแผนที่เพื่อเปิดดูภาพของกล้องแต่ละตัว',
  },
};

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'th' || saved === 'en' ? saved : 'en';
  });

  const setLanguage = useCallback((lang) => {
    setLanguageState(lang);
    localStorage.setItem(STORAGE_KEY, lang);
  }, []);

  const t = useCallback((key, vars) => {
    const entry = dict[key];
    let str = entry ? (entry[language] || entry.en || key) : key;
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(`{${k}}`, v);
      });
    }
    return str;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hook อยู่ไฟล์เดียวกับ LanguageProvider
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
