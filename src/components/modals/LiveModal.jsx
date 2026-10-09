import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import LivePlayer from '@/components/live/LivePlayer';
import PtzPad from '@/components/live/PtzPad';
import { cn } from '@/lib/utils';

/*
  ภาพสดกล้องหนึ่งตัวแบบเต็ม + แผง PTZ — เปิดจากหน้า Cameras, Camera Map และดับเบิลคลิกช่องใน Live Wall

  เริ่มที่ main (ภาพเต็มความละเอียด) สลับเป็น sub ได้ถ้าเน็ตช้า · ปิด dialog = LivePlayer ถอด src
  ซึ่งปิดสายไป go2rtc ทันที กล้องไม่ถูกดึงภาพค้างไว้
*/
// showPtz=false: กล้องที่ไม่มีทางสั่ง PTZ เลย (กล้อง Public) — ภาพเต็มความกว้าง ไม่ต้องถาม /ptz ให้เสียเที่ยว
export default function LiveModal({ camera, open, onClose, showPtz = true, description }) {
  const [type, setType] = useState('main');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(1200px,calc(100vw-2rem))] max-w-none gap-0 overflow-x-hidden p-0 md:p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-3">
            {camera?.name || camera?.id}
            <span className="font-mono text-xs font-normal text-muted-foreground">{camera?.global_id || camera?.id}</span>
          </DialogTitle>
          <DialogDescription>{description || <>ภาพสดผ่าน Gateway{Number(camera?.audio_enabled) === 1 ? ' — กดลำโพงมุมล่างขวาเพื่อเปิดเสียง' : ' — ไม่มีเสียง'}</>}</DialogDescription>
        </DialogHeader>

        {/* minmax(0,1fr): คอลัมน์ภาพต้องหดได้ — ไม่งั้นความกว้างจริงของวิดีโอ (1280+) ดันแผง PTZ หลุดขอบ */}
        <div className={cn('mt-4 grid grid-cols-1', showPtz && 'lg:grid-cols-[minmax(0,1fr)_260px]')}>
          <div className="relative aspect-video min-w-0 bg-black">
            {open && camera?.id && <LivePlayer key={`${camera.id}-${type}`} cameraId={camera.id} type={type} audio={Number(camera.audio_enabled) === 1} className="absolute inset-0" />}
            <div className="absolute right-3 top-3 flex overflow-hidden rounded-md border border-white/20 bg-black/60 text-[11px] text-white">
              {['main', 'sub'].map((t) => (
                <button key={t} type="button" onClick={() => setType(t)}
                  className={cn('px-2.5 py-1 uppercase tracking-wider transition-colors', type === t ? 'bg-white/20' : 'hover:bg-white/10')}>
                  {t === 'main' ? 'Main' : 'Sub'}
                </button>
              ))}
            </div>
          </div>
          {/* จอกว้าง: แผง PTZ สูงเท่าภาพพอดี preset เยอะก็เลื่อนในแผง ไม่ดัน dialog ให้ยาว */}
          {showPtz && (
            <div className="relative min-w-0 border-t lg:border-l lg:border-t-0">
              <div className="lg:absolute lg:inset-0 lg:overflow-y-auto custom-scrollbar">
                {open && camera?.id && <PtzPad cameraId={camera.id} />}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end px-5 py-4">
          <Button variant="outline" size="sm" onClick={onClose}>ปิด</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
