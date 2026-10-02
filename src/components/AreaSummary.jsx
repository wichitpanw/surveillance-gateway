import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';

const REGION_NAMES = {
  central: 'ภาคกลาง', north: 'ภาคเหนือ', northeast: 'ภาคตะวันออกเฉียงเหนือ',
  east: 'ภาคตะวันออก', west: 'ภาคตะวันตก', south: 'ภาคใต้',
};

const blank = () => ({ total: 0, online: 0, offline: 0, unknown: 0 });

export default function AreaSummary({ cameras, cameraStatus, edges = [] }) {
  const [provinces, setProvinces] = useState([]);
  const [instanceRegion, setInstanceRegion] = useState(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/region-groups')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (alive) setProvinces(data?.provinces || []); })
      .catch(() => {});
    apiFetch('/api/instance')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (alive) setInstanceRegion(data?.role === 'regional' ? data.region : null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => {
    const byCode = new Map(provinces.map((p) => [p.code, p]));
    const bySource = new Map(edges.filter((e) => e.remote_role === 'regional').map((e) => [e.id, e.remote_region]));
    const grouped = new Map();
    for (const camera of cameras) {
      const code = String(camera.province_code || '');
      const province = byCode.get(code);
      const inheritedRegion = (camera.source_role === 'regional' ? camera.source_region : null) || bySource.get(camera.source_id) || instanceRegion;
      const region = province?.region || (REGION_NAMES[inheritedRegion] ? inheritedRegion : 'unknown');
      if (!grouped.has(region)) grouped.set(region, { ...blank(), provinces: new Map() });
      const area = grouped.get(region);
      const name = province?.name || 'ไม่ระบุจังหวัด';
      if (!area.provinces.has(code)) area.provinces.set(code, { code, name, ...blank() });
      const bucket = area.provinces.get(code);
      const state = cameraStatus[camera.id] === 'online' ? 'online' : cameraStatus[camera.id] === 'offline' ? 'offline' : 'unknown';
      for (const target of [area, bucket]) { target.total += 1; target[state] += 1; }
    }
    return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([code, area]) => ({
      code, name: REGION_NAMES[code] || 'ไม่ระบุภาค', ...area,
      provinces: [...area.provinces.values()].sort((a, b) => a.code.localeCompare(b.code)),
    }));
  }, [cameras, cameraStatus, provinces, edges, instanceRegion]);

  if (!provinces.length || !cameras.length) return null;
  return (
    <section className="rounded-md border bg-card p-5">
      <h3 className="mb-1 text-sm font-medium">สรุปตามภาคและจังหวัด</h3>
      <p className="mb-4 text-xs text-muted-foreground">นับเฉพาะกล้องที่บัญชีนี้มีสิทธิ์ดู · ไม่ทราบสถานะเมื่อสายต้นทางขาด</p>
      <div className="space-y-2">
        {rows.map((region) => (
          <details key={region.code} className="rounded border px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
              <span className="font-medium">{region.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{region.total} กล้อง · online {region.online} · offline {region.offline} · ไม่ทราบ {region.unknown}</span>
            </summary>
            <div className="mt-2 divide-y border-t text-xs">
              {region.provinces.map((province) => (
                <div key={province.code || '-'} className="flex justify-between gap-3 py-1.5">
                  <span>{province.name}</span>
                  <span className="tabular-nums text-muted-foreground">{province.total} · online {province.online} · offline {province.offline} · ไม่ทราบ {province.unknown}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
