import { Fragment, useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Server, Loader2, Copy, Cable, Download, ArrowUpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';
import { cn } from '@/lib/utils';
import CentralEndpoints from './CentralEndpoints';
import EdgeKitDownload from './EdgeKitDownload';
import RegionalChildren from './RegionalChildren';
import { linkUrlOf, hostOfUrl } from '@/lib/central-endpoints';

/*
  Edge Nodes — หน้าที่ central ใช้ "แอด edge" (docs/EDGE-PLAN.md)

  แอด edge = กรอกที่อยู่ + API key ที่ edge ออกให้ (หน้า Central Access ของ edge) แล้ว central รับ
  กล้องทุกตัวของ edge นั้นมาทันที หลังจากนั้นกล้องที่ edge แอดเพิ่มจะไหลมาเองทุก 10 นาที หรือกด Sync
  central ไม่เคยได้รหัสผ่านกล้อง — ที่เก็บคือ key ของ edge อย่างเดียว

  แบบ "edge ต่อขึ้นมาเอง" (link, เฟส 4): สำหรับ edge ที่ central ต่อเข้าไปไม่ถึง (หลัง NAT) — central
  ออก token ให้ไปตั้งที่ edge (GATEWAY_CENTRAL_URL / GATEWAY_CENTRAL_TOKEN) แล้ว edge ต่อ WebSocket
  ขึ้นมาเอง ไม่ต้องกรอกที่อยู่ของ edge · token แสดงครั้งเดียว central เก็บแค่ hash
*/

const fmt = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');
const REGIONS = [
  ['central', 'ภาคกลาง'], ['north', 'ภาคเหนือ'], ['northeast', 'ภาคตะวันออกเฉียงเหนือ'],
  ['east', 'ภาคตะวันออก'], ['west', 'ภาคตะวันตก'], ['south', 'ภาคใต้'],
];

function StatusDot({ reachable }) {
  if (reachable === null || reachable === undefined) return <span className="text-xs text-muted-foreground">ยังไม่ได้ตรวจ</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', reachable ? 'text-status-ok' : 'text-status-crit')}>
      <span className={cn('size-2 rounded-full', reachable ? 'bg-status-ok animate-pulse' : 'bg-status-crit')} />
      {reachable ? 'Online' : 'ติดต่อไม่ได้'}
    </span>
  );
}

// สถานะอัปเดตผ่านสาย link ที่ edge รายงานมา (docs/EDGE-KIT.md) — ติดตั้งจริงต้องกดที่หน้าเว็บของ edge
const UPDATE_TEXT = {
  available: 'มีเวอร์ชันใหม่ — เครื่องนี้ต้องอัปเดตเอง',
  downloading: 'กำลังโหลดเวอร์ชันใหม่',
  ready: 'โหลดแล้ว — กดอัปเดต (ปุ่มลูกศร) หรือกดที่หน้าเว็บของ edge',
  installing: 'กำลังติดตั้ง',
  installed: 'ติดตั้งสำเร็จ',
  rolled_back: 'ติดตั้งไม่สำเร็จ ถอยกลับแล้ว',
  failed: 'อัปเดตผิดพลาด',
};

function UpdateLine({ update, published, build }) {
  const target = update?.platform ? published[update.platform] : null;
  const text = update?.state ? UPDATE_TEXT[update.state] : null;
  // ไม่มีสถานะใหม่และ edge เป็นรุ่นที่เผยแพร่อยู่แล้ว = ไม่มีอะไรต้องบอก
  if (!text && (!target || target === build)) return null;
  const bad = ['failed', 'rolled_back'].includes(update?.state);
  return (
    <div className={cn('mt-1 text-[11px]', bad ? 'text-status-crit' : 'text-muted-foreground')} title={update?.error || ''}>
      {text ? `${text}${update.build ? ` (${update.build})` : ''}` : `แพ็กเกจ ${update.platform}: ${target}`}
    </div>
  );
}

export default function EdgeNodes({ gatewayRole = 'central', canManage, centralBuild, onCamerasChanged }) {
  const [edges, setEdges] = useState([]);
  const [published, setPublished] = useState({}); // platform → build ที่เผยแพร่ให้ edge แบบ link
  const [mirror, setMirror] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [form, setForm] = useState({ host: '', port: '5173', key: '', label: '', remark: '' });
  const [linkForm, setLinkForm] = useState({ node: '', province: '10', role: gatewayRole === 'central' ? 'regional' : 'edge', region: 'central' });
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(null);
  const [mode, setMode] = useState('pull'); // pull = central ต่อเข้า edge · link = edge ต่อขึ้นมาเอง
  const [linkIssued, setLinkIssued] = useState(null); // { token, label, node, province } — แสดงครั้งเดียว
  const [provinces, setProvinces] = useState([]);
  // เลข edge ที่จะจองให้ (ค่าเริ่มต้น = เลขว่างถัดไปจาก central) และจังหวัดตั้งต้นของกล้องใหม่ — ใส่ลงไฟล์ edge.json
  // ที่อยู่ของ central ที่ edge ใช้ต่อ (CentralEndpoints) และเส้นทางที่เลือกใส่ในคำสั่งของ token นี้
  const [endpoints, setEndpoints] = useState([]);
  const [picked, setPicked] = useState(null); // null = ทุกเส้นทาง
  const chosen = endpoints.filter((e, i) => picked === null || picked.includes(i));
  // ยังไม่ได้ตั้งเลย = ใช้ที่อยู่ของเบราว์เซอร์ไปก่อน (เตือนไว้ในกล่อง)
  const linkUrls = chosen.length ? chosen.map(linkUrlOf) : [`ws://${window.location.host}/api/edge-link`];

  const issueLink = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await apiFetch('/api/edges/link', { method: 'POST', body: JSON.stringify({ label: form.label, remark: form.remark, node: linkForm.node, role: linkForm.role, region: linkForm.role === 'regional' ? linkForm.region : undefined }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'ออก token ไม่สำเร็จ');
      setLinkIssued({ token: data.token, label: form.label || `${data.role === 'regional' ? 'Regional' : 'Edge'} (link)`, node: data.node,
        province: linkForm.province || '10', role: data.role, region: data.region, remark: data.remark });
      setForm({ host: '', port: '5173', key: '', label: '', remark: '' });
      setShowForm(false);
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  // โหลดชื่อจังหวัดสำหรับเลือก แต่เก็บรหัสเดิมในไฟล์ตั้งค่า Edge
  useEffect(() => {
    if (!showForm || mode !== 'link' || linkForm.role !== 'edge') return;
    apiFetch('/api/regions')
      .then((res) => { if (!res.ok) throw new Error('โหลดจังหวัดไม่สำเร็จ'); return res.json(); })
      .then((rows) => setProvinces(Array.isArray(rows) ? rows : []))
      .catch(() => toast({ title: 'โหลดจังหวัดไม่สำเร็จ — ปิดแล้วเปิดฟอร์มอีกครั้ง', variant: 'destructive' }));
  }, [showForm, mode, linkForm.role]);

  // เลขว่างถัดไปทุกครั้งที่เปิดฟอร์มแบบ link — ผู้ใช้แก้เองได้ ถ้าชนระบบตอบ 409
  useEffect(() => {
    if (!showForm || mode !== 'link') return;
    apiFetch(`/api/edges/next-node?role=${encodeURIComponent(linkForm.role)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.node) setLinkForm((f) => ({ ...f, node: d.node })); })
      .catch(() => {});
  }, [showForm, mode, linkForm.role]);

  /*
    ไฟล์ตั้งค่าสำหรับชุดติดตั้ง flash drive (docs/EDGE-KIT.md) — ตัวติดตั้งอ่านไฟล์ edge-<เลข>.json ที่ราก
    flash drive แล้วลบทิ้งหลังติดตั้ง เพราะมี token · พอร์ต/โฟลเดอร์ ตัวติดตั้งใส่เองตามเครื่อง
  */
  const edgeJson = (issued) => JSON.stringify({
    node: issued.node || '',
    ...(issued.role === 'regional' ? { role: 'regional', region: issued.region } : { province: issued.province || '10' }),
    label: issued.label,
    remark: issued.remark || '',
    centralUrls: linkUrls,
    centralToken: issued.token,
  }, null, 2);
  const downloadEdgeJson = () => {
    const blob = new Blob([`${edgeJson(linkIssued)}\n`], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `edge-${linkIssued.node || 'new'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'คัดลอกแล้ว' });
    } catch {
      toast({ title: 'คัดลอกไม่ได้ — เลือกข้อความแล้วคัดลอกเอง', variant: 'destructive' });
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/edges');
      if (res.ok) setEdges(await res.json());
      const up = await apiFetch('/api/edge-updates');
      if (up.ok) {
        const data = await up.json();
        setPublished(data.published || {});
        setMirror(data.mirror || null);
      }
    } catch { /* ครั้งหน้าลองใหม่ */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const add = async (e) => {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await apiFetch('/api/edges', { method: 'POST', body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เพิ่ม edge ไม่สำเร็จ');
      toast({ title: `เพิ่ม edge ${data.node} แล้ว`, description: `รับกล้อง ${data.imported} ตัว` });
      setForm({ host: '', port: '5173', key: '', label: '', remark: '' });
      setShowForm(false);
      await load();
      onCamerasChanged?.();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  /*
    ลบกล้องที่หายจาก edge แล้วแต่ edge ไม่มีบันทึกว่าคนลบ (ลบก่อนมีระบบบันทึก หรือ DB ของ edge ถูกล้าง)
    ระบบไม่ลบเองเพราะแยกไม่ออกจาก edge ที่ตอบไม่ครบชั่วคราว — ให้คนยืนยัน
  */
  const purgeMissing = async (edge) => {
    const ok = await appConfirm({
      title: 'ลบกล้องที่หายจาก edge',
      description: `ลบกล้อง ${edge.missingCount} ตัวของ "${edge.label}" ที่ไม่มีที่ edge แล้วออกจาก central — สิทธิ์และผัง wall ที่ผูกกับกล้องเหล่านี้จะหายด้วย ถ้า edge กลับมามีกล้องตัวเดิม central จะรับเข้ามาใหม่เป็นแถวใหม่`,
      confirmText: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(edge.id);
    try {
      const res = await apiFetch(`/api/edges/${encodeURIComponent(edge.id)}/missing`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'ลบไม่สำเร็จ');
      toast({ title: `ลบกล้องที่หายจาก edge ${data.removed} ตัว` });
      await load();
      onCamerasChanged?.();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const resync = async (edge) => {
    setBusy(edge.id);
    try {
      const res = await apiFetch(`/api/edges/${encodeURIComponent(edge.id)}/resync`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sync ไม่สำเร็จ');
      if (data.requested) toast({ title: `Sync ${edge.label}`, description: 'ขอให้ edge ส่งรายการกล้องใหม่แล้ว — จะอัปเดตภายในไม่กี่วินาที' });
      else toast({ title: `Sync ${edge.label}`, description: `กล้อง ${data.imported} ตัว · รับใหม่ ${data.added}${data.removed ? ` · ลบตาม edge ${data.removed}` : ''} · หายจาก edge ${data.missing.length}` });
      await load();
      onCamerasChanged?.();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  /*
    สั่ง edge ติดตั้งเวอร์ชันที่โหลดไว้แล้ว (สถานะ ready) ผ่านสาย link — edge ถอยกลับเองถ้ารุ่นใหม่ต่อ central ไม่ติดใน 5 นาที
    หลายตัว = สั่งทีละตัวตามลำดับ ตัวที่พลาดไม่หยุดตัวอื่น
  */
  const readyEdges = edges.filter((e) => e.update?.state === 'ready');
  const retryUpdate = async (edge) => {
    setBusy(edge.id);
    try {
      const res = await apiFetch(`/api/edges/${encodeURIComponent(edge.id)}/update/retry`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ลองโหลดใหม่ไม่สำเร็จ');
      toast({ title: `${edge.label}: กำลังลองโหลดใหม่` });
      await load();
    } catch (err) { toast({ title: err.message, variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const updateEdges = async (list) => {
    const names = list.map((e) => `${e.label} (${e.remote_node || '-'})`).join(', ');
    const ok = await appConfirm({
      title: list.length > 1 ? `อัปเดต edge ${list.length} ตัว` : 'อัปเดต edge',
      description: `${names} จะติดตั้งเวอร์ชัน ${list[0].update?.build || 'ใหม่'} · ภาพจาก edge นั้นหยุดราว 5–10 วินาที · ถ้าเวอร์ชันใหม่ต่อ central ไม่ติดภายใน 5 นาที edge ถอยกลับเอง`,
      confirmText: 'อัปเดต',
    });
    if (!ok) return;
    for (const edge of list) {
      setBusy(edge.id);
      try {
        const res = await apiFetch(`/api/edges/${encodeURIComponent(edge.id)}/update`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'สั่งอัปเดตไม่สำเร็จ');
        toast({ title: `${edge.label}: กำลังติดตั้ง ${data.build || ''}`, description: 'สถานะจะเปลี่ยนเป็น "ติดตั้งสำเร็จ" เมื่อ edge ต่อกลับมาด้วยเวอร์ชันใหม่' });
      } catch (err) {
        toast({ title: `${edge.label}: ${err.message}`, variant: 'destructive' });
      }
    }
    setBusy(null);
    await load();
  };

  const remove = async (edge) => {
    const ok = await appConfirm({
      title: 'ถอด edge',
      description: `ถอด "${edge.label}" และกล้อง ${edge.cameraCount} ตัวของมันออกจาก central? กล้องที่ edge ไม่ถูกลบ แอดกลับได้ด้วย key เดิม`,
      confirmText: 'ถอด edge',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(edge.id);
    try {
      const res = await apiFetch(`/api/edges/${encodeURIComponent(edge.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ถอดไม่สำเร็จ');
      await load();
      onCamerasChanged?.();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="stagger-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl tracking-tight">{gatewayRole === 'central' ? 'Regional Nodes' : 'Edge Nodes'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Edge แอดกล้อง · Regional รวม Edge จังหวัด · Central รวม Regional</p>
        </div>
        {canManage && readyEdges.length > 1 && (
          <Button variant="outline" onClick={() => updateEdges(readyEdges)} className="ml-auto gap-2">
            <ArrowUpCircle className="size-4" /> อัปเดตทั้งหมด ({readyEdges.length})
          </Button>
        )}
        {canManage && (
          <Button onClick={() => setShowForm((s) => !s)} className="gap-2">
            <Plus className={cn('size-4 transition-transform', showForm && 'rotate-45')} /> {gatewayRole === 'central' ? 'Add Regional' : 'Add Edge'}
          </Button>
        )}
      </div>

      {/*
        central ขึ้นรุ่นใหม่แล้วแต่ยังไม่ publish แพ็กเกจรุ่นนั้น — edge แบบ link จะไม่ได้ข้อเสนออัปเดตเลย
        (เกิดจริง 2026-09-28: restart ไปสามรอบโดยไม่ publish edge 002 ค้างที่ a934d0f) · แก้ด้วย scripts\deploy.ps1
      */}
      {centralBuild && edges.some((e) => e.mode === 'link') && (() => {
        const stale = Object.entries(published).filter(([, b]) => b !== centralBuild);
        if (!stale.length && Object.keys(published).length) return null;
        return (
          <div role="alert" className="rounded-md border border-status-warn bg-status-warn/10 px-4 py-3 text-sm">
            <div className="font-semibold text-status-warn">{gatewayRole === 'regional' ? `รอซิงก์แพ็กเกจรุ่น ${centralBuild} จาก Central` : `ยังไม่ได้ publish รุ่น ${centralBuild} ครบทุกแพลตฟอร์ม`}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              แพ็กเกจที่เผยแพร่อยู่: {Object.keys(published).length
                ? stale.map(([p, b]) => `${p} ${b || 'ไม่มี'}`).join(' · ')
                : 'ไม่มี'}
              {' '}· {gatewayRole === 'regional'
                ? 'Regional ตรวจจาก Central ทุก 1 นาที และ Edge ตรวจแพ็กเกจทุก 1 นาที'
                : <>รันจาก PowerShell แบบ admin: <code className="font-mono">scripts\deploy.ps1</code> (deploy + publish)
                  หรือ <code className="font-mono">scripts\build-edge-kit.ps1 -UpdatesOnly</code> (publish อย่างเดียว)</>}
            </div>
          </div>
        );
      })()}
      {gatewayRole === 'regional' && mirror && (
        <div className={cn('text-xs', mirror.error ? 'text-status-crit' : 'text-muted-foreground')}>
          ซิงก์แพ็กเกจ: {mirror.state === 'syncing' ? 'กำลังซิงก์' : mirror.state === 'ok' ? 'สำเร็จ' : mirror.state === 'failed' ? 'ผิดพลาด' : 'รอเชื่อมต่อ Central'}
          {' · '}ตรวจล่าสุด {fmt(mirror.lastAttemptAt)} · สำเร็จล่าสุด {fmt(mirror.lastSuccessAt)}
          {mirror.error && <div>{mirror.error}</div>}
        </div>
      )}

      {linkIssued && (
        <div className="space-y-3 rounded-md border border-status-warn/50 bg-card p-5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2 font-medium"><Cable className="size-4" /> token ของ "{linkIssued.label}"{linkIssued.node ? ` (${linkIssued.role === 'regional' ? 'Regional' : 'Edge'} ${linkIssued.node})` : ''} — แสดงครั้งเดียว</div>
          <p className="text-xs text-muted-foreground">
            เครื่องลูกจะลองที่อยู่ของ {gatewayRole === 'regional' ? 'Regional' : 'Central'} ตามลำดับแล้วใช้อันที่ต่อติด — เลือกเฉพาะเส้นทางที่เครื่องนี้เข้าถึงได้ ·
            ยังไม่มี TLS: ใช้ผ่าน LAN/VPN เท่านั้น
          </p>
          {endpoints.length > 0 ? (
            <div className="flex flex-wrap gap-2 text-xs">
              {endpoints.map((e, i) => {
                const on = picked === null || picked.includes(i);
                return (
                  <label key={i} className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1', on ? 'border-primary bg-primary/10' : 'opacity-60')}>
                    <input type="checkbox" className="accent-primary" checked={on}
                      onChange={() => setPicked((prev) => {
                        const cur = prev === null ? endpoints.map((_, j) => j) : prev;
                        return on ? cur.filter((j) => j !== i) : [...cur, i].sort((a, b) => a - b);
                      })} />
                    {e.label} <span className="font-mono text-muted-foreground">{e.host}:{e.port}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="rounded bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
              ยังไม่ได้ตั้ง "ที่อยู่ของ {gatewayRole === 'regional' ? 'Regional' : 'Central'}" (กล่องด้านล่าง) — คำสั่งนี้ใช้ที่อยู่ที่เบราว์เซอร์เปิดเว็บอยู่ ({window.location.host})
              ซึ่ง edge ที่อยู่คนละวงอาจต่อไม่ถึง
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/40 px-3 py-3">
            <Button type="button" className="gap-2" disabled={!linkIssued.node} onClick={downloadEdgeJson}>
              <Download className="size-4" /> ดาวน์โหลด edge-{linkIssued.node || 'new'}.json
            </Button>
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {linkIssued.node
                ? 'ชุดติดตั้ง flash drive: วางไฟล์นี้ไว้ที่รากของ flash drive ข้าง install-windows.cmd / install-pi.sh — ไฟล์มี token ตัวติดตั้งลบทิ้งให้หลังติดตั้งเสร็จ'
                : 'token นี้ออกโดยไม่จองเลข edge — ใช้ได้แค่วิธีติดตั้งเองด้านล่าง'}
            </p>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">ติดตั้งเอง (เครื่องที่ลงไว้แล้ว)</div>
          {[
            ['Linux (Ubuntu) — รันบนเครื่อง edge', `~/gw-edge/scripts/setup-edge.sh ${linkUrls.map((u) => `--central-url '${u}'`).join(' ')} --central-token ${linkIssued.token} && sudo systemctl restart gw-edge`],
            ['Windows — ใส่ใน <stateDir>/edge.json แล้ว pm2 delete/start 3-edge-gateway', JSON.stringify({ centralUrls: linkUrls, centralToken: linkIssued.token })],
          ].map(([k, v]) => (
            <div key={k} className="space-y-1">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">{v}</code>
                <Button type="button" variant="outline" size="icon" title="คัดลอก" onClick={() => copy(v)}><Copy className="size-4" /></Button>
              </div>
            </div>
          ))}
          <div className="flex justify-end"><Button variant="outline" size="sm" onClick={() => setLinkIssued(null)}>เก็บ token แล้ว ปิด</Button></div>
        </div>
      )}

      {showForm && (
        <div className="flex w-fit overflow-hidden rounded-md border text-xs">
          {[['pull', `${gatewayRole === 'regional' ? 'Regional' : 'Central'} ต่อเข้าเครื่องลูก`], ['link', 'เครื่องลูกต่อขึ้นมาเอง (หลัง NAT)']].map(([m, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={cn('px-3 py-1.5 transition-colors', mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>{label}</button>
          ))}
        </div>
      )}

      {showForm && mode === 'link' && (
        <form onSubmit={issueLink} className="grid gap-4 rounded-md border bg-card p-5 animate-in fade-in slide-in-from-top-2 duration-200 md:grid-cols-12">
          <div className="space-y-2 md:col-span-4">
            <Label className="text-xs text-muted-foreground">ชื่อ {linkForm.role === 'regional' ? 'Regional' : 'Edge'}</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={gatewayRole === 'central' ? 'เช่น Regional ภาคกลาง' : 'เช่น Edge ตัวอย่าง'} className="text-xs" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs text-muted-foreground">เลข node (ห้ามซ้ำ)</Label>
            <Input required pattern="\d{3}" maxLength={3} value={linkForm.node} onChange={(e) => setLinkForm({ ...linkForm, node: e.target.value.replace(/\D/g, '') })} className="font-mono text-xs" />
          </div>
          {linkForm.role === 'regional' ? <div className="space-y-2 md:col-span-2">
            <Label className="text-xs text-muted-foreground">ภาค</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-xs" value={linkForm.region}
              onChange={(e) => setLinkForm((f) => ({ ...f, region: e.target.value }))}>
              {REGIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div> : <div className="space-y-2 md:col-span-2">
            <Label htmlFor="edge-province" className="text-xs text-muted-foreground">จังหวัด</Label>
            <Select value={linkForm.province} disabled={!provinces.length}
              onValueChange={(province) => setLinkForm((f) => ({ ...f, province }))}>
              <SelectTrigger id="edge-province" className="h-9 text-xs">
                <SelectValue placeholder="เลือกจังหวัด" />
              </SelectTrigger>
              <SelectContent>
                {provinces.map((province) => (
                  <SelectItem key={province.code} value={province.code} className="text-xs">{province.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>}
          <div className="space-y-2 md:col-span-12">
            <Label className="text-xs text-muted-foreground">Remark / จุดติดตั้ง (ไม่บังคับ)</Label>
            <Input maxLength={500} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="เช่น อำเภอเมือง · ชุมสาย A · ห้องอุปกรณ์ชั้น 2" className="text-xs" />
          </div>
          <div className="flex items-end justify-between gap-3 md:col-span-12">
            <p className="text-xs text-muted-foreground">{gatewayRole === 'central' ? 'Central ออก token ให้ Regional แล้ว Regional ต่อขึ้นมาเอง' : 'Regional ออก token ให้ Edge แล้ว Edge ต่อขึ้นมาเอง'}</p>
            <Button type="submit" disabled={adding || (linkForm.role === 'edge' && !provinces.length)} className="gap-2">
              {adding && <Loader2 className="size-4 animate-spin" />} ออก token
            </Button>
          </div>
        </form>
      )}

      {showForm && mode === 'pull' && (
        <form onSubmit={add} className="grid gap-4 rounded-md border bg-card p-5 animate-in fade-in slide-in-from-top-2 duration-200 md:grid-cols-12">
          <div className="space-y-2 md:col-span-3">
            <Label className="text-xs text-muted-foreground">{gatewayRole === 'central' ? 'Regional address' : 'Edge address'}</Label>
            <Input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="100.x.x.x (Tailscale)" className="font-mono text-xs" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs text-muted-foreground">Port</Label>
            <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="font-mono text-xs" />
          </div>
          <div className="space-y-2 md:col-span-4">
            <Label className="text-xs text-muted-foreground">{gatewayRole === 'central' ? 'API key จาก API Clients ของ Regional' : 'API key จาก Central Access ของ Edge'}</Label>
            <Input required type="password" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="sgw_…" className="font-mono text-xs" />
          </div>
          <div className="space-y-2 md:col-span-3">
            <Label className="text-xs text-muted-foreground">ชื่อ (ไม่บังคับ)</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="เช่น Edge ตัวอย่าง" className="text-xs" />
          </div>
          <div className="space-y-2 md:col-span-12">
            <Label className="text-xs text-muted-foreground">Remark / จุดติดตั้ง (ไม่บังคับ)</Label>
            <Input maxLength={500} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="เช่น อำเภอเมือง · ชุมสาย A · ห้องอุปกรณ์ชั้น 2" className="text-xs" />
          </div>
          <div className="flex items-center justify-between gap-3 md:col-span-12">
            <p className="text-xs text-muted-foreground">ถ้าจะสั่ง PTZ ผ่าน central ให้ติ๊ก "คุม PTZ" ให้ key นี้ที่ edge ด้วย</p>
            <Button type="submit" disabled={adding} className="gap-2">
              {adding && <Loader2 className="size-4 animate-spin" />} เพิ่มและรับกล้อง
            </Button>
          </div>
        </form>
      )}

      <div className="stagger-in overflow-hidden rounded-md border bg-card" style={{ '--i': 2 }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Cameras</TableHead>
              <TableHead>Build</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {edges.map((e) => (
              <Fragment key={e.id}><TableRow className="animate-in fade-in duration-300">
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    {e.remote_role === 'regional' && <Button variant="outline" size="sm" aria-expanded={!!expanded[e.id]} title="ดู Edge ลูก" onClick={() => setExpanded((prev) => ({ ...prev, [e.id]: !prev[e.id] }))}>{expanded[e.id] ? '▾' : '▸'}</Button>}
                    <Server className="size-4 text-muted-foreground" />
                    <div>
                      <div className="flex items-center gap-2 font-medium">{e.label}<Badge variant="outline">{e.remote_role === 'regional' ? 'Regional' : 'Edge'}</Badge></div>
                      <div className="font-mono text-[11px] text-muted-foreground">node {e.remote_node || '—'}{e.remote_region ? ` · ${e.remote_region}` : ''}</div>
                      {e.remark && <div className="mt-1 max-w-md whitespace-pre-wrap break-words text-xs text-muted-foreground">{e.remark}</div>}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {e.mode === 'link'
                    ? (
                      <div className="font-sans text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5"><Cable className="size-3.5" /> ต่อขึ้นมาเอง</span>
                        {e.link_via && <div className="mt-0.5 font-mono text-[11px]" title="ที่อยู่ของ central ที่ edge ใช้ต่อ · IP ที่สายมาถึง">ผ่าน {hostOfUrl(e.link_via)}{e.link_remote ? ` จาก ${e.link_remote}` : ''}</div>}
                      </div>
                    )
                    : `${e.host}:${e.port}`}
                </TableCell>
                <TableCell>
                  <StatusDot reachable={e.reachable} />
                  {e.reachable === false && e.status_error && <div className="mt-1 max-w-[260px] truncate text-[11px] text-muted-foreground" title={e.status_error}>{e.status_error}</div>}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {e.cameraCount}
                  {e.missingCount > 0 && (
                    canManage ? (
                      <button
                        type="button"
                        onClick={() => purgeMissing(e)}
                        disabled={busy === e.id}
                        className="ml-2 inline-flex items-center gap-1 rounded-md border border-status-warn/50 px-1.5 py-0.5 text-[10px] text-status-warn hover:bg-status-warn/10 disabled:opacity-50"
                        title="หายจาก edge แล้ว — ไม่ส่งภาพและไม่นับสถานะ · คลิกเพื่อลบออกจาก central"
                      >
                        {e.missingCount} หาย <Trash2 className="size-3" />
                      </button>
                    ) : <Badge variant="outline" className="ml-2 text-[10px]" title="หายจาก edge แล้ว — ยังไม่ลบ">{e.missingCount} หาย</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{e.remote_build || '—'}</span>
                  {centralBuild && e.remote_build && e.remote_build !== centralBuild && (
                    <Badge variant="outline" className="ml-2 border-status-warn/50 text-[10px] text-status-warn" title={`central รัน ${centralBuild}`}>ไม่ตรง central</Badge>
                  )}
                  <UpdateLine update={e.update} published={published} build={e.remote_build} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(e.last_sync_at)}</TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {canManage && (
                    <>
                      {e.update?.state === 'failed' && e.update?.retryable && (
                        <Button variant="outline" size="sm" disabled={busy === e.id} onClick={() => retryUpdate(e)}>ลองโหลดใหม่</Button>
                      )}
                      {e.update?.state === 'ready' && (
                        <Button variant="ghost" size="icon" title={`อัปเดตเป็น ${e.update.build}`} disabled={busy === e.id} onClick={() => updateEdges([e])}>
                          <ArrowUpCircle className="size-4 text-primary" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" title="Sync ตอนนี้" disabled={busy === e.id} onClick={() => resync(e)}>
                        <RefreshCw className={cn('size-4', busy === e.id && 'animate-spin')} />
                      </Button>
                      <Button variant="ghost" size="icon" title="ถอด edge" disabled={busy === e.id} onClick={() => remove(e)}>
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
              {e.remote_role === 'regional' && expanded[e.id] && <TableRow><TableCell colSpan={7}><RegionalChildren sourceId={e.id} /></TableCell></TableRow>}</Fragment>
            ))}
            {!edges.length && (
              <TableRow>
                <TableCell colSpan={7} className="py-14 text-center">
                  <Server className="mx-auto mb-3 size-8 text-muted-foreground/40" />
                  <div className="text-sm text-muted-foreground">ยังไม่มี edge — กด Add Edge แล้วใส่ key ที่ออกจากหน้า Central Access ของ edge</div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <CentralEndpoints gatewayRole={gatewayRole} canManage={canManage} onChange={setEndpoints} />
      {canManage && <EdgeKitDownload gatewayRole={gatewayRole} />}
    </div>
  );
}
