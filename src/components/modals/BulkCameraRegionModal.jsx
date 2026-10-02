import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import RegionPicker from '@/components/RegionPicker';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';

/** เปลี่ยนพื้นที่ทั้งกลุ่มหรือกล้องที่เลือก โดยให้ผู้ใช้เห็นจำนวนก่อนบันทึก */
export default function BulkCameraRegionModal({ cameras, label, onClose, onSaved }) {
  const [area, setArea] = useState(() => {
    const first = cameras[0];
    return cameras.every((c) => c.province_code === first?.province_code && c.district_code === first?.district_code)
      ? { province_code: first?.province_code, district_code: first?.district_code }
      : { province_code: null, district_code: null };
  });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/cameras/region', {
        method: 'PATCH', body: JSON.stringify({ ids: cameras.map((c) => c.id), ...area }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({ title: `แก้จังหวัด–อำเภอ ${data.changes} กล้องแล้ว` });
      await onSaved?.();
      onClose();
    } catch (err) { toast({ title: err.message, variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>แก้จังหวัด–อำเภอ</DialogTitle>
        <DialogDescription>{label} · {cameras.length} กล้อง — ใช้พื้นที่เดียวกันกับกล้องทั้งหมดที่ระบุ พิกัดและ Global ID คงเดิม</DialogDescription>
      </DialogHeader>
      <RegionPicker required isEdit provinceCode={area.province_code} districtCode={area.district_code} onChange={setArea} />
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onClose}>ยกเลิก</Button>
        <Button disabled={saving || !cameras.length || !area.province_code || !area.district_code} onClick={save}>{saving ? 'กำลังบันทึก…' : `บันทึก ${cameras.length} กล้อง`}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
