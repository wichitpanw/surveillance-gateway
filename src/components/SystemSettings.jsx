import React, { useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  BellRing, 
  Trash2, 
  Send, 
  Plus, 
  Settings, 
  MessageSquare,
  Bot,
  Download,
  Upload,
  Loader2
} from "lucide-react";
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';
import { useLanguage } from '@/lib/i18n';
import { apiFetch, getAuthHeaders, handleAuthExpired } from '@/lib/api';

/**
 * System Settings Component - Monochrome Shadcn Style
 */
const SystemSettings = ({
  systemSettings,
  setSystemSettings,
  setIsLoading,
}) => {
  const { t } = useLanguage();
  const fileInputRef = useRef(null);
  const [isRestoring, setIsRestoring] = useState(false);

  /** ดาวน์โหลดไฟล์สำรองฐานข้อมูล */
  const handleBackup = () => {
    setIsLoading(true);
    // session token (Bearer) จาก lib/api — หน้าเว็บไม่เก็บรหัสผ่านไว้ส่งเป็น header แล้ว
    apiFetch(`/api/system/backup`, { headers: getAuthHeaders() })
      .then(res => {
        if (res.status === 401) handleAuthExpired();
        if (!res.ok) throw new Error("Database download failed");
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vms-backup-${new Date().toISOString().split('T')[0]}.db`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setIsLoading(false);
      })
      .catch(e => {
        toast({ title: t('backupFailed') + ': ' + e.message, variant: 'destructive' });
        setIsLoading(false);
      });
  };

  const handleRestoreClick = () => {
    fileInputRef.current?.click();
  };

  /** อัปโหลดไฟล์เพื่อกู้คืนฐานข้อมูล */
  const handleRestoreFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ok = await appConfirm({
      title: t('restoreSystemTitle'),
      description: t('restoreSystemDesc'),
      confirmText: t('restore'),
      variant: 'destructive',
    });
    if (!ok) {
      e.target.value = '';
      return;
    }

    setIsLoading(true);
    setIsRestoring(true);

    const formData = new FormData();
    formData.append('backup', file);

    try {
      const res = await apiFetch(`/api/system/restore`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData
      });

      if (res.ok) {
        toast({ title: t('restoreSuccess') });
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      } else {
        const errData = await res.json();
        toast({ title: t('restoreFailed') + ': ' + (errData.error || 'Unknown error'), variant: 'destructive' });
        setIsLoading(false);
        setIsRestoring(false);
      }
    } catch (err) {
      toast({ title: t('restoreFailed') + ': ' + err.message, variant: 'destructive' });
      setIsLoading(false);
      setIsRestoring(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in font-sans pb-10">
      {/* Header Area */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 px-2">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">System Settings</h2>
          <p className="text-muted-foreground text-sm font-medium">Map provider, offline tiles, and system backup.</p>
        </div>
      </div>

      {/* Map Configuration Area */}
      <Card className="border shadow-sm overflow-hidden bg-card mt-2">
        <CardHeader className="bg-muted/10 border-b p-6">
          <CardTitle className="text-sm font-bold tracking-tight uppercase flex items-center gap-2">
            <Settings className="size-4 text-primary" />
            Map Provider Configuration
          </CardTitle>
          <p className="text-[11px] text-muted-foreground font-medium mt-1">
            {t('mapProviderDek')}
          </p>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-foreground uppercase tracking-wider">Map Source Engine</label>
              <select
                value={systemSettings.MAP_TYPE || 'satellite'}
                onChange={async (e) => {
                  const newType = e.target.value;
                  setIsLoading(true);
                  try {
                    const res = await apiFetch('/api/settings', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...getAuthHeaders(),
                      },
                      body: JSON.stringify({ MAP_TYPE: newType })
                    });
                    if (res.ok) {
                      setSystemSettings(prev => ({ ...prev, MAP_TYPE: newType }));
                      toast({ title: `${t('mapSwitchSuccess')} ${newType === 'satellite' ? 'Satellite' : newType === 'openstreetmap' ? 'OpenStreetMap (Online)' : newType === 'image' ? 'Image File' : 'MBTiles'} ${t('mapSwitchSuccessSuffix')}` });
                    }
                  } catch (err) {
                    toast({ title: t('mapSwitchFailed') + ': ' + err.message, variant: 'destructive' });
                  }
                  setIsLoading(false);
                }}
                className="h-10 px-3 rounded-lg border bg-background text-xs font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-full"
              >
                <option value="satellite">Satellite (Esri World Imagery)</option>
                <option value="openstreetmap">{t('mapOsmOption')}</option>
                <option value="mbtiles">{t('mapMbtilesOption')}</option>
                <option value="image">{t('mapImageOption')}</option>
              </select>
            </div>

            {/* Asset Upload Segment */}
            <div className="flex flex-col gap-2">
              {systemSettings.MAP_TYPE === 'mbtiles' && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold text-foreground uppercase tracking-wider">Upload MBTiles Database (.mbtiles)</label>
                  <div className="flex gap-2">
                    <input
                      type="file"
                      id="mbtiles-file-input"
                      accept=".mbtiles"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setIsLoading(true);
                        const formData = new FormData();
                        formData.append('mbtiles', file);
                        try {
                          const res = await apiFetch('/api/settings/upload-mbtiles', {
                            method: 'POST',
                            headers: getAuthHeaders(),
                            body: formData
                          });
                          if (res.ok) {
                            toast({ title: t('mbtilesUploadSuccess') });
                          } else {
                            toast({ title: t('mbtilesUploadFailed'), variant: 'destructive' });
                          }
                        } catch (err) {
                          toast({ title: t('uploadFailed') + ': ' + err.message, variant: 'destructive' });
                        }
                        setIsLoading(false);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() => document.getElementById('mbtiles-file-input')?.click()}
                      className="h-10 text-xs font-bold gap-2 w-full justify-center bg-background border-muted hover:bg-muted/40"
                    >
                      <Upload className="size-3.5" />
                      Choose & Upload MBTiles
                    </Button>
                  </div>
                </div>
              )}

              {systemSettings.MAP_TYPE === 'image' && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold text-foreground uppercase tracking-wider">Upload Map Image File (.png, .jpg, .jpeg)</label>
                  <div className="flex gap-2">
                    <input
                      type="file"
                      id="image-file-input"
                      accept=".png,.jpg,.jpeg"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setIsLoading(true);
                        const formData = new FormData();
                        formData.append('image', file);
                        try {
                          const res = await apiFetch('/api/settings/upload-map-image', {
                            method: 'POST',
                            headers: getAuthHeaders(),
                            body: formData
                          });
                          if (res.ok) {
                            const data = await res.json();
                            setSystemSettings(prev => ({ ...prev, MAP_IMAGE_PATH: data.image_url }));
                            toast({ title: t('mapImageUploadSuccess') });
                          } else {
                            toast({ title: t('mapImageUploadFailed'), variant: 'destructive' });
                          }
                        } catch (err) {
                          toast({ title: t('uploadFailed') + ': ' + err.message, variant: 'destructive' });
                        }
                        setIsLoading(false);
                        e.target.value = '';
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() => document.getElementById('image-file-input')?.click()}
                      className="h-10 text-xs font-bold gap-2 w-full justify-center bg-background border-muted hover:bg-muted/40"
                    >
                      <Upload className="size-3.5" />
                      Choose & Upload Map Image
                    </Button>
                  </div>
                </div>
              )}

              {(systemSettings.MAP_TYPE === 'openstreetmap' || !systemSettings.MAP_TYPE) && (
                <div className="text-xs font-semibold text-muted-foreground bg-muted/20 p-3 rounded-lg border border-dashed text-center">
                  {t('osmAutoConnectHint')}
                </div>
              )}
            </div>
          </div>
          
          {systemSettings.MAP_TYPE === 'image' && systemSettings.MAP_IMAGE_PATH && (
            <div className="mt-4 p-4 border rounded-xl bg-muted/10">
              <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground block mb-2">Current Map Image Path</span>
              <code className="text-xs font-mono text-primary select-all block bg-background px-3 py-2 rounded-lg border">{systemSettings.MAP_IMAGE_PATH}</code>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Maintenance Area - Claude Style */}
      <Card className="border shadow-sm overflow-hidden bg-card mt-2">
        <CardHeader className="bg-muted/10 border-b p-6">
          <CardTitle className="text-sm font-bold tracking-tight uppercase flex items-center gap-2">
            <Settings className="size-4 text-primary" />
            System Maintenance
          </CardTitle>
          <p className="text-[11px] text-muted-foreground font-medium mt-1">
            Perform database diagnostics, system configuration backup, and historical disaster recovery.
          </p>
        </CardHeader>
        <CardContent className="p-6 flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
          <div className="flex-1 flex flex-col gap-1 justify-center">
            <span className="text-xs font-bold text-foreground">Database Backup & Disaster Recovery</span>
            <span className="text-[10px] text-muted-foreground leading-relaxed">
              Backup includes all camera nodes, NVR settings, user accounts, and layout markers. Keep backups secure.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleRestoreFileChange} 
              className="hidden" 
              accept=".db"
            />
            <Button
              variant="outline"
              onClick={handleBackup}
              disabled={isRestoring}
              className="h-10 px-5 text-xs font-bold gap-2 bg-background border-muted hover:bg-muted/40"
            >
              <Download className="size-3.5" />
              Backup System
            </Button>
            <Button
              variant="default"
              onClick={handleRestoreClick}
              disabled={isRestoring}
              className="h-10 px-5 text-xs font-bold gap-2 hover:bg-primary/95 text-primary-foreground"
            >
              {isRestoring ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <Upload className="size-3.5" />
                  Restore System
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SystemSettings;
