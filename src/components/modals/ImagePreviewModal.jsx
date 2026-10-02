import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, X, ImageIcon, ShieldAlert, SearchCode } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Image Preview Modal - ส่วนแสดงภาพเหตุการณ์สไตล์ Monochrome Shadcn
 * ปรับปรุงการแสดงผลรูปภาพเพื่อป้องกันการโดนบีบสัดส่วน (Aspect Ratio) บนหน้าจอ PC ค่ะ
 */
const ImagePreviewModal = ({ 
  selectedEventImage, 
  setSelectedEventImage 
}) => {
  if (!selectedEventImage) return null;

  return (
    <Dialog open={!!selectedEventImage} onOpenChange={() => setSelectedEventImage(null)}>
      <DialogContent showCloseButton={false} className="max-w-[90vw] lg:max-w-6xl h-fit max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-[0_32px_64px_rgba(0,0,0,0.5)] bg-card font-sans">
        {/* Header Bar */}
        <div className="p-6 border-b bg-muted/20 flex items-center justify-between shrink-0">
           <div className="flex items-center gap-3">
              <div className="size-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
                 <ShieldAlert className="size-5" />
              </div>
              <div>
                 <DialogTitle className="text-xl font-black uppercase tracking-tighter">Event Intelligence</DialogTitle>
                 <DialogDescription className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">
                   High-Fidelity Evidence Reconstruction & Visual Audit
                 </DialogDescription>
              </div>
           </div>
           <Button 
             variant="ghost" 
             size="icon" 
             onClick={() => setSelectedEventImage(null)}
             className="rounded-full size-10 hover:bg-destructive hover:text-destructive-foreground transition-all"
           >
             <X className="size-5" />
           </Button>
        </div>

        {/* Image Container - ปรับปรุงเพื่อรักษา Aspect Ratio และขยายเต็มกรอบค่ะ */}
        <div className="flex-1 bg-black flex items-center justify-center relative group overflow-hidden min-h-[400px] lg:min-h-[600px]">
           <ScrollArea className="w-full h-full">
              <div className="flex items-center justify-center p-2 lg:p-6 min-h-[600px]">
                 <img 
                   src={selectedEventImage} 
                   alt="Event Capture" 
                   className="max-w-full max-h-[82vh] w-auto h-auto object-contain shadow-2xl animate-in zoom-in-95 duration-500 rounded-sm border border-white/5 transition-transform duration-500 group-hover:scale-[1.02]" 
                   style={{ imageRendering: 'auto' }}
                 />
              </div>
           </ScrollArea>
           
           {/* HUD Overlay */}
           <div className="absolute top-4 right-4 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-md border border-white/10 flex items-center gap-2">
                 <SearchCode className="size-3 text-primary" />
                 <span className="text-[9px] font-black text-white uppercase tracking-widest">Original Aspect Ratio</span>
              </div>
           </div>
        </div>

        {/* Action Footer */}
        <div className="p-6 border-t bg-muted/20 flex justify-center gap-4 shrink-0">
           <Button asChild className="px-10 h-11 text-[11px] font-black uppercase tracking-[0.2em] shadow-xl">
             <a href={selectedEventImage} download>
               <Download className="size-4 mr-2" />
               Extract Evidence
             </a>
           </Button>
           <Button 
             variant="outline" 
             onClick={() => setSelectedEventImage(null)}
             className="px-10 h-11 text-[11px] font-black uppercase tracking-[0.2em] bg-card border-muted hover:bg-muted"
           >
             Terminate Preview
           </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ImagePreviewModal;
