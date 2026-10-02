import { useEffect, useState } from 'react';
import { Cctv, Server, Cpu, MemoryStick, ArrowRight, CircleAlert } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import AreaSummary from './AreaSummary';

/*
  หน้าแรกของทั้งสองโปรแกรม (Dashboard ของ reference edge project) — ตอบสามคำถามในหน้าเดียว:
  มีกล้องกี่ตัวและกี่ตัวออนไลน์, เครื่องนี้ภาระเท่าไร, เพิ่งเกิดอะไรขึ้น
  central มีการ์ด edge เพิ่ม เพราะกล้องทั้งหมดของ central มาจาก edge
*/

function StatCard({ i, icon, label, value, sub, tone, onClick }) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{ '--i': i }}
      className={cn(
        'stagger-in group flex flex-col gap-3 rounded-md border bg-card p-5 text-left transition-all',
        onClick && 'hover:-translate-y-0.5 hover:shadow-md',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={cn('size-5', tone || 'text-muted-foreground')} />
      </div>
      <div className="text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{sub}</span>
        {onClick && <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />}
      </div>
    </button>
  );
}

function Meter({ label, pct }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{v.toFixed(0)}%</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all duration-700', v >= 85 ? 'bg-status-crit' : v >= 60 ? 'bg-status-warn' : 'bg-status-ok')} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

export default function Dashboard({ app, cameras, cameraStatus, systemStats, logs, onOpen }) {
  const [edges, setEdges] = useState(null);

  useEffect(() => {
    if (app.role === 'edge') return undefined;
    let alive = true;
    const load = () => apiFetch('/api/edges').then((r) => (r.ok ? r.json() : [])).then((d) => { if (alive) setEdges(d); }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [app.role]);

  const total = cameras.length;
  const online = cameras.filter((c) => cameraStatus[c.id] === 'online').length;
  const edgeUp = (edges || []).filter((e) => e.reachable === true).length;
  const gpu0 = Array.isArray(systemStats?.gpu) ? systemStats.gpu[0] : null;

  return (
    <div className="space-y-6">
      <div className="stagger-in">
        <h2 className="text-2xl tracking-tight">{app.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {app.role === 'central'
            ? 'รวมกล้องจาก Regional ทุกภาค และ Edge เดิมที่ยังต่อตรง'
            : app.role === 'regional'
              ? 'รวมกล้องจาก Edge จังหวัดในภาค · Client ภายในภาคต่อที่นี่โดยตรงได้แม้สายไป Central ขาด'
              : 'แอดกล้องในวงแลนของเครื่องนี้ แล้วออก key ให้ Regional มารับกล้อง'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard i={1} icon={Cctv} label="Cameras" value={total} sub={`${online} online · ${Math.max(0, total - online)} offline`} tone="text-foreground" onClick={() => onOpen('cameras')} />
        {app.role !== 'edge' ? (
          <StatCard i={2} icon={Server} label={app.role === 'central' ? 'Regional / Edge' : 'Edge จังหวัด'} value={edges ? edges.length : '—'} sub={edges ? `${edgeUp} reachable` : 'กำลังโหลด'} tone={edges && edgeUp < edges.length ? 'text-status-crit' : 'text-status-ok'} onClick={() => onOpen('edges')} />
        ) : (
          <StatCard i={2} icon={Server} label="Central Access" value="Keys" sub="ออก key ให้ central" onClick={() => onOpen('api-clients')} />
        )}
        <StatCard i={3} icon={Cpu} label="CPU" value={`${Number(systemStats?.cpu || 0).toFixed(0)}%`} sub={gpu0 ? `GPU ${Number(gpu0.util || 0).toFixed(0)}%` : 'ไม่มี GPU'} />
        <StatCard i={4} icon={MemoryStick} label="Memory" value={`${Number(systemStats?.ram || 0).toFixed(0)}%`} sub={systemStats?.totalRamGB ? `${Number(systemStats.usedRamGB).toFixed(1)} / ${Number(systemStats.totalRamGB).toFixed(0)} GB` : ''} />
      </div>

      {app.role !== 'edge' && <AreaSummary cameras={cameras} cameraStatus={cameraStatus} edges={edges || []} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="stagger-in rounded-md border bg-card p-5 xl:col-span-2" style={{ '--i': 5 }}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm">Recent activity</h3>
            <button type="button" onClick={() => onOpen('logs')} className="text-xs text-muted-foreground hover:text-foreground">ดูทั้งหมด</button>
          </div>
          <div className="divide-y">
            {(logs || []).slice(0, 8).map((l, idx) => (
              <div key={l.id || idx} className="flex items-start gap-3 py-2.5 text-sm">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{l.details}</div>
                  <div className="text-xs text-muted-foreground">{l.action} · {l.username} · {String(l.timestamp || '').replace('T', ' ').slice(0, 19)}</div>
                </div>
              </div>
            ))}
            {!(logs || []).length && <div className="py-8 text-center text-sm text-muted-foreground">ยังไม่มีเหตุการณ์</div>}
          </div>
        </div>

        <div className="stagger-in space-y-4 rounded-md border bg-card p-5" style={{ '--i': 6 }}>
          <h3 className="text-sm">This machine</h3>
          <Meter label="CPU" pct={systemStats?.cpu} />
          <Meter label="Memory" pct={systemStats?.ram} />
          {gpu0 && <Meter label="GPU" pct={gpu0.util} />}
          {app.role !== 'edge' && edges && edges.some((e) => e.reachable !== true) && (
            <div className="flex items-start gap-2 rounded border border-status-crit/40 bg-status-crit/5 p-3 text-xs">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-status-crit" />
              <span>มีโหนดที่ติดต่อไม่ได้ — กล้องในกิ่งนั้นขึ้นเป็นไม่ทราบสถานะ</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
