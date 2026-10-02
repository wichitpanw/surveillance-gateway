import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../fonts.css';
import './map.css';
import { buildStyle } from './style.js';

/**
 * แผนที่กล้องแบบ 3D สำหรับ client บน Windows
 *
 * หน้านี้ตั้งใจให้ "โง่": ไม่รู้จัก API key ไม่เคยเรียก /api/v1 และไม่ตัดสินใจเรื่องสิทธิ์
 * รายชื่อกล้องถูกส่งเข้ามาจากตัวโปรแกรม ซึ่งเป็นฝั่งที่ถือคีย์และผ่าน scope ของ Gateway มาแล้ว
 * ถ้าหน้านี้ไปดึงเอง จะกลายเป็นที่ที่สองที่ตัดสินว่าใครเห็นกล้องอะไรได้ ซึ่งเป็นแบบที่พลาดแล้ว
 * ไม่มีอะไรจับได้
 *
 * ไทล์มาจาก /api/vector-tiles และ glyph มาจาก /fonts ซึ่งเป็น route ที่ไม่ต้องยืนยันตัวตนอยู่แล้ว
 * หน้านี้จึงโหลดได้โดยไม่ต้องมี credential ใด ๆ (ดู style.js ว่าทำไมไม่ใช้ /api/map-style.json)
 */

const BANGKOK = { lng: 100.5018, lat: 13.7563 };

/** มุมเงยตอนเปิดอาคารสามมิติ — ปิดตึกแล้วแผนที่กลับไปมองจากด้านบน */
const PITCH_3D = 55;

const el = (id) => document.getElementById(id);
const setHint = (text) => {
  const node = el('hint');
  node.textContent = text || '';
  node.style.display = text ? 'block' : 'none';
};

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';

/*
  ภาษาของหน้านี้มาจากตัวโปรแกรม ไม่ใช่จากเบราว์เซอร์

  ค่าเริ่มต้นเป็นอังกฤษเหมือนฝั่ง client และถูกส่งมาทาง ?lang= ทุกครั้งที่เปิดหน้า การอ่านจาก
  navigator.language แทนจะทำให้แผนที่พูดคนละภาษากับเมนูรอบตัวมันเมื่อผู้ใช้เลือกภาษาเอง
*/
const STRINGS = {
  en: {
    layers: 'Layers',
    buildings: '3D buildings',
    roads: 'Street names',
    poi: 'Points of interest',
    loading: 'Loading the map…',
    waiting: 'Waiting for the page to be shown…',
    noPins: 'No camera has coordinates yet',
    placed: (n) => `<strong>${n}</strong> cameras on the map`,
    skipped: (n) => `${n} without coordinates`,
  },
  th: {
    layers: 'ชั้นข้อมูล',
    buildings: 'อาคาร 3 มิติ',
    roads: 'ชื่อถนน',
    poi: 'จุดสนใจ',
    loading: 'กำลังโหลดแผนที่…',
    waiting: 'รอแสดงหน้าจอก่อนเริ่มแผนที่…',
    noPins: 'ยังไม่มีกล้องตัวไหนถูกกำหนดพิกัด',
    placed: (n) => `<strong>${n}</strong> กล้องบนแผนที่`,
    skipped: (n) => `${n} ตัวยังไม่มีพิกัด`,
  },
}[params.get('lang') === 'th' ? 'th' : 'en'];

for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = STRINGS[node.dataset.i18n] || '';
}

setHint(STRINGS.loading);

const isLight = theme === 'light';
document.body.dataset.theme = theme;

/*
  รอจนหน้าถูกแสดงจริงก่อนค่อยสร้างแผนที่

  MapLibre โหลดสไตล์ที่ส่งมาเป็นออบเจ็กต์ผ่าน requestAnimationFrame ซึ่งเบราว์เซอร์ไม่ยิงเลย
  เมื่อหน้าอยู่ในสถานะ hidden ผลคือแผนที่ค้างที่ "กำลังโหลด" ตลอดไป โดยไม่มี error ให้เห็น —
  ไม่ใช่เรื่องสมมุติ WebView2 ที่ถูกสร้างไว้ในช่องที่ยังไม่ได้แสดงก็เข้าเงื่อนไขเดียวกัน

  การเลื่อนการสร้างออกไปเปลี่ยนอาการจาก "ค้างถาวร" เป็น "เริ่มเมื่อถูกมองเห็น" ซึ่งเป็นสิ่งที่
  ผู้ใช้คาดหวังอยู่แล้ว
*/
if (document.hidden) {
  setHint(STRINGS.waiting);
  await new Promise((resolve) => {
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    document.addEventListener('visibilitychange', onVisible);
  });
}

const style = buildStyle({ origin: window.location.origin, light: isLight });
window.__style = style;

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [BANGKOK.lng, BANGKOK.lat],
  zoom: 15,
  pitch: PITCH_3D,
  bearing: -18,
  // ไทล์ชุดนี้จบที่ z14 การให้ซูมเกินไปมากได้แปลว่าผู้ใช้ซูมเข้าไปเจอไทล์ที่ถูกขยายจนเบลอ
  // โดยไม่มีรายละเอียดเพิ่ม — 18 คือจุดที่อาคารยังอ่านเป็นรูปทรงได้อยู่
  maxZoom: 18,
  fadeDuration: 0,
  attributionControl: false,
  antialias: true,
});

// เปิดตัวแผนที่ไว้ให้ตรวจสอบจากคอนโซลได้ — หน้านี้ถูก debug ผ่าน WebView2 ซึ่งไม่มี devtools ติดมา
window.__map = map;

// เก็บ error ของแผนที่ไว้ในหน้า เพราะคอนโซลของ WebView2 ไม่มี devtools ให้เปิดดู
window.__mapErrors = [];
map.on('error', (e) => window.__mapErrors.push(String(e?.error?.message || e?.error || e)));
map.on('style.load', () => window.__mapErrors.push('style.load'));
map.on('sourcedata', (e) => { if (e.sourceId) window.__mapErrors.push('sourcedata:' + e.sourceId + ':' + (e.isSourceLoaded ? 'loaded' : 'pending')); });

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

/*
  ผูกขนาดแผนที่กับขนาดของกล่องจริง ไม่ใช่กับ resize ของหน้าต่าง

  trackResize ของ MapLibre ฟัง window resize อย่างเดียว ซึ่งไม่เกิดขึ้นเมื่อ WebView2 ถูกย่อขยาย
  ตามช่องที่มันอยู่ใน WPF — ผลคือ canvas ค้างขนาดตอนโหลดหน้า แล้วแผนที่กินพื้นที่แค่มุมเดียว
  ทั้งที่กล่องเต็มจอ
*/
let sizeWatcher = null;
const watchSize = () => {
  if (sizeWatcher) return;
  // ผูกหลังแผนที่พร้อมเท่านั้น — ResizeObserver ยิงหนึ่งครั้งทันทีที่ observe() และการเรียก
  // resize() ก่อน painter พร้อมทำให้ตัวแผนที่ค้างตั้งแต่เริ่ม โดยไม่มี error ให้เห็น
  sizeWatcher = new ResizeObserver(() => map.resize());
  sizeWatcher.observe(document.getElementById('map'));
};

let markers = [];
let pendingCameras = null;
let ready = false;

/** ส่งข้อความกลับไปที่ตัวโปรแกรม — WebView2 ฝั่ง WPF รับที่ WebMessageReceived */
const post = (payload) => {
  window.chrome?.webview?.postMessage(JSON.stringify(payload));
};

function setLayerVisible(ids, visible) {
  for (const id of ids) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }
}

function wireLayerControls() {
  el('toggle-3d').addEventListener('change', (e) => {
    const on = e.target.checked;
    setLayerVisible(['buildings-3d'], on);
    // แผนที่เอียงโดยไม่มีตึกอ่านยากกว่าแผนที่แบน — ปิดตึกแล้วกลับไปมองจากด้านบน
    map.easeTo({ pitch: on ? PITCH_3D : 0, duration: 400 });
  });

  el('toggle-roads').addEventListener('change', (e) => setLayerVisible(['road-labels'], e.target.checked));
  el('toggle-poi').addEventListener('change', (e) => setLayerVisible(['poi-labels'], e.target.checked));
}

map.on('load', () => {
  watchSize();
  wireLayerControls();

  ready = true;
  setHint('');
  if (pendingCameras) {
    render(pendingCameras);
    pendingCameras = null;
  }
});

map.on('error', (e) => {
  // ที่พบบ่อยที่สุดคือไทล์โหลดไม่ได้ ซึ่งแปลว่า Gateway ยังไม่ได้ตั้งไฟล์แผนที่ ไม่ใช่หน้านี้พัง
  console.warn('[map error]', e?.error?.message || JSON.stringify(e?.error || e));
});

function clearMarkers() {
  for (const m of markers) m.remove();
  markers = [];
}

/**
 * วาดหมุดจากรายชื่อกล้องที่ตัวโปรแกรมส่งมา
 *
 * กล้องที่ยังไม่มีพิกัดถูกข้าม ไม่ใช่วางไว้ที่ (0,0) — หมุดกลางมหาสมุทรอ่านได้ว่า "กล้องอยู่ตรงนั้น"
 * ซึ่งผิดกว่าการไม่มีหมุดเลย จำนวนที่ข้ามถูกรายงานกลับไปให้โปรแกรมบอกผู้ใช้แทน
 */
function render(cameras) {
  clearMarkers();

  const placed = [];
  let skipped = 0;

  for (const cam of cameras) {
    const lat = cam?.location?.lat;
    const lng = cam?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      skipped += 1;
      continue;
    }

    const node = document.createElement('button');
    const status = cam.availability || (cam.online === false ? 'offline' : cam.online === true ? 'online' : 'unknown');
    node.className = `pin ${status}`;
    node.type = 'button';
    node.dataset.cameraId = cam.id;
    node.title = cam.name || cam.id;
    node.innerHTML = '<span class="dot"></span><span class="label"></span>';
    node.querySelector('.label').textContent = cam.name || cam.id;

    // คลิกหมุด = ขอให้โปรแกรมเปิดกล้องตัวนั้น การเล่นวิดีโอเกิดฝั่ง native เสมอ ไม่ใช่ในหน้านี้
    // ทั้งเพราะ WebView2 เล่น H.265 ไม่ได้ และเพราะภาพซ้อนบน WebView2 วาดไม่ได้อยู่ดี
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      post({ type: 'camera-activated', cameraId: cam.id });
    });

    markers.push(new maplibregl.Marker({ element: node }).setLngLat([lng, lat]).addTo(map));
    placed.push([lng, lat]);
  }

  if (placed.length > 0) {
    const bounds = placed.reduce(
      (acc, c) => acc.extend(c),
      new maplibregl.LngLatBounds(placed[0], placed[0]),
    );
    map.fitBounds(bounds, { padding: 90, maxZoom: 16, pitch: map.getPitch(), duration: 0 });
  }

  el('summary').innerHTML = STRINGS.placed(placed.length)
    + (skipped > 0 ? `<br>${STRINGS.skipped(skipped)}` : '');

  post({ type: 'rendered', placed: placed.length, skipped });
  setHint(placed.length === 0 ? STRINGS.noPins : '');
}

/**
 * ทางเข้าเดียวจากฝั่งโปรแกรม
 *
 * เรียกก่อน map load ได้ — เก็บไว้แล้ววาดตอนพร้อม ไม่อย่างนั้นการแข่งกันระหว่าง "แผนที่โหลดเสร็จ"
 * กับ "โปรแกรมส่งกล้องมา" จะทำให้บางครั้งเปิดมาแล้วไม่มีหมุด โดยไม่มีอะไรผิดพลาดให้เห็น
 */
window.setCameras = (cameras) => {
  const list = Array.isArray(cameras) ? cameras : [];
  if (!ready) {
    pendingCameras = list;
    return;
  }
  render(list);
};

/**
 * อัปเดตสถานะของหมุดตัวเดียว โดยไม่วาดใหม่ทั้งแผนที่
 *
 * ตัวโปรแกรมได้สถานะมาจาก SSE ของ Gateway ซึ่งส่งมาทีละเหตุการณ์ การเรียก setCameras ใหม่
 * ทุกครั้งที่กล้องตัวหนึ่งเปลี่ยนจะรื้อหมุดทั้งหมดแล้วดึงมุมมองกลับไป fitBounds — คนที่กำลังซูมดู
 * จุดหนึ่งอยู่จะโดนกระชากออกทุกครั้งที่กล้องตัวไหนก็ได้ในระบบเปลี่ยนสถานะ
 */
window.setCameraStatus = (cameraId, status) => {
  const marker = markers.find((m) => m.getElement().dataset.cameraId === cameraId);
  if (!marker) return;
  const node = marker.getElement();
  node.className = `pin ${status}`;
};

/** ให้โปรแกรมสั่งบินไปที่กล้องตัวหนึ่งได้ เช่นเมื่อผู้ใช้เลือกจากรายการข้าง ๆ */
window.focusCamera = (cameraId) => {
  const marker = markers.find((m) => m.getElement().dataset.cameraId === cameraId);
  if (marker) {
    map.flyTo({ center: marker.getLngLat(), zoom: 17, duration: 600 });
  }
};

post({ type: 'ready' });
