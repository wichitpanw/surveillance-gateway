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
import { Search, Radio, Cctv, Loader2, X, RefreshCw, Satellite } from "lucide-react";

/**
 * Scan Modal - ส่วนค้นหากล้องในวงแลนสไตล์ Monochrome Shadcn
 * ปรับปรุงความชัดเจนให้มองเห็นได้ชัดขึ้น และแก้ปัญหา Scroll ค่ะ
 */
const ScanModal = ({ 
  isScanModalOpen, 
  setIsScanModalOpen, 
  isScanning, 
  handleStartScan, 
  scannedDevices, 
  selectScannedDevice,
  subnetPrefix,
  setSubnetPrefix
}) => {
  if (!isScanModalOpen) return null;

  return (
    <Dialog open={isScanModalOpen} onOpenChange={setIsScanModalOpen}>
      <DialogContent showCloseButton={false} className="w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl bg-card font-sans">
        {/* Header */}
        <div className="p-6 border-b bg-muted/20 flex items-center justify-between shrink-0">
           <div className="flex items-center gap-3">
              <div className="size-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
                 <Search className="size-5" />
              </div>
              <div>
                  <DialogTitle className="text-lg font-bold tracking-tight">Scan Network Cameras</DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    Scan for ONVIF-compatible cameras in your local network
                  </DialogDescription>
              </div>
           </div>
           {isScanning && (
              <Badge variant="secondary" className="gap-2 px-3 py-1 bg-primary/10 border-primary/20 animate-pulse">
                 <Loader2 className="size-3 animate-spin text-primary" />
                 <span className="text-xs font-bold text-primary">Scanning...</span>
              </Badge>
           )}
        </div>

        {/* Subnet Input Bar */}
        <div className="px-6 py-3.5 bg-muted/20 border-b flex items-center gap-3 shrink-0">
           <span className="text-xs font-bold text-muted-foreground shrink-0 uppercase tracking-wider">IP Subnet Prefix:</span>
           <Input 
             value={subnetPrefix}
             onChange={(e) => setSubnetPrefix(e.target.value)}
             placeholder="e.g. 203.0.113. (leave empty for local scan)"
             className="h-9 text-xs font-mono max-w-[280px] bg-background border-muted"
             disabled={isScanning}
           />
           <span className="text-[10px] text-muted-foreground italic opacity-60">(for scanning routed subnets)</span>
        </div>

        {/* Discovery Area */}
        <div className="flex-1 min-h-0 overflow-hidden p-6 bg-muted/10">
           <Card className="h-full min-h-0 border-muted/50 overflow-hidden flex flex-col bg-card/80">
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
                 {isScanning ? (
                    <div className="h-full flex flex-col items-center justify-center gap-6 py-20 opacity-40 animate-in fade-in duration-500">
                       <div className="size-20 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex items-center justify-center">
                          <Satellite className="size-8 text-primary" />
                       </div>
                        <p className="text-xs font-bold text-center">Searching for cameras on the network...</p>
                    </div>
                 ) : (
                    <div className="divide-y border-t-0 pb-10">
                       {scannedDevices.map((device, idx) => (
                          <div key={idx} className="p-5 flex items-center justify-between hover:bg-muted/40 transition-all group animate-in slide-in-from-left-2 duration-300">
                             <div className="flex items-center gap-5">
                                <div className="size-12 rounded-xl bg-muted flex items-center justify-center text-primary border shadow-sm group-hover:scale-110 transition-transform">
                                  <Cctv className="size-6" />
                                </div>
                                <div className="flex flex-col gap-0.5">
                                   <h4 className="text-sm font-bold tracking-tight">{device.name}</h4>
                                   <span className="text-xs font-mono text-muted-foreground">IP Address: {device.ip}</span>
                                </div>
                             </div>
                               <Button 
                               onClick={() => selectScannedDevice(device)}
                               className="h-9 px-5 text-xs font-bold rounded-full shadow-lg transition-all active:scale-95"
                             >
                               Add Camera
                             </Button>
                          </div>
                       ))}
                       {scannedDevices.length === 0 && !isScanning && (
                           <div className="flex flex-col items-center justify-center py-32 gap-4 opacity-20">
                              <Radio className="size-12" />
                              <p className="text-xs font-bold">No cameras found on this network</p>
                           </div>
                       )}
                    </div>
                 )}
              </div>
           </Card>
        </div>

        {/* Footer */}
        <div className="p-6 border-t bg-muted/20 flex justify-end gap-3 shrink-0">
            <Button 
              variant="ghost" 
              onClick={() => setIsScanModalOpen(false)}
              className="px-8 text-xs font-bold opacity-60 hover:opacity-100"
            >
              Close
            </Button>
            {!isScanning && (
              <Button 
               onClick={handleStartScan} 
               variant="outline"
               className="px-8 h-11 text-xs font-bold gap-2 bg-card border-muted hover:bg-primary hover:text-primary-foreground shadow-md transition-all"
              >
                <RefreshCw className="size-3.5" />
                Scan Again
              </Button>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ScanModal;
