import { useEffect, useState } from 'react';
import { Download, HardDrive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/*
  ดาวน์โหลดชุดติดตั้ง Surveillance Gateway Edge จาก central — เลือกระบบปฏิบัติการของเครื่อง edge
  (docs/EDGE-KIT.md) · ไฟล์มาจาก scripts/build-edge-kit.ps1 -Publish · ไม่มี secret ในชุด —
  ค่าของเครื่อง (เลข edge, token) อยู่ในไฟล์ edge-<เลข>.json ที่ได้ตอนออก token แยกต่างหาก
*/
const OS = [
  { platform: 'windows-x64', label: 'Windows (x64)', hint: 'mini PC / PC ทั่วไป', steps: ['แตก .zip ลง flash drive', 'วาง edge-<เลข>.json ไว้ข้าง install-windows.cmd', 'ที่เครื่อง edge ดับเบิลคลิก install-windows.cmd'] },
  { platform: 'linux-arm64', label: 'Raspberry Pi 5 (Linux arm64)', hint: 'Raspberry Pi OS / Ubuntu arm64', steps: ['ก๊อป .tar.gz ลง flash drive แล้วแตก: tar -xzf Edge-linux-arm64-….tar.gz', 'วาง edge-<เลข>.json ไว้ข้าง install-linux.sh', 'sudo bash install-linux.sh'] },
  { platform: 'linux-x64', label: 'Linux (x64)', hint: 'Ubuntu 22/24 บน PC', steps: ['ก๊อป .tar.gz ลงเครื่องแล้วแตก: tar -xzf Edge-linux-x64-….tar.gz', 'วาง edge-<เลข>.json ไว้ข้าง install-linux.sh', 'sudo bash install-linux.sh'] },
];

const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;

export default function EdgeKitDownload({ gatewayRole = 'central' }) {
  const [kits, setKits] = useState(null);
  const [os, setOs] = useState('windows-x64');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch('/api/edge-kits')
      .then((r) => (r.ok ? r.json() : { kits: [] }))
      .then((d) => setKits(d.kits || []))
      .catch(() => setKits([]));
  }, []);

  const kit = kits?.find((k) => k.platform === os);
  const info = OS.find((o) => o.platform === os);

  const download = async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/edge-kits/${encodeURIComponent(kit.file)}/ticket`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'ขอลิงก์ดาวน์โหลดไม่สำเร็จ');
      // ลิงก์ตรง (ตั๋วใช้ครั้งเดียว) — เบราว์เซอร์ดาวน์โหลดเองพร้อมแถบความคืบหน้า ไม่ต้องถือไฟล์ 300 MB ในหน่วยความจำ
      window.location.href = data.url;
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border bg-card p-5">
      <div>
        <div className="flex items-center gap-2 font-medium"><HardDrive className="size-4" /> ดาวน์โหลดตัวติดตั้ง {gatewayRole === 'central' ? 'Regional' : 'Edge จังหวัด'}</div>
        <p className="mt-1 text-xs text-muted-foreground">
          ติดตั้งได้โดยไม่ต้องใช้ internet ที่หน้างาน · ต้องใช้คู่กับไฟล์ edge-&lt;เลข&gt;.json จากปุ่ม {gatewayRole === 'central' ? 'Add Regional' : 'Add Edge'} → "เครื่องลูกต่อขึ้นมาเอง"
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {OS.map((o) => {
          const has = kits?.some((k) => k.platform === o.platform);
          return (
            <button key={o.platform} type="button" onClick={() => setOs(o.platform)}
              className={cn('rounded border px-3 py-2 text-left text-xs transition-colors', os === o.platform ? 'border-primary bg-primary/10' : 'hover:bg-muted', !has && kits && 'opacity-60')}>
              <div className="font-medium">{o.label}</div>
              <div className="text-[11px] text-muted-foreground">{o.hint}</div>
            </button>
          );
        })}
      </div>
      {kits === null ? (
        <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline size-3 animate-spin" /> กำลังโหลดรายการ</p>
      ) : kit ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded bg-muted/40 px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xs">{kit.file} · {mb(kit.size)} · build {kit.build}</div>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
              {info.steps.map((s) => <li key={s}>{gatewayRole === 'central' ? s.replace('ที่เครื่อง edge', 'ที่เครื่อง Regional') : s}</li>)}
              <li>เปิดเว็บตามที่อยู่ที่ขึ้นบนจอ → เปลี่ยนรหัส superadmin → {gatewayRole === 'central' ? 'แอด Edge' : 'แอดกล้อง'}</li>
            </ol>
            <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground" title="ใช้ตรวจว่าไฟล์ครบ">sha256 {kit.sha256}</div>
          </div>
          <Button onClick={download} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} ดาวน์โหลด
          </Button>
        </div>
      ) : (
        <p className="rounded bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
          ยังไม่มีชุดติดตั้งสำหรับ {info.label} — ผู้ดูแลต้องรัน scripts\build-edge-kit.ps1 -Publish ที่เครื่อง central ก่อน
        </p>
      )}
    </div>
  );
}
