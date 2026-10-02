import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, History, ImageOff } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAiSnapshot } from '@/lib/useAiSnapshot';

/*
  AiEventDialog — ดู event ของ AI แบบ popup บนหน้า AI Events (แทนการเปิดภาพในแท็บใหม่)

  ภาพประกอบเต็มขนาด + รายละเอียด (เวลา, กล้อง, ประเภท, กฎ, track, ช่วงที่เห็น)
  เลื่อน event ก่อนหน้า/ถัดไปในรายการด้วยปุ่มหรือลูกศรซ้าย-ขวา · Esc ปิด · ปุ่ม "ย้อนหลัง" เหมือนในแถว
*/
const fmtTime = (iso) => (iso ? iso.slice(11, 19) : '-');

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export default function AiEventDialog({ events, index, onIndexChange, labelTh = {}, originLabel = {}, onOpenPlayback }) {
  const event = index != null ? events[index] : null;
  const snap = useAiSnapshot(event?.hasSnapshot ? event.seq : null);
  const hasPrev = index != null && index > 0;
  const hasNext = index != null && index < events.length - 1;

  useEffect(() => {
    if (!event) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1);
      if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [event, index, hasPrev, hasNext, onIndexChange]);

  if (!event) return null;
  const a = event.attrs || {};
  const what = event.label ? (labelTh[event.label] || event.label) : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onIndexChange(null); }}>
      <DialogContent className="max-w-5xl gap-0 overflow-hidden p-0 md:p-0">
        <div className="flex items-center gap-3 border-b px-5 py-3 pr-14">
          <DialogTitle className="font-sans text-base font-semibold">{event.type}</DialogTitle>
          {what && <Badge variant="secondary" className="text-[10px]">{what}</Badge>}
          <DialogDescription className="truncate text-xs">
            {event.cameraName || event.cameraId} · {event.ts.slice(0, 10)} {fmtTime(event.ts)}
          </DialogDescription>
        </div>

        <div className="relative flex min-h-0 items-center justify-center bg-black">
          {snap.url && <img src={snap.url} alt="" className="max-h-[65dvh] w-full object-contain" />}
          {!snap.url && (
            <div className="flex aspect-video w-full items-center justify-center text-sm text-white/60">
              {!event.hasSnapshot || snap.failed
                ? <span className="flex items-center gap-2"><ImageOff className="size-4" /> ไม่มีภาพประกอบ</span>
                : <span className="animate-pulse">กำลังโหลดภาพ…</span>}
            </div>
          )}
          <Button variant="secondary" size="icon" className="absolute left-3 top-1/2 -translate-y-1/2 opacity-80"
            disabled={!hasPrev} onClick={() => onIndexChange(index - 1)} title="event ก่อนหน้า (←)">
            <ChevronLeft className="size-5" />
          </Button>
          <Button variant="secondary" size="icon" className="absolute right-3 top-1/2 -translate-y-1/2 opacity-80"
            disabled={!hasNext} onClick={() => onIndexChange(index + 1)} title="event ถัดไป (→)">
            <ChevronRight className="size-5" />
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-5 py-4">
          <Field label="เวลา">{fmtTime(event.ts)}</Field>
          {a.firstSeen && <Field label="เห็นช่วง">{fmtTime(a.firstSeen)} – {fmtTime(a.lastSeen)} ({a.durationSec} วิ)</Field>}
          {event.rule && <Field label="กฎ">{event.rule}</Field>}
          {a.direction && <Field label="ทิศ">{a.direction}</Field>}
          {event.trackId && <Field label="track">{event.trackId}</Field>}
          {a.maxScore != null && <Field label="ความมั่นใจ">{Math.round(a.maxScore * 100)}%</Field>}
          <Field label="ที่มา">{originLabel[event.origin] || event.origin}</Field>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{index + 1} / {events.length}</span>
            {onOpenPlayback && (
              <Button variant="outline" size="sm" className="gap-1.5"
                onClick={() => { onIndexChange(null); onOpenPlayback(event.cameraId, Date.parse(event.ts) - 10_000); }}>
                <History className="size-3.5" /> ย้อนหลัง
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
