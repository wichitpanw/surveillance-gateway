import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import MapBaseToggle from './MapBaseToggle';
import { getMapBase, mapStyleUrl } from '@/lib/map-style';

const MAP_CENTER = { lat: 13.7563, lng: 100.5018 };

/**
 * แผนที่สำหรับปักหมุดกล้องเป็นชุด
 *
 * แยกจาก OfflineMapPicker เพราะตัวนั้นถือหมุดเดียวและ flyTo ทุกครั้งที่พิกัดเปลี่ยน ซึ่งเป็น
 * พฤติกรรมที่ถูกสำหรับฟอร์มแก้กล้องหนึ่งตัว แต่ผิดสำหรับหน้านี้: คนกำลังไล่ปักกล้องทีละจุด
 * แผนที่ที่กระโดดเองทุกครั้งที่บันทึกทำให้ต้องเลื่อนกลับมาที่เดิมด้วยมือทุกรอบ
 *
 * กล้องที่พิกัดตรงกันถูกยุบเป็นหมุดเดียวพร้อมตัวเลขจำนวน เพราะจุดติดตั้งจริงหลายจุดมีกล้อง
 * มากกว่าหนึ่งตัว การวาดหมุดซ้อนกันสนิททำให้คลิกโดนแค่ตัวบนสุดและไม่มีทางรู้ว่ามีตัวอื่นอยู่
 */
/*
  readOnly — central (หน้า Camera Map): หมุดลากไม่ได้ คลิกแผนที่ไม่ปัก พิกัดเป็นของ edge
  markerColor(cams) — สีหมุดต่อกอง (เช่นตามสถานะออนไลน์) ไม่ส่ง = สีตามการเลือกแบบเดิม
  focus — { lat, lng, key } บินไปจุดนั้นเมื่อ key เปลี่ยน · fit — ซูมให้เห็นหมุดทั้งหมดครั้งแรกที่มีหมุด
*/
const PinMap = ({ cameras, selectedIds = [], theme, onMapClick, onPickGroup, onMoveGroup, readOnly = false, markerColor, focus, fit = false }) => {
  const container = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const handlers = useRef({});
  const [base, setBase] = useState(() => getMapBase() || 'satellite');

  // เก็บ callback ล่าสุดไว้ใน ref เพราะ listener ของ maplibre ผูกครั้งเดียวตอนสร้างแผนที่
  // การอ่านตัวแปรตรงๆ ใน listener จะได้ closure รอบแรกค้างไว้ตลอด
  useEffect(() => {
    handlers.current = { onMapClick, onPickGroup, onMoveGroup };
  }, [onMapClick, onPickGroup, onMoveGroup]);

  useEffect(() => {
    if (!container.current || map.current) return;
    map.current = new maplibregl.Map({
      container: container.current,
      style: mapStyleUrl(theme, base),
      center: [MAP_CENTER.lng, MAP_CENTER.lat],
      zoom: 14,
      // ภาพดาวเทียมละเอียดถึง z19 — ซูมลึกพอเห็นเสาและมุมตึกที่ติดกล้อง
      maxZoom: 19,
      fadeDuration: 0,
    });
    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current.on('click', (e) => {
      handlers.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng);
    });
    map.current.on('load', () => {
      try { map.current?.resize(); } catch { /* ignore */ }
    });
    const t = setTimeout(() => { try { map.current?.resize(); } catch { /* ignore */ } }, 100);
    return () => {
      clearTimeout(t);
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  useEffect(() => {
    if (map.current) {
      map.current.setStyle(mapStyleUrl(theme, base));
    }
  }, [theme, base]);

  useEffect(() => {
    if (!map.current) return;

    for (const m of markers.current) m.remove();
    markers.current = [];

    // ยุบกล้องที่พิกัดเท่ากันเป็นกองเดียว — ปัดหกตำแหน่งพอสำหรับความละเอียดระดับเมตร
    const groups = new Map();
    for (const cam of cameras) {
      const lat = parseFloat(cam.lat);
      const lng = parseFloat(cam.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (!groups.has(key)) groups.set(key, { lat, lng, cams: [] });
      groups.get(key).cams.push(cam);
    }

    for (const group of groups.values()) {
      const isSelected = group.cams.some((c) => selectedIds.includes(c.id));
      const el = document.createElement('button');
      el.type = 'button';
      el.title = group.cams.map((c) => c.name).join('\n');
      el.textContent = group.cams.length > 1 ? String(group.cams.length) : '';
      el.style.cssText = [
        'width:26px', 'height:26px', 'border-radius:50%', 'cursor:pointer',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font:700 11px/1 system-ui', 'color:#fff',
        `background:${markerColor ? markerColor(group.cams) : isSelected ? '#b8860b' : '#0066cc'}`,
        'border:2px solid #fff', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
      ].join(';');

      const marker = new maplibregl.Marker({ element: el, draggable: !readOnly })
        .setLngLat([group.lng, group.lat])
        .addTo(map.current);

      el.addEventListener('click', (ev) => {
        // ไม่ให้คลิกทะลุลงแผนที่ ไม่งั้นการกดหมุดจะกลายเป็นการปักทับที่เดิมทันที
        ev.stopPropagation();
        handlers.current.onPickGroup?.(group.cams.map((c) => c.id));
      });
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLngLat();
        handlers.current.onMoveGroup?.(group.cams.map((c) => c.id), lat, lng);
      });

      markers.current.push(marker);
    }
  }, [cameras, selectedIds, readOnly, markerColor]);

  // ซูมให้เห็นกล้องทุกตัวครั้งแรกที่มีพิกัดให้ดู — ไม่ทำซ้ำทุกครั้งที่ข้อมูลอัปเดต ไม่งั้นแผนที่กระโดดขณะคนกำลังดู
  const fitted = useRef(false);
  useEffect(() => {
    if (!fit || fitted.current || !map.current) return;
    const pts = cameras.map((c) => [parseFloat(c.lng), parseFloat(c.lat)]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (!pts.length) return;
    fitted.current = true;
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.current.fitBounds(b, { padding: 60, maxZoom: 17, duration: 0 });
  }, [cameras, fit]);

  useEffect(() => {
    if (!focus || !map.current) return;
    map.current.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.current.getZoom(), 17), speed: 1.6 });
  }, [focus]);

  return (
    <div className="relative w-full h-full">
      <div ref={container} className="w-full h-full" />
      <MapBaseToggle base={base} onChange={setBase} />
    </div>
  );
};

export default PinMap;
