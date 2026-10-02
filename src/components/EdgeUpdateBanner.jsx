import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';

/*
  แถบแจ้งเวอร์ชันใหม่บนหน้าเว็บของ edge (docs/EDGE-KIT.md หัวข้อ "อัปเดตผ่านสาย link")

  central ส่งข้อเสนอมาทางสาย link → edge โหลดและตรวจลายเซ็นเอง → แถบนี้บอกขั้นตอนและให้คนกดติดตั้ง
  การสลับโปรแกรมทำโดยตัวคุม edge-run (มีเฉพาะเครื่องที่ติดตั้งจากชุด flash drive) — เครื่องที่ใช้ pm2
  ได้แค่ขั้นตอนอัปเดตเอง
*/
const DISMISS_KEY = 'edgeUpdate.dismissedResult';

function Steps({ items }) {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  );
}

export default function EdgeUpdateBanner({ gatewayRole = 'edge', canInstall }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
  });

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/edge-update');
      if (res.ok) setSt(await res.json());
    } catch { /* ระหว่างติดตั้ง gateway ปิดอยู่ — รอบหน้าลองใหม่ */ }
  }, []);

  const active = st && ['downloading', 'installing'].includes(st.state);
  useEffect(() => {
    load();
    const t = setInterval(load, active ? 5000 : 60000);
    return () => clearInterval(t);
  }, [load, active]);

  if (!st) return null;

  const install = async () => {
    const ok = await appConfirm({
      title: `ติดตั้งเวอร์ชัน ${st.offer?.build}`,
      description: 'ภาพและสายไป central จะหยุดประมาณ 1 นาทีระหว่างสลับโปรแกรม ถ้าเวอร์ชันใหม่ต่อ central ไม่ติดภายใน 5 นาที ระบบถอยกลับเวอร์ชันเดิมเอง',
      confirmText: 'ติดตั้งตอนนี้',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/edge-update/apply', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'สั่งติดตั้งไม่สำเร็จ');
      toast({ title: `กำลังติดตั้ง ${data.build}`, description: 'หน้านี้จะหลุดไปครู่หนึ่ง แล้วกลับมาเอง' });
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/edge-update/retry', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ลองโหลดใหม่ไม่สำเร็จ');
      await load();
    } catch (err) { toast({ title: err.message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const last = st.lastResult;
  const resultKey = last ? `${last.build}@${last.at}` : null;
  const showResult = last && resultKey !== dismissed && Date.now() - Date.parse(last.at) < 7 * 86_400_000;
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, resultKey); } catch { /* ไม่เป็นไร */ }
    setDismissed(resultKey);
  };

  const box = 'mb-4 rounded-md border bg-card p-4 animate-in fade-in slide-in-from-top-2 duration-200';

  // ผลการติดตั้งครั้งล่าสุด (สำเร็จ / ถอยกลับ) — แสดงจนกว่าจะปิด
  if (showResult && !st.offer) {
    return (
      <div className={`${box} ${last.ok ? 'border-status-ok/40' : 'border-status-crit/40'}`}>
        <div className="flex items-start gap-3">
          {last.ok ? <CheckCircle2 className="mt-0.5 size-4 text-status-ok" /> : <AlertTriangle className="mt-0.5 size-4 text-status-crit" />}
          <div className="min-w-0 flex-1 text-sm">
            {last.ok
              ? <>อัปเดตจาก <span className="font-mono">{last.from}</span> เป็น <span className="font-mono">{last.build}</span> สำเร็จ</>
              : <>อัปเดตเป็น <span className="font-mono">{last.build}</span> ไม่สำเร็จ{last.rolledBack ? ` — ถอยกลับเป็น ${last.from} แล้ว` : ''}<div className="mt-1 text-xs text-muted-foreground">{last.error}</div></>}
          </div>
          <Button variant="ghost" size="icon" title="ปิด" onClick={dismiss}><X className="size-4" /></Button>
        </div>
      </div>
    );
  }

  if (!st.offer || st.state === 'idle') return null;
  const { offer } = st;
  const head = (
    <div className="flex items-center gap-2 font-medium">
      <ArrowUpCircle className="size-4 text-primary" /> มีเวอร์ชันใหม่ <span className="font-mono">{offer.build}</span>
      <span className="text-xs font-normal text-muted-foreground">(เครื่องนี้ <span className="font-mono">{st.current}</span>)</span>
    </div>
  );

  // เครื่องที่ไม่ได้ติดตั้งจากชุด flash drive (edge 001/002 ที่ใช้ pm2) — บอกวิธีอัปเดตเอง
  if (!st.canInstall) {
    return (
      <div className={`${box} border-primary/40`}>
        {head}
        <p className="mt-1 text-xs text-muted-foreground">เครื่องนี้ไม่ได้ติดตั้งจากชุด flash drive จึงติดตั้งจากหน้าเว็บไม่ได้ — อัปเดตตามขั้นตอนนี้</p>
        <Steps items={gatewayRole === 'regional' ? [
          'ติดตั้ง Regional จากชุด flash drive รุ่นใหม่ หรืออัปเดตบริการด้วยขั้นตอนของเครื่องนี้',
          'ตรวจว่า Regional ต่อ Central และ Edge จังหวัดต่อ Regional กลับครบหลังอัปเดต',
        ] : st.platform?.startsWith('linux') ? [
          'ที่เครื่องสร้างชุด (HOST) เปิด Git Bash ที่ D:\\gateway-dashboard',
          'รัน  scripts/deploy-edge.sh <ผู้ใช้>@<IP ของ edge นี้> --port 2222',
          'ที่เครื่อง edge นี้รัน  sudo systemctl restart gw-edge',
          'หน้า Edge Nodes ของ central ต้องขึ้น build ตรงกัน',
        ] : [
          'เครื่องนี้ใช้โค้ดชุดเดียวกับ central — อัปเดตพร้อม central',
          'ใน PowerShell แบบ admin รัน pm2 restart 3-edge-gateway (ดู docs/OPERATIONS.md)',
          'หรือถ้าจะย้ายมาใช้การอัปเดตอัตโนมัติ: ติดตั้งใหม่จากชุด flash drive (docs/EDGE-KIT.md)',
        ]} />
      </div>
    );
  }

  return (
    <div className={`${box} ${st.state === 'failed' ? 'border-status-crit/40' : 'border-primary/40'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {head}
          {st.state === 'downloading' && (
            <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> กำลังโหลดจาก central {st.progress}%</p>
          )}
          {st.state === 'ready' && (
            <Steps items={[
              'แพ็กเกจโหลดครบและตรวจลายเซ็นแล้ว',
              'เลือกช่วงที่ไม่มีใครต้องดูภาพสำคัญ — ภาพหยุดประมาณ 1 นาที',
              'กด "ติดตั้งตอนนี้" แล้วรอ หน้านี้จะหลุดแล้วกลับมาเอง',
              'ระบบรอให้เวอร์ชันใหม่ต่อ central ติดภายใน 5 นาที — ไม่ติดจะถอยกลับเวอร์ชันเดิมเอง',
            ]} />
          )}
          {st.state === 'installing' && (
            <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> กำลังติดตั้ง — อย่าปิดเครื่อง</p>
          )}
          {st.state === 'failed' && <p className="mt-1 text-xs text-status-crit">{st.error}{st.retryAt && ' · ระบบจะลองโหลดใหม่อัตโนมัติ'}</p>}
        </div>
        {st.state === 'failed' && st.retryable && canInstall && <Button onClick={retry} disabled={busy}>ลองโหลดใหม่</Button>}
        {st.state === 'ready' && (
          canInstall
            ? <Button onClick={install} disabled={busy} className="gap-2">{busy && <Loader2 className="size-4 animate-spin" />} ติดตั้งตอนนี้</Button>
            : <span className="text-xs text-muted-foreground">ต้องใช้สิทธิ์ดูแลระบบ (system.maintain)</span>
        )}
      </div>
    </div>
  );
}
