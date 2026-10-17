import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from '@/lib/maplibre';
import MapBaseToggle from './MapBaseToggle';
import { getMapBase, mapStyleUrl } from '@/lib/map-style';

const MAP_CENTER = { lat: 13.7563, lng: 100.5018 };

const OfflineMapPicker = ({ lat, lng, onChange, theme }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const onChangeRef = useRef(onChange);
  const [base, setBase] = useState(() => getMapBase() || 'satellite');

  // 💡 อัปเดต ref ให้ชี้ไปยังฟังก์ชัน onChange ล่าสุดเสมอเพื่อขจัดปัญหา Stale Closure ค่ะ
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: mapStyleUrl(theme, base),
      center: [lng || MAP_CENTER.lng, lat || MAP_CENTER.lat],
      zoom: 14,
      maxZoom: 19,
      fadeDuration: 0
    });
    map.current.on('click', (e) => {
      const { lng, lat } = e.lngLat;
      if (onChangeRef.current) {
        onChangeRef.current(lat, lng);
      }
    });
    map.current.on('load', () => {
      try { map.current?.resize(); } catch { /* ignore */ }
    });
    // Dialog/layout may mount with 0 size — resize after paint
    const t1 = setTimeout(() => { try { map.current?.resize(); } catch { /* ignore */ } }, 50);
    const t2 = setTimeout(() => { try { map.current?.resize(); } catch { /* ignore */ } }, 250);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  useEffect(() => {
    if (map.current) map.current.setStyle(mapStyleUrl(theme, base));
  }, [theme, base]);

  useEffect(() => {
    if (!map.current) return;
    if (marker.current) { marker.current.remove(); marker.current = null; }
    // ยังไม่ปักหมุด (NaN/null) = ไม่วาดหมุด — เดิมวาดที่จุดกลางแผนที่ ดูเหมือนกล้องอยู่ตรงนั้นจริง
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const el = document.createElement('div');
    el.style.cssText = 'width:14px; height:14px; border-radius:50%; background-color:#0066cc; border:2px solid white; box-shadow:0 4px 12px rgba(0, 102, 204, 0.4);';
    marker.current = new maplibregl.Marker({ element: el }).setLngLat([lng || MAP_CENTER.lng, lat || MAP_CENTER.lat]).addTo(map.current);
    map.current.flyTo({ center: [lng || MAP_CENTER.lng, lat || MAP_CENTER.lat], speed: 2 });
  }, [lat, lng]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />
      <MapBaseToggle base={base} onChange={setBase} />
    </div>
  );
};

export default OfflineMapPicker;
