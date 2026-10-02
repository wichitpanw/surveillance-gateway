import { Satellite, Map as MapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { setMapBase } from '@/lib/map-style';

/** ปุ่มสลับ ดาวเทียม / แผนที่ มุมซ้ายบนของแผนที่ — จำค่าที่เลือกไว้ต่อเครื่อง */
export default function MapBaseToggle({ base, onChange }) {
  const pick = (value) => {
    setMapBase(value);
    onChange(value);
  };
  const options = [
    { value: 'satellite', label: 'ดาวเทียม', icon: Satellite },
    { value: 'openstreetmap', label: 'แผนที่', icon: MapIcon },
  ];
  return (
    <div className="absolute left-3 top-3 z-10 flex overflow-hidden rounded-md border bg-card/95 text-xs shadow-md backdrop-blur">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            onClick={(e) => { e.stopPropagation(); pick(o.value); }}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
              base === o.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" /> {o.label}
          </button>
        );
      })}
    </div>
  );
}
