import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { KeyRound, Plus, Trash2, Copy, ShieldAlert, Eye } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/lib/toast';
import { appConfirm } from '@/lib/appDialog';
import { formatThaiDateTime } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import ScopeGroupPicker from '@/components/ScopeGroupPicker';

/**
 * หน้าจัดการ API key ของ API Gateway (/api/v1)
 *
 * key ที่ออกจากที่นี่คือสิ่งที่ระบบภายนอก เช่น Edge AI ที่รันคนละเครื่อง ใช้ดึง
 * สตรีมและ metadata ไปใช้ — ต่างจากบัญชีผู้ใช้ตรงที่ไม่ผูกกับคน เพิกถอนได้ทีละใบ
 * โดยไม่กระทบใคร และไม่มีสิทธิ์เข้าหน้าเว็บนี้เลย
 *
 * การตรวจตอนยืนยันตัวตนใช้ hash ของ key เท่านั้น ส่วนตัว key ถูกเก็บไว้แบบเข้ารหัสอีกช่อง
 * หนึ่ง (กุญแจอยู่นอกฐานข้อมูล ดู server/gateway/key-vault.js) จึงเปิดดูซ้ำได้จากปุ่มรูปตา
 * ในตาราง — ใบที่ออกก่อนมีระบบนี้เปิดดูไม่ได้ตลอดไป และปุ่มจะถูกปิดพร้อมบอกเหตุผล
 */
// showPublic: คอลัมน์ "กล้อง Public" — เฉพาะ Central และผู้ที่มี menu.publiccam (กล้อง Public มีที่ Central เท่านั้น)
export default function ApiClients({ groupedCameras = {}, showPublic = false }) {
  const [clients, setClients] = useState([]);
  const [name, setName] = useState('');
  /*
    กลุ่มที่ติ๊กไว้ — ว่าง = เห็นทุกกลุ่ม ตรงกับสัญญาของ API ที่ถือว่า "ไม่ส่ง scopeGroups
    มาเลย" แปลว่าไม่จำกัด เดิมช่องนี้ให้พิมพ์ชื่อกลุ่มเอง ซึ่งพิมพ์ผิดตัวเดียวก็ได้ key ที่
    มองไม่เห็นกล้องสักตัว โดยไม่มีอะไรเตือนจนกว่าปลายทางจะโทรมาบอกว่าใช้ไม่ได้
  */
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  /** key ที่กำลังแสดงอยู่ — มาจากการออกใบใหม่ หรือจากการกดเปิดดูใบเดิม */
  const [freshKey, setFreshKey] = useState(null);

  const load = async () => {
    try {
      const res = await apiFetch('/api/gateway/clients');
      if (!res.ok) throw new Error(`โหลดรายการไม่สำเร็จ (${res.status})`);
      setClients(await res.json());
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    }
  };

  useEffect(() => {
    load();
  }, []);

  /** สร้าง key ใหม่ — ช่องกลุ่มว่าง = เห็นทุกกลุ่มรวมกล้องที่เพิ่มในอนาคต */
  const handleCreate = async () => {
    if (!name.trim()) {
      toast({ title: 'ต้องตั้งชื่อ client ก่อน', variant: 'destructive' });
      return;
    }
    setIsLoading(true);
    try {
      const groups = selectedGroups.filter(Boolean);
      const body = { name: name.trim() };
      // ไม่ส่ง scopeGroups เลย = ทุกกลุ่ม ต่างจากส่ง array ว่างซึ่ง API ปฏิเสธ
      // เพราะ array ว่างอ่านได้ทั้ง "ยังไม่ได้เลือก" และ "ไม่ให้เห็นอะไรเลย"
      if (groups.length > 0) body.scopeGroups = groups;

      const res = await apiFetch('/api/gateway/clients', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'สร้าง key ไม่สำเร็จ');

      setFreshKey(data);
      setName('');
      setSelectedGroups([]);
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  // field = 'enabled', 'allowPtz', 'allowPlayback', 'allowEventWrite' หรือ 'allowPublic' — ส่งไปแค่ field เดียว ฝั่งเซิร์ฟเวอร์แก้เฉพาะที่ส่งมา
  const handleToggle = async (client, field = 'enabled') => {
    try {
      const res = await apiFetch(`/api/gateway/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: !client[field] }),
      });
      if (!res.ok) throw new Error('เปลี่ยนสถานะไม่สำเร็จ');
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    }
  };

  /**
   * เปิดดู key ใบเดิมซ้ำ
   *
   * ยิงทีละใบตอนกดเท่านั้น ไม่ได้ติดมากับรายการทั้งหน้า — ตัว key ควรออกจากเซิร์ฟเวอร์
   * เฉพาะตอนที่มีคนขอดูมันจริง ๆ และฝั่งเซิร์ฟเวอร์บันทึก log ไว้ทุกครั้งที่มีการเปิดดู
   */
  const handleReveal = async (client) => {
    try {
      const res = await apiFetch(`/api/gateway/clients/${client.id}/key`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เปิดดู key ไม่สำเร็จ');
      setFreshKey({ ...data, revealed: true });
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    }
  };

  const handleDelete = async (client) => {
    const ok = await appConfirm({
      title: 'เพิกถอน API key',
      description: `ระบบที่ใช้ key "${client.name}" อยู่จะเข้าถึง Gateway ไม่ได้ทันที และกู้คืน key เดิมไม่ได้`,
      confirmText: 'เพิกถอน',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/gateway/clients/${client.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('เพิกถอนไม่สำเร็จ');
      await load();
    } catch (err) {
      toast({ title: err.message, variant: 'destructive' });
    }
  };

  /*
    เรียกผ่าน copyText ไม่ใช่ navigator.clipboard ตรง ๆ

    ของเดิมเรียก navigator.clipboard.writeText() ซึ่งบนหน้าที่เสิร์ฟผ่าน http:// ธรรมดา
    navigator.clipboard เป็น undefined ทั้งก้อน (secure context เท่านั้นถึงจะมี) จึงโยน
    TypeError ทุกครั้งแล้วตกไป catch — ปุ่มคัดลอกไม่เคยทำงานเลยบนเครื่องที่ใช้จริง แต่ผ่าน
    ตอนทดสอบบน localhost เพราะ localhost นับเป็น secure context ดู src/lib/clipboard.js
  */
  const copyKey = async (value) => {
    const ok = await copyText(value);
    toast(
      ok
        ? { title: 'คัดลอก key แล้ว' }
        : { title: 'คัดลอกอัตโนมัติไม่ได้ — กรุณาเลือกข้อความแล้วคัดลอกเอง', variant: 'destructive' },
    );
  };

  /*
    ใช้ formatThaiDateTime ไม่ใช่ new Date().toLocaleString() ตรง ๆ

    ของเดิมเรียก new Date(value) กับค่าที่ SQLite คืนมาเป็น "YYYY-MM-DD HH:MM:SS" ซึ่งไม่มี
    ตัวบอกเขตเวลา เบราว์เซอร์จึงตีความเป็นเวลาท้องถิ่นทั้งที่ค่านั้นเป็น UTC — วันที่ออกคีย์
    และ last seen จึงแสดงเพี้ยนไป 7 ชั่วโมงอยู่นานโดยไม่มีใครสังเกต เพราะตัวเลขยัง "ดูสมเหตุสมผล"

    ตอนนี้ฐานข้อมูลเก็บเป็นเวลาไทยพร้อม offset แล้วก็จริง แต่ยังเรียกผ่านตัวช่วยตัวเดียวกับ
    ที่อื่น เพื่อให้มีที่เดียวที่ตัดสินใจเรื่องรูปแบบเวลา และเพื่อให้แถวเก่าที่ยังไม่ถูกแปลง
    (ถ้ามี) ยังแสดงถูกต้อง
  */
  const fmt = (value) => (value ? formatThaiDateTime(value) : '—');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            API Gateway Clients
          </CardTitle>
          <CardDescription>
            ออก API key ให้ระบบภายนอกเรียก <code>/api/v1</code> เพื่อดึงสตรีมและ metadata
            ของกล้อง โดยไม่ต้องรู้รหัสผ่านกล้องและไม่ต้องมีบัญชีผู้ใช้ในระบบนี้
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            ตัวเลือกกลุ่มอยู่แถวของตัวเองเต็มความกว้าง ไม่ใช่คอลัมน์กลางเหมือนเดิม เพราะตอนกาง
            มันสูงขึ้นและมีรายชื่อกล้องข้างใน การบีบไว้ในคอลัมน์แคบข้างช่องชื่อทำให้ชื่อกล้อง
            ยาว ๆ ถูกตัดทิ้งทั้งที่มีที่ว่างเหลือทั้งแถว
          */}
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <label className="text-xs font-medium">ชื่อ client</label>
              <Input
                value={name}
                placeholder="เช่น people-counting-edge"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={handleCreate} disabled={isLoading} className="gap-2">
                <Plus className="size-4" />
                ออก key ใหม่
              </Button>
            </div>
          </div>

          <ScopeGroupPicker
            groupedCameras={groupedCameras}
            value={selectedGroups}
            onChange={setSelectedGroups}
          />

          {freshKey && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <ShieldAlert className="size-4 shrink-0" />
                {/*
                  ข้อความต่างกันตามที่มา: ใบที่เพิ่งออกและเก็บกู้ได้ไม่ควรขู่ว่า "ดูไม่ได้อีก"
                  เพราะไม่จริงแล้ว ส่วนใบที่เก็บกู้ไม่ได้ต้องขู่ตามเดิม เพราะยังจริงอยู่
                */}
                <span className="text-sm font-semibold">
                  {freshKey.revealed
                    ? `key ของ "${freshKey.name}"`
                    : freshKey.recoverable
                      ? 'เก็บ key นี้ไว้ให้ดี — เปิดดูซ้ำได้จากปุ่มรูปตาในตารางด้านล่าง'
                      : 'คัดลอก key นี้เก็บไว้ทันที — ระบบไม่แสดงให้ดูอีก'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background/80 px-3 py-2 text-xs">
                  {freshKey.key}
                </code>
                <Button variant="outline" size="icon" onClick={() => copyKey(freshKey.key)}>
                  <Copy className="size-4" />
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFreshKey(null)}>
                เก็บไว้แล้ว ปิดข้อความนี้
              </Button>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ชื่อ</TableHead>
                <TableHead>key</TableHead>
                <TableHead>ขอบเขตกล้อง</TableHead>
                <TableHead>กำลังใช้อยู่</TableHead>
                <TableHead>ใช้งานล่าสุด</TableHead>
                <TableHead className="w-24" title="อนุญาตให้ key ใบนี้หมุน/ซูม/เรียก preset ของกล้องใน scope">คุม PTZ</TableHead>
                <TableHead className="w-24" title="อนุญาตให้ key ใบนี้ดูภาพบันทึกย้อนหลัง (บันทึกที่ edge) — key ที่ central ถือไว้กับ edge ต้องติ๊กที่ edge">ย้อนหลัง</TableHead>
                <TableHead className="w-24" title="อนุญาตให้ key ใบนี้ส่งผล AI จาก API ภายนอกเข้ามาที่ Edge">ส่ง event</TableHead>
                {showPublic && (
                  <TableHead className="w-24" title="อนุญาตให้ key ใบนี้เห็นกล้องสาธารณะทั้งหมด (หน้า Public Cam Map) — ไม่ขึ้นกับขอบเขตกลุ่ม · ค่าตั้งต้นปิด">กล้อง Public</TableHead>
                )}
                <TableHead className="w-24">เปิดใช้</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 && (
                <TableRow>
                  <TableCell colSpan={showPublic ? 11 : 10}className="text-center text-sm text-muted-foreground py-8">
                    ยังไม่มี client — ออก key ใบแรกได้จากฟอร์มด้านบน
                  </TableCell>
                </TableRow>
              )}
              {clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell className="font-medium">{client.name}</TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">{client.keyHint}</code>
                  </TableCell>
                  <TableCell>
                    {client.scopeGroups ? (
                      <div className="flex flex-wrap gap-1">
                        {client.scopeGroups.map((g) => (
                          <Badge key={g} variant="secondary" className="text-[10px]">{g}</Badge>
                        ))}
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">ทุกกลุ่ม</Badge>
                    )}
                  </TableCell>
                  {/*
                    จำนวนเครื่องที่กำลังใช้ key ใบนี้อยู่ ต่างจาก "ใช้งานล่าสุด" คนละเรื่อง —
                    ใบที่แจกไปสิบเครื่องกับใบที่ใช้เครื่องเดียวให้เวลาใช้งานล่าสุดเท่ากันหมด
                    ตัวเลขนี้คือสิ่งที่ต้องดูก่อนตัดสินใจปิดหรือลบ key ใบไหน

                    นับจากหน่วยความจำของ backend จึงเริ่มใหม่ทุกครั้งที่รีสตาร์ต — 0 หลังรีสตาร์ต
                    แปลว่า "ยังไม่มีใครกลับมาต่อ" ไม่ใช่ "ไม่มีใครใช้ใบนี้"
                  */}
                  <TableCell className="text-xs">
                    {client.activeInstances > 0 ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {client.activeInstances} เครื่อง
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmt(client.lastSeenAt)}
                  </TableCell>
                  <TableCell>
                    <Checkbox checked={client.allowPtz} onCheckedChange={() => handleToggle(client, 'allowPtz')} />
                  </TableCell>
                  <TableCell>
                    <Checkbox checked={client.allowPlayback} onCheckedChange={() => handleToggle(client, 'allowPlayback')} />
                  </TableCell>
                  <TableCell>
                    <Checkbox checked={client.allowEventWrite} onCheckedChange={() => handleToggle(client, 'allowEventWrite')} />
                  </TableCell>
                  {showPublic && (
                    <TableCell>
                      <Checkbox checked={client.allowPublic} onCheckedChange={() => handleToggle(client, 'allowPublic')} />
                    </TableCell>
                  )}
                  <TableCell>
                    <Checkbox checked={client.enabled} onCheckedChange={() => handleToggle(client)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {/*
                      ปุ่มเปิดดู key ซ้ำ — มีเพราะทางเลือกเดิมคือ "คัดลอกให้ทันในครั้งเดียว"
                      ซึ่งพลาดทีเดียวแล้วต้องออกใบใหม่และไล่แก้ config ของทุกเครื่องที่ใช้ใบเก่า

                      ใบที่ออกก่อนระบบเก็บคีย์จะเปิดดูไม่ได้ตลอดไป ปุ่มจึงถูกปิดพร้อมบอกเหตุผล
                      ไม่ใช่ซ่อนไปเฉย ๆ ให้เดาเอง
                    */}
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!client.recoverable}
                      title={
                        client.recoverable
                          ? 'เปิดดู key ใบนี้'
                          : 'ใบนี้ออกก่อนระบบเก็บคีย์ — เปิดดูซ้ำไม่ได้'
                      }
                      onClick={() => handleReveal(client)}
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(client)}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
