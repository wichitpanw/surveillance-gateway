import { useCallback, useEffect, useState } from 'react';
import { Globe, Plus, Trash2, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';

/*
  ที่อยู่ของ central ที่ edge ใช้ต่อได้ — หนึ่งแถวต่อหนึ่งเส้นทาง (LAN, VPN/MPLS ของหน่วยงาน, IP ที่ NAT มา)

  central ไม่รู้เองว่า edge แต่ละแห่งเห็นตัวเองที่ที่อยู่ไหน (IP ที่ถูก route/NAT มาไม่ปรากฏบนเครื่อง) จึงให้ผู้ดูแล
  บันทึกไว้ ระบบเสนอ IP ของเครื่องให้เป็นจุดเริ่ม · กล่อง token ของ edge แบบ link ใช้รายการนี้สร้างคำสั่งตั้งค่า
  ให้ edge ลองทีละที่อยู่ตามลำดับ (server/vms/edge-link-client.js)
*/
export default function CentralEndpoints({ gatewayRole = 'central', canManage, onChange }) {
  const owner = gatewayRole === 'regional' ? 'Regional' : 'Central';
  const defaultPort = gatewayRole === 'regional' ? 5273 : 5173;
  const defaultRtsp = gatewayRole === 'regional' ? 8565 : 8555;
  const [rows, setRows] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/edges/endpoints');
      if (!res.ok) return;
      const data = await res.json();
      setRows(data.endpoints || []);
      setSuggestions(data.suggestions || []);
      setDirty(false);
      onChange?.(data.endpoints || []);
    } catch { /* ลองใหม่ตอนเปิดหน้าครั้งหน้า */ }
  }, [onChange]);

  useEffect(() => { load(); }, [load]);

  const update = (i, key, value) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
    setDirty(true);
  };
  const add = (seed = {}) => {
    setRows((prev) => [...prev, { label: '', host: '', port: defaultPort, rtspPort: defaultRtsp, ...seed }]);
    setDirty(true);
  };
  const remove = (i) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/edges/endpoints', { method: 'PUT', body: JSON.stringify({ endpoints: rows }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');
      setRows(data.endpoints);
      setDirty(false);
      onChange?.(data.endpoints);
      toast({ title: `บันทึกที่อยู่ของ ${owner} แล้ว` });
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const unused = suggestions.filter((s) => !rows.some((r) => r.host === s.host));

  return (
    <div className="space-y-3 rounded-md border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-medium"><Globe className="size-4" /> ที่อยู่ของ {owner} ที่ {gatewayRole === 'central' ? 'Regional' : 'Edge'} ใช้ต่อได้</div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            หนึ่งแถวต่อหนึ่งเส้นทาง (LAN, VPN/MPLS ของหน่วยงาน, IP ที่ NAT มา) · edge แบบต่อขึ้นมาเองจะลองตามลำดับแล้วใช้อันที่ต่อติด ·
            ถ้าเส้นทางนั้นแมปพอร์ตใหม่ ใส่พอร์ตที่ edge เห็นจากฝั่งนั้น (gateway และ RTSP ของ go2rtc)
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => add()}><Plus className="size-3.5" /> เพิ่ม</Button>
            <Button type="button" size="sm" className="gap-1.5" disabled={!dirty || saving} onClick={save}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} บันทึก
            </Button>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1.2fr_1.4fr_90px_90px_36px] gap-2 px-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>ชื่อเส้นทาง</span><span>host / IP</span><span>พอร์ต</span><span>RTSP</span><span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1.2fr_1.4fr_90px_90px_36px] items-center gap-2">
              <Input value={r.label} disabled={!canManage} onChange={(e) => update(i, 'label', e.target.value)} placeholder="เช่น VPN ตัวอย่าง" className="h-9 text-xs" />
              <Input value={r.host} disabled={!canManage} onChange={(e) => update(i, 'host', e.target.value.trim())} placeholder="10.x.x.x" className="h-9 font-mono text-xs" />
              <Input value={r.port} disabled={!canManage} onChange={(e) => update(i, 'port', e.target.value.replace(/\D/g, ''))} className="h-9 font-mono text-xs" />
              <Input value={r.rtspPort} disabled={!canManage} onChange={(e) => update(i, 'rtspPort', e.target.value.replace(/\D/g, ''))} className="h-9 font-mono text-xs" />
              {canManage
                ? <Button type="button" variant="ghost" size="icon" title="ลบ" onClick={() => remove(i)}><Trash2 className="size-4 text-destructive" /></Button>
                : <span />}
            </div>
          ))}
        </div>
      )}

      {!rows.length && (
        <p className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
          ยังไม่ได้ตั้ง — edge แบบต่อขึ้นมาเองจะได้แค่ที่อยู่ที่เบราว์เซอร์นี้ใช้เปิดเว็บ ซึ่ง edge ที่อยู่คนละวงอาจต่อไม่ถึง
        </p>
      )}

      {canManage && unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">IP ของเครื่องนี้:</span>
          {unused.map((s) => (
            <button key={s.host} type="button" onClick={() => add(s)}
              className="inline-flex items-center gap-1 rounded border px-2 py-1 font-mono transition-colors hover:bg-muted">
              <Plus className="size-3" /> {s.label} · {s.host}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
