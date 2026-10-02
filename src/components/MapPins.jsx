import React, { useMemo, useState } from 'react';
import { apiFetch, getJsonHeaders } from '@/lib/api';
import { toast } from '@/lib/toast';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { MapPin, MapPinOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import PinMap from './PinMap';

const hasPin = (cam) =>
  Number.isFinite(parseFloat(cam?.lat)) && Number.isFinite(parseFloat(cam?.lng));

/**
 * หน้าปักหมุดกล้องเป็นชุด
 *
 * ทำขึ้นเพราะการนำเข้ากล้องจาก VMS ทีเดียวหลายสิบถึงหลักร้อยตัว ทำให้การเปิดฟอร์มแก้กล้อง
 * ทีละตัวเพื่อปักหมุดใช้เวลาเกินกว่าที่ใครจะทำจบ กล้องที่นำเข้ามาไม่มีพิกัดติดมาด้วยเลย
 * (Digifort ส่งฟิลด์ Latitude/Longitude มาก็จริง แต่เป็น 0 ทั้งหมด)
 *
 * วิธีใช้: ติ๊กกล้องที่อยู่จุดเดียวกันให้ครบ แล้วคลิกแผนที่หนึ่งครั้ง ทั้งชุดได้พิกัดเดียวกัน
 */
const MapPins = ({ cameras = [], theme, onCamerasChanged }) => {
  const [filter, setFilter] = useState('unpinned');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  const groups = useMemo(() => {
    const names = (cameras || []).map((c) => c.group_name || c.group || 'Default');
    return Array.from(new Set(names)).filter(Boolean).sort();
  }, [cameras]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (cameras || []).filter((cam) => {
      if (filter === 'unpinned' && hasPin(cam)) return false;
      if (filter === 'pinned' && !hasPin(cam)) return false;
      if (group !== 'all' && (cam.group_name || cam.group || 'Default') !== group) return false;
      if (q && !`${cam.name || ''} ${cam.group_name || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [cameras, filter, group, search]);

  const unpinnedCount = useMemo(() => (cameras || []).filter((c) => !hasPin(c)).length, [cameras]);

  const toggle = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** เขียนพิกัดให้กล้องหลายตัวในคำขอเดียว — lat/lng เป็น null คือถอนหมุด */
  const saveLocations = async (ids, lat, lng) => {
    if (!ids.length) return;
    setIsSaving(true);
    try {
      const res = await apiFetch('/api/cameras/locations', {
        method: 'POST',
        headers: getJsonHeaders(),
        body: JSON.stringify({ items: ids.map((id) => ({ id, lat, lng })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error || 'บันทึกหมุดไม่สำเร็จ', variant: 'destructive' });
        return;
      }
      toast({
        title: lat === null
          ? `ถอนหมุด ${data.updated} ตัว`
          : `ปักหมุด ${data.updated} ตัวที่ ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
      });
      setSelectedIds([]);
      await onCamerasChanged?.();
    } catch (e) {
      toast({ title: e.message || 'บันทึกหมุดไม่สำเร็จ', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleMapClick = (lat, lng) => {
    if (!selectedIds.length) {
      toast({ title: 'เลือกกล้องก่อน แล้วคลิกจุดบนแผนที่', variant: 'destructive' });
      return;
    }
    saveLocations(selectedIds, lat, lng);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 px-2">
        <div>
          <h2 className="text-xl font-bold tracking-tight">ปักหมุดกล้อง</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            เลือกกล้องที่อยู่จุดเดียวกันให้ครบ แล้วคลิกตำแหน่งบนแผนที่หนึ่งครั้ง
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={unpinnedCount ? "default" : "secondary"} className="h-7 px-3 text-[11px] font-bold">
            ยังไม่ปัก {unpinnedCount} ตัว
          </Badge>
          <Button
            variant="secondary"
            disabled={!selectedIds.length || isSaving}
            onClick={() => saveLocations(selectedIds, null, null)}
            className="h-9 px-4 text-xs font-bold gap-2 border bg-card hover:bg-muted"
          >
            <MapPinOff className="size-4" />
            ถอนหมุดที่เลือก
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
        <Card className="p-4 space-y-3 h-[70vh] flex flex-col">
          <div className="flex gap-1">
            {[['unpinned', 'ยังไม่ปัก'], ['pinned', 'ปักแล้ว'], ['all', 'ทั้งหมด']].map(([key, label]) => (
              <Button
                key={key}
                variant="ghost"
                onClick={() => setFilter(key)}
                className={cn(
                  "flex-1 h-8 rounded-lg text-[11px] font-bold",
                  filter === key ? "bg-muted text-primary" : "text-muted-foreground",
                )}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อกล้อง"
              className="h-9 pl-9 text-xs"
            />
          </div>

          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-xs font-bold"
          >
            <option value="all">ทุกกลุ่ม</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
            <span>{visible.length} ตัวในรายการ · เลือก {selectedIds.length}</span>
            <Button
              variant="link"
              className="h-auto p-0 text-[11px] font-bold"
              onClick={() => setSelectedIds(
                visible.every((c) => selectedIds.includes(c.id)) ? [] : visible.map((c) => c.id),
              )}
            >
              {visible.every((c) => selectedIds.includes(c.id)) && visible.length ? 'ล้างการเลือก' : 'เลือกทั้งรายการ'}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {visible.map((cam) => (
              <div
                key={cam.id}
                className={cn(
                  "flex items-center gap-3 p-2.5 rounded-lg border bg-card hover:bg-muted/50 transition-all",
                  selectedIds.includes(cam.id) && "border-primary bg-muted/40",
                )}
              >
                <Checkbox
                  id={`pin-${cam.id}`}
                  checked={selectedIds.includes(cam.id)}
                  onCheckedChange={() => toggle(cam.id)}
                />
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`pin-${cam.id}`} className="text-xs font-bold cursor-pointer block truncate">
                    {cam.name}
                  </Label>
                  <span className="text-[10px] text-muted-foreground font-mono block truncate">
                    {cam.group_name || cam.group || 'Default'}
                    {hasPin(cam) && ` · ${parseFloat(cam.lat).toFixed(5)}, ${parseFloat(cam.lng).toFixed(5)}`}
                  </span>
                </div>
                {hasPin(cam) && <MapPin className="size-3.5 text-primary shrink-0" />}
              </div>
            ))}
            {visible.length === 0 && (
              <div className="py-10 text-center text-xs font-bold opacity-40">ไม่มีกล้องตามเงื่อนไขนี้</div>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden h-[70vh]">
          <PinMap
            cameras={cameras}
            selectedIds={selectedIds}
            theme={theme}
            onMapClick={handleMapClick}
            onPickGroup={(ids) => setSelectedIds(ids)}
            onMoveGroup={(ids, lat, lng) => saveLocations(ids, lat, lng)}
          />
        </Card>
      </div>
    </div>
  );
};

export default MapPins;
