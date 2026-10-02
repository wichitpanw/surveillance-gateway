import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * HardwareMonitor — แถบสถานะ CPU / GPU / RAM ของ "เครื่องที่รัน backend" (Linux VM)
 * วางไว้ข้าง ACTIVE NODES บน header ให้เห็นภาระเครื่องได้ตลอดโดยไม่ต้องเข้าหน้า dashboard
 *
 * ค่าทั้งหมดมาจาก /api/stats ที่ App.jsx โพลอยู่แล้วทุก 10 วินาที
 * ถ้าเครื่องไม่มี NVIDIA GPU backend จะส่ง gpu: null มา แล้วเราซ่อนช่อง GPU ทิ้งไปเลย
 */

// เขียว < 60% / เหลือง < 85% / แดง เกินนั้น — ให้เหลือบตาแล้วรู้ทันทีว่าเครื่องเริ่มตึง
const loadColor = (pct) => {
  if (pct >= 85) return 'text-red-500';
  if (pct >= 60) return 'text-amber-500';
  return 'text-emerald-500';
};

const barColor = (pct) => {
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-emerald-500';
};

const Metric = ({ label, pct, detail, tip }) => {
  const safePct = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 cursor-default">
          <span className="text-[9px] font-black uppercase tracking-widest opacity-50">{label}</span>
          <div className="flex flex-col gap-0.5 w-12">
            <span className={`text-[10px] font-black leading-none tabular-nums ${loadColor(safePct)}`}>
              {safePct.toFixed(0)}%
            </span>
            <div className="h-[3px] w-full rounded-full bg-foreground/10 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColor(safePct)}`}
                style={{ width: `${safePct}%` }}
              />
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        <div className="font-bold">{tip || label}</div>
        {detail && <div className="opacity-70">{detail}</div>}
      </TooltipContent>
    </Tooltip>
  );
};

const HardwareMonitor = ({ systemStats }) => {
  if (!systemStats) return null;

  const cpu = Number(systemStats.cpu) || 0;
  const ram = Number(systemStats.ram) || 0;
  const usedRamGB = Number(systemStats.usedRamGB) || 0;
  const totalRamGB = Number(systemStats.totalRamGB) || 0;

  // backend ส่ง gpu มาเป็น array (รองรับหลายใบ) — แสดงใบแรก แล้วสรุปที่เหลือใน tooltip
  const gpus = Array.isArray(systemStats.gpu) ? systemStats.gpu : null;
  const gpu0 = gpus?.[0] || null;

  return (
    <div className="hidden md:flex items-center gap-4 px-4 py-1.5 rounded-full bg-primary/5 border border-primary/10 shadow-inner">
      <Metric
        label="CPU"
        pct={cpu}
        tip="CPU Load"
        detail={`${cpu.toFixed(1)}% ของทั้งเครื่อง`}
      />

      {gpu0 && (
        <Metric
          label="GPU"
          pct={gpu0.util}
          tip={gpu0.name}
          detail={[
            `VRAM ${(gpu0.memUsedMB / 1024).toFixed(1)} / ${(gpu0.memTotalMB / 1024).toFixed(1)} GB`,
            gpu0.temp ? `${gpu0.temp}°C` : null,
            gpus.length > 1 ? `+ อีก ${gpus.length - 1} ใบ` : null,
          ].filter(Boolean).join(' · ')}
        />
      )}

      <Metric
        label="RAM"
        pct={ram}
        tip="Memory"
        detail={`${usedRamGB.toFixed(1)} / ${totalRamGB.toFixed(1)} GB`}
      />
    </div>
  );
};

export default HardwareMonitor;
