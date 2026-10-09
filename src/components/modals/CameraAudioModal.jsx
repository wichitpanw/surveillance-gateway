import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * ตั้งค่าเสียงของกล้องหนึ่งตัว — ที่ edge เท่านั้น (Regional/Central รับค่าตามรอบ sync)
 *
 * เปิดแล้วถามกล้องทันทีว่ามี track เสียงไหม (ffprobe ต้นทาง) เพื่อให้คนตัดสินใจจากข้อมูลจริง
 * แต่ไม่บังคับ: กล้องที่ถามไม่ได้ตอนนี้ (ออฟไลน์) ก็เปิดรอไว้ได้ ผู้ชมจะได้แค่ภาพจนกว่าต้นทางจะมีเสียง
 */
export default function CameraAudioModal({ camera, open, onClose, onSaved }) {
  const [probe, setProbe] = useState(null); // { hasAudio, codec, sampleRate, channels } | { error }
  const [probing, setProbing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const enabled = Number(camera?.audio_enabled) === 1;

  useEffect(() => {
    if (!open || !camera?.id) return undefined;
    let cancelled = false;
    setProbing(true);
    setProbe(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/cameras/${encodeURIComponent(camera.id)}/audio-probe`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setProbe(res.ok ? data : { error: data.error || `HTTP ${res.status}` });
      } catch (err) {
        if (!cancelled) setProbe({ error: err.message });
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, camera?.id, attempt]);

  const save = async (next) => {
    setSaving(true);
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(camera.id)}/audio`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({ title: next ? `เปิดรับเสียง "${camera.name}" แล้ว` : `ปิดรับเสียง "${camera.name}" แล้ว` });
      onSaved?.();
      onClose();
    } catch (err) {
      toast({ title: `บันทึกไม่สำเร็จ: ${err.message}`, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const describe = (p) => {
    const parts = [p.codec, p.sampleRate ? `${p.sampleRate / 1000} kHz` : null, p.channels === 1 ? 'mono' : p.channels === 2 ? 'stereo' : null];
    return parts.filter(Boolean).join(' · ');
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>เสียงจากกล้อง</DialogTitle>
          <DialogDescription>{camera?.name}</DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4 text-sm">
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">ผลตรวจจากกล้อง</span>
              <Button type="button" variant="ghost" size="sm" disabled={probing} onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw className="mr-1.5 size-3.5" />ตรวจใหม่
              </Button>
            </div>
            <div className="mt-2 text-muted-foreground">
              {probing && <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />กำลังถามกล้อง…</span>}
              {!probing && probe?.error && <span className="text-destructive">{probe.error}</span>}
              {!probing && probe && !probe.error && (probe.hasAudio
                ? <span className="text-status-ok">พบ track เสียง ({describe(probe)})</span>
                : <span>กล้องไม่ส่ง track เสียงมา — อาจไม่มีไมค์ หรือปิด audio ไว้ที่ตัวกล้อง/NVR</span>)}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            เปิดแล้ว Regional และ Central ได้เสียงตามรอบ sync · ผู้ชมทุกช่องเริ่มแบบปิดเสียง ต้องกดลำโพงที่ช่องภาพเอง ·
            เสียงเพิ่มงานแปลง AAC และแบนด์วิดท์เล็กน้อย จึงเปิดเฉพาะกล้องที่ต้องใช้
          </p>

          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <span className="flex items-center gap-2">
              {enabled ? <Volume2 className="size-4 text-status-ok" /> : <VolumeX className="size-4 text-muted-foreground" />}
              {enabled ? 'เปิดรับเสียงอยู่' : 'ปิดรับเสียงอยู่'}
            </span>
            <Button type="button" disabled={saving} variant={enabled ? 'outline' : 'default'} onClick={() => save(!enabled)}>
              {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {enabled ? 'ปิดรับเสียง' : 'เปิดรับเสียง'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
