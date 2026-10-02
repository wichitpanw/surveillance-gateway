import { useCallback, useMemo, useState } from 'react';
import { Search, MapPin, MapPinOff, Server, Video } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import PinMap from './PinMap';
import LiveModal from './modals/LiveModal';

const hasPin = (cam) => Number.isFinite(parseFloat(cam?.lat)) && Number.isFinite(parseFloat(cam?.lng));
const edgeOf = (cam) => (cam.type === 'edge_relay' ? String(cam.id).split('_')[2] || '' : '');

/*
  Camera Map ของ central — แสดงว่ากล้องอยู่ที่ไหน ไม่มีการปักหมุด

  พิกัดเป็นของ edge: ปักที่หน้า Map Pins ของ edge แล้ว central รับมาตอน sync (ทุก 10 นาที)
  API ปักหมุดที่ central ตอบ 403 จึงไม่มีปุ่มแก้ตรงนี้เลย กล้องที่ยังไม่มีพิกัดแสดงเป็นรายการแยก
  พร้อมบอกว่าต้องไปปักที่ edge ไหน
*/
export default function CameraMap({ cameras = [], cameraStatus = {}, theme }) {
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState(null);
  const [picked, setPicked] = useState([]);
  const [liveCam, setLiveCam] = useState(null);

  const q = search.trim().toLowerCase();
  const match = useCallback(
    (c) => !q || `${c.name || ''} ${c.global_id || ''} ${c.group_name || ''}`.toLowerCase().includes(q),
    [q],
  );
  const pinned = useMemo(() => cameras.filter(hasPin), [cameras]);
  const unpinned = useMemo(() => cameras.filter((c) => !hasPin(c)), [cameras]);
  const shownPinned = pinned.filter(match);
  const shownUnpinned = unpinned.filter(match);

  // สีหมุด: เขียว = ออนไลน์ทุกตัวในกอง, แดง = ไม่มีตัวไหนออนไลน์, เหลือง = ปนกัน
  const markerColor = useCallback((cams) => {
    const on = cams.filter((c) => cameraStatus[c.id] === 'online').length;
    if (on === cams.length) return '#16a34a';
    if (on === 0) return '#dc2626';
    return '#d97706';
  }, [cameraStatus]);

  const pickedCams = cameras.filter((c) => picked.includes(c.id));

  return (
    <div className="space-y-6">
      <div className="stagger-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl tracking-tight">Camera Map</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            ตำแหน่งกล้องจากทุก edge — ปักหรือแก้ตำแหน่งที่หน้า Map Pins ของ edge แล้วจะอัปเดตมาเองทุก 10 นาที
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <Badge variant="outline" className="gap-1.5 px-3 py-1"><MapPin className="size-3.5" /> มีพิกัด {pinned.length}</Badge>
          <Badge variant="outline" className="gap-1.5 px-3 py-1"><MapPinOff className="size-3.5" /> ยังไม่มีพิกัด {unpinned.length}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        <div className="stagger-in flex h-[68svh] min-h-[420px] flex-col rounded-md border bg-card" style={{ '--i': 1 }}>
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ / global ID / กลุ่ม" className="pl-9 text-sm" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {shownPinned.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setPicked([c.id]); setFocus({ lat: parseFloat(c.lat), lng: parseFloat(c.lng), key: `${c.id}-${Date.now()}` }); }}
                className={cn('flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50', picked.includes(c.id) && 'bg-muted')}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', cameraStatus[c.id] === 'online' ? 'bg-status-ok' : 'bg-status-crit')} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{c.global_id || c.id}{edgeOf(c) && ` · edge ${edgeOf(c)}`}</div>
                </div>
              </button>
            ))}
            {shownUnpinned.length > 0 && (
              <div className="bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">ยังไม่มีพิกัด — ปักที่ edge</div>
            )}
            {shownUnpinned.map((c) => (
              <div key={c.id} className="flex items-start gap-3 border-b px-4 py-3 opacity-70">
                <MapPinOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm">{c.name}</div>
                  <div className="flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
                    {edgeOf(c) ? <><Server className="size-3" /> edge {edgeOf(c)}</> : (c.global_id || c.id)}
                  </div>
                </div>
              </div>
            ))}
            {!shownPinned.length && !shownUnpinned.length && (
              <div className="py-14 text-center text-sm text-muted-foreground">{cameras.length ? 'ไม่พบกล้องตามคำค้น' : 'ยังไม่มีกล้อง — เพิ่ม edge ที่หน้า Edge Nodes'}</div>
            )}
          </div>
        </div>

        <div className="stagger-in relative h-[68svh] min-h-[420px] overflow-hidden rounded-md border bg-card" style={{ '--i': 2 }}>
          <PinMap
            cameras={shownPinned}
            selectedIds={picked}
            theme={theme}
            readOnly
            fit
            focus={focus}
            markerColor={markerColor}
            onPickGroup={(ids) => setPicked(ids)}
          />
          {pickedCams.length > 0 && (
            <div className="absolute bottom-3 left-3 z-10 max-w-sm rounded-md border bg-card/95 p-3 text-sm shadow-lg backdrop-blur animate-in fade-in slide-in-from-bottom-2 duration-200">
              {pickedCams.map((c) => (
                <div key={c.id} className="flex items-start gap-2 py-1">
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', cameraStatus[c.id] === 'online' ? 'bg-status-ok' : 'bg-status-crit')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {c.global_id || c.id}{edgeOf(c) && ` · edge ${edgeOf(c)}`} · {parseFloat(c.lat).toFixed(5)}, {parseFloat(c.lng).toFixed(5)}
                    </div>
                  </div>
                  <button type="button" title="ดูภาพสด" onClick={() => setLiveCam(c)}
                    className="shrink-0 rounded-md border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    <Video className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <LiveModal camera={liveCam} open={Boolean(liveCam)} onClose={() => setLiveCam(null)} />
    </div>
  );
}
