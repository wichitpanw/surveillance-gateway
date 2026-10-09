import {
  LayoutDashboard,
  Server,
  Cctv,
  MapPin,
  Map as MapIcon,
  MonitorPlay,
  History,
  Sparkles,
  KeyRound,
  Users,
  ClipboardList,
  Settings,
  Globe,
} from 'lucide-react';

/*
  สองโปรแกรม โค้ดชุดเดียว (docs/EDGE-PLAN.md) — ต่างกันที่ชื่อ เมนู และหน้าที่

    central  แอด edge, รวมกล้องจากทุก edge, ออก key ให้ client ภายนอก
    edge     แอดกล้องในวงแลนของตัวเอง, ออก key ให้ central มาดึงกล้องไป

  เลือกด้วย entry (index.html = central, edge.html = edge) ซึ่ง backend เสิร์ฟตาม GATEWAY_ROLE
  เครื่อง edge จริงในอนาคตจึงแค่ clone repo เดียวกันแล้วตั้ง GATEWAY_ROLE=edge

  perm = สิทธิ์ที่ต้องมีจึงเห็นเมนู (ตรงกับ MENU_KEYS ใน server.js) null = ทุกคนที่ล็อกอินได้
*/
export const APPS = {
  central: {
    role: 'central',
    name: 'Surveillance Gateway Central',
    short: 'Central',
    tagline: 'API Platform',
    home: 'dashboard',
    nav: [
      {
        key: 'overview', label: 'Overview', items: [
          { tab: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: null },
          // ดูสดที่ central เท่านั้น — edge ทำหน้าที่ส่งต่อภาพ ไม่มีหน้าดู
          { tab: 'live', label: 'Live', icon: MonitorPlay, perm: 'menu.live' },
          { tab: 'playback', label: 'Playback', icon: History, perm: 'playback.view' },
          { tab: 'ai-events', label: 'AI Events', icon: Sparkles, perm: 'menu.ai' },
          // กล้องสาธารณะที่ Central ดึงเอง (server/vms/public-cams.js) — Central เท่านั้น Regional ตัดออกข้างล่าง
          { tab: 'public-cam-map', label: 'Public Cam Map', icon: Globe, perm: 'menu.publiccam' },
        ],
      },
      {
        key: 'network', label: 'Network', items: [
          { tab: 'edges', label: 'Regional Nodes', icon: Server, perm: 'menu.cameras' },
          { tab: 'cameras', label: 'Cameras', icon: Cctv, perm: 'menu.cameras' },
          // central แสดงตำแหน่งอย่างเดียว — ปักหมุดที่ edge (พิกัดเป็นของ edge)
          { tab: 'camera-map', label: 'Camera Map', icon: MapIcon, perm: 'menu.cameras' },
        ],
      },
      {
        key: 'access', label: 'Access', items: [
          { tab: 'api-clients', label: 'API Clients', icon: KeyRound, perm: 'menu.apiclients' },
          { tab: 'users', label: 'Users & Roles', icon: Users, perm: 'menu.users' },
        ],
      },
      {
        key: 'system', label: 'System', items: [
          { tab: 'logs', label: 'System Logs', icon: ClipboardList, perm: 'menu.logs' },
          { tab: 'settings', label: 'Settings', icon: Settings, perm: 'menu.settings' },
        ],
      },
    ],
  },
  edge: {
    role: 'edge',
    name: 'Surveillance Gateway Edge',
    short: 'Edge',
    tagline: 'API Gateway',
    home: 'dashboard',
    nav: [
      {
        key: 'overview', label: 'Overview', items: [
          { tab: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: null },
        ],
      },
      {
        key: 'devices', label: 'Devices', items: [
          { tab: 'cameras', label: 'Cameras', icon: Cctv, perm: 'menu.cameras' },
          { tab: 'map-pins', label: 'Map Pins', icon: MapPin, perm: 'menu.cameras' },
          { tab: 'ai-sources', label: 'AI Sources', icon: Sparkles, perm: 'menu.cameras' },
        ],
      },
      {
        key: 'access', label: 'Access', items: [
          // key ที่ central ใช้ดึงกล้องไปก็ออกที่หน้านี้ — ติ๊ก "คุม PTZ" ถ้าจะให้ central สั่งหมุน
          { tab: 'api-clients', label: 'Central Access', icon: KeyRound, perm: 'menu.apiclients' },
          { tab: 'users', label: 'Users & Roles', icon: Users, perm: 'menu.users' },
        ],
      },
      {
        key: 'system', label: 'System', items: [
          { tab: 'logs', label: 'System Logs', icon: ClipboardList, perm: 'menu.logs' },
          { tab: 'settings', label: 'Settings', icon: Settings, perm: 'menu.settings' },
        ],
      },
    ],
  },
};

/** เมนูทุกตัวของแอปเรียงเป็นแถวเดียว — ใช้หาชื่อหน้า/ไอคอนของ tab และ breadcrumb */
export const flatNav = (app) => app.nav.flatMap((sec) => sec.items.map((it) => ({ ...it, section: sec.label })));

// Regional รวมภาพและ event ในภาค ใช้งานได้เมื่อสาย Central ขาด
APPS.regional = {
  ...APPS.central,
  role: 'regional',
  name: 'Surveillance Gateway Regional',
  short: 'Regional',
  nav: APPS.central.nav.map((section) => ({
    ...section,
    items: section.items
      .filter((item) => item.tab !== 'public-cam-map')
      .map((item) => item.tab === 'edges' ? { ...item, label: 'Edge Nodes' } : item),
  })),
};
