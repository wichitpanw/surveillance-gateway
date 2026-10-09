import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Globe, RefreshCw, ExternalLink, Video, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn, formatThaiDateTime } from '@/lib/utils';
import PinMap from './PinMap';
import LiveModal from './modals/LiveModal';

/** สีของกล้อง public — ม่วงทั้งชุด ให้แยกจากกล้องของเรา (เขียว/แดง/เหลือง) ได้ทันทีที่เห็น */
const PUBLIC_COLORS = { online: '#7c3aed', mixed: '#a78bfa', offline: '#6b7280' };

const hasPin = (cam) => Number.isFinite(parseFloat(cam?.lat)) && Number.isFinite(parseFloat(cam?.lng));
const REFRESH_MS = 30000;

/*
  Public Cam Map — กล้องสาธารณะที่ Central ดึงจาก API ของหน่วยงานเอง (server/vms/public-cams.js)

  รายชื่อ/พิกัด/สถานะมาจากหน่วยงานทุก 5 นาที แก้ที่นี่ไม่ได้ · ใครเห็นหน้านี้ (menu.publiccam) ดูภาพได้ทุกตัว
  ส่วน client ภายนอกเห็นกล้องชุดนี้เมื่อ API key ติ๊ก "กล้อง Public" ที่หน้า API Clients
*/
export default function PublicCamMap({ theme, canSync = false }) {
  const [data, setData] = useState({ sources: [], cameras: [] });
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState(null);
  const [picked, setPicked] = useState([]);
  const [liveCam, setLiveCam] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/public-cams');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `โหลดกล้อง Public ไม่สำเร็จ (${res.status})`);
      setData(body);
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/public-cams/sync', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ซิงก์ไม่สำเร็จ');
      await load();
      toast({ title: 'ซิงก์กล้อง Public แล้ว' });
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setSyncing(false);
    }
  };

  const cameras = data.cameras || [];
  const sourceOf = useMemo(() => new Map((data.sources || []).map((s) => [s.key, s])), [data.sources]);
  const q = search.trim().toLowerCase();
  const match = (c) => !q || `${c.name || ''} ${c.global_id || ''} ${c.group_name || ''}`.toLowerCase().includes(q);
  const active = cameras.filter((c) => !c.missing);
  const shown = active.filter(hasPin).filter(match);
  const onlineCount = active.filter((c) => c.online === true).length;
  const missingCount = cameras.length - active.length;

  // ม่วงเข้ม = ออนไลน์ทุกตัวในกอง, ม่วงอ่อน = ปนกัน, เทา = ไม่มีตัวไหนออนไลน์ (หรือหน่วยงานยังไม่รายงาน)
  const markerColor = useCallback((cams) => {
    const on = cams.filter((c) => c.online === true).length;
    if (on === cams.length) return PUBLIC_COLORS.online;
    if (on === 0) return PUBLIC_COLORS.offline;
    return PUBLIC_COLORS.mixed;
  }, []);

  const pickedCams = cameras.filter((c) => picked.includes(c.id));
  const dot = (c) => (c.online === true ? 'bg-violet-600' : 'bg-muted-foreground/50');
  const creditOf = (c) => sourceOf.get(c.source)?.credit || c.source;

  return (
    <div className="space-y-6">
      <div className="stagger-in flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl tracking-tight"><Globe className="size-6 text-violet-600" /> Public Cam Map</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            กล้องสาธารณะของหน่วยงานรัฐที่ Central ดึงมาเอง — รายชื่อ พิกัด และสถานะอัปเดตจากหน่วยงานทุก 5 นาที
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="gap-1.5 px-3 py-1">
            <span className="size-2 rounded-full" style={{ background: PUBLIC_COLORS.online }} /> ออนไลน์ {onlineCount}/{active.length}
          </Badge>
          {missingCount > 0 && (
            <Badge variant="outline" className="gap-1.5 px-3 py-1" title="หายจาก API ของหน่วยงาน — ถอดออกจากระบบดึงภาพแล้ว กลับมาเมื่อหน่วยงานเปิดอีกครั้ง">
              <AlertTriangle className="size-3.5" /> หายจากต้นทาง {missingCount}
            </Badge>
          )}
          {canSync && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleSync} disabled={syncing}>
              <RefreshCw className={cn('size-4', syncing && 'animate-spin')} /> ซิงก์ตอนนี้
            </Button>
          )}
        </div>
      </div>

      {/* แหล่งข้อมูล + เครดิต — ภาพเป็นของหน่วยงานต้นทาง ต้องบอกที่มาทุกครั้ง */}
      <div className="stagger-in flex flex-wrap gap-3" style={{ '--i': 1 }}>
        {(data.sources || []).map((s) => (
          <div key={s.key} className="flex min-w-[260px] flex-1 flex-col gap-1 rounded-md border bg-card px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{s.label}</span>
              <Badge variant="secondary" className="text-[10px]">{s.count || 0} กล้อง</Badge>
            </div>
            <a href={s.pageUrl} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              ที่มา: {s.credit} <ExternalLink className="size-3" />
            </a>
            <div className="text-[11px] text-muted-foreground">
              ซิงก์ล่าสุด {s.lastSyncAt ? formatThaiDateTime(s.lastSyncAt) : '—'}
              {s.lastError && <span className="ml-2 text-destructive">ครั้งล่าสุดล้มเหลว: {s.lastError}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        <div className="stagger-in flex h-[64svh] min-h-[420px] flex-col rounded-md border bg-card" style={{ '--i': 2 }}>
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ / global ID / กลุ่ม" className="pl-9 text-sm" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {cameras.filter(match).map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={c.missing || !hasPin(c)}
                onClick={() => { setPicked([c.id]); setFocus({ lat: parseFloat(c.lat), lng: parseFloat(c.lng), key: `${c.id}-${Date.now()}` }); }}
                className={cn('flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:opacity-60',
                  picked.includes(c.id) && 'bg-muted')}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot(c))} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {c.global_id || c.id}{c.missing ? ' · หายจากต้นทาง' : !hasPin(c) ? ' · ไม่มีพิกัด' : ''}
                  </div>
                </div>
              </button>
            ))}
            {loaded && !cameras.filter(match).length && (
              <div className="py-14 text-center text-sm text-muted-foreground">{cameras.length ? 'ไม่พบกล้องตามคำค้น' : 'ยังไม่มีกล้อง Public — รอซิงก์รอบแรก'}</div>
            )}
          </div>
        </div>

        <div className="stagger-in relative h-[64svh] min-h-[420px] overflow-hidden rounded-md border bg-card" style={{ '--i': 3 }}>
          <PinMap
            cameras={shown}
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
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot(c))} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {c.global_id || c.id} · {parseFloat(c.lat).toFixed(5)}, {parseFloat(c.lng).toFixed(5)}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">ที่มา: {creditOf(c)}</div>
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
      <LiveModal
        camera={liveCam}
        open={Boolean(liveCam)}
        onClose={() => setLiveCam(null)}
        showPtz={false}
        description={liveCam ? `ภาพสดจาก ${creditOf(liveCam)} ผ่าน Gateway — ไม่มีเสียง` : null}
      />
    </div>
  );
}
