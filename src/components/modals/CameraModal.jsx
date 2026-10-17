import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import OfflineMapPicker from '../OfflineMapPicker';
import RegionPicker from '../RegionPicker';
import { Camera, Network, Database, MapPin, X, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_CAMERA_PROVIDERS, DEFAULT_API_CAMERA_PROVIDER } from "@/lib/camera-api-providers";

/**
 * Camera Modal - ส่วนจัดการกล้องใหม่สไตล์ Monochrome Shadcn
 * ปรับปรุงการ Scroll และเพิ่ม Description เพื่อความถูกต้องของระบบค่ะ
 */
const CameraModal = ({ 
  isModalOpen, 
  modalMode, 
  formData, 
  setFormData, 
  handleSaveCamera, 
  handleBulkSaveNvr, 
  handleFetchNvrChannels, 
  setIsModalOpen, 
  isLoading, 
  nvrChannels, 
  setNvrChannels,
  vmsCameras = [],
  handleFetchVmsCameras,
  handleImportVms,
  selectedChannels, 
  setSelectedChannels, 
  theme, 
  setIsMapFullPickerOpen,
  cameras = []
}) => {
  const [isCreatingNewGroup, setIsCreatingNewGroup] = React.useState(false);
  const [coordsInput, setCoordsInput] = React.useState('');
  // กรองรายการกล้องจาก VMS (DSS มีเป็นร้อยช่อง) — ปุ่มเลือกทั้งหมด/ไม่เลือกมีผลเฉพาะตัวที่เห็นอยู่
  const [vmsFilter, setVmsFilter] = React.useState('');
  const visibleVmsCameras = React.useMemo(() => {
    const q = vmsFilter.trim().toLowerCase();
    if (!q) return vmsCameras;
    return vmsCameras.filter((c) => [c.name, c.groupName, c.ip, c.description].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [vmsCameras, vmsFilter]);
  const isApi = formData.type === 'api';
  const apiProvider = isApi ? API_CAMERA_PROVIDERS[formData.apiProvider || DEFAULT_API_CAMERA_PROVIDER] : null;
  const isMilestone = formData.type === 'vms' && formData.vmsKind === 'milestone';
  const isNvr = formData.type === 'onvif_nvr' || isApi || isMilestone;

  const existingGroups = React.useMemo(() => {
    const groups = (cameras || []).map(c => c.group_name || c.group || 'Default');
    return Array.from(new Set(groups)).filter(Boolean);
  }, [cameras]);

  /*
    เลือกโหมดช่องกลุ่ม (เลือกจากรายการ / พิมพ์ชื่อใหม่) ครั้งเดียวตอนเปิดฟอร์มเท่านั้น

    เดิมคำนวณใหม่ทุกครั้งที่ formData.group เปลี่ยน: กด "+ Create New Group" → group เป็น '' →
    effect เห็น '' แล้วสลับกลับเป็นโหมดเลือก ต้องกด 2-3 ครั้งถึงติด และพิมพ์ชื่อที่บังเอิญตรงกับกลุ่มเดิม
    ก็เด้งกลับกลางคัน — หลังเปิดแล้วให้ปุ่มเป็นตัวสลับโหมดเท่านั้น
  */
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (isModalOpen && !wasOpenRef.current) {
      const groupExists = existingGroups.includes(formData.group);
      setIsCreatingNewGroup(!groupExists && formData.group !== 'Default' && formData.group !== '');
    }
    wasOpenRef.current = isModalOpen;
  }, [isModalOpen, formData.group, existingGroups]);

  React.useEffect(() => {
    // ซิงค์พิกัดเข้าช่องพิมพ์ — ไม่มีพิกัด (ยังไม่ปักหมุด) = ช่องว่าง
    if (!isModalOpen) return;
    const hasPin = Number.isFinite(parseFloat(formData.lat)) && Number.isFinite(parseFloat(formData.lng));
    setCoordsInput(hasPin ? `${formData.lat}, ${formData.lng}` : '');
  }, [isModalOpen, formData.lat, formData.lng]);

  const handleCoordsChange = (value) => {
    setCoordsInput(value);
    // ลบช่องจนว่าง = ถอนหมุด (กล้องยังไม่มีตำแหน่ง)
    if (value.trim() === '') {
      setFormData(prev => ({ ...prev, lat: null, lng: null }));
      return;
    }
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

  if (!isModalOpen) return null;

  return (
    <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
      <DialogContent 
        showCloseButton={false} 
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl bg-card"
      >
        {/* Header */}
        <div className="p-6 border-b bg-muted/20 flex items-center justify-between shrink-0">
           <div className="flex items-center gap-3">
              <div className="size-10 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-lg">
                 <Camera className="size-5" />
              </div>
              <div>
                  <DialogTitle className="text-lg font-bold tracking-tight">
                    {modalMode === 'add' ? "Add New Camera" : "Edit Camera Configuration"}
                  </DialogTitle>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    Configure connection details and map coordinates
                  </DialogDescription>
              </div>
           </div>
        </div>

        <div className="flex-1 w-full overflow-y-auto border-b min-h-0">
          <div className="p-8 space-y-10 pb-12">
            {/* Logic Selection: Segmented Control Style */}
            <div className="space-y-2">
               <Label className="text-xs font-semibold text-muted-foreground ml-1">Connection Type</Label>
               <div className="grid grid-cols-2 sm:grid-cols-5 bg-muted/50 p-1 rounded-xl border">
                  {['manual', 'onvif_cam', 'onvif_nvr', 'api', 'vms'].map((type) => (
                    <Button
                      key={type}
                      variant="ghost"
                      onClick={() => {
                        setNvrChannels([]);
                        setSelectedChannels([]);
                        if (type === 'manual') setFormData({...formData, type: 'manual'});
                        else if (type === 'onvif_cam') setFormData({...formData, type: 'onvif_cam', brand: 'generic'});
                        else if (type === 'onvif_nvr') setFormData({...formData, type: 'onvif_nvr'});
                        else if (type === 'api') setFormData({...formData, type: 'api', apiProvider: DEFAULT_API_CAMERA_PROVIDER,
                          brand: API_CAMERA_PROVIDERS[DEFAULT_API_CAMERA_PROVIDER].brand,
                          apiPort: formData.apiPort === '80' ? formData.onvifPort || '80' : formData.apiPort});
                        // VMS ถามรายชื่อกล้องจากตัวเซิร์ฟเวอร์ ไม่ได้ต่อกล้องเอง จึงตั้งพอร์ตของ
                        // Digifort ไว้ให้เลย (8601 = API, 554 = เส้น relay) แทนพอร์ตของหัวกล้อง
                        else setFormData({...formData, type: 'vms', vmsKind: 'digifort', vmsPort: '8601', rtspPort: '554', ip: '', onvifUser: '', onvifPass: ''});
                      }}
                      className={cn(
                        "w-full h-9 rounded-lg text-xs font-bold transition-all",
                        formData.type === type ? "bg-card text-primary shadow-xs" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {type === 'manual' ? 'Manual RTSP' : type === 'onvif_cam' ? 'ONVIF Camera' : type === 'onvif_nvr' ? 'ONVIF NVR' : type === 'api' ? 'API' : 'VMS'}
                    </Button>
                  ))}
               </div>
            </div>

            {formData.type === 'vms' && (
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-muted-foreground ml-1">VMS Type</Label>
                <Select value={formData.vmsKind || 'digifort'} onValueChange={(kind) => {
                  setNvrChannels([]);
                  setSelectedChannels([]);
                  setFormData({ ...formData, vmsKind: kind, ip: '', onvifUser: '', onvifPass: '',
                    brand: kind === 'milestone' ? 'milestone' : 'generic',
                    onvifPort: kind === 'milestone' ? '580' : '80',
                    rtspPort: '554', vmsPort: kind === 'edge' ? '5173' : kind === 'dss' ? '443' : '8601' });
                }}>
                  <SelectTrigger className="h-11 font-bold text-xs"><SelectValue placeholder="Select VMS" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="digifort">DIGIFORT</SelectItem>
                    <SelectItem value="dss">DAHUA DSS PRO</SelectItem>
                    <SelectItem value="milestone">MILESTONE OPEN NETWORK BRIDGE</SelectItem>
                    <SelectItem value="edge">EDGE GATEWAY</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Core Identification */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div className="space-y-2">
                  <Label className="text-xs font-semibold text-muted-foreground ml-1">
                    Camera Name{(isNvr || formData.type === 'vms') && ' (Optional)'}
                  </Label>
                  <Input
                    value={formData.name}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                    className="h-11 font-medium text-sm"
                    placeholder={isApi ? 'เว้นว่างได้ — จะใช้ชื่อช่องจาก API ของผู้ให้บริการ'
                      : formData.type === 'onvif_nvr' ? 'เว้นว่างได้ — จะใช้ชื่อ channel จาก ONVIF อัตโนมัติ'
                      : isMilestone ? 'เว้นว่างเพื่อใช้ชื่อกล้องจาก Milestone Bridge'
                      : formData.type === 'vms' ? 'ไม่ใช้ — กล้องจาก VMS ใช้ชื่อเดิมของ VMS เสมอ'
                      : 'e.g. Front Gate 01'}
                  />
               </div>
                <div className="space-y-2">
                   {isCreatingNewGroup ? (
                     <div className="space-y-2 animate-in fade-in duration-200">
                        <div className="flex justify-between items-center px-1">
                           <Label className="text-xs font-semibold text-muted-foreground ml-1">Camera Group / Location</Label>
                           <Button 
                             type="button" 
                             variant="link" 
                             onClick={() => {
                               setIsCreatingNewGroup(false);
                               setFormData({...formData, group: existingGroups[0] || 'Default'});
                             }} 
                             className="h-auto p-0 text-[10px] font-bold"
                           >
                             Choose Existing
                           </Button>
                        </div>
                        <Input 
                          value={formData.group} 
                          onChange={e => setFormData({...formData, group: e.target.value})} 
                          className="h-11 font-medium text-sm" 
                          placeholder="Enter new group name" 
                          autoFocus
                        />
                     </div>
                   ) : (
                     <div className="space-y-2 animate-in fade-in duration-200">
                        <div className="flex justify-between items-center px-1">
                           <Label className="text-xs font-semibold text-muted-foreground ml-1">Camera Group / Location</Label>
                           <Button 
                             type="button" 
                             variant="link" 
                             onClick={() => {
                               setIsCreatingNewGroup(true);
                               setFormData({...formData, group: ''});
                             }} 
                             className="h-auto p-0 text-[10px] font-bold"
                           >
                             + Create New Group
                           </Button>
                        </div>
                        <Select 
                          value={formData.group || 'Default'} 
                          onValueChange={(val) => {
                            if (val === 'NEW_GROUP') {
                              setIsCreatingNewGroup(true);
                              setFormData({...formData, group: ''});
                            } else {
                              setFormData({...formData, group: val});
                            }
                          }}
                        >
                          <SelectTrigger className="h-11 font-bold text-xs uppercase tracking-widest">
                             <SelectValue placeholder="Select Camera Group" />
                          </SelectTrigger>
                          <SelectContent>
                             {existingGroups.map(g => (
                               <SelectItem key={g} value={g} className="text-xs font-bold uppercase tracking-wider">{g}</SelectItem>
                             ))}
                             <SelectItem value="NEW_GROUP" className="text-xs text-primary font-bold uppercase tracking-wider">+ Create New Group...</SelectItem>
                          </SelectContent>
                        </Select>
                     </div>
                   )}
                </div>
            </div>

            {/* จังหวัด/อำเภอของกล้องทุกประเภทที่แอดที่ Edge */}
            {formData.type !== 'edge_relay' && (
              <RegionPicker required
                provinceCode={formData.province_code || null}
                districtCode={formData.district_code || null}
                isEdit={modalMode === 'edit'}
                onChange={(region) => setFormData((prev) => ({ ...prev, ...region }))}
              />
            )}

            {/* Protocol Specific Configuration */}
            {formData.type === 'manual' ? (
               <div className="space-y-2 animate-in fade-in zoom-in duration-300">
                  <Label className="text-xs font-semibold text-muted-foreground ml-1">RTSP Stream URL</Label>
                  <Input value={formData.rtspUrl} onChange={e => setFormData({...formData, rtspUrl: e.target.value})} className="h-11 font-mono text-xs bg-muted/10" placeholder="rtsp://username:password@ip_address:port/stream_path" />
                  <Label className="text-xs font-semibold text-muted-foreground ml-1 pt-2 block">RTSP Sub Stream URL (Optional)</Label>
                  <Input value={formData.rtspSubUrl || ''} onChange={e => setFormData({...formData, rtspSubUrl: e.target.value})} className="h-11 font-mono text-xs bg-muted/10" placeholder="rtsp://username:password@ip_address:port/sub_stream_path" />
                  <p className="text-[11px] text-muted-foreground ml-1">stream 2 ของกล้อง (ความละเอียดต่ำ) ใช้บน Live Wall — เว้นว่าง = ใช้เส้นเดียวกับ main ซึ่ง transcode ภาพเต็มขนาด</p>
               </div>
            ) : formData.type === 'vms' && !isMilestone ? (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">
                           {formData.vmsKind === 'edge' ? 'Edge Address' : 'VMS Server Address'}
                         </Label>
                         <Input value={formData.ip} onChange={e => setFormData({...formData, ip: e.target.value})} className="h-11 font-mono text-xs" placeholder={formData.vmsKind === 'edge' ? '100.x.x.x (Tailscale)' : '203.0.113.76'} />
                      </div>
                  </div>

                  {formData.vmsKind === 'edge' ? (
                    /*
                      edge คือ Gateway ชุดเดียวกับเรา ต่อด้วย API key ที่ edge ออกให้ (หน้า API Clients ของ edge)
                      ไม่มีรหัสผ่านกล้องผ่านมาทางนี้เลย — กล้องทุกตัวยังถือรหัสไว้ที่ edge
                    */
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="space-y-2">
                           <Label className="text-xs font-semibold text-muted-foreground ml-1">Gateway Port</Label>
                           <Input value={formData.vmsPort || '5173'} onChange={e => setFormData({...formData, vmsPort: e.target.value})} className="h-11 font-mono text-xs" placeholder="5173" />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                           <Label className="text-xs font-semibold text-muted-foreground ml-1">API Key ของ edge</Label>
                           <Input type="password" value={formData.edgeKey || ''} onChange={e => setFormData({...formData, edgeKey: e.target.value})} className="h-11 font-mono text-xs" placeholder="sgw_…" />
                        </div>
                      </div>
                      <div className="flex gap-2 items-start text-[10px] text-muted-foreground leading-relaxed">
                         <Info className="size-3.5 mt-0.5 shrink-0" />
                         <span>ออก key ที่หน้า API Clients ของเครื่อง edge ถ้าจะสั่ง PTZ ผ่าน central ต้องติ๊ก "คุม PTZ" ให้ key นั้นด้วย ชื่อ พิกัด และจังหวัดของกล้องแก้ที่ edge — central ดึงค่าใหม่เองทุก 10 นาที</span>
                      </div>
                    </div>
                  ) : (<>

                  <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">API Port</Label>
                         <Input value={formData.vmsPort || '8601'} onChange={e => setFormData({...formData, vmsPort: e.target.value})} className="h-11 font-mono text-xs" placeholder="8601" />
                      </div>
                      {formData.vmsKind !== 'dss' && (
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">RTSP Port</Label>
                         <Input value={formData.rtspPort} onChange={e => setFormData({...formData, rtspPort: e.target.value})} className="h-11 font-mono text-xs" placeholder="554" />
                      </div>
                      )}
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">Username</Label>
                         <Input value={formData.onvifUser} onChange={e => setFormData({...formData, onvifUser: e.target.value})} className="h-11 font-medium text-xs" />
                      </div>
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">Password</Label>
                         <Input type="password" value={formData.onvifPass} onChange={e => setFormData({...formData, onvifPass: e.target.value})} className="h-11 font-medium text-xs" />
                      </div>
                  </div>

                  {/*
                    เตือนเรื่องรหัสผิดไว้ตรงนี้ ไม่ใช่ใน toast หลังยิงไปแล้ว: Digifort บล็อกบัญชี
                    เมื่อใส่รหัสผิดครบสามครั้ง และบัญชีที่ถูกบล็อกทำให้กล้องทุกตัวที่ดึงผ่านมันดับพร้อมกัน
                  */}
                  <div className="flex gap-2 items-start text-[10px] text-muted-foreground leading-relaxed">
                     <Info className="size-3.5 mt-0.5 shrink-0" />
                     <span>{formData.vmsKind === 'dss' ? 'DSS ล็อกบัญชีเมื่อใส่รหัสผิดหลายครั้ง' : 'Digifort บล็อกบัญชีเมื่อใส่รหัสผิดครบ 3 ครั้ง'} ระบบจึงยิงคำขอครั้งเดียวต่อการกดหนึ่งครั้งและไม่ลองซ้ำให้ ตรวจรหัสให้แน่ก่อนกด{formData.vmsKind === 'dss' ? ' · API Port ของ DSS Pro คือ 443 (HTTPS) · กล้องจาก DSS ไม่มีพิกัด — ปักที่หน้า Map Pins' : ''}</span>
                  </div>
                  </>)}

                  <Card className="border-dashed bg-muted/10 p-6 space-y-4">
                     <div className="flex justify-between items-center">
                         <div className="flex items-center gap-2">
                            <Database className="size-4 text-primary" />
                            <span className="text-xs font-bold">Cameras on VMS</span>
                            {vmsCameras.length > 0 && (
                              <span className="text-[10px] text-muted-foreground font-mono">
                                {selectedChannels.length}/{vmsCameras.length} selected
                              </span>
                            )}
                         </div>
                         <Button
                           variant="secondary"
                           size="sm"
                           onClick={handleFetchVmsCameras}
                           disabled={isLoading}
                           className="h-8 text-xs font-bold px-4"
                         >
                           Scan VMS Cameras
                         </Button>
                     </div>

                     {vmsCameras.length > 0 && (
                       <div className="flex flex-wrap items-center gap-2">
                         <Input
                           value={vmsFilter}
                           onChange={(e) => setVmsFilter(e.target.value)}
                           className="h-8 text-xs flex-1 min-w-[160px]"
                           placeholder="ค้นหาชื่อ / กลุ่ม / IP"
                         />
                         <Button
                           variant="outline"
                           size="sm"
                           className="h-8 text-xs"
                           onClick={() => setSelectedChannels(Array.from(new Set([...selectedChannels, ...visibleVmsCameras.map((c) => c.ref)])))}
                         >
                           เลือกทั้งหมด{vmsFilter.trim() ? ` (${visibleVmsCameras.length})` : ''}
                         </Button>
                         <Button
                           variant="outline"
                           size="sm"
                           className="h-8 text-xs"
                           onClick={() => {
                             const hide = new Set(visibleVmsCameras.map((c) => c.ref));
                             setSelectedChannels(selectedChannels.filter((ref) => !hide.has(ref)));
                           }}
                         >
                           ไม่เลือก{vmsFilter.trim() ? ` (${visibleVmsCameras.length})` : ''}
                         </Button>
                       </div>
                     )}

                     <div className="max-h-64 overflow-y-auto pr-2 space-y-2">
                        {visibleVmsCameras.map(cam => (
                          <div key={cam.ref} className={cn("flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-all gap-2", !cam.working && "opacity-60")}>
                             <div className="flex items-center gap-3 min-w-0">
                                <Checkbox
                                  id={`vms-${cam.ref}`}
                                  checked={selectedChannels.includes(cam.ref)}
                                  onCheckedChange={(checked) => {
                                    if (checked) setSelectedChannels([...selectedChannels, cam.ref]);
                                    else setSelectedChannels(selectedChannels.filter(ref => ref !== cam.ref));
                                  }}
                                />
                                <div className="min-w-0">
                                  <Label htmlFor={`vms-${cam.ref}`} className="text-xs font-bold uppercase tracking-tight cursor-pointer block truncate">{cam.name}</Label>
                                  <span className="text-[10px] text-muted-foreground font-mono block truncate">
                                    {[cam.groupName, formData.vmsKind === 'dss' ? cam.ip : cam.model].filter(Boolean).join(' · ')}
                                  </span>
                                </div>
                             </div>
                             <div className="flex items-center gap-1 shrink-0">
                               {cam.fps > 0 && (
                                 <Badge variant="secondary" className="text-[8px] font-black px-2 h-4">{cam.fps} FPS</Badge>
                               )}
                               <Badge variant={cam.working ? "default" : "outline"} className="text-[8px] font-black px-2 h-4">
                                  {cam.working ? 'WORKING' : cam.active ? 'DOWN' : 'DISABLED'}
                               </Badge>
                             </div>
                          </div>
                        ))}
                        {vmsCameras.length === 0 && (
                          <div className="py-10 flex flex-col items-center justify-center gap-2 opacity-40">
                             <Info className="size-5" />
                             <span className="text-xs font-bold text-center">Scan VMS Cameras — ดึงรายชื่อกล้องทั้งหมดจาก VMS</span>
                          </div>
                        )}
                     </div>
                  </Card>
              </div>
            ) : (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {isMilestone && <p className="text-xs text-muted-foreground leading-relaxed">เชื่อมต่อ Milestone Open Network Bridge ผ่าน ONVIF เพื่ออ่านชื่อกล้องและ RTSP จริง แล้วนำเข้าสตรีมผ่าน TCP · กรอกที่อยู่ Bridge และบัญชี ONVIF client ของคุณ</p>}
                  <div className={cn("grid grid-cols-1 gap-6", !isMilestone && "md:grid-cols-2")}>
                      {!isMilestone && <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">{isApi ? 'API Provider' : 'Camera Brand'}</Label>
                         {isApi ? (
                           <Select value={formData.apiProvider || DEFAULT_API_CAMERA_PROVIDER} onValueChange={(val) => {
                             const provider = API_CAMERA_PROVIDERS[val];
                             if (!provider) return;
                             setFormData({...formData, apiProvider: val, brand: provider.brand,
                               apiPort: provider.importMode === 'axis_s30' ? '443' : '80',
                               onvifUser: provider.importMode === 'axis_s30' ? 'root' : formData.onvifUser});
                             setNvrChannels([]);
                             setSelectedChannels([]);
                           }}>
                             <SelectTrigger className="h-11 font-bold text-xs"><SelectValue placeholder="Select API Provider" /></SelectTrigger>
                             <SelectContent>
                               {Object.entries(API_CAMERA_PROVIDERS).map(([id, provider]) => (
                                 <SelectItem key={id} value={id}>{provider.label}</SelectItem>
                               ))}
                             </SelectContent>
                           </Select>
                         ) : (
                         <Select value={formData.brand || 'generic'} onValueChange={(val) => setFormData({...formData, brand: val})}>
                            <SelectTrigger className="h-11 font-bold text-xs">
                               <SelectValue placeholder="Select Brand" />
                            </SelectTrigger>
                            <SelectContent>
                               <SelectItem value="uniview">UNIVIEW</SelectItem>
                               <SelectItem value="tiandy">TIANDY</SelectItem>
                               <SelectItem value="hikvision">HIKVISION</SelectItem>
                               <SelectItem value="dahua">DAHUA</SelectItem>
                               <SelectItem value="hiview">HI-VIEW (XM)</SelectItem>
                               <SelectItem value="axis">AXIS</SelectItem>
                               <SelectItem value="generic">GENERIC ONVIF</SelectItem>
                            </SelectContent>
                         </Select>
                         )}
                         {formData.brand === 'axis' && (
                           <p className="ml-1 text-[11px] leading-relaxed text-muted-foreground">
                             AXIS S30: เลือก API → AXIS S30 (VAPIX) และใช้บัญชีเว็บของ recorder เพื่อสแกนกล้องที่ต่ออยู่
                           </p>
                         )}
                      </div>}
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">{isMilestone ? 'Bridge Address' : 'IP Address'}</Label>
                         <Input value={formData.ip} onChange={e => setFormData({...formData, ip: e.target.value})} className="h-11 font-mono text-xs" placeholder={isMilestone ? 'IP address or hostname' : '192.168.1.100'} />
                      </div>
                  </div>

                  <div className={cn("grid gap-6", isApi ? 'grid-cols-3' : 'grid-cols-2')}>
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">{apiProvider?.importMode === 'axis_s30' ? 'ONVIF Port (ไม่ใช้)' : 'ONVIF Port'}</Label>
                         <Input value={formData.onvifPort} onChange={e => setFormData({...formData, onvifPort: e.target.value})} className="h-11 font-mono text-xs" placeholder={isMilestone ? '580' : '80'} />
                      </div>
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">RTSP Port</Label>
                         <Input value={formData.rtspPort} onChange={e => setFormData({...formData, rtspPort: e.target.value})} className="h-11 font-mono text-xs" placeholder="554" />
                      </div>
                      {isApi && (
                        <div className="space-y-2">
                          <Label className="text-xs font-semibold text-muted-foreground ml-1">API Port</Label>
                         <Input value={formData.apiPort || ''} onChange={e => setFormData({...formData, apiPort: e.target.value})} className="h-11 font-mono text-xs" placeholder={apiProvider?.importMode === 'axis_s30' ? '443' : '80'} />
                        </div>
                      )}
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">{apiProvider?.importMode === 'axis_s30' ? 'Recorder Web Username' : 'Username'}</Label>
                         <Input value={formData.onvifUser} onChange={e => setFormData({...formData, onvifUser: e.target.value})} className="h-11 font-medium text-xs" />
                      </div>
                      <div className="space-y-2">
                         <Label className="text-xs font-semibold text-muted-foreground ml-1">{apiProvider?.importMode === 'axis_s30' ? 'Recorder Web Password' : 'Password'}</Label>
                         <Input type="password" value={formData.onvifPass} onChange={e => setFormData({...formData, onvifPass: e.target.value})} className="h-11 font-medium text-xs" />
                      </div>
                  </div>

                 {formData.type === 'onvif_cam' && (
                    <div className="space-y-2">
                       <Label className="text-xs font-semibold text-muted-foreground ml-1">RTSP Sub Stream URL (Optional)</Label>
                       <Input value={formData.rtspSubUrl || ''} onChange={e => setFormData({...formData, rtspSubUrl: e.target.value})} className="h-11 font-mono text-xs" placeholder="rtsp://username:password@ip_address:port/sub_stream_path" />
                       <p className="text-[11px] text-muted-foreground ml-1">ใช้เฉพาะเมื่อ ONVIF ของกล้องให้มาแค่ stream เดียว — กล้องที่มี stream 2 ระบบใช้ของ ONVIF เอง</p>
                    </div>
                 )}

                 {isNvr && (
                    <Card className="border-dashed bg-muted/10 p-6 space-y-4">
                       <div className="flex justify-between items-center">
                           <div className="flex items-center gap-2">
                              <Database className="size-4 text-primary" />
                              <span className="text-xs font-bold">{isMilestone ? 'Cameras on Milestone Bridge' : 'Available NVR Channels'}</span>
                              {nvrChannels.length > 0 && (
                                <span className="text-[10px] text-muted-foreground font-mono">
                                  {nvrChannels.filter(c => c.isOnline).length} online · {nvrChannels.filter(c => !c.isOnline).length} offline · {selectedChannels.length} selected
                                </span>
                              )}
                           </div>
                           <Button 
                             variant="secondary" 
                             size="sm" 
                             onClick={handleFetchNvrChannels} 
                             disabled={isLoading}
                             className="h-8 text-xs font-bold px-4"
                           >
                             {isMilestone ? 'Scan Bridge' : 'Scan Channels'}
                           </Button>
                       </div>
                       
                       <div className="max-h-48 overflow-y-auto pr-2 space-y-2">
                          {nvrChannels.map(ch => {
                            const mainRes = ch.main?.width
                              ? `${ch.main.width}×${ch.main.height}`
                              : null;
                            const subRes = ch.sub?.width
                              ? `${ch.sub.width}×${ch.sub.height}`
                              : null;
                            const resLabel = mainRes
                              ? (subRes && subRes !== mainRes ? `${mainRes} / ${subRes}` : mainRes)
                              : null;
                            return (
                            <div key={ch.id} className={cn("flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-all cursor-pointer group gap-2", !ch.isOnline && !isApi && "opacity-50")}>
                               <div className="flex items-center gap-3 min-w-0">
                                  <Checkbox
                                    id={`ch-${ch.id}`}
                                    checked={selectedChannels.includes(ch.id)}
                                    disabled={!!ch.existingId || (!!ch.noVideoSource && !isMilestone) || (apiProvider?.importMode === 'axis_s30'
                                      ? !ch.sourceId || !ch.isOnline : apiProvider?.offlineImport
                                      ? !Number.isInteger(ch.channel) || ch.channel < 1
                                      : !ch.isOnline || !ch.main?.rtsp)}
                                    onCheckedChange={(checked) => {
                                      if (checked) setSelectedChannels([...selectedChannels, ch.id]);
                                      else setSelectedChannels(selectedChannels.filter(id => id !== ch.id));
                                    }}
                                  />
                                  <div className="min-w-0" title={
                                    apiProvider?.importMode === 'axis_s30' ? `กล้อง ${ch.sourceId} ผ่าน AXIS S30` : !ch.main?.rtsp
                                      ? apiProvider?.offlineImport
                                        ? 'เพิ่มเป็นช่องรอภาพได้ — Edge จะเติม RTSP จาก ONVIF อัตโนมัติเมื่อกล้องกลับมา'
                                        : 'ไม่มี RTSP จาก ONVIF จึงแอดไม่ได้ — Scan Channels ใหม่เมื่อกล้องกลับมา'
                                      : ch.noVideoSource ? 'สตรีมนี้ไม่ผูกกับช่องกล้อง (เช่น ภาพรวมของ NVR) — ไม่เลือกให้อัตโนมัติ' : undefined
                                  }>
                                    <Label htmlFor={`ch-${ch.id}`} className="text-xs font-bold uppercase tracking-tight cursor-pointer block truncate">
                                      {ch.channel ? `CH ${ch.channel} · ` : ''}{ch.name}
                                    </Label>
                                    {(resLabel || ch.existingId) && (
                                      <span className="text-[10px] text-muted-foreground font-mono block truncate">
                                        {[resLabel, ch.existingId && `แอดแล้ว: ${ch.existingName || ch.existingId}`].filter(Boolean).join(' · ')}
                                      </span>
                                    )}
                                  </div>
                               </div>
                               <div className="flex items-center gap-1 shrink-0">
                                 {ch.existingId ? (
                                   <Badge variant="outline" className="text-[8px] font-black px-2 h-4">ADDED</Badge>
                                 ) : ch.noVideoSource ? (
                                   <Badge variant="outline" className="text-[8px] font-black px-2 h-4">NVR STREAM</Badge>
                                 ) : ch.main?.rtsp || (apiProvider?.importMode === 'axis_s30' && ch.sourceId) ? (
                                   <Badge variant="secondary" className="text-[8px] font-black px-2 h-4">{apiProvider?.importMode === 'axis_s30' ? 'VAPIX' : 'ONVIF'}</Badge>
                                 ) : (
                                   <Badge variant="outline" className="text-[8px] font-black px-2 h-4">{apiProvider?.offlineImport ? 'รอ RTSP' : 'NO RTSP'}</Badge>
                                 )}
                                 <Badge variant={ch.isOnline ? "default" : "outline"} className="text-[8px] font-black px-2 h-4">
                                    {ch.isOnline ? 'ACTIVE' : 'OFFLINE'}
                                 </Badge>
                               </div>
                            </div>
                            );
                          })}
                           {nvrChannels.length === 0 && (
                             <div className="py-10 flex flex-col items-center justify-center gap-2 opacity-40">
                                <Info className="size-5" />
                                <span className="text-xs font-bold text-center">{isMilestone ? 'Scan Bridge — ดึงชื่อกล้องและ RTSP จาก ONVIF ของ Milestone' : `Scan Channels — ${apiProvider?.importMode === 'axis_s30' ? 'ค้นกล้องจาก S30 ผ่าน VAPIX (ไม่ต้องรู้ IP กล้อง)' : isApi ? `ดึงชื่อจาก ${apiProvider?.label || 'API'} และ RTSP จาก ONVIF` : 'ดึง RTSP จริงจาก ONVIF'}`}</span>
                             </div>
                           )}
                       </div>
                    </Card>
                 )}
              </div>
            )}

            {/* Geographic Precision — กล้องจาก NVR และ VMS เข้ามาทีละหลายตัวคนละที่กัน
                พิกัดชุดเดียวในฟอร์มจึงใช้กับทั้งชุดไม่ได้ ปักทีหลังในหน้าปักหมุดกล้องแทน */}
            {!isNvr && formData.type !== 'vms' && (
              <div className="space-y-4 pt-6 border-t col-span-1">
                 <div className="flex justify-between items-center px-1">
                    <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                       <MapPin className="size-3.5" /> Map Coordinates
                    </Label>
                    <Button type="button" variant="link" size="sm" onClick={() => setIsMapFullPickerOpen(true)} className="h-auto p-0 text-xs font-bold">Full Map Picker</Button>
                 </div>

                 {/* 💡 เพิ่มกล่องกรอกพิกัดด้วยตนเอง (Latitude, Longitude) */}
                 <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground font-semibold ml-1">Manual Coordinates (Latitude, Longitude)</Label>
                    <Input 
                      value={coordsInput} 
                      onChange={e => handleCoordsChange(e.target.value)} 
                      className="h-9 font-mono text-xs bg-muted/10" 
                      placeholder="ยังไม่ปักหมุด — คลิกบนแผนที่ หรือพิมพ์ 13.756981, 100.498959"
                    />
                 </div>

                 <div className="h-52 rounded-xl overflow-hidden border shadow-inner relative">
                     <OfflineMapPicker 
                       lat={parseFloat(formData.lat)} 
                       lng={parseFloat(formData.lng)} 
                       theme={theme}
                       onChange={(lat, lng) => setFormData(prev => ({ ...prev, lat, lng }))} 
                     />
                 </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-6 bg-muted/20 border-t flex justify-end gap-3 shrink-0">
           <Button 
             variant="ghost" 
             onClick={() => setIsModalOpen(false)}
             className="px-8 text-xs font-bold opacity-60 hover:opacity-100"
           >
             Cancel
           </Button>
           <Button 
             onClick={isNvr ? handleBulkSaveNvr : formData.type === 'vms' ? handleImportVms : handleSaveCamera}
             disabled={isLoading || (formData.type !== 'edge_relay' && (!formData.province_code || !formData.district_code))}
             className="px-10 h-11 text-xs font-bold tracking-wider shadow-xl min-w-[150px]"
           >
             {isLoading ? "Saving..." : isNvr ? "Import Channels" : formData.type === 'vms' ? "Import Cameras" : "Confirm"}
           </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CameraModal;
