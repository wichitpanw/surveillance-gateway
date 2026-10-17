# Windows Client 1.10.0 — release validation

วันที่ตรวจ: 2026-10-11 · publish production feed 1.10.0 แล้ว (`bb58d2d`); รุ่นปัจจุบัน 1.11.0

## สิ่งที่ทำ
- Diagnostics: codec/resolution/FPS/lost frames/reconnect/fallback/error, CPU/RAM และ export JSON แบบ whitelist ไม่เก็บ URL/key/credential
- Multi-monitor: เปิด saved wall แยกจอ จำตำแหน่ง ปรับขอบเขตเมื่อจอเปลี่ยน และ opt-in restore ตอนเริ่มโปรแกรม
- Auto stream: sub สำหรับ grid, main สำหรับ focused/single; manual main/sub ยังใช้ได้
- AI event: เปิด Live หรือ Playback ที่เวลา event (+07:00), ตรวจ catalog ใน scope และสิทธิ์ย้อนหลัง
- Evidence: mark start/end บน timeline, export MP4 พร้อม .evidence.json ระบุ Global ID/เวลาที่ขอ/ขนาดไฟล์/SHA256; manifest ไม่ใช่ digital signature หรือการรับรองเวลา frame จริง

## ผลตรวจ
- Build Release และ publish จาก development worktree สำเร็จ
- Fixture checks: PASS 27 / FAIL 0
- ครอบคลุม Auto policy, monitor bounds/default restore, diagnostics whitelist, SHA256/cleanup/cancel, event timezone/gap/race/403 และ theme/localization
- ตรวจ render offscreen: dark/light diagnostics, timeline, Playback 900×650/1280×800, wall ภาษาไทย
- ไม่ได้ทดสอบบนหน้าต่าง Client จริง: multi-monitor/mixed DPI/hotplug, กล้องจริง/เสียง/decoder GPU และ installer บนเครื่องผู้ใช้
- Hardware decoding requested ไม่เท่ากับ decoder ที่ใช้งานจริง; GPU telemetry ยังไม่มี จึงไม่แสดงค่าคาดเดา

## UX/UI ที่แก้
- Clear all ถูกตัดเมื่อเพิ่ม Auto: แยกแถว
- Playback controls แน่นในพื้นที่แคบ: wrap เป็นหลายแถว
- Event detail: header แยกปุ่มปิด, scroll ภายใน work area และ cancel snapshot เมื่อเปลี่ยน/ปิด event
- Stream label เปลี่ยนตามภาษาเมื่อเปิดหน้าค้าง

## ข้อเสนอขั้นต่อไป (ยังไม่เพิ่ม scope)
1. ทดสอบ installer บนเครื่องใช้งานจริง โดยเฉพาะสองจอ DPI ต่างกัน และเปิด/ปิด wall ซ้ำเพื่อดู resource คืน
2. ทำสถานะ player พร้อมเหตุผลและทางแก้ให้สม่ำเสมอ เช่น reconnect/permission/no recording
3. Density Compact/Comfortable และ Ctrl+F ส่งมอบแล้วใน 1.11.0; การทวน focus เมื่อ video HWND จับ focus ยังต้องทดสอบจริง
4. ทวน font/spacing/contrast ให้สม่ำเสมอใน dialog เก่า; ไม่จำเป็นต้องเปลี่ยนหน้าตาทั้งระบบ

## Packaging limitations
Velopack แจ้ง warning เดิม: startup hook อยู่ใน OnStartup และไม่ได้ตั้ง Authenticode signing; ควรตรวจ installation/update/uninstall บนเครื่องทดสอบสำหรับการรับรองครบทุกกรณี; feed เผยแพร่แล้ว