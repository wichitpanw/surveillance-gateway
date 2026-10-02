import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api';

const fmt = (iso) => (iso ? iso.slice(5, 16).replace('T', ' ') : '');

/*
  แถบเตือนบนหน้าเว็บ central เมื่อมี edge ติดต่อไม่ได้เกิน 2 นาที (server/vms/edge-alerts.js)

  มีเพราะ edge 002 หลุด 2 วันโดยไม่มีใครเห็น — สถานะเคยอยู่แค่ในหน้า Edge Nodes
  ถามทุก 30 วิ · หายเองเมื่อ edge กลับมา · กดชื่อแล้วไปหน้า Edge Nodes
*/
export default function EdgeAlertBanner({ gatewayRole = 'central', onOpenEdges }) {
  const [down, setDown] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/edge-alerts');
        if (res.ok && !cancelled) setDown((await res.json()).down || []);
      } catch { /* ไม่มีข้อมูลก็ไม่แสดง */ }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!down.length) return null;
  const childName = gatewayRole === 'central' ? 'โหนด' : 'Edge จังหวัด';
  return (
    <div role="alert" className="mb-4 flex items-start gap-3 rounded-md border border-status-crit bg-status-crit/10 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-crit" />
      <div className="min-w-0">
        <div className="font-semibold text-status-crit">{childName} ติดต่อไม่ได้ {down.length} เครื่อง — สถานะกล้องในกิ่งนั้นยังไม่ทราบ</div>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {down.map((e) => (
            <li key={e.sourceId}>
              <button type="button" onClick={onOpenEdges} className="font-medium text-foreground underline-offset-2 hover:underline">
                {e.role === 'regional' ? 'Regional' : gatewayRole === 'regional' ? 'Edge จังหวัด' : 'Edge'} {e.node || '-'} · {e.name}
              </button>
              {' '}— ตั้งแต่ {fmt(e.downSince)} · กล้อง {e.cameras} ตัว{e.error ? ` · ${e.error}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
