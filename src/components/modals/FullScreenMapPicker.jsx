import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import OfflineMapPicker from '../OfflineMapPicker';
import { MapPin, Check, Crosshair, Satellite, X } from "lucide-react";

/**
 * FullScreenMapPicker Component - หน้าจอเลือกพิกัดแบบเต็มจอ Monochrome Shadcn
 * ปรับปรุงความชัดเจนและความสมบูรณ์ของคอมโพเนนต์ค่ะ
 */
const FullScreenMapPicker = ({ 
  isMapFullPickerOpen, 
  setIsMapFullPickerOpen, 
  formData, 
  setFormData, 
  theme 
}) => {
  const [coordsInput, setCoordsInput] = React.useState('');

  React.useEffect(() => {
    // 💡 ซิงค์พิกัดละติจูดและลองจิจูดเข้ามายังช่องพิมพ์เสมอเมื่อเปลี่ยนค่าและหน้าต่างถูกเปิดค่ะ
    if (isMapFullPickerOpen && formData.lat && formData.lng) {
      setCoordsInput(`${formData.lat}, ${formData.lng}`);
    }
  }, [isMapFullPickerOpen, formData.lat, formData.lng]);

  const handleCoordsChange = (value) => {
    setCoordsInput(value);
    // 💡 ตรวจจับและพาร์สค่าพิกัด lat, lng จากการพิมพ์เองด้วยคอมม่าค่ะ
    const parts = value.split(',').map(p => p.trim());
    if (parts.length === 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lng)) {
        setFormData(prev => ({ ...prev, lat, lng }));
      }
    }
  };

  if (!isMapFullPickerOpen) return null;

  return (
    <Dialog open={isMapFullPickerOpen} onOpenChange={setIsMapFullPickerOpen}>
      <DialogContent className="max-w-[95vw] w-full max-h-[calc(100dvh-2rem)] h-[min(95vh,calc(100dvh-2rem))] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl bg-card font-sans">
        {/* Header Bar */}
        <div className="p-6 border-b bg-muted/20 flex flex-col sm:flex-row justify-between items-center gap-4 shrink-0">
           <div className="flex items-center gap-4">
              <div className="size-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
                 <Satellite className="size-6" />
              </div>
              <div className="text-center sm:text-left">
                 <DialogTitle className="text-2xl font-black uppercase tracking-tighter">Precision Geospatial Pick</DialogTitle>
                 <DialogDescription className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">
                   Asset Deployment Coordinate Definition and Verification
                 </DialogDescription>
              </div>
           </div>
           
           <Button 
            onClick={() => setIsMapFullPickerOpen(false)}
            className="px-10 h-12 text-[11px] font-black uppercase tracking-[0.2em] shadow-xl gap-2 min-w-[200px]"
           >
             <Check className="size-4" />
             Confirm Location
           </Button>
        </div>

        {/* Map Canvas */}
        <div className="flex-1 relative bg-muted/5 group">
           <div className="absolute inset-0">
              <OfflineMapPicker 
                lat={parseFloat(formData.lat)} 
                lng={parseFloat(formData.lng)} 
                theme={theme}
                onChange={(lat, lng) => setFormData(prev => ({ ...prev, lat, lng }))} 
              />
           </div>
           
            {/* HUD: Telemetry Data */}
            <div className="absolute top-6 left-6 pointer-events-none z-10 animate-in slide-in-from-top-2 duration-500">
               <Card className="p-5 border-primary/20 bg-background/90 backdrop-blur-xl shadow-2xl flex flex-col gap-4 pointer-events-auto">
                  <div className="flex items-center gap-2 border-b pb-3 opacity-60">
                     <Crosshair className="size-3.5 text-primary" />
                     <span className="text-[9px] font-black uppercase tracking-widest">Live Telemetry</span>
                  </div>
                  <div className="flex flex-col gap-3 min-w-[180px]">
                     <div className="flex justify-between items-center gap-6">
                        <span className="text-[10px] font-black text-muted-foreground uppercase">Latitude</span>
                        <Badge variant="secondary" className="font-mono text-[11px] h-6 px-3">{Number.isFinite(parseFloat(formData.lat)) ? parseFloat(formData.lat).toFixed(8) : "—"}</Badge>
                     </div>
                     <div className="flex justify-between items-center gap-6">
                        <span className="text-[10px] font-black text-muted-foreground uppercase">Longitude</span>
                        <Badge variant="secondary" className="font-mono text-[11px] h-6 px-3">{Number.isFinite(parseFloat(formData.lng)) ? parseFloat(formData.lng).toFixed(8) : "—"}</Badge>
                     </div>
                  </div>
                  
                  {/* 💡 เพิ่มกล่องข้อความสำหรับป้อนพิกัดเองในแผนที่เต็มจอค่ะ */}
                  <div className="space-y-1.5 pt-3 border-t">
                     <Label className="text-[9px] font-black text-muted-foreground uppercase">Manual Coordinate Override</Label>
                     <Input 
                       value={coordsInput} 
                       onChange={e => handleCoordsChange(e.target.value)} 
                       className="h-8 font-mono text-[10px] bg-muted/10 w-full" 
                       placeholder="e.g. 13.756981, 100.498959"
                     />
                  </div>
               </Card>
            </div>

           {/* Central Target UI Overlay */}
           <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="relative size-12 flex items-center justify-center">
                 <div className="absolute size-full border-2 border-primary/20 rounded-full animate-ping opacity-20" />
                 <div className="absolute size-full border border-primary/40 rounded-full scale-150 opacity-10" />
                 <Crosshair className="size-8 text-primary opacity-40" />
              </div>
           </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FullScreenMapPicker;
