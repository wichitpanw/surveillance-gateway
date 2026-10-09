import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { apiFetch, getJsonHeaders } from '@/lib/api';
import { toast } from '@/lib/toast';
import CameraScopeTree from '../CameraScopeTree';

// ป้ายอ่านง่ายของ perm key — key ที่ไม่มีในนี้จะโชว์ key ดิบ (ยังใช้งานได้)
const PERM_LABEL = {
  'menu.logs': 'System Logs', 'menu.users': 'Access Control', 'menu.settings': 'System Settings',
  'menu.live': 'Live view', 'menu.publiccam': 'Public Cam Map (Central)', 'device.ptz': 'Control PTZ (pan / tilt / zoom / presets)',
  'playback.view': 'View recorded video (playback)',
  'device.manage': 'Manage cameras & AI', 'device.secrets': 'View camera credentials',
  'user.manage': 'Manage users & roles', 'system.settings': 'System settings & notifications',
  'system.maintain': 'Backup / restore / resync', 'log.purge': 'Clear system logs', };

const TABS = [
  { id: 'menu', label: 'Menu' },
  { id: 'operation', label: 'Operations' },
  { id: 'device', label: 'Devices' },
];
const REGION_OPTIONS = [
  ['central', 'กลาง (รวม กทม./ปริมณฑล)'], ['north', 'เหนือ'], ['northeast', 'ตะวันออกเฉียงเหนือ'],
  ['east', 'ตะวันออก'], ['west', 'ตะวันตก'], ['south', 'ใต้'],
];

/**
 * สร้าง/แก้ role — 3 แกน: เมนู / การกระทำ / กล้อง
 * role.is_system (superadmin) เปิดดูได้แต่แก้ไม่ได้ (ทุก control disabled)
 */
export default function RoleModal({ open, onClose, mode, role, roles = [], catalogue, groupedCameras = {}, onSaved }) {
  const [tab, setTab] = useState('menu');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [perms, setPerms] = useState(new Set());
  const [allDevices, setAllDevices] = useState(false);
  const [deviceIds, setDeviceIds] = useState([]);
  const [areaRegions, setAreaRegions] = useState([]);
  const [areaProvinces, setAreaProvinces] = useState([]);
  const [provinceOptions, setProvinceOptions] = useState([]);
  const [saving, setSaving] = useState(false);

  const isEdit = mode === 'edit';
  const readOnly = isEdit && role?.is_system;

  useEffect(() => {
    if (!open) return;
    setTab('menu');
    if (isEdit && role) {
      setName(role.name || '');
      setLabel(role.label || '');
      setPerms(new Set(role.permissions || []));
      setAllDevices(Boolean(role.all_devices));
      setDeviceIds(Array.isArray(role.deviceIds) ? role.deviceIds : []);
      setAreaRegions(role.areaScope?.regions || []);
      setAreaProvinces(role.areaScope?.provinces || []);
    } else {
      setName(''); setLabel(''); setPerms(new Set()); setAllDevices(false); setDeviceIds([]);
      setAreaRegions([]); setAreaProvinces([]);
    }
  }, [open, isEdit, role]);

  useEffect(() => {
    if (!open) return;
    apiFetch('/api/regions', { headers: getJsonHeaders() })
      .then((res) => res.ok ? res.json() : [])
      .then((rows) => setProvinceOptions(Array.isArray(rows) ? rows : []))
      .catch(() => setProvinceOptions([]));
  }, [open]);

  const toggleArea = (value, setter) => setter((prev) => prev.includes(value)
    ? prev.filter((item) => item !== value) : [...prev, value]);

  const togglePerm = (key) => {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Copy from role — เติมทั้ง 3 แกนจาก role ที่เลือก
  const copyFrom = (roleId) => {
    const src = roles.find((r) => r.id === roleId);
    if (!src) return;
    setPerms(new Set(src.permissions || []));
    setAllDevices(Boolean(src.all_devices));
    setDeviceIds(Array.isArray(src.deviceIds) ? src.deviceIds : []);
    setAreaRegions(src.areaScope?.regions || []);
    setAreaProvinces(src.areaScope?.provinces || []);
    toast({ title: `คัดลอกสิทธิ์จาก ${src.label || src.name}` });
  };

  const save = async () => {
    if (!isEdit && !name.trim()) { toast({ title: 'ต้องใส่ชื่อ role', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(), label: label.trim() || name.trim(),
        permissions: [...perms], all_devices: allDevices, deviceIds,
        areaScope: { regions: areaRegions, provinces: areaProvinces },
      };
      const url = isEdit ? `/api/roles/${role.id}` : '/api/roles';
      const res = await apiFetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: getJsonHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({ title: isEdit ? 'บันทึก role แล้ว' : 'สร้าง role แล้ว' });
      onSaved?.();
      onClose();
    } catch (e) {
      toast({ title: e.message || 'บันทึกไม่สำเร็จ', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const menuKeys = catalogue?.menu || [];
  const opKeys = catalogue?.operation || [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-6 pb-4 border-b">
          <DialogTitle className="text-xl font-black uppercase tracking-tight">
            {isEdit ? (readOnly ? 'View Role' : 'Edit Role') : 'Create Role'}
          </DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            {readOnly ? 'System role — ดูได้อย่างเดียว แก้ไม่ได้' : 'กำหนดเมนู การกระทำ และกล้องที่ role นี้เข้าถึงได้'}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pt-4 space-y-4 shrink-0">
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Role Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. guard"
                disabled={isEdit /* ชื่อ = id เปลี่ยนไม่ได้หลังสร้าง */}
                className="h-10 font-mono text-xs"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Display Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Guard" disabled={readOnly} className="h-10 text-xs" />
            </div>
          </div>

          {!isEdit && roles.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Copy from role</Label>
              <Select onValueChange={copyFrom}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="เริ่มจาก role ที่มีอยู่ (ไม่บังคับ)" /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => <SelectItem key={r.id} value={r.id}>{r.label || r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* แท็บ 3 แกน */}
          <div className="flex gap-1 border-b">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'px-4 py-2 text-[11px] font-black uppercase tracking-wider border-b-2 -mb-px transition-colors',
                  tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
                {t.id === 'operation' && (
                  <Badge variant="outline" className="ml-2 h-4 text-[8px] font-mono">{opKeys.filter((k) => perms.has(k)).length}</Badge>
                )}
                {t.id === 'menu' && (
                  <Badge variant="outline" className="ml-2 h-4 text-[8px] font-mono">{menuKeys.filter((k) => perms.has(k)).length}</Badge>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 custom-scrollbar">
          {tab === 'menu' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {menuKeys.map((k) => (
                <label key={k} className={cn('flex items-center gap-3 p-2.5 rounded-md hover:bg-muted/50 cursor-pointer', readOnly && 'pointer-events-none opacity-70')}>
                  <Checkbox checked={perms.has(k)} onCheckedChange={() => togglePerm(k)} disabled={readOnly} />
                  <span className="text-[11px] font-bold uppercase">{PERM_LABEL[k] || k}</span>
                </label>
              ))}
            </div>
          )}

          {tab === 'operation' && (
            <div className="grid grid-cols-1 gap-2">
              {opKeys.map((k) => (
                <label key={k} className={cn('flex items-center gap-3 p-2.5 rounded-md hover:bg-muted/50 cursor-pointer', readOnly && 'pointer-events-none opacity-70')}>
                  <Checkbox checked={perms.has(k)} onCheckedChange={() => togglePerm(k)} disabled={readOnly} />
                  <div className="flex flex-col">
                    <span className="text-[11px] font-bold uppercase">{PERM_LABEL[k] || k}</span>
                    <span className="text-[9px] font-mono text-muted-foreground">{k}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          {tab === 'device' && (
            <div className="space-y-4">
              <label className={cn('flex items-center gap-3 p-3 rounded-md border cursor-pointer', readOnly && 'pointer-events-none opacity-70')}>
                <Checkbox checked={allDevices} onCheckedChange={(v) => setAllDevices(Boolean(v))} disabled={readOnly} />
                <div className="flex flex-col">
                  <span className="text-[11px] font-black uppercase">All devices</span>
                  <span className="text-[9px] text-muted-foreground">เห็นกล้องทุกตัว รวมกล้องที่เพิ่มในอนาคต</span>
                </div>
              </label>
              {!allDevices && (
                <div className={cn('space-y-4', readOnly && 'pointer-events-none opacity-70')}>
                  <div className="space-y-2">
                    <div className="text-xs font-bold">สิทธิ์ตามภาค</div>
                    <div className="grid grid-cols-2 gap-2">
                      {REGION_OPTIONS.map(([code, title]) => (
                        <label key={code} className="flex items-center gap-2 text-xs">
                          <Checkbox checked={areaRegions.includes(code)} onCheckedChange={() => toggleArea(code, setAreaRegions)} disabled={readOnly} />
                          {title}
                        </label>
                      ))}
                    </div>
                  </div>
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-xs font-bold">สิทธิ์รายจังหวัด ({areaProvinces.length})</summary>
                    <div className="mt-3 grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
                      {provinceOptions.map((province) => (
                        <label key={province.code} className="flex items-center gap-2 text-xs">
                          <Checkbox checked={areaProvinces.includes(province.code)} onCheckedChange={() => toggleArea(province.code, setAreaProvinces)} disabled={readOnly} />
                          {province.name}
                        </label>
                      ))}
                    </div>
                  </details>
                  <div className="text-xs font-bold">กล้องที่กำหนดเป็นรายตัว</div>
                  <CameraScopeTree groupedCameras={groupedCameras} value={deviceIds} onChange={setDeviceIds} />
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="p-6 pt-4 border-t flex-row gap-3 sm:justify-end">
          <Button variant="ghost" onClick={onClose} className="h-10 text-[11px] font-black uppercase">
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button onClick={save} disabled={saving} className="h-10 text-[11px] font-black uppercase">
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Role')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
