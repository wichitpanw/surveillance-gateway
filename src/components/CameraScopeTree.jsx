import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Shield, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Checkbox tree เลือกกล้องแบบพับตามกลุ่ม — ใช้ร่วมกันระหว่าง RoleModal (device scope ของ role)
 * และ UserModal (สิทธิ์รายคนของ monitor)
 *
 * ต่างจากโค้ดเดิมใน UserModal ตรงที่เก็บ camera **id** ไม่ใช่ camera name — แก้บั๊กกล้องชื่อซ้ำ
 * ข้าม NVR (เช่น VideoSourceConfig_Channel8 มี 2 ตัวคนละเครื่อง) ที่เดิม assign ชื่อเดียวแล้วได้ทั้งคู่
 *
 * props:
 *   groupedCameras: { groupName: [{id, name}, ...] }
 *   value: string[] (camera ids ที่เลือก)
 *   onChange: (nextIds: string[]) => void
 */
export default function CameraScopeTree({ groupedCameras = {}, value = [], onChange }) {
  const [collapsed, setCollapsed] = useState({});
  const selected = Array.isArray(value) ? value : [];
  const sel = new Set(selected);

  const toggleCam = (id, checked) => {
    onChange(checked ? [...selected, id] : selected.filter((x) => x !== id));
  };
  const toggleGroup = (ids, allSelected) => {
    const next = allSelected
      ? selected.filter((id) => !ids.includes(id))
      : Array.from(new Set([...selected, ...ids]));
    onChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center px-1">
        <Label />
        <Badge variant="outline" className="h-5 text-[9px] font-mono">{selected.length} ASSIGNED</Badge>
      </div>
      <div className="space-y-4">
        {Object.entries(groupedCameras).sort().map(([groupName, groupCams]) => {
          const ids = groupCams.map((c) => c.id);
          const allSelected = ids.length > 0 && ids.every((id) => sel.has(id));
          const isCollapsed = !!collapsed[groupName];
          return (
            <Card key={groupName} className="overflow-hidden border-muted/50">
              <div
                onClick={() => setCollapsed((p) => ({ ...p, [groupName]: !p[groupName] }))}
                className="bg-muted/30 px-4 py-2 border-b flex justify-between items-center cursor-pointer hover:bg-muted/40 transition-colors select-none"
              >
                <div className="flex items-center gap-2">
                  {isCollapsed
                    ? <ChevronRight className="size-3.5 text-muted-foreground" />
                    : <ChevronDown className="size-3.5 text-muted-foreground" />}
                  <span className="text-[10px] font-black uppercase tracking-wider opacity-70">📁 {groupName}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); toggleGroup(ids, allSelected); }}
                  className={cn(
                    'h-6 text-[8px] font-black uppercase px-2 rounded-md',
                    allSelected ? 'text-destructive hover:bg-destructive/10' : 'text-primary hover:bg-primary/10'
                  )}
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              {!isCollapsed && (
                <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {groupCams.map((cam) => (
                    <label key={cam.id} className="flex items-center gap-3 p-2.5 rounded-md hover:bg-muted/50 transition-all cursor-pointer group">
                      <Checkbox
                        checked={sel.has(cam.id)}
                        onCheckedChange={(checked) => toggleCam(cam.id, checked)}
                      />
                      <span className="text-[11px] font-bold truncate uppercase opacity-60 group-hover:opacity-100 min-w-0">{cam.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// Label เล็กสำหรับหัวข้อ (แยกไว้ให้ผู้เรียกใส่เองได้ ไม่ผูกข้อความ)
function Label() {
  return (
    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
      <Shield className="size-3.5" /> Node Access
    </span>
  );
}
