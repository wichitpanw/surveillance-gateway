import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight,
  Home, ZoomIn, ZoomOut, Plus, Trash2, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';
import { cn } from '@/lib/utils';

const DIRS = [
  { key: 'ul', icon: ArrowUpLeft, pan: -1, tilt: 1 },
  { key: 'u', icon: ArrowUp, pan: 0, tilt: 1 },
  { key: 'ur', icon: ArrowUpRight, pan: 1, tilt: 1 },
  { key: 'l', icon: ArrowLeft, pan: -1, tilt: 0 },
  { key: 'home', icon: Home },
  { key: 'r', icon: ArrowRight, pan: 1, tilt: 0 },
  { key: 'dl', icon: ArrowDownLeft, pan: -1, tilt: -1 },
  { key: 'd', icon: ArrowDown, pan: 0, tilt: -1 },
  { key: 'dr', icon: ArrowDownRight, pan: 1, tilt: -1 },
];

/*
  แผงควบคุม PTZ ของกล้องหนึ่งตัว — เรียก /api/cameras/:id/ptz (session) ซึ่งใช้ตัวคุมเดียวกับ /api/v1

  กดค้าง = หมุน, ปล่อย/ลากออก = หยุด · ฝั่ง server ตั้ง timeout 10 วิ ให้ move ทุกครั้ง ถ้า stop หาย
  (ปิดแท็บกลางทาง เน็ตหลุด) กล้องหยุดเอง · แสดงเฉพาะเมื่อกล้องรองรับ ปุ่มสั่งปิดถ้า role ไม่มี device.ptz
*/
export default function PtzPad({ cameraId }) {
  const [info, setInfo] = useState(null); // { supported, allowed, presets }
  const [loading, setLoading] = useState(true);
  const [speed, setSpeed] = useState(0.5);
  const [presetName, setPresetName] = useState('');
  const moving = useRef(false);
  const movedAt = useRef(0);
  const stopTimer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/ptz`);
      const data = await res.json().catch(() => ({}));
      setInfo(res.ok ? data : { supported: false, error: data.error });
    } catch (err) {
      setInfo({ supported: false, error: err.message });
    } finally {
      setLoading(false);
    }
  }, [cameraId]);

  useEffect(() => { load(); }, [load]);

  const send = useCallback(async (body, { quiet = false } = {}) => {
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cameraId)}/ptz`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      if (!quiet) toast({ title: `สั่ง PTZ ไม่สำเร็จ: ${err.message}`, variant: 'destructive' });
      return null;
    }
  }, [cameraId]);

  /*
    มอเตอร์ซูมของกล้อง varifocal ช้า (Tiandy 203.0.113.12 ที่ 25% ต้องกดราว 2 วิ ถึงเห็นชัด — ทดสอบ 2026-09-23)
    คลิกทีเดียวเดิมส่ง stop ตามหลังแทบทันที ภาพไม่ขยับจนดูเหมือนซูมไม่ทำงาน จึง:
    - ทุกการกดขยับอย่างน้อย MIN_MOVE_MS ก่อนหยุด
    - ซูมใช้ความเร็วอย่างน้อย 50% (ตัวเลื่อนความเร็วมีไว้คุมการหมุนเป็นหลัก)
  */
  const MIN_MOVE_MS = 600;
  const start = (pan, tilt, zoom = 0) => {
    clearTimeout(stopTimer.current);
    stopTimer.current = null;
    moving.current = true;
    movedAt.current = Date.now();
    send({ action: 'move', pan: pan * speed, tilt: tilt * speed, zoom: zoom * Math.max(speed, 0.5) });
  };
  const stop = () => {
    if (!moving.current) return;
    moving.current = false;
    const wait = Math.max(0, MIN_MOVE_MS - (Date.now() - movedAt.current));
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      stopTimer.current = null;
      send({ action: 'stop' }, { quiet: true });
    }, wait);
  };

  // ปิด modal ระหว่างกดค้าง — สั่งหยุดก่อนหายไป
  useEffect(() => () => {
    // ปิด modal ระหว่างกดค้าง หรือระหว่างรอ stop ที่หน่วงไว้ — หยุดทันที อย่าปล่อยให้หมุนจนหมดเวลา 10 วิ
    const pending = stopTimer.current !== null;
    clearTimeout(stopTimer.current);
    if (moving.current || pending) send({ action: 'stop' }, { quiet: true });
  }, [send]);

  if (loading) {
    return <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> ถามกล้องว่ารองรับ PTZ ไหม…</div>;
  }
  if (!info?.supported) {
    return <div className="p-4 text-xs text-muted-foreground">{info?.reason || 'กล้องนี้ไม่รองรับ PTZ'}{info?.error ? ` — ${info.error}` : ''}</div>;
  }
  const allowed = Boolean(info.allowed);
  const presets = info.presets || [];

  const holdProps = (pan, tilt, zoom) => ({
    onPointerDown: (e) => { e.currentTarget.setPointerCapture?.(e.pointerId); start(pan, tilt, zoom); },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  });

  return (
    <div className="space-y-4 p-4">
      {!allowed && <p className="text-[11px] text-muted-foreground">ดูได้อย่างเดียว — role ของคุณไม่มีสิทธิ์ควบคุม PTZ</p>}

      <div className="mx-auto grid w-fit grid-cols-3 gap-1.5">
        {DIRS.map((d) => {
          const Icon = d.icon;
          if (d.key === 'home') {
            return (
              <Button key={d.key} variant="outline" size="icon" className="size-11" disabled={!allowed}
                title="กลับตำแหน่ง Home" onClick={() => send({ action: 'home' })}>
                <Icon className="size-4" />
              </Button>
            );
          }
          return (
            <Button key={d.key} variant="outline" size="icon" className="size-11 touch-none select-none" disabled={!allowed}
              {...holdProps(d.pan, d.tilt, 0)}>
              <Icon className="size-4" />
            </Button>
          );
        })}
      </div>

      <div className="flex items-center justify-center gap-2">
        <Button variant="outline" size="sm" className="touch-none select-none gap-1.5" disabled={!allowed} {...holdProps(0, 0, -1)}>
          <ZoomOut className="size-4" /> ซูมออก
        </Button>
        <Button variant="outline" size="sm" className="touch-none select-none gap-1.5" disabled={!allowed} {...holdProps(0, 0, 1)}>
          <ZoomIn className="size-4" /> ซูมเข้า
        </Button>
      </div>

      <label className="flex items-center gap-3 text-xs text-muted-foreground">
        ความเร็ว
        <input type="range" min="0.1" max="1" step="0.1" value={speed} disabled={!allowed}
          onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1 accent-primary" />
        <span className="w-8 text-right font-mono">{Math.round(speed * 100)}%</span>
      </label>

      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Presets</div>
        <div className="max-h-48 space-y-1 overflow-y-auto custom-scrollbar">
          {presets.length === 0 && <p className="text-xs text-muted-foreground">ยังไม่มี preset</p>}
          {presets.map((p) => (
            <div key={p.token} className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className={cn('h-8 flex-1 justify-start truncate text-xs')} disabled={!allowed}
                onClick={() => send({ action: 'preset.goto', token: p.token })}>
                {p.name || p.token}
              </Button>
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" disabled={!allowed}
                title="ลบ preset"
                onClick={async () => {
                  const ok = await appConfirm({ title: 'ลบ preset', description: `ลบ preset "${p.name || p.token}" ออกจากกล้อง? ทุกคนที่ใช้กล้องนี้จะเสีย preset นี้ไปด้วย`, confirmText: 'ลบ', variant: 'destructive' });
                  if (ok && (await send({ action: 'preset.remove', token: p.token }))) load();
                }}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {allowed && (
          <form className="flex gap-1.5" onSubmit={async (e) => {
            e.preventDefault();
            const name = presetName.trim();
            if (!name) return;
            if (await send({ action: 'preset.set', name })) { setPresetName(''); toast({ title: `บันทึก preset "${name}" แล้ว` }); load(); }
          }}>
            <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={64} placeholder="ชื่อ preset ใหม่ (ตำแหน่งปัจจุบัน)" className="h-8 text-xs" />
            <Button type="submit" size="sm" variant="outline" className="h-8 gap-1"><Plus className="size-3.5" /> บันทึก</Button>
          </form>
        )}
      </div>
    </div>
  );
}
