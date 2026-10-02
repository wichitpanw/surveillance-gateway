import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import OfflineMapPicker from '../OfflineMapPicker';
import { MapPin, Check, Crosshair, Loader2 } from "lucide-react";

/**
 * Edit map pin only — no camera connection config.
 * Always mounts Dialog (controlled by `open`) so Radix opens reliably.
 */
const EditMapPinModal = ({
  open,
  onClose,
  camera,
  lat,
  lng,
  onCoordsChange,
  onSave,
  isSaving = false,
  theme,
}) => {
  const [coordsInput, setCoordsInput] = React.useState('');
  const safeLat = Number.isFinite(parseFloat(lat)) ? parseFloat(lat) : 13.7563;
  const safeLng = Number.isFinite(parseFloat(lng)) ? parseFloat(lng) : 100.5018;

  const openedAtRef = React.useRef(0);

  React.useEffect(() => {
    if (open) {
      openedAtRef.current = Date.now();
      setCoordsInput(`${safeLat}, ${safeLng}`);
    }
  }, [open, safeLat, safeLng]);

  const handleCoordsChange = (value) => {
    setCoordsInput(value);
    const parts = value.split(',').map((p) => p.trim());
    if (parts.length === 2) {
      const nextLat = parseFloat(parts[0]);
      const nextLng = parseFloat(parts[1]);
      if (!Number.isNaN(nextLat) && !Number.isNaN(nextLng)) {
        onCoordsChange(nextLat, nextLng);
      }
    }
  };

  return (
    <Dialog
      open={!!open}
      onOpenChange={(v) => {
        if (v) return;
        // Radix บางทียิง close ทันทีตอน mount — กันเด้งปิดใน 400ms แรก
        if (Date.now() - openedAtRef.current < 400) return;
        if (!isSaving) onClose?.();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => { if (isSaving) e.preventDefault(); }}
        onInteractOutside={(e) => { if (isSaving) e.preventDefault(); }}
        className="max-w-[95vw] w-full max-h-[calc(100dvh-2rem)] h-[min(95vh,calc(100dvh-2rem))] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl bg-card font-sans"
      >
        <div className="p-5 border-b bg-muted/20 flex flex-col sm:flex-row justify-between items-center gap-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="size-11 rounded-xl bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
              <MapPin className="size-5" />
            </div>
            <div className="text-center sm:text-left">
              <DialogTitle className="text-lg font-bold tracking-tight">
                แก้ไขหมุดบนแผนที่
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                <span className="font-semibold text-foreground uppercase">{camera?.name || '—'}</span>
                {' · '}คลิกแผนที่หรือพิมพ์พิกัด — ไม่แตะการตั้งค่ากล้องอื่น
              </DialogDescription>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={isSaving}
              onClick={() => onClose?.()}
              className="h-11 px-6 text-[10px] font-bold uppercase tracking-widest"
            >
              ยกเลิก
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => onSave?.()}
              className="h-11 px-8 text-[10px] font-bold uppercase tracking-widest gap-2 shadow-lg"
            >
              {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              บันทึกหมุด
            </Button>
          </div>
        </div>

        <div className="flex-1 relative bg-muted/5 min-h-0">
          {open && (
            <div className="absolute inset-0">
              <OfflineMapPicker
                lat={safeLat}
                lng={safeLng}
                theme={theme}
                onChange={onCoordsChange}
              />
            </div>
          )}

          <div className="absolute top-6 left-6 pointer-events-none z-10">
            <Card className="p-4 border-primary/20 bg-background/90 backdrop-blur-xl shadow-2xl flex flex-col gap-3 pointer-events-auto min-w-[200px]">
              <div className="flex items-center gap-2 border-b pb-2 opacity-60">
                <Crosshair className="size-3.5 text-primary" />
                <span className="text-[9px] font-black uppercase tracking-widest">พิกัดหมุด</span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center gap-4">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase">Lat</span>
                  <Badge variant="secondary" className="font-mono text-[11px] h-6 px-2">
                    {safeLat.toFixed(8)}
                  </Badge>
                </div>
                <div className="flex justify-between items-center gap-4">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase">Lng</span>
                  <Badge variant="secondary" className="font-mono text-[11px] h-6 px-2">
                    {safeLng.toFixed(8)}
                  </Badge>
                </div>
              </div>
              <div className="space-y-1.5 pt-2 border-t">
                <Label className="text-[9px] font-bold text-muted-foreground uppercase">พิมพ์พิกัด</Label>
                <Input
                  value={coordsInput}
                  onChange={(e) => handleCoordsChange(e.target.value)}
                  className="h-8 font-mono text-[10px] bg-muted/10 w-full"
                  placeholder="13.756981, 100.498959"
                />
              </div>
            </Card>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default EditMapPinModal;
