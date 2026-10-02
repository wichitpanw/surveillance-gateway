import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Pentagon, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch, getAuthHeaders } from '@/lib/api';
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';
import { cn } from '@/lib/utils';
import useFitToViewport from '@/lib/useFitToViewport';

const MAIN_CLASSES = ['person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck'];
const CLASS_TH = { person: 'คน', car: 'รถยนต์', motorcycle: 'จักรยานยนต์', bicycle: 'จักรยาน', bus: 'รถบัส', truck: 'รถบรรทุก' };
const COLORS = ['#f59e0b', '#22d3ee', '#a3e635', '#f472b6', '#818cf8', '#fb7185'];

/** สวิตช์เปิด/ปิด */
function Toggle({ on, onChange, disabled, title }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} title={title}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40',
        on ? 'border-primary bg-primary' : 'bg-muted')}>
      <span className={cn('inline-block size-3.5 rounded-full bg-background shadow transition-transform', on ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
    </button>
  );
}

/*
  AI Rules — ตั้ง AI บน GPU ของ edge (server/gateway/ai-config.js, ai-worker/)

  เปิด AI รายกล้อง แล้ววาดกฎบนภาพนิ่งของกล้อง: เส้น (คลิก 2 จุด) นับข้ามเส้น · โซน (คลิกหลายจุด แล้วกด "จบโซน")
  แจ้งเตือนเมื่อมีวัตถุเข้า/อยู่นานเกิน · พิกัดเก็บเป็นสัดส่วน 0–1 ใช้ได้ทุกความละเอียด
  "บันทึกทุกวัตถุ" = ai-worker ส่ง event `object` ทุกคน/รถที่ผ่าน ใช้ค้นย้อนหลังที่ central
*/
export default function AiRules({ canManage = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null); // { aiEnabled, objects, rules } ของกล้องที่เลือก
  const [dirty, setDirty] = useState(false);
  const [drawing, setDrawing] = useState(null); // { type, points }
  const [snapshot, setSnapshot] = useState(null);
  const [snapError, setSnapError] = useState(null);
  const [saving, setSaving] = useState(false);
  const svgRef = useRef(null);
  // ภาพต้องอยู่ในจอทั้งภาพ (จอ 1080p ภาพ 4:3 เต็มความกว้างล้นจอ) — กว้างสุดตามความสูงที่เหลือ × สัดส่วนภาพจริง
  const imgBoxRef = useRef(null);
  const [imgAspect, setImgAspect] = useState(16 / 9);
  const imgMaxWidth = useFitToViewport(imgBoxRef, imgAspect);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/config');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `โหลดค่า AI ไม่สำเร็จ (${res.status})`);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cameras = useMemo(() => data?.cameras || [], [data]);
  const selected = cameras.find((c) => c.id === selectedId) || null;

  const select = async (cam) => {
    if (dirty && selected) {
      const ok = await appConfirm({ title: 'ยังไม่ได้บันทึก', description: `ทิ้งการแก้ไขกฎของ ${selected.name}?`,
        confirmText: 'ทิ้ง', cancelText: 'กลับไปแก้ต่อ' });
      if (!ok) return;
    }
    setSelectedId(cam.id);
    setDraft({ aiEnabled: cam.aiEnabled, objects: cam.objects, rules: cam.rules.map((r) => ({ ...r, points: r.points.map((p) => [...p]) })) });
    setDirty(false);
    setDrawing(null);
  };

  // ภาพนิ่งของกล้องที่เลือก — endpoint อยู่หลัง checkAuth จึง fetch แล้วแปลงเป็น blob
  const [snapTick, setSnapTick] = useState(0);
  useEffect(() => {
    if (!selectedId) return undefined;
    let created = null;
    let cancelled = false;
    setSnapshot(null);
    setSnapError(null);
    apiFetch(`/api/cameras/${encodeURIComponent(selectedId)}/snapshot`, { headers: getAuthHeaders() })
      .then(async (r) => (r.ok ? r.blob() : Promise.reject(new Error((await r.json().catch(() => null))?.error || `จับภาพไม่ได้ (${r.status})`))))
      .then((b) => { if (!cancelled) { created = URL.createObjectURL(b); setSnapshot(created); } })
      .catch((e) => { if (!cancelled) setSnapError(e.message); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [selectedId, snapTick]);

  const change = (patch) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); };
  const changeRule = (i, patch) => change({ rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const pointFromEvent = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  };

  const addRule = (type, points) => {
    const n = draft.rules.filter((r) => r.type === type).length + 1;
    change({ rules: [...draft.rules, {
      id: `r_${Math.random().toString(36).slice(2, 10)}`, type, name: type === 'line' ? `เส้น ${n}` : `โซน ${n}`,
      points, classes: ['person'], direction: type === 'line' ? 'any' : null, dwellSec: 0, enabled: true,
    }] });
  };

  const onCanvasClick = (e) => {
    if (!drawing) return;
    const pts = [...drawing.points, pointFromEvent(e)];
    if (drawing.type === 'line' && pts.length === 2) {
      addRule('line', pts);
      setDrawing(null);
      return;
    }
    setDrawing({ ...drawing, points: pts });
  };

  const finishZone = () => {
    if (drawing?.type !== 'zone') return;
    if (drawing.points.length < 3) {
      toast({ title: 'โซนต้องมีอย่างน้อย 3 จุด', variant: 'destructive' });
      return;
    }
    addRule('zone', drawing.points);
    setDrawing(null);
  };

  const save = async (override) => {
    if (!selected) return;
    const body = override || draft;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/ai/cameras/${encodeURIComponent(selected.id)}`, { method: 'PUT', body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'บันทึกไม่สำเร็จ');
      toast({ title: 'บันทึกค่า AI แล้ว — ai-worker รับค่าใหม่ภายใน 30 วินาที' });
      setDirty(false);
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const quickToggle = async (cam, on) => {
    try {
      const res = await apiFetch(`/api/ai/cameras/${encodeURIComponent(cam.id)}`, { method: 'PUT', body: JSON.stringify({ aiEnabled: on }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'เปลี่ยนไม่สำเร็จ');
      if (cam.id === selectedId) setDraft((d) => ({ ...d, aiEnabled: on }));
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    }
  };

  const toSvg = (pts) => pts.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl tracking-tight">AI Rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">AI บน GPU ของ edge · เปิดรายกล้อง แล้ววาดเส้นนับ/โซนเฝ้าบนภาพ · event ส่งขึ้น central</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={load}><RefreshCw className="size-3.5" /> รีเฟรช</Button>
      </div>

      {error && <p className="border border-status-crit px-3 py-2 text-sm text-status-crit">{error}</p>}
      {data && !data.workerEnabled && (
        <p className="border border-status-warn px-3 py-2 text-sm text-muted-foreground">
          เครื่องนี้ยังไม่ได้เปิด ai-worker — ใส่ <code>"aiWorker": true</code> ใน edge.json แล้วเปิด gateway ใหม่ · ตั้งกฎไว้ล่วงหน้าได้
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="flex h-[320px] flex-col rounded-md border bg-card lg:h-auto">
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0 overflow-y-auto custom-scrollbar">
              {cameras.map((c) => (
                <div key={c.id} role="button" tabIndex={0} onClick={() => select(c)} onKeyDown={(e) => e.key === 'Enter' && select(c)}
                  className={cn('flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 hover:bg-muted/50', selectedId === c.id && 'bg-muted/60')}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{c.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{c.group || 'ไม่มีกลุ่ม'} · กฎ {c.rules.length} ข้อ</div>
                  </div>
                  <Toggle on={c.aiEnabled} disabled={!canManage || !c.cameraEnabled} title="เปิด/ปิด AI กล้องนี้" onChange={(v) => quickToggle(c, v)} />
                </div>
              ))}
              {data && !cameras.length && <div className="py-10 text-center text-sm text-muted-foreground">ยังไม่มีกล้อง</div>}
            </div>
          </div>
        </div>

        {!selected || !draft ? (
          <div className="flex min-h-[320px] items-center justify-center rounded-md border text-sm text-muted-foreground">เลือกกล้องทางซ้าย</div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-semibold">{selected.name}</span>
              <label className="flex items-center gap-2"><Toggle on={draft.aiEnabled} disabled={!canManage} onChange={(v) => change({ aiEnabled: v })} /> เปิด AI</label>
              <label className="flex items-center gap-2" title="ส่ง event object ทุกคน/รถที่ผ่าน ใช้ค้นย้อนหลังที่ central">
                <Toggle on={draft.objects} disabled={!canManage} onChange={(v) => change({ objects: v })} /> บันทึกทุกวัตถุ (ค้นย้อนหลัง)
              </label>
              <div className="ml-auto flex items-center gap-2">
                {canManage && (
                  <>
                    <Button variant={drawing?.type === 'line' ? 'default' : 'outline'} size="sm" className="gap-1.5"
                      onClick={() => setDrawing(drawing?.type === 'line' ? null : { type: 'line', points: [] })}>
                      <Minus className="size-3.5" /> เพิ่มเส้น
                    </Button>
                    <Button variant={drawing?.type === 'zone' ? 'default' : 'outline'} size="sm" className="gap-1.5"
                      onClick={() => setDrawing(drawing?.type === 'zone' ? null : { type: 'zone', points: [] })}>
                      <Pentagon className="size-3.5" /> เพิ่มโซน
                    </Button>
                    {drawing?.type === 'zone' && <Button size="sm" onClick={finishZone}>จบโซน ({drawing.points.length} จุด)</Button>}
                    <Button size="sm" className="gap-1.5" disabled={!dirty || saving} onClick={() => save()}>
                      <Save className="size-3.5" /> บันทึก
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="icon" title="จับภาพใหม่" onClick={() => setSnapTick((n) => n + 1)}><RefreshCw className="size-4" /></Button>
              </div>
            </div>
            {drawing && (
              <p className="text-xs text-muted-foreground">
                {drawing.type === 'line' ? 'คลิกจุด A แล้วจุด B บนภาพ — ab คือข้ามจากซ้ายไปขวาเมื่อมองจาก A ไป B' : 'คลิกมุมของโซนทีละจุด แล้วกด "จบโซน"'}
              </p>
            )}

            {/* ภาพกับรายการกฎวางข้างกันเมื่อที่พอ (ภาพถูกจำกัดกว้างตามความสูงจอ) ไม่พอ = รายการลงไปข้างล่าง */}
            <div className="flex flex-wrap items-start gap-4">
            <div ref={imgBoxRef} className="relative w-full overflow-hidden rounded-md border bg-black" style={{ maxWidth: imgMaxWidth || undefined }}>
              {snapshot
                ? <img src={snapshot} alt="" className="block w-full select-none" draggable={false}
                    onLoad={(e) => { const { naturalWidth: w, naturalHeight: h } = e.currentTarget; if (w && h) setImgAspect(w / h); }} />
                : <div className="flex aspect-video items-center justify-center text-sm text-white/60">{snapError || 'กำลังจับภาพ…'}</div>}
              <svg ref={svgRef} viewBox="0 0 1000 1000" preserveAspectRatio="none" onClick={onCanvasClick}
                className={cn('absolute inset-0 size-full', drawing && 'cursor-crosshair')}>
                {draft.rules.map((r, i) => {
                  const c = COLORS[i % COLORS.length];
                  const [a, b] = r.points;
                  return r.type === 'line' ? (
                    <g key={r.id} opacity={r.enabled ? 1 : 0.4}>
                      <line x1={a[0] * 1000} y1={a[1] * 1000} x2={b[0] * 1000} y2={b[1] * 1000} stroke={c} strokeWidth="4" vectorEffect="non-scaling-stroke" />
                      <text x={a[0] * 1000} y={a[1] * 1000 - 8} fill={c} fontSize="28">A {r.name}</text>
                      <text x={b[0] * 1000} y={b[1] * 1000 - 8} fill={c} fontSize="28">B</text>
                    </g>
                  ) : (
                    <g key={r.id} opacity={r.enabled ? 1 : 0.4}>
                      <polygon points={toSvg(r.points)} fill={c} fillOpacity="0.18" stroke={c} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                      <text x={a[0] * 1000 + 6} y={a[1] * 1000 + 30} fill={c} fontSize="28">{r.name}</text>
                    </g>
                  );
                })}
                {drawing && drawing.points.length > 0 && (
                  <polyline points={toSvg(drawing.points)} fill="none" stroke="#fff" strokeDasharray="8 6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                )}
                {drawing?.points.map(([x, y], i) => <circle key={i} cx={x * 1000} cy={y * 1000} r="7" fill="#fff" />)}
              </svg>
            </div>

            <div className="min-w-[300px] flex-1 space-y-2">
              {draft.rules.map((r, i) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
                  <span className="size-3 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="w-10 text-xs text-muted-foreground">{r.type === 'line' ? 'เส้น' : 'โซน'}</span>
                  <Input value={r.name} disabled={!canManage} onChange={(e) => changeRule(i, { name: e.target.value })} className="h-8 w-40" />
                  <div className="flex flex-wrap gap-1">
                    {MAIN_CLASSES.map((cls) => (
                      <button key={cls} type="button" disabled={!canManage}
                        onClick={() => changeRule(i, { classes: r.classes.includes(cls) ? r.classes.filter((x) => x !== cls) : [...r.classes, cls] })}
                        className={cn('h-7 rounded-sm border px-2 text-xs', r.classes.includes(cls) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                        {CLASS_TH[cls]}
                      </button>
                    ))}
                  </div>
                  {r.type === 'line' ? (
                    <select value={r.direction || 'any'} disabled={!canManage} onChange={(e) => changeRule(i, { direction: e.target.value })}
                      className="h-8 rounded-md border bg-background px-2 text-xs">
                      <option value="any">ทั้งสองทิศ</option>
                      <option value="ab">ซ้าย → ขวา (ab)</option>
                      <option value="ba">ขวา → ซ้าย (ba)</option>
                    </select>
                  ) : (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="0 = แจ้งเฉพาะตอนเข้าโซน">
                      อยู่นานเกิน
                      <Input type="number" min={0} max={3600} value={r.dwellSec || 0} disabled={!canManage}
                        onChange={(e) => changeRule(i, { dwellSec: Number(e.target.value) || 0 })} className="h-8 w-20" />
                      วิ
                    </label>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <Toggle on={r.enabled} disabled={!canManage} title="เปิด/ปิดกฎนี้" onChange={(v) => changeRule(i, { enabled: v })} />
                    {canManage && (
                      <Button variant="ghost" size="icon" className="size-8" title="ลบกฎ"
                        onClick={() => change({ rules: draft.rules.filter((_, j) => j !== i) })}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {!draft.rules.length && (
                <p className="text-xs text-muted-foreground">
                  ยังไม่มีกฎ — {draft.objects ? 'AI จะบันทึกคน/รถทุกตัวที่ผ่านไว้ค้นย้อนหลังอย่างเดียว' : 'เปิด "บันทึกทุกวัตถุ" หรือเพิ่มเส้น/โซน'}
                </p>
              )}
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
