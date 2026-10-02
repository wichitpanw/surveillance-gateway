import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, ImageOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { useAiSnapshot } from '@/lib/useAiSnapshot';
import AiEventDialog from '@/components/modals/AiEventDialog';

const BANGKOK_MS = 7 * 3600_000;
const todayBangkok = () => new Date(Date.now() + BANGKOK_MS).toISOString().slice(0, 10);
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00+07:00`) + 86_400_000 + BANGKOK_MS).toISOString().slice(0, 10);
const ORIGIN_LABEL = { camera: 'กล้อง', nvr: 'NVR', vms: 'VMS', api: 'API ภายนอก', 'edge-ai': 'Edge AI (เดิม)' };
const LABEL_TH = { person: 'คน', car: 'รถยนต์', motorcycle: 'จักรยานยนต์', bicycle: 'จักรยาน', bus: 'รถบัส', truck: 'รถบรรทุก' };

/** ภาพย่อในแถว (คลิกทั้งแถวเพื่อเปิด popup) */
function Thumb({ seq }) {
  const { url, failed } = useAiSnapshot(seq);
  if (failed) return <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-sm bg-muted"><ImageOff className="size-4 text-muted-foreground" /></div>;
  return url
    ? <img src={url} alt="" className="h-14 w-24 shrink-0 rounded-sm object-cover" />
    : <div className="h-14 w-24 shrink-0 animate-pulse rounded-sm bg-muted" />;
}

/*
  AI Events — ผลตรวจจับจากต้นทางที่ Regional/Central รวมไว้

  กรองตามวัน กล้อง ชนิด และประเภทวัตถุ · รีเฟรชเองทุก 15 วิ · คลิกแถว = popup ภาพเต็มและรายละเอียด (modals/AiEventDialog.jsx)
  · ปุ่ม "ย้อนหลัง" เปิดหน้า Playback ที่เวลาเกิดเหตุ (ถอยไป 10 วิ ให้เห็นก่อนเกิด)
*/
export default function AiEvents({ cameras = [], onOpenPlayback }) {
  const [day, setDay] = useState(todayBangkok);
  const [cameraId, setCameraId] = useState('');
  const [edgeNode, setEdgeNode] = useState('');
  const [group, setGroup] = useState('');
  const ownerEdge = (c) => {
    if (c.type !== 'edge_relay') return '';
    const id = c.source_role === 'regional' ? c.source_ref : c.id;
    const node = /^cam_edge_(\d+)_/.exec(String(id || ''))?.[1] || (c.source_role !== 'regional' ? c.source_node : null);
    return node == null ? '' : String(Number(node));
  };
  const edgeNodes = [...new Set(cameras.map(ownerEdge).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  const edgeCameras = cameras.filter((c) => !edgeNode || ownerEdge(c) === edgeNode);
  const groups = [...new Set(edgeCameras.map((c) => c.group_name || 'Default'))].sort();
  const filteredCameras = edgeCameras.filter((c) => !group || (c.group_name || 'Default') === group);
  const [type, setType] = useState('');
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // popup ผูกกับ seq ไม่ใช่ตำแหน่ง — รีเฟรชทุก 15 วิแล้ว event ใหม่ดันรายการลง popup ต้องยังเป็นตัวเดิม
  const [openSeq, setOpenSeq] = useState(null);
  // ช่องชนิดพิมพ์อิสระ — รอหยุดพิมพ์ 400 ms ก่อนค้น ไม่ยิงคำขอทุกตัวอักษร
  const [typeQuery, setTypeQuery] = useState('');
  const reqRef = useRef(0); // เลขคำขอล่าสุด — คำตอบของคำขอเก่าทิ้ง

  useEffect(() => {
    const timer = setTimeout(() => setTypeQuery(type.trim().toLowerCase()), 400);
    return () => clearTimeout(timer);
  }, [type]);

  /** โหลด event ตามตัวกรอง — เฉพาะคำขอล่าสุดเท่านั้นที่เขียน state ได้ */
  const load = useCallback(async () => {
    const reqId = ++reqRef.current;
    setLoading(true);
    try {
      const q = new URLSearchParams({ from: `${day}T00:00:00+07:00`, to: `${nextDay(day)}T00:00:00+07:00`, limit: '500' });
      if (cameraId) q.set('cameraId', cameraId);
      if (edgeNode) q.set('edgeNode', edgeNode);
      if (group) q.set('group', group);
      if (typeQuery) q.set('type', typeQuery);
      if (label) q.set('label', label);
      if (origin) q.set('origin', origin);
      const res = await apiFetch(`/api/ai/events?${q}`);
      const body = await res.json().catch(() => ({}));
      if (reqId !== reqRef.current) return;
      if (!res.ok) throw new Error(body.error || `โหลด event ไม่สำเร็จ (${res.status})`);
      setEvents(body.events || []);
      setError(null);
    } catch (err) {
      if (reqId === reqRef.current) setError(err.message);
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [day, cameraId, typeQuery, label, origin, edgeNode, group]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const types = useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const openIndex = useMemo(() => {
    const i = events.findIndex((e) => e.seq === openSeq);
    return i < 0 ? null : i;
  }, [events, openSeq]);


  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl tracking-tight">AI Events</h2>
          <p className="mt-1 text-sm text-muted-foreground">ผลตรวจจับจากกล้อง / NVR / VMS / API ภายนอก</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={load} disabled={loading}>
          <RefreshCw className="size-3.5" /> รีเฟรช
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="ที่มาของ event" value={origin} onChange={(e) => setOrigin(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">ทุกแหล่ง</option>
          {Object.entries(ORIGIN_LABEL).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        </select>
        <Input type="date" value={day} max={todayBangkok()} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-40" />
        <select aria-label="Edge" value={edgeNode} onChange={(e) => { setEdgeNode(e.target.value); setGroup(''); setCameraId(''); }} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">ทุก Edge</option>
          {edgeNodes.map((node) => <option key={node} value={node}>Edge {node.padStart(3, '0')}</option>)}
        </select>
        <select aria-label="กลุ่ม" value={group} onChange={(e) => { setGroup(e.target.value); setCameraId(''); }} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">ทุกกลุ่ม</option>
          {groups.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <select aria-label="กล้อง" value={cameraId} onChange={(e) => setCameraId(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">ทุกกล้อง</option>
          {filteredCameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="ชนิด เช่น intrusion" list="ai-event-types" className="w-48" />
        <datalist id="ai-event-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
        <select value={label} onChange={(e) => setLabel(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
          <option value="">ทุกวัตถุ</option>
          {Object.entries(LABEL_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">{events.length} รายการ{events.length >= 500 ? ' (แสดง 500 ล่าสุด)' : ''}</span>
      </div>

      {error && <p className="border border-status-crit px-3 py-2 text-sm text-status-crit">{error}</p>}

      <div className="overflow-hidden rounded-md border">
        {events.map((e) => (
          <div key={e.seq} role="button" tabIndex={0} onClick={() => setOpenSeq(e.seq)}
            onKeyDown={(k) => { if (k.key === 'Enter') setOpenSeq(e.seq); }}
            className="flex cursor-pointer items-center gap-4 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/50">
            {e.hasSnapshot ? <Thumb seq={e.seq} /> : <div className="h-14 w-24 shrink-0 rounded-sm bg-muted" />}
            <div className="w-20 shrink-0 font-mono tabular-nums">{e.ts.slice(11, 19)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.type}</span>
                {e.label && <Badge variant="secondary" className="text-[10px]">{LABEL_TH[e.label] || e.label}</Badge>}
                {e.attrs?.direction && <span className="text-xs text-muted-foreground">ทิศ {e.attrs.direction}</span>}
                {e.rule && <span className="text-xs text-muted-foreground">{e.rule}</span>}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {e.cameraName || e.cameraId} · {ORIGIN_LABEL[e.origin] || e.origin}{e.trackId ? ` · track ${e.trackId}` : ''}
              </div>
            </div>
            {onOpenPlayback && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" title="เปิดภาพย้อนหลัง ณ เวลานี้"
                onClick={(ev) => { ev.stopPropagation(); onOpenPlayback(e.cameraId, Date.parse(e.ts) - 10_000); }}>
                <History className="size-3.5" /> ย้อนหลัง
              </Button>
            )}
          </div>
        ))}
        {!events.length && !loading && <div className="py-12 text-center text-sm text-muted-foreground">ไม่มี event ในวันนี้</div>}
      </div>

      <AiEventDialog events={events} index={openIndex} labelTh={LABEL_TH} originLabel={ORIGIN_LABEL} onOpenPlayback={onOpenPlayback}
        onIndexChange={(i) => setOpenSeq(i == null ? null : events[i]?.seq ?? null)} />
    </div>
  );
}
