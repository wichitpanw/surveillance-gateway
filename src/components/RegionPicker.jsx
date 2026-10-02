import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiFetch } from '@/lib/api';

/*
  จังหวัด → อำเภอ ของกล้องหนึ่งตัว (รหัสกรมการปกครอง จาก server/data/thai-regions.csv)

  จังหวัดที่เลือกตอนแอดกล้องเข้าไปอยู่ใน global ID (TH-<จังหวัด>-…) ซึ่งออกครั้งเดียวแล้วไม่เปลี่ยน
  การเลือกผิดแล้วแก้ทีหลังจึงแก้ได้แค่ป้ายจังหวัด ไม่ใช่ตัว ID — บอกไว้ใต้ช่องให้เห็นก่อนกดบันทึก
*/
const NONE = '__none__';

export default function RegionPicker({ provinceCode, districtCode, onChange, isEdit = false, required = false }) {
  const [provinces, setProvinces] = useState([]);
  // อำเภอผูกกับจังหวัดที่โหลดมา — เปลี่ยนจังหวัดแล้วรายการเก่าต้องหายทันที ไม่ใช่ค้างจนคำขอใหม่กลับมา
  const [loaded, setLoaded] = useState({ parent: null, list: [] });
  const districts = loaded.parent === provinceCode ? loaded.list : [];

  useEffect(() => {
    apiFetch('/api/regions').then((r) => (r.ok ? r.json() : [])).then(setProvinces).catch(() => setProvinces([]));
  }, []);

  useEffect(() => {
    if (!provinceCode) return;
    apiFetch(`/api/regions?parent=${encodeURIComponent(provinceCode)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setLoaded({ parent: provinceCode, list }))
      .catch(() => setLoaded({ parent: provinceCode, list: [] }));
  }, [provinceCode]);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground ml-1">Province (จังหวัด){required && ' *'}</Label>
          <Select
            value={provinceCode || (required ? '' : NONE)}
            onValueChange={(val) => onChange({ province_code: val === NONE ? null : val, district_code: null })}
          >
            <SelectTrigger className="h-11 text-xs">
              <SelectValue placeholder="เลือกจังหวัด" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {!required && <SelectItem value={NONE} className="text-xs text-muted-foreground">— ยังไม่ระบุ —</SelectItem>}
              {provinces.map((p) => (
                <SelectItem key={p.code} value={p.code} className="text-xs">{p.name} · {p.code}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-muted-foreground ml-1">District (อำเภอ/เขต){required && ' *'}</Label>
          <Select
            value={districtCode || (required ? '' : NONE)}
            disabled={!provinceCode}
            onValueChange={(val) => onChange({ province_code: provinceCode, district_code: val === NONE ? null : val })}
          >
            <SelectTrigger className="h-11 text-xs">
              <SelectValue placeholder="เลือกอำเภอ" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {!required && <SelectItem value={NONE} className="text-xs text-muted-foreground">— ยังไม่ระบุ —</SelectItem>}
              {districts.map((d) => (
                <SelectItem key={d.code} value={d.code} className="text-xs">{d.name} · {d.code}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground ml-1">
        {required && 'ต้องเลือกจังหวัดและอำเภอ/เขต · '}
        {isEdit
          ? 'เปลี่ยนจังหวัดได้ แต่ global ID ของกล้องที่ออกไปแล้วจะไม่เปลี่ยนตาม'
          : 'จังหวัดจะอยู่ใน global ID ของกล้อง (TH-<จังหวัด>-…) ซึ่งออกครั้งเดียวแล้วไม่เปลี่ยน'}
      </p>
    </div>
  );
}
