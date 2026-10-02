import React, { useState, useMemo, useEffect } from 'react';
import { getJsonHeaders, apiFetch } from '@/lib/api';
import { cameraOriginLabel } from '@/lib/camera-origin';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Cctv,
  Trash2,
  Search,
  Plus,
  ChevronDown,
  Settings2,
  Video,
  FolderOpen,
  MapPin,
  Camera as CameraIcon,
  RefreshCw,
  Power,
  Download,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n";
import SnapshotModal from "@/components/modals/SnapshotModal";
import LiveModal from "@/components/modals/LiveModal";
import BulkCameraRegionModal from "@/components/modals/BulkCameraRegionModal";

/**
 * Camera Management Component - Monochrome Shadcn Style
 */
const CameraManagement = ({
  handleBulkDelete,
  onCamerasChanged,
  selectedCamerasForDelete, 
  handleStartScan, 
  vmsSourceCount = 0,
  handleVmsResync,
  unpinnedCount = 0,
  onGoToMapPins,
  isLoading = false,
  openAddModal, 
  groupedCameras, 
  expandedAssetGroups, 
  setExpandedAssetGroups, 
  handleDeleteGroup, 
  handleToggleSelectCamera, 
  cameraStatus, 
  openEditModal,
  openMapPinEdit,
  handleRenameGroup,
  // central: กล้องทั้งหมดมาจาก edge — แอด/แก้/ลบ/ปักหมุดทำที่ edge (resync เขียนทับอยู่แล้ว) เหลือแค่ดูและจัดกลุ่ม
  readOnly = false,
  // ปุ่มดูสด — central เท่านั้น (edge ส่งต่อภาพ ไม่มีหน้าดู)
  canLive = false,
}) => {
  const { language, t } = useLanguage();
  const [confirmState, setConfirmState] = useState({ isOpen: false, type: '', data: null });
  /* กล้องที่กำลังเปิดดูภาพนิ่ง — null = ยังไม่ได้เปิด */
  const [snapshotCamera, setSnapshotCamera] = useState(null);
  /* กล้องที่กำลังเปิดดูภาพสด + PTZ */
  const [liveCamera, setLiveCamera] = useState(null);
  // state สำหรับ search filter
  const [areaSelection, setAreaSelection] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  // health เสริม (deviceReachable ผ่าน ONVIF/HTTP) — แยก "อุปกรณ์ออนไลน์แต่ไม่มี stream" ออกจาก
  // "ตายสนิท" เช่นกรณี forward พอร์ต HTTP ไว้ก่อนแต่ยังไม่ forward RTSP
  const [deviceHealth, setDeviceHealth] = useState({});
  // สถานะสามค่าต่อกล้อง (enabled / reachable / streaming) — ดู server/shared/camera-state.js
  const [states, setStates] = useState({});
  const [togglingId, setTogglingId] = useState(null);
  const [exporting, setExporting] = useState(false);

  /** ดาวน์โหลด CSV จาก backend ซึ่งตัด credential และกรองขอบเขตกล้องแล้ว */
  const exportCameras = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await apiFetch('/api/cameras/export');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'cameras.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/camera-states');
        if (res.ok && !cancelled) setStates(await res.json());
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [togglingId]);

  /** เปิด/ปิดใช้งานกล้องที่ edge — ปิดแล้วถอดออกจาก go2rtc และ central ปิดตามรอบ sync */
  const toggleEnabled = async (cam) => {
    const next = states[cam.id]?.enabled === false;
    setTogglingId(cam.id);
    try {
      const res = await apiFetch(`/api/cameras/${encodeURIComponent(cam.id)}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStates((prev) => ({ ...prev, [cam.id]: { ...(prev[cam.id] || {}), enabled: next, reachable: next ? prev[cam.id]?.reachable ?? null : null } }));
      toast({ title: next ? `เปิดใช้งาน "${cam.name}" แล้ว` : `ปิดใช้งาน "${cam.name}" แล้ว` });
    } catch (err) {
      toast({ title: `เปลี่ยนสถานะไม่สำเร็จ: ${err.message}`, variant: 'destructive' });
    } finally {
      setTogglingId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/system/stream-health', { headers: getJsonHeaders() });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const map = {};
        (data.cameras || []).forEach((c) => { map[c.id] = c; });
        if (!cancelled) setDeviceHealth(map);
      } catch { /* ignore */ }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const triggerConfirm = (type, data = null) => {
    setConfirmState({ isOpen: true, type, data });
  };

  const executeConfirm = () => {
    if (confirmState.type === 'bulk_delete') handleBulkDelete();
    if (confirmState.type === 'delete_group') handleDeleteGroup(confirmState.data);
    if (confirmState.type === 'configure') openEditModal(confirmState.data);
    setConfirmState({ isOpen: false, type: '', data: null });
  };

  const allCameras = Object.values(groupedCameras).flat();
  const onlineCount = allCameras.filter(cam => !cam.source_missing_at && cameraStatus[cam.id] === 'online').length;
  const offlineCount = allCameras.length - onlineCount;

  // กรอง groupedCameras ตาม searchTerm (ชื่อกล้อง / กลุ่ม / IP)
  const filteredGroupedCameras = useMemo(() => {
    if (!searchTerm.trim()) return groupedCameras;
    const q = searchTerm.toLowerCase();
    const result = {};
    Object.entries(groupedCameras).forEach(([groupName, cameras]) => {
      // ถ้าชื่อกลุ่มตรง → เอาทุกกล้องในกลุ่ม
      if (groupName.toLowerCase().includes(q)) {
        result[groupName] = cameras;
        return;
      }
      // กรองเฉพาะกล้องที่ตรง
      const matched = cameras.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.ip || '').toLowerCase().includes(q)
      );
      if (matched.length > 0) result[groupName] = matched;
    });
    return result;
  }, [groupedCameras, searchTerm]);

  const filteredTotal = Object.values(filteredGroupedCameras).flat().length;

  return (
    <div className="flex flex-col gap-6 animate-fade-in font-sans pb-10">
      {/* Header Area */}
      <div className="flex flex-col lg:flex-row justify-between lg:items-end gap-6 px-2">
        <div>
           <h2 className="text-2xl tracking-tight">Camera Management</h2>
           <div className="flex items-center gap-4 mt-2">
             <p className="text-muted-foreground text-sm font-medium">{t('cameraMgmtDek')}</p>
             <div className="flex gap-0 font-mono">
                <span className="border border-status-ok/40 text-status-ok px-2 py-0.5 text-[9px] font-semibold tracking-wider">
                   {onlineCount} ACTIVE
                </span>
                <span className="border border-l-0 border-status-crit/40 text-status-crit px-2 py-0.5 text-[9px] font-semibold tracking-wider">
                   {offlineCount} DISCONNECTED
                </span>
             </div>
           </div>
        </div>
        {readOnly ? (
          <div className="flex flex-col items-end gap-2">
            <Button variant="outline" onClick={exportCameras} disabled={exporting}
              title={language === 'th' ? 'ส่งออกกล้องทั้งหมดที่คุณมีสิทธิ์เห็น โดยไม่รวม username/password' : 'Export all cameras in your scope without usernames/passwords'}>
              <Download className="mr-2 h-4 w-4" />
              {exporting ? (language === 'th' ? 'กำลังส่งออก…' : 'Exporting…') : (language === 'th' ? 'ส่งออก CSV' : 'Export CSV')}
            </Button>
            <p className="max-w-sm text-right text-xs text-muted-foreground">กล้องทุกตัวมาจาก edge — แอดหรือแก้กล้องที่เครื่อง edge แล้วจะอัปเดตมาเองทุก 10 นาที</p>
          </div>
        ) : (
        <div className="flex flex-wrap gap-2">
          {selectedCamerasForDelete.length > 0 && <Button variant="secondary" onClick={() => setAreaSelection({ cameras: allCameras.filter((c) => selectedCamerasForDelete.includes(c.id)), label: 'กล้องที่เลือก' })}>แก้จังหวัด–อำเภอ ({selectedCamerasForDelete.length})</Button>}
          {selectedCamerasForDelete.length > 0 && (
            <Button
              variant="destructive"
              onClick={() => triggerConfirm('bulk_delete')}
              className="h-10 px-4 text-xs font-bold uppercase tracking-widest gap-2 animate-in zoom-in duration-200"
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')} ({selectedCamerasForDelete.length})
            </Button>
          )}
          {unpinnedCount > 0 && (
            <Button
              variant="secondary"
              onClick={onGoToMapPins}
              className="h-10 px-4 text-xs font-bold uppercase tracking-widest gap-2 border bg-card hover:bg-muted"
            >
              <MapPin className="size-4" />
              ยังไม่ปักหมุด {unpinnedCount}
            </Button>
          )}
          {vmsSourceCount > 0 && (
            <Button
              variant="secondary"
              onClick={handleVmsResync}
              disabled={isLoading}
              className="h-10 px-4 text-xs font-bold uppercase tracking-widest gap-2 border bg-card hover:bg-muted"
            >
              <RefreshCw className="size-4" />
              Re-sync VMS
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={handleStartScan}
            className="h-10 px-4 text-xs font-bold uppercase tracking-widest gap-2 border bg-card hover:bg-muted"
          >
            <Search className="size-4" />
            {t('networkScan')}
          </Button>
           <Button
            onClick={openAddModal}
            className="h-10 px-6 text-xs font-medium gap-2"
          >
            <Plus className="size-4" />
            {t('addCamera')}
          </Button>
        </div>
        )}
      </div>

      {/* Search Bar */}
      <div className="relative px-2">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          placeholder={t('searchCameras')}
          className="h-10 pl-10 pr-4 text-sm font-medium bg-card border focus-visible:ring-1"
        />
        {searchTerm && (
          <div className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">
              {filteredTotal} {t('searchResults')}{filteredTotal !== 1 && language === 'en' ? 's' : ''}
            </span>
            <button
              onClick={() => setSearchTerm('')}
              className="size-5 bg-muted hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-all text-xs"
            >✕</button>
          </div>
        )}
      </div>

      {/* Grouped Camera Lists */}
      <div className="flex flex-col gap-4">
        {Object.keys(filteredGroupedCameras).sort().length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <Search className="size-10 opacity-20" />
            <div className="text-center">
              <p className="text-sm font-bold uppercase tracking-widest">{t('noCamerasFound')}</p>
              <p className="text-xs mt-1 opacity-60">{t('noCamerasFoundHint')}</p>
            </div>
          </div>
        ) : Object.keys(filteredGroupedCameras).sort().map(groupName => {
          const groupCams = filteredGroupedCameras[groupName];
          const groupOnline = groupCams.filter(c => !c.source_missing_at && cameraStatus[c.id] === 'online').length;
          const groupMissing = groupCams.filter(c => c.source_missing_at).length;
          // auto-expand เมื่อมีการค้นหา
          const isExpanded = searchTerm.trim() ? true : (expandedAssetGroups[groupName] ?? false);
          
          return (
          <Card key={groupName} className="border overflow-hidden bg-card">
            {/* Group Header */}
            <div
              className={cn(
                "px-5 py-3.5 flex justify-between items-center transition-colors cursor-pointer group",
                isExpanded ? "bg-muted/50 border-b" : "hover:bg-muted/30"
              )}
              onClick={() => setExpandedAssetGroups(prev => ({...prev, [groupName]: !isExpanded}))}
            >
               <div className="flex items-center gap-4">
                  <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform duration-300", !isExpanded && "-rotate-90")} />
                  <div className="flex items-center gap-2.5">
                    <div className="size-8 bg-primary/10 flex items-center justify-center text-primary border border-primary/10">
                      <FolderOpen className="size-4" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                       <h4 className="text-sm font-bold tracking-tight uppercase">{groupName}</h4>
                       <span className="text-xs text-muted-foreground font-mono font-semibold">
                          {groupOnline} {t('onlineLabel')} · {groupCams.length} {t('totalCameras')}
                          {groupMissing > 0 && <span className="text-destructive"> · {groupMissing} หายจาก edge</span>}
                       </span>
                    </div>
                  </div>
               </div>
               <div className="flex items-center gap-4">
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRenameGroup(groupName)}
                      className="h-8 text-[10px] font-bold text-primary hover:bg-primary/10 uppercase"
                    >
                      {t('renameGroup')}
                    </Button>
                    {!readOnly && <Button variant="ghost" size="sm" onClick={() => setAreaSelection({ cameras: groupedCameras[groupName], label: groupName })}>แก้จังหวัด–อำเภอทั้งกลุ่ม</Button>}
                    {!readOnly && <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => triggerConfirm('delete_group', groupName)}
                      className="h-8 text-[10px] font-bold text-destructive hover:bg-destructive/10 uppercase"
                    >
                      {t('deleteGroup')}
                    </Button>}
                  </div>
               </div>
            </div>

            {/* Table in Group */}
            {isExpanded && (
              <div className="animate-in fade-in duration-300">
                <Table>
                  <TableBody>
                    {filteredGroupedCameras[groupName].map(cam => (
                      <TableRow key={cam.id} className={cn("group hover:bg-muted/20 transition-all", selectedCamerasForDelete.includes(cam.id) && "bg-destructive/5")}>
                        <TableCell className="py-4 px-6 w-12">
                           {!readOnly && <input
                             type="checkbox"
                             checked={selectedCamerasForDelete.includes(cam.id)}
                             onChange={() => handleToggleSelectCamera(cam.id)}
                             className="size-4 border-muted-foreground/30 text-primary focus:ring-primary/20 cursor-pointer"
                           />}
                        </TableCell>
                        <TableCell className="py-4 px-6">
                           <div className="flex flex-col">
                              <span className="text-sm font-bold tracking-tight uppercase">{cam.name}</span>
                              <span className="text-[10px] text-muted-foreground font-mono opacity-60 mt-0.5">
                                {cam.global_id || cam.id}
                                {cam.type === 'edge_relay'
                                  ? ` • ${cameraOriginLabel(cam)}`
                                  : cam.ip ? ` • IP ${cam.ip}` : ''}
                              </span>
                           </div>
                        </TableCell>
                        <TableCell className="py-4 px-6">
                          <Badge variant="outline" className="text-[9px] font-mono font-semibold tracking-widest bg-muted/30">
                             {cam.type === 'edge_relay' ? 'EDGE' : cam.type?.replace('_', ' ').toUpperCase() || 'RTSP'}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-4 px-6">
                          {(() => {
                            const st = states[cam.id];
                            // edge ไม่มีกล้องนี้แล้ว (ไม่มีบันทึกว่าคนลบ) — ไม่ส่งภาพ ลบได้ที่ป้าย "หาย" ในหน้า Edge Nodes
                            if (cam.source_missing_at) {
                              return (
                                <div className="flex items-center gap-2.5" title={`หายจาก edge ตั้งแต่ ${cam.source_missing_at} — ลบได้ที่หน้า Edge Nodes`}>
                                  <span className="size-2 border border-destructive shrink-0" />
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-destructive">MISSING AT EDGE</span>
                                </div>
                              );
                            }
                            if (st?.enabled === false || cameraStatus[cam.id] === 'disabled') {
                              return (
                                <div className="flex items-center gap-2.5" title="ปิดใช้งานอยู่ — ไม่ดึงภาพ ไม่เช็คสถานะ">
                                  <span className="size-2 bg-muted-foreground/40 shrink-0" />
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-muted-foreground">DISABLED</span>
                                </div>
                              );
                            }
                            const isOnline = cameraStatus[cam.id] === 'online';
                            const noStream = !isOnline && deviceHealth[cam.id]?.health === 'no_stream';
                            // กล้องจาก edge ที่ edge ติดต่อไม่ได้ — ไม่รู้สถานะ ไม่ใช่กล้องดับ
                            const unknown = !isOnline && cam.type === 'edge_relay' && st && st.reachable === null;
                            if (isOnline) {
                              return (
                                <div className="flex items-center gap-2.5">
                                  <span className="size-2 bg-status-ok shrink-0" />
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-status-ok">ONLINE</span>
                                  {st?.streaming && (
                                    <span className="text-[9px] font-mono font-semibold uppercase tracking-widest text-muted-foreground" title="กำลังดึงภาพอยู่ (มีคนดู)">· LIVE</span>
                                  )}
                                </div>
                              );
                            }
                            if (unknown) {
                              return (
                                <div className="flex items-center gap-2.5" title="edge ที่ถือกล้องนี้ติดต่อไม่ได้ — ยังไม่รู้สถานะกล้อง">
                                  <span className="size-2 border border-status-warn shrink-0" />
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-status-warn">UNKNOWN</span>
                                </div>
                              );
                            }
                            if (noStream) {
                              return (
                                <div className="flex items-center gap-2.5" title={t('noStreamTooltip')}>
                                  <span className="size-2 bg-status-warn shrink-0" />
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-status-warn">ONLINE · NO STREAM</span>
                                </div>
                              );
                            }
                            return (
                              <div className="flex items-center gap-2.5">
                                <span className="size-2 border border-status-crit shrink-0" />
                                <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-muted-foreground">OFFLINE</span>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="py-4 px-6 text-right">
                          <div className="flex justify-end gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all">
                            {/*
                              แทนที่การกดดูวิดีโอสดแบบเดิม — หน้าเว็บไม่มีผู้เล่นวิดีโอแล้ว คำถามตรงนี้คือ
                              "RTSP ที่กรอกไปใช้ได้ไหม" ซึ่งภาพนิ่งภาพเดียวตอบได้ครบพอ ๆ กับวิดีโอ
                            */}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSnapshotCamera(cam);
                              }}
                              className="h-8 text-[10px] font-bold tracking-wide gap-1.5 hover:bg-primary hover:text-primary-foreground"
                              title="ทดสอบภาพจากกล้อง"
                            >
                              <CameraIcon className="size-3.5" />
                              ทดสอบภาพ
                            </Button>
                            {canLive && <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={states[cam.id]?.enabled === false}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setLiveCamera(cam);
                              }}
                              className="h-8 text-[10px] font-bold tracking-wide gap-1.5 hover:bg-primary hover:text-primary-foreground"
                              title="ดูภาพสด + PTZ"
                            >
                              <Video className="size-3.5" />
                              ดูสด
                            </Button>}
                            {!readOnly && <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={togglingId === cam.id}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                toggleEnabled(cam);
                              }}
                              className="h-8 text-[10px] font-bold tracking-wide gap-1.5 hover:bg-primary hover:text-primary-foreground"
                              title={states[cam.id]?.enabled === false ? 'เปิดใช้งานกล้องนี้' : 'ปิดใช้งาน — หยุดดึงภาพและไม่นับเป็นกล้องดับ'}
                            >
                              <Power className="size-3.5" />
                              {states[cam.id]?.enabled === false ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (typeof openMapPinEdit !== 'function') {
                                  console.error('[Cameras] openMapPinEdit missing');
                                  return;
                                }
                                openMapPinEdit(cam);
                              }}
                              className="h-8 text-[10px] font-bold tracking-wide gap-1.5 hover:bg-primary hover:text-primary-foreground"
                              title={t('editMapPin')}
                            >
                              <MapPin className="size-3.5" />
                              {t('editMapPin')}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                triggerConfirm('configure', cam);
                              }}
                              className="h-8 text-[10px] font-bold uppercase tracking-widest gap-2 hover:bg-primary hover:text-primary-foreground"
                            >
                              <Settings2 className="size-3.5" />
                              {t('configure')}
                            </Button>
                            </>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
          );
        })}
      </div>

      {areaSelection && <BulkCameraRegionModal cameras={areaSelection.cameras} label={areaSelection.label} onClose={() => setAreaSelection(null)} onSaved={onCamerasChanged} />}
      <ConfirmationDialog
        isOpen={confirmState.isOpen}
        onClose={() => setConfirmState({ isOpen: false, type: '', data: null })}
        onConfirm={executeConfirm}
        title={
          confirmState.type === 'bulk_delete' ? t('confirmBulkDeleteTitle') :
          confirmState.type === 'delete_group' ? t('confirmGroupDeleteTitle') :
          t('confirmConfigureTitle')
        }
        description={
          confirmState.type === 'bulk_delete'
            ? (language === 'th'
                ? `คุณแน่ใจหรือไม่ที่จะลบกล้องที่เลือกทั้ง ${selectedCamerasForDelete.length} ตัว? การลบนี้ไม่สามารถย้อนกลับได้`
                : `Delete the ${selectedCamerasForDelete.length} selected camera${selectedCamerasForDelete.length !== 1 ? 's' : ''}? This cannot be undone.`)
            : confirmState.type === 'delete_group'
            ? (language === 'th'
                ? `คุณแน่ใจหรือไม่ที่จะลบกลุ่ม "${confirmState.data}" และกล้องทั้งหมดในกลุ่มนี้?`
                : `Delete the group "${confirmState.data}" and every camera in it?`)
            : (language === 'th'
                ? `คุณต้องการเข้าสู่โหมดปรับแต่งการตั้งค่าของกล้อง "${confirmState.data?.name}" ใช่หรือไม่?`
                : `Enter configuration mode for camera "${confirmState.data?.name}"?`)
        }
        confirmText={confirmState.type === 'configure' ? t('enterSetup') : t('terminateAsset')}
        cancelText={t('abort')}
        variant={confirmState.type === 'configure' ? "default" : "destructive"}
      />

      <SnapshotModal
        camera={snapshotCamera}
        open={Boolean(snapshotCamera)}
        onClose={() => setSnapshotCamera(null)}
      />
      <LiveModal camera={liveCamera} open={Boolean(liveCamera)} onClose={() => setLiveCamera(null)} />
    </div>
  );
};

export default CameraManagement;
