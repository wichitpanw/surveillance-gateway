import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RefreshCw, ImageOff } from 'lucide-react';
import { apiFetch, getAuthHeaders } from '@/lib/api';

/**
 * ภาพนิ่งภาพเดียวจากกล้องหนึ่งตัว
 *
 * มาแทนผู้เล่นวิดีโอในหน้าเว็บ ซึ่งถูกถอดออกไปตอนที่การดูภาพย้ายไปอยู่ที่ client ทั้งหมด
 * คำถามที่หน้านี้ต้องตอบคือคำถามของคนที่เพิ่งกรอก RTSP เข้าไป — "กรอกถูกไหม" — ซึ่งภาพนิ่ง
 * ภาพเดียวตอบได้ครบพอ ๆ กับวิดีโอ โดยไม่ต้องมี player ไม่ต้องมี stream token และไม่ทำให้
 * streaming core ต้องเปิดสตรีมค้างไว้ให้คนที่แค่จะเช็คว่ากล้องมาไหม
 *
 * ต้อง fetch แล้วแปลงเป็น object URL ไม่ใช่ชี้ src ไปที่ endpoint ตรง ๆ เพราะแท็ก img ส่ง
 * header ไม่ได้ และ endpoint นี้อยู่หลัง checkAuth — เหมือนที่ demo-client ทำกับ snapshot
 * ของ /api/v1
 */
export default function SnapshotModal({ camera, open, onClose }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || !camera?.id) return undefined;

    let cancelled = false;
    let created = null;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      setSource(null);
      try {
        const res = await apiFetch(`/api/cameras/${encodeURIComponent(camera.id)}/snapshot`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) {
          // ข้อความจากเซิร์ฟเวอร์บอกสาเหตุจริง (รหัสผ่านผิด, path ผิด, ต่อไม่ถึง) ซึ่งเป็น
          // สิ่งเดียวที่คนกรอก RTSP ผิดต้องได้อ่าน — อย่าเขียนทับด้วยข้อความของตัวเอง
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `จับภาพไม่สำเร็จ (${res.status})`);
        }
        const blob = await res.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
        setSource(res.headers.get('X-Snap-Source'));
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      // ปล่อย object URL ทุกครั้ง ไม่งั้น blob ค้างในหน่วยความจำสะสมทุกครั้งที่กดรีเฟรช
      if (created) URL.revokeObjectURL(created);
      setObjectUrl(null);
    };
  }, [open, camera?.id, attempt]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{camera?.name || camera?.id}</DialogTitle>
          <DialogDescription>
            ภาพนิ่งล่าสุดจากกล้อง — ใช้ยืนยันว่า RTSP และรหัสผ่านถูกต้อง
            {source ? ` · แหล่งภาพ: ${source}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex min-h-[320px] items-center justify-center rounded-md border bg-muted/30">
          {isLoading && (
            <p className="text-xs uppercase tracking-widest text-muted-foreground">กำลังจับภาพ…</p>
          )}

          {!isLoading && error && (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <ImageOff className="size-6 text-destructive" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {!isLoading && !error && objectUrl && (
            <img src={objectUrl} alt={camera?.name || 'snapshot'} className="max-h-[60vh] w-full object-contain" />
          )}
        </div>

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={isLoading}
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw className="size-3.5" />
            จับภาพใหม่
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
