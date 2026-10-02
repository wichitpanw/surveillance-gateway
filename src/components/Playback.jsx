import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Play, Download, SkipBack, SkipForward, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import useFitToViewport from '@/lib/useFitToViewport';

/** ความยาวต่อคำขอ — จบแล้วขอช่วงถัดไปต่อเอง (server จำกัด 3600 วิ) */
const CHUNK_SECONDS = 600;
const DAY_SECONDS = 86_400;
const BANGKOK_MS = 7 * 3600_000;

/** วันนี้ตามปฏิทินกรุงเทพ — ไม่พึ่งเขตเวลาของเครื่องที่เปิดเว็บ */
const todayBangkok = () => new Date(Date.now() + BANGKOK_MS).toISOString().slice(0, 10);
const dayStartMs = (day) => Date.parse(`${day}T00:00:00+07:00`);
/** ms → `HH:MM:SS` เวลากรุงเทพ */
const clock = (ms) => new Date(ms + BANGKOK_MS).toISOString().slice(11, 19);
/** ms → ISO-8601 +07:00 (รูปแบบเดียวกับ server/shared/time.js) */
const isoBangkok = (ms) => new Date(ms + BANGKOK_MS).toISOString().replace('Z', '+07:00');

/*
  Playback — ดูภาพย้อนหลังจากแหล่งภาพที่ edge (server/gateway/playback.js) ผ่าน central · กล้องที่ยังไม่รองรับขึ้นข้อความจาก server

  เลือกกล้อง → วัน → คลิกบนแถบเวลา 24 ชม. (ช่วงที่มีภาพเป็นแถบทึบ) · วิดีโอมาจาก /playback/<id>.mp4 ด้วย token
  (แท็ก <video> ส่ง header ไม่ได้) และแปลงเป็น H.264 ที่ edge เสมอ · ขอทีละ 10 นาทีแล้วต่อช่วงถัดไปเอง
*/
/**
 * @param {object} props
 * @param {Array} props.cameras
 * @param {{cameraId: string, ms: number}|null} [props.target]  เปิดมาจากหน้าอื่น (AI Events) — เลือกกล้องและเล่นที่เวลานี้
 * @param {() => void} [props.onTargetUsed]
 */
export default function Playback({ cameras = [], target = null, onTargetUsed }) {
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [camera, setCamera] = useState(null);
  const [day, setDay] = useState(todayBangkok);
  const [ranges, setRanges] = useState([]);
  const [rangeError, setRangeError] = useState(null);
  const [loadingRanges, setLoadingRanges] = useState(false);
  const [src, setSrc] = useState(null);
  const [playStart, setPlayStart] = useState(null); // ms ของเฟรมแรกในวิดีโอที่เล่นอยู่
  const [nowMs, setNowMs] = useState(null);
  const [videoError, setVideoError] = useState(null);
  const [timeInput, setTimeInput] = useState('');
  const videoRef = useRef(null);
  const tokenRef = useRef(null);
  const videoBoxRef = useRef(null);
  // วิดีโอ 16:9 ทั้งกล่องต้องอยู่ในจอ (จอ 1080p กว้างเต็มแล้วสูงเกินจอ) — จำกัดกว้างตามความสูงที่เหลือ
  const videoMaxWidth = useFitToViewport(videoBoxRef, 16 / 9);
  const pendingRef = useRef(null); // ms ที่รอเล่นหลังโหลดช่วงเวลาของวัน/กล้องใหม่เสร็จ
  const [pendingTick, setPendingTick] = useState(0); // กล้อง/วันเดิม = ไม่มีอะไรโหลดใหม่ ต้องปลุก effect เอง
  const rangesReqRef = useRef(0); // เลขคำขอช่วงเวลาล่าสุด — คำตอบของคำขอเก่า (เปลี่ยนกล้อง/วันเร็ว ๆ) ทิ้ง

  const usable = useMemo(() => cameras.filter((c) => !c.source_missing_at), [cameras]);
  const q = search.trim().toLowerCase();
  const list = useMemo(() => usable.filter((c) => !q
    || `${c.name || ''} ${c.global_id || ''} ${c.group_name || ''}`.toLowerCase().includes(q)), [usable, q]);
  const groups = useMemo(() => {
    const grouped = new Map();
    for (const cam of list) {
      const name = String(cam.group_name || '').trim() || 'ไม่มีกลุ่ม';
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(cam);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'th'));
  }, [list]);

  /** การค้นหาเปิดเฉพาะกลุ่มที่มีผลลัพธ์; การพับด้วยมือคงไว้เมื่อเลิกค้นหา */
  const toggleGroup = (name) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  /** โหลดช่วงเวลาที่มีภาพของกล้อง/วัน — เฉพาะคำขอล่าสุดเท่านั้นที่เขียน state ได้ */
  const loadRanges = useCallback(async (cam, d) => {
    const reqId = ++rangesReqRef.current;
    if (!cam) {
      setLoadingRanges(false);
      return;
    }
    setRanges([]);
    setLoadingRanges(true);
    setRangeError(null);
    try {
      const from = `${d}T00:00:00.000+07:00`;
      const to = isoBangkok(dayStartMs(d) + DAY_SECONDS * 1000);
      const res = await apiFetch(`/api/playback/${encodeURIComponent(cam.id)}/ranges?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const body = await res.json().catch(() => ({}));
      if (reqId !== rangesReqRef.current) return;
      if (!res.ok) throw new Error(body.error || `โหลดช่วงเวลาไม่สำเร็จ (${res.status})`);
      setRanges(body.ranges || []);
    } catch (err) {
      if (reqId !== rangesReqRef.current) return;
      setRanges([]);
      setRangeError(err.message);
    } finally {
      if (reqId === rangesReqRef.current) setLoadingRanges(false);
    }
  }, []);

  useEffect(() => {
    setSrc(null);
    setPlayStart(null);
    setVideoError(null);
    loadRanges(camera, day);
  }, [camera, day, loadRanges]);

  // ถอดวิดีโอเก่าเมื่อเปลี่ยน src / ออกจากหน้า — ปิดการเชื่อมต่อที่ค้าง (แบบเดียวกับ LivePlayer)
  useEffect(() => {
    const video = videoRef.current;
    if (!src || !video) return undefined;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  useEffect(() => {
    if (!target) return;
    const cam = cameras.find((c) => c.id === target.cameraId);
    if (cam) {
      setExpandedGroups((current) => new Set(current).add(String(cam.group_name || '').trim() || 'ไม่มีกลุ่ม'));
      pendingRef.current = target.ms;
      setPendingTick((n) => n + 1);
      setCamera(cam);
      setDay(new Date(target.ms + BANGKOK_MS).toISOString().slice(0, 10));
    }
    onTargetUsed?.();
  }, [target, cameras, onTargetUsed]);

  /** token ของกล้องนี้ (อายุ 1 ชม.) — ขอใหม่ถ้าเปลี่ยนกล้องหรือใกล้หมด */
  const tokenFor = async (cam) => {
    const t = tokenRef.current;
    if (t && t.id === cam.id && Date.now() - t.at < 50 * 60_000) return t;
    const res = await apiFetch(`/api/playback/${encodeURIComponent(cam.id)}/token`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'ขอสิทธิ์ดูภาพไม่สำเร็จ');
    tokenRef.current = { id: cam.id, at: Date.now(), ...body };
    return tokenRef.current;
  };

  /** เล่นจากเวลา ms — ถ้าตรงช่องว่างระหว่างช่วง ข้ามไปต้นช่วงถัดไป */
  const playAt = async (ms) => {
    if (!camera) return;
    const next = ranges.find((r) => Date.parse(r.end) > ms);
    if (!next) {
      setVideoError('หลังเวลานี้ไม่มีภาพบันทึกในวันที่เลือก');
      return;
    }
    const start = Math.max(ms, Date.parse(next.start));
    try {
      const t = await tokenFor(camera);
      setVideoError(null);
      setPlayStart(start);
      setNowMs(start);
      setSrc(`${t.video}?t=${encodeURIComponent(t.token)}&start=${encodeURIComponent(isoBangkok(start))}&duration=${CHUNK_SECONDS}`);
    } catch (err) {
      setVideoError(err.message);
    }
  };

  /** วิดีโอเล่นไม่ได้ — ถามเซิร์ฟเวอร์ซ้ำเพื่อเอาข้อความจริง (แท็ก <video> ไม่บอกเหตุผล) */
  const onVideoError = async () => {
    if (!src) return;
    const ctrl = new AbortController();
    try {
      const res = await fetch(src, { signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setVideoError(body?.error || `เล่นไม่ได้ (${res.status})`);
      } else {
        setVideoError('เบราว์เซอร์เล่นวิดีโอนี้ไม่ได้');
      }
    } catch (err) {
      setVideoError(err.message);
    } finally {
      ctrl.abort();
    }
  };

  // เวลาที่รอเล่น (มาจาก AI Events) — เล่นเมื่อช่วงเวลาของกล้อง/วันใหม่โหลดเสร็จ
  useEffect(() => {
    if (loadingRanges || pendingRef.current === null || !camera) return;
    const ms = pendingRef.current;
    pendingRef.current = null;
    playAt(ms);
    // playAt อ่าน ranges/camera ชุดล่าสุดอยู่แล้ว — ใส่ใน deps จะเล่นซ้ำทุกครั้งที่ฟังก์ชันถูกสร้างใหม่
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingRanges, ranges, camera, pendingTick]);

  const onEnded = () => {
    if (playStart === null) return;
    const v = videoRef.current;
    const reached = playStart + Math.round((v?.currentTime || 0) * 1000);
    playAt(reached + 500);
  };

  const onTimeUpdate = () => {
    if (playStart !== null && videoRef.current) setNowMs(playStart + videoRef.current.currentTime * 1000);
  };

  const base = dayStartMs(day);
  const onTimelineClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    playAt(base + Math.round(frac * DAY_SECONDS) * 1000);
  };

  const onTimeSubmit = (e) => {
    e.preventDefault();
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeInput.trim());
    if (!m) {
      setVideoError('รูปแบบเวลา HH:MM หรือ HH:MM:SS');
      return;
    }
    playAt(base + ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] || 0)) * 1000);
  };

  /** เปิดภาพนิ่ง — เปิดหน้าต่างทันทีตอนคลิก (กัน popup blocker) แล้วค่อยใส่ URL หลังได้ token */
  const snapshotUrl = async () => {
    if (!camera || nowMs === null) return;
    const at = nowMs;
    const win = window.open('about:blank', '_blank');
    try {
      const t = await tokenFor(camera);
      const url = `${t.frame}?t=${encodeURIComponent(t.token)}&at=${encodeURIComponent(isoBangkok(at))}`;
      if (!win) throw new Error('เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต popup แล้วลองอีกครั้ง');
      win.opener = null;
      win.location.href = url;
    } catch (err) {
      win?.close();
      setVideoError(`เปิดภาพนิ่งไม่สำเร็จ: ${err.message}`);
    }
  };

  const pct = (ms) => `${Math.min(Math.max(((ms - base) / 1000 / DAY_SECONDS) * 100, 0), 100)}%`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-2xl tracking-tight">Playback</h2>
        <p className="mt-1 text-sm text-muted-foreground">ภาพบันทึกย้อนหลังจาก edge · เลือกกล้องและวัน แล้วคลิกบนแถบเวลา</p>
      </div>

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
                return (
                  <div key={name} className="border-b">
                    <button type="button" aria-expanded={expanded} disabled={!!q} onClick={() => toggleGroup(name)}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold hover:bg-muted/50 disabled:cursor-default">
                      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
                      <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{members.length}</span>
                    </button>
                    {expanded && members.map((c) => (
                      <button key={c.id} type="button" onClick={() => setCamera(c)}
                        className={cn('flex w-full items-start border-t py-2 pl-8 pr-3 text-left transition-colors hover:bg-muted/50', camera?.id === c.id && 'bg-primary/10 text-primary')}>
                        <span className="min-w-0">
                          <span className="block truncate text-sm" title={c.name}>{c.name}</span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">{c.global_id || c.id}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
              {!list.length && <div className="py-10 text-center text-sm text-muted-foreground">ไม่พบกล้อง</div>}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={day} max={todayBangkok()} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-40" />
            <Button variant="outline" size="icon" title="วันก่อนหน้า"
              onClick={() => setDay(new Date(dayStartMs(day) - DAY_SECONDS * 1000 + BANGKOK_MS).toISOString().slice(0, 10))}>
              <SkipBack className="size-4" />
            </Button>
            <Button variant="outline" size="icon" title="วันถัดไป" disabled={day >= todayBangkok()}
              onClick={() => setDay(new Date(dayStartMs(day) + DAY_SECONDS * 1000 + BANGKOK_MS).toISOString().slice(0, 10))}>
              <SkipForward className="size-4" />
            </Button>
            <form onSubmit={onTimeSubmit} className="flex items-center gap-2">
              <Input value={timeInput} onChange={(e) => setTimeInput(e.target.value)} placeholder="HH:MM:SS" className="w-28 font-mono" />
              <Button type="submit" size="sm" className="gap-1.5" disabled={!camera}><Play className="size-3.5" /> เล่น</Button>
            </form>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={nowMs === null} onClick={snapshotUrl} title="เปิดภาพนิ่ง ณ เวลาที่เล่นอยู่">
              <Download className="size-3.5" /> ภาพนิ่ง
            </Button>
            <span className="ml-auto font-mono text-sm tabular-nums">{nowMs !== null ? `${day} ${clock(nowMs)}` : ''}</span>
          </div>

          {/* แถบเวลา 24 ชม. — แถบทึบ = มีภาพ · เส้นแดง = ตำแหน่งที่เล่นอยู่ */}
          <div className="select-none">
            <div role="slider" aria-label="เลือกเวลา" aria-valuemin={0} aria-valuemax={DAY_SECONDS} aria-valuenow={nowMs !== null ? Math.round((nowMs - base) / 1000) : 0} tabIndex={0}
              onClick={onTimelineClick}
              className={cn('relative h-8 w-full rounded-sm border bg-muted', camera ? 'cursor-pointer' : 'opacity-50')}>
              {ranges.map((r) => (
                <div key={r.start} className="absolute inset-y-1 bg-primary/70"
                  style={{ left: pct(Date.parse(r.start)), width: `calc(${pct(Date.parse(r.end))} - ${pct(Date.parse(r.start))})`, minWidth: 2 }}
                  title={`${clock(Date.parse(r.start))} – ${clock(Date.parse(r.end))}`} />
              ))}
              {nowMs !== null && <div className="absolute inset-y-0 w-0.5 bg-status-crit" style={{ left: pct(nowMs) }} />}
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h}>{String(h).padStart(2, '0')}</span>)}
            </div>
          </div>

          <div ref={videoBoxRef} className="relative aspect-video w-full overflow-hidden rounded-md border bg-black" style={{ maxWidth: videoMaxWidth || undefined }}>
            {src ? (
              <video ref={videoRef} key={src} src={src} autoPlay controls playsInline muted
                onError={onVideoError} onEnded={onEnded} onTimeUpdate={onTimeUpdate}
                className="size-full object-contain" />
            ) : (
              <div className="flex size-full items-center justify-center text-sm text-white/60">
                {!camera ? 'เลือกกล้องทางซ้าย'
                  : loadingRanges ? 'กำลังโหลดช่วงเวลา…'
                    : rangeError ? rangeError
                      : ranges.length ? 'คลิกบนแถบเวลาเพื่อเริ่มเล่น' : 'ไม่มีภาพบันทึกในวันนี้'}
              </div>
            )}
            {videoError && (
              <div className="absolute inset-x-0 bottom-0 bg-black/80 px-4 py-2 text-sm text-status-crit">{videoError}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
