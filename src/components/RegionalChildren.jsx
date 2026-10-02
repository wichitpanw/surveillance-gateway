import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** ดู Edge ลูกจาก Regional ผ่าน Central โดยไม่ส่งคีย์หรือที่อยู่ส่วนตัวมาที่เบราว์เซอร์ */
export default function RegionalChildren({ sourceId }) {
  const [children, setChildren] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await apiFetch(`/api/edges/${encodeURIComponent(sourceId)}/children`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'อ่านรายการ Edge ลูกไม่สำเร็จ');
        if (alive) { setChildren(data.children || []); setError(null); }
      } catch (err) { if (alive) setError(err.message); }
      finally { if (alive) setLoading(false); }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [sourceId, revision]);
  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-4">
      <div className="flex items-center justify-between text-sm font-medium">Edge ลูกของ Regional<Button variant="outline" size="sm" onClick={() => setRevision((r) => r + 1)}>รีเฟรช</Button></div>
      {loading ? <p className="text-xs text-muted-foreground">กำลังโหลด…</p> : error ? <p className="text-xs text-status-crit">{error}</p> : children.length ? (
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr className="border-b"><th className="p-2">Edge / Remark</th><th className="p-2">สถานะ</th><th className="p-2">กล้อง</th><th className="p-2">Build</th><th className="p-2">Sync ล่าสุด</th></tr></thead>
          <tbody>{children.map((child, i) => <tr key={child.node || i} className="border-b last:border-0">
            <td className="p-2"><div className="font-medium">Edge {child.node || '—'} · {child.name || '—'}</div>{child.remark && <div className="mt-1 max-w-md whitespace-pre-wrap break-words text-muted-foreground">{child.remark}</div>}</td>
            <td className="p-2">{child.reachable === true ? 'Online' : child.reachable === false ? 'ติดต่อไม่ได้' : 'ไม่ทราบ'}</td>
            <td className="p-2">{child.cameras ?? '—'}</td><td className="p-2 font-mono">{child.build || '—'}</td><td className="p-2">{child.lastSyncAt || '—'}</td>
          </tr>)}</tbody>
        </table></div>
      ) : <p className="text-xs text-muted-foreground">ยังไม่มี Edge ลูก</p>}
    </div>
  );
}
