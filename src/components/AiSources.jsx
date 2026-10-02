import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';

const STATUS = { disabled: 'ปิดรับ', camera_disabled: 'กล้องปิดใช้งาน', waiting: 'รอเชื่อมต่อ', connected: 'เชื่อมต่อแล้ว',
  disconnected: 'ติดต่อไม่ได้', auth_error: 'บัญชีกล้องถูกปฏิเสธ', api: 'รับผ่าน API key' };

/** แหล่งรับผล AI ของ Edge — เส้น/โซนตั้งที่ต้นทางซึ่งประมวลผลเอง */
export default function AiSources({ canManage = false }) {
  const [cameras, setCameras] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [group, setGroup] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/ai/sources');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'โหลดแหล่งรับ AI ไม่สำเร็จ');
      const next = body.cameras || [];
      setCameras(next); setError(null);
      setGroup((old) => !old || next.some((cam) => (cam.group || 'Default') === old) ? old : '');
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [load]);
  const change = (cam, key, value) => setDrafts((old) => ({ ...old, [cam.id]: { ...(old[cam.id] || cam), [key]: value } }));
  const save = async (cam) => {
    setSaving(cam.id);
    try {
      const d = drafts[cam.id] || cam;
      const res = await apiFetch('/api/ai/sources/' + encodeURIComponent(cam.id), {
        method: 'PUT', body: JSON.stringify({ driver: d.driver, enabled: d.enabled, channel: Number(d.channel), timeMode: d.timeMode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'บันทึกไม่สำเร็จ');
      setDrafts((old) => { const next = { ...old }; delete next[cam.id]; return next; });
      toast({ title: 'บันทึกแหล่งรับ AI แล้ว' }); await load();
    } catch (e) { toast({ title: e.message, variant: 'destructive' }); }
    finally { setSaving(null); }
  };
  const groups = [...new Set(cameras.map((cam) => cam.group || 'Default'))].sort((a, b) => a.localeCompare(b, 'th'));
  const visibleCameras = cameras.filter((cam) => !group || (cam.group || 'Default') === group);
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-2xl tracking-tight">AI Sources</h2>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="mr-2 size-4" />รีเฟรช</Button>
      </div>
      <label className="flex items-center gap-2 text-sm">Group
        <select aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 rounded-md border bg-background px-2">
          <option value="">ทุกกลุ่ม</option>
          {groups.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/40"><tr>
            <th className="p-3">กล้อง</th><th className="p-3">แหล่งรับหลัก</th><th className="p-3">เปิดรับ</th><th className="p-3">สถานะตัวรับ</th><th className="p-3">บันทึก</th>
          </tr></thead>
          <tbody>{visibleCameras.map((cam) => {
            const d = drafts[cam.id] || cam;
            return <tr key={cam.id} className="border-b last:border-0">
              <td className="p-3"><div>{cam.name}</div><div className="text-xs text-muted-foreground">{cam.globalId || cam.id}</div></td>
              <td className="p-3">
                <select aria-label={'แหล่งรับ ' + cam.name} className="h-9 rounded-md border bg-background px-2" disabled={!canManage}
                  value={d.driver} onChange={(e) => change(cam, 'driver', e.target.value)}>
                  <option value="api">API ภายนอก</option>
                  <option value="device" disabled={!cam.deviceSupported}>อุปกรณ์ต้นทาง</option>
                </select>
                {d.driver === 'device' && <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label>ช่อง <input aria-label={'ช่อง ' + cam.name} type="number" min="1" max="1024" className="w-16 rounded border bg-background px-2 py-1"
                    disabled={!canManage} value={d.channel} onChange={(e) => change(cam, 'channel', e.target.value)} /></label>
                  {String(cam.brand).toLowerCase() !== 'uniview' && <select aria-label={'วิธีอ่านเวลา ' + cam.name} className="rounded border bg-background px-2 py-1" disabled={!canManage}
                    value={d.timeMode} onChange={(e) => change(cam, 'timeMode', e.target.value)}>
                    <option value="bangkok-wall">เวลาหน้าปัดไทย</option><option value="utc">UTC ตามต้นทาง</option>
                  </select>}
                </div>}
              </td>
              <td className="p-3"><input aria-label={'เปิดรับ ' + cam.name} type="checkbox" disabled={!canManage}
                checked={d.enabled} onChange={(e) => change(cam, 'enabled', e.target.checked)} /></td>
              <td className="p-3"><div>{STATUS[cam.status] || cam.status}</div>
                {cam.lastSuccessAt && <div className="text-xs text-muted-foreground">อ่านล่าสุด {cam.lastSuccessAt.slice(0, 19).replace('T', ' ')}</div>}
                {cam.lastEventAt && <div className="text-xs text-muted-foreground">เหตุล่าสุด {cam.lastEventAt.slice(0, 19).replace('T', ' ')}</div>}
                {cam.error && <div className="max-w-80 break-words text-xs text-destructive">{cam.error}</div>}
              </td>
              <td className="p-3"><Button size="sm" disabled={!canManage || saving === cam.id || !drafts[cam.id]} onClick={() => save(cam)}>
                <Save className="mr-2 size-4" />{saving === cam.id ? 'กำลังบันทึก' : 'บันทึก'}
              </Button></td>
            </tr>;
          })}</tbody>
        </table>
        {!visibleCameras.length && <p className="p-5 text-sm text-muted-foreground">{group ? 'ไม่มีกล้องในกลุ่มนี้' : 'ยังไม่มีกล้องต้นทาง'}</p>}
      </div>
    </div>
  );
}
