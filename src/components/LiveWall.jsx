import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Maximize2, LayoutGrid, Trash2, ChevronRight, ListPlus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import LivePlayer from '@/components/live/LivePlayer';
import LiveModal from '@/components/modals/LiveModal';

const LAYOUTS = [1, 4, 9, 16];
const STORAGE_KEY = 'sgw.liveWall.v1';

/** อ่านผังที่จำไว้ในเบราว์เซอร์นี้ — ห่อ try เพราะ storage อาจถูกปิด (private window ฯลฯ) */
function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && LAYOUTS.includes(raw.layout) && Array.isArray(raw.cells)) return raw;
  } catch { /* ใช้ค่าเริ่มต้น */ }
  return { layout: 4, cells: [] };
}

/*
  Live Wall — ภาพสดหลายกล้องพร้อมกันบนเว็บ (1 / 4 / 9 / 16 ช่อง)

  ทุกช่องใช้ sub stream: 16 ช่อง main คือ transcode 1080p สิบหกตัวบน GPU ของเครื่องนี้ต่อผู้ชมหนึ่งคน
  ดับเบิลคลิกช่องเพื่อเปิด main + PTZ ใน LiveModal · ผังจำต่อเบราว์เซอร์ (localStorage) ไม่ใช่ต่อบัญชี
  เพราะจอแต่ละเครื่องจัดต่างกัน · กล้องที่ปิดใช้งานไม่อยู่ในรายการ
*/
export default function LiveWall({ cameras = [], cameraStatus = {} }) {
  const [saved] = useState(loadSaved);
  const [layout, setLayout] = useState(saved.layout);
  const [cells, setCells] = useState(() => Array.from({ length: 16 }, (_, i) => saved.cells[i] || null));
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [modalCam, setModalCam] = useState(null);
  const wallRef = useRef(null);
  const [wallMaxWidth, setWallMaxWidth] = useState(null);

  /*
    ให้ wall ทั้งก้อนพอดีจอ: ความสูงที่เหลือจริง (วัดจากขอบบนของ wall ถึงล่างจอ) → ความกว้างสูงสุดแบบ 16:9
    วัดจากหน้าจอจริงทุกครั้งที่ย่อ/ขยาย แทนการเดาความสูงของ header เป็นเลขตายตัว (AGENTS.md ข้อ h-[calc])
  */
  useEffect(() => {
    const fit = () => {
      const el = wallRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const avail = window.innerHeight - top - 24;
      setWallMaxWidth(avail > 200 ? Math.floor(avail * 16 / 9) : null);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // กล้องที่หายจาก edge ไม่มีภาพให้ดึงแล้ว (go2rtc ถอดออก) — ไม่ให้เลือกลงช่อง
  const usable = useMemo(() => cameras.filter((c) => cameraStatus[c.id] !== 'disabled' && !c.source_missing_at), [cameras, cameraStatus]);
  const byId = useMemo(() => new Map(usable.map((c) => [c.id, c])), [usable]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout, cells })); } catch { /* ไม่จำก็ยังใช้งานได้ */ }
  }, [layout, cells]);

  const q = search.trim().toLowerCase();
  const list = usable.filter((c) => !q || `${c.name || ''} ${c.global_id || ''} ${c.group_name || ''}`.toLowerCase().includes(q));
  const shown = cells.slice(0, layout);

  // จัดกลุ่มตาม group_name แบบหน้า Playback — เริ่มพับไว้ (กล้องเป็นร้อยตัว) · ค้นหาอยู่ = กางเฉพาะกลุ่มที่มีผล
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const groups = useMemo(() => {
    const grouped = new Map();
    for (const cam of list) {
      const name = String(cam.group_name || '').trim() || 'ไม่มีกลุ่ม';
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(cam);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'th'));
  }, [list]);
  const toggleGroup = (name) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  /** ใส่กล้องทั้งกลุ่มลงช่องว่างของผังตอนนี้ (ตามลำดับ) — ตัวที่อยู่ในผังแล้วข้าม · ช่องไม่พอ = ใส่เท่าที่ได้ */
  const placeGroup = (members) => {
    setCells((prev) => {
      const next = [...prev];
      const inWall = new Set(next.slice(0, layout).filter(Boolean));
      const queue = members.map((c) => c.id).filter((id) => !inWall.has(id));
      for (let i = 0; i < layout && queue.length; i += 1) if (!next[i]) next[i] = queue.shift();
      return next;
    });
  };
  const cols = Math.sqrt(layout);

  /** ใส่กล้องลงช่อง — ช่องที่เลือกอยู่ก่อน แล้วเลื่อนไปช่องว่างถัดไป */
  const place = (cameraId, index = selected) => {
    setCells((prev) => {
      const next = [...prev];
      const existing = next.indexOf(cameraId);
      if (existing >= 0 && existing < layout) next[existing] = null; // ย้าย ไม่ใช่ซ้ำ
      next[index] = cameraId;
      return next;
    });
    const nextEmpty = shown.findIndex((id, i) => i !== index && !id);
    if (nextEmpty >= 0) setSelected(nextEmpty);
  };
  const clearCell = (index) => setCells((prev) => prev.map((id, i) => (i === index ? null : id)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl tracking-tight">Live</h2>
          <p className="mt-1 text-sm text-muted-foreground">คลิกหรือลากกล้องลงช่อง · ดับเบิลคลิกช่องเพื่อดูภาพเต็มและคุม PTZ</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border">
            {LAYOUTS.map((n) => (
              <button key={n} type="button" onClick={() => { setLayout(n); if (selected >= n) setSelected(0); }}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors', layout === n ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                <LayoutGrid className="size-3.5" /> {n}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setCells(Array(16).fill(null))}>
            <Trash2 className="size-3.5" /> ล้างผัง
          </Button>
        </div>
      </div>

      {/* ความสูงของทั้งแถวมาจาก wall (16:9 ตามความกว้าง) — รายการกล้องยืดตามแล้วเลื่อนในตัว ไม่ดันหน้าให้ยาว */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[280px_1fr]">
        <div className="flex h-[320px] flex-col rounded-md border bg-card lg:h-auto">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหากล้อง" className="pl-9 text-sm" />
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0 overflow-y-auto custom-scrollbar">
            {groups.map(([name, members]) => {
              const expanded = !!q || expandedGroups.has(name);
              const online = members.filter((c) => cameraStatus[c.id] === 'online').length;
              return (
                <div key={name} className="border-b">
                  <div className="flex items-center hover:bg-muted/50">
                    <button type="button" aria-expanded={expanded} disabled={!!q} onClick={() => toggleGroup(name)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold disabled:cursor-default">
                      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
                      <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title="online / ทั้งหมด">
                        {online}/{members.length}
                      </span>
                    </button>
                    <button type="button" title="ใส่ทั้งกลุ่มลงช่องว่างของผัง" onClick={() => placeGroup(members)}
                      className="mr-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                      <ListPlus className="size-3.5" />
                    </button>
                  </div>
                  {expanded && members.map((c) => {
                    const inWall = shown.includes(c.id);
                    return (
                      <button key={c.id} type="button" draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/camera-id', c.id)}
                        onClick={() => place(c.id)}
                        className={cn('flex w-full items-start gap-3 border-t py-2 pl-8 pr-3 text-left transition-colors hover:bg-muted/50', inWall && 'bg-muted/60')}>
                        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', cameraStatus[c.id] === 'online' ? 'bg-status-ok' : 'bg-status-crit')} />
                        <div className="min-w-0">
                          <div className="truncate text-sm">{c.name}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">{c.global_id || c.id}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!list.length && <div className="py-10 text-center text-sm text-muted-foreground">ไม่พบกล้อง</div>}
          </div>
          </div>
        </div>

        {/* ทุกช่อง 16:9 — ขนาดมาจากความกว้าง ไม่ใช่จากขนาดภาพของกล้อง (เดิมภาพดันช่องให้สูงเกินจอ) */}
        <div ref={wallRef} className="grid w-full content-start gap-1 self-start justify-self-center rounded-md border bg-black p-1"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, maxWidth: wallMaxWidth || undefined }}>
          {shown.map((id, i) => {
            const cam = id ? byId.get(id) : null;
            return (
              <div key={i}
                onClick={() => setSelected(i)}
                onDoubleClick={() => cam && setModalCam(cam)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const cid = e.dataTransfer.getData('text/camera-id'); if (cid) place(cid, i); }}
                className={cn('group relative aspect-video min-w-0 overflow-hidden rounded-sm border',
                  selected === i ? 'border-primary' : 'border-white/10')}>
                {cam ? (
                  <>
                    <LivePlayer key={cam.id} cameraId={cam.id} type="sub" fit={layout === 1 ? 'contain' : 'cover'} className="absolute inset-0" />
                    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 py-1.5">
                      <span className={cn('size-1.5 shrink-0 rounded-full', cameraStatus[cam.id] === 'online' ? 'bg-status-ok' : 'bg-status-crit')} />
                      <span className="truncate text-[11px] text-white">{cam.name}</span>
                    </div>
                    <div className="absolute right-1.5 top-1.5 hidden gap-1 group-hover:flex">
                      <button type="button" title="ภาพเต็ม + PTZ" onClick={(e) => { e.stopPropagation(); setModalCam(cam); }}
                        className="rounded bg-black/70 p-1 text-white hover:bg-black"><Maximize2 className="size-3.5" /></button>
                      <button type="button" title="เอาออกจากช่อง" onClick={(e) => { e.stopPropagation(); clearCell(i); }}
                        className="rounded bg-black/70 p-1 text-white hover:bg-black"><X className="size-3.5" /></button>
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[11px] text-white/30">
                    {id ? 'กล้องนี้ไม่อยู่ในสิทธิ์หรือถูกปิดใช้งาน' : selected === i ? 'เลือกกล้องจากรายการ' : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <LiveModal camera={modalCam} open={Boolean(modalCam)} onClose={() => setModalCam(null)} />
    </div>
  );
}
