import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronRight, Layers, Search } from 'lucide-react';

/**
 * ตัวเลือกกลุ่มกล้องสำหรับจำกัดขอบเขตของ API key
 *
 * เดิมเป็นรายการแบนในกล่องสูง 128px ซึ่งอ่านได้ดีตอนมีสามกลุ่ม แต่พังเงียบ ๆ เมื่อระบบโต:
 * กลุ่มที่หกเป็นต้นไปต้องเลื่อนหาในกล่องสูงเท่าสี่บรรทัด และไม่มีทางรู้ว่ากลุ่มหนึ่ง ๆ มีกล้อง
 * ตัวไหนอยู่บ้าง นอกจากเปิดหน้า Cameras ไปเทียบเอง
 *
 * โครงใหม่พับได้สองระดับ:
 *
 *   - ทั้งบล็อกหุบเป็นค่าเริ่มต้น เพราะค่าปกติของช่องนี้คือ "ไม่จำกัด" ฟอร์มออก key จึงสั้น
 *     สำหรับกรณีที่พบบ่อยที่สุด และหัวข้อสรุปให้เห็นว่าตอนนี้เลือกอะไรไว้โดยไม่ต้องกาง
 *
 *   - แต่ละกลุ่มกางดูรายชื่อกล้องข้างในได้ ส่วนนี้เป็นข้อมูลอย่างเดียว ติ๊กไม่ได้ เพราะสัญญา
 *     ของ API จำกัดขอบเขตด้วย "ชื่อกลุ่ม" ไม่ใช่รายกล้อง (ดู scope_groups ใน
 *     server/gateway/auth.js) การใส่ checkbox รายกล้องจะสื่อว่าเลือกได้ทั้งที่เลือกไม่ได้
 *
 * ช่องค้นหาโผล่เมื่อมีกลุ่มมากพอที่การกวาดสายตาจะเริ่มไม่ไหวเท่านั้น — สามกลุ่มกับช่องค้นหา
 * คือ UI ที่ดูยุ่งกว่าปัญหาที่มันแก้
 *
 * props:
 *   groupedCameras: { groupName: [{ id, name }, ...] }
 *   value: string[] — ชื่อกลุ่มที่เลือก, array ว่าง = ไม่จำกัด
 *   onChange: (nextGroups: string[]) => void
 */
export default function ScopeGroupPicker({ groupedCameras = {}, value = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState({});

  const groupNames = useMemo(
    () => Object.keys(groupedCameras).sort((a, b) => a.localeCompare(b, 'th')),
    [groupedCameras],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? groupNames.filter((g) => g.toLowerCase().includes(q)) : groupNames;
  }, [groupNames, filter]);

  const selected = Array.isArray(value) ? value : [];
  const cameraCount = selected.reduce((n, g) => n + (groupedCameras[g]?.length ?? 0), 0);

  const toggle = (g, checked) =>
    onChange(checked ? [...selected, g] : selected.filter((x) => x !== g));

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <Layers className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">จำกัดกลุ่มกล้อง</span>
        <span className="ml-auto shrink-0">
          {selected.length === 0 ? (
            <Badge variant="outline" className="h-5 text-[10px] font-normal">
              ทุกกลุ่ม รวมที่เพิ่มในอนาคต
            </Badge>
          ) : (
            <Badge className="h-5 text-[10px] font-normal">
              {selected.length} กลุ่ม · {cameraCount} กล้อง
            </Badge>
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t p-2">
          {groupNames.length > 5 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`ค้นหาใน ${groupNames.length} กลุ่ม`}
                className="h-8 pl-7 text-xs"
              />
            </div>
          )}

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={shown.length === 0}
              onClick={() => onChange(Array.from(new Set([...selected, ...shown])))}
            >
              เลือกที่เห็นทั้งหมด
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={selected.length === 0}
              onClick={() => onChange([])}
            >
              ล้าง
            </Button>
          </div>

          {groupNames.length === 0 && (
            <p className="py-1 text-xs text-muted-foreground">ยังไม่มีกลุ่มกล้องในระบบ</p>
          )}
          {groupNames.length > 0 && shown.length === 0 && (
            <p className="py-1 text-xs text-muted-foreground">ไม่พบกลุ่มที่ตรงกับคำค้น</p>
          )}

          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {shown.map((g) => {
              const cams = groupedCameras[g] || [];
              const isOpen = !!expanded[g];
              return (
                <div key={g}>
                  <div className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/40">
                    <Checkbox
                      id={`scope-group-${g}`}
                      checked={selected.includes(g)}
                      onCheckedChange={(v) => toggle(g, v)}
                    />
                    <label
                      htmlFor={`scope-group-${g}`}
                      className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                    >
                      {g}
                    </label>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {cams.length} กล้อง
                    </span>
                    {/*
                      ปุ่มกางแยกจาก label โดยตั้งใจ — ถ้าคลิกชื่อกลุ่มแล้วทั้งกางทั้งติ๊ก
                      ผู้ใช้จะเผลอเปลี่ยนขอบเขตของ key ทั้งที่แค่อยากดูว่ามีกล้องอะไรอยู่
                    */}
                    <button
                      type="button"
                      onClick={() => setExpanded((p) => ({ ...p, [g]: !p[g] }))}
                      disabled={cams.length === 0}
                      title={isOpen ? 'ซ่อนรายชื่อกล้อง' : 'ดูรายชื่อกล้อง'}
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      {isOpen
                        ? <ChevronDown className="size-3.5" />
                        : <ChevronRight className="size-3.5" />}
                    </button>
                  </div>

                  {isOpen && (
                    <ul className="ml-6 border-l pb-1 pl-3">
                      {cams.map((c) => (
                        <li key={c.id} className="truncate py-0.5 text-[11px] text-muted-foreground">
                          {c.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground">
            ไม่ติ๊กเลย = เห็นทุกกลุ่ม รวมกล้องที่เพิ่มในอนาคต · ติ๊กแล้วจะเห็นเฉพาะกลุ่มที่เลือก
          </p>
        </div>
      )}
    </div>
  );
}
