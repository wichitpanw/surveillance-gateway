# Windows Client workspace redesign — released 1.11.0

วันที่: 2026-10-11 · branch codex/client-workspace-redesign · ฐาน bb58d2d / Client 1.10.0 · รุ่นต่อยอดปัจจุบันใน feed: 1.14.2 (2026-10-17)

## ปิดงานรอบ Client และ Map — 2026-10-12

- Client 1.10.0 (`bb58d2d`): Diagnostics, multi-monitor walls, Auto stream, AI event navigation และ evidence export พร้อม SHA256
- Client 1.11.0 (`1a4ba1c`): Shell/Live/Playback redesign; Release build 0 warnings / 0 errors และ fixture PASS 41 / FAIL 0
- Gateway `a0d8867`: แก้แผนที่ค้าง Loading เพราะ MapLibre 6 worker ไม่ถูกปล่อยไปกับ Vite build; ใช้ `src/lib/maplibre.js` และ `worker.format: es` ให้ bundle worker พร้อมไฟล์ release
- ตรวจหน้า client-map บน production ผ่าน browser เห็นถนน/อาคาร 3D และ worker ตอบ HTTP 200 ทั้ง Central/Regional; ผู้ดูแลยืนยันอัปเดตเรียบร้อยแล้ว
- แก้ Map ที่หน้าเว็บของ Gateway ไม่ต้องเพิ่มเวอร์ชัน Client; ปิดแท็บ Map แล้วเปิดใหม่ หรือเปิด Client ใหม่เพื่อโหลด bundle ใหม่
- ปิดขอบเขตที่ส่งมอบรอบนี้; ผล fixture/browser ไม่แทนการทดสอบ native Client ทุกกรณี โดยเฉพาะ multi-monitor/mixed DPI, HWND/video/audio และ update/uninstall
- Linux บน Raspberry Pi รอทดสอบภายหลัง; Events/Map inspector และ Settings/Dialogs redesign รอบถัดไปยังไม่ได้ทำ ไม่รวมในงานที่ปิดรอบนี้

## ขอบเขตรอบแรก
Shell + Live + Playback และ design tokens ร่วม ตามลำดับที่เสนอแก่ผู้ดูแล
ปล่อย Client 1.11.0 ในรอบนี้; โค้ด backend ไม่เปลี่ยนใน redesign; Map worker hotfix ที่หน้าเว็บปล่อยแยกเป็น Gateway build `a0d8867`

## สิ่งที่ทำ
- Shell: rail 64/188 px, header/title/status แยกช่อง, ตัดข้อความสถานะยาวพร้อม tooltip, ลดความสูง chrome และเลิก animation ขนาด sidebar เพื่อไม่ reflow HWND ทุก frame
- Graphite Dark theme และ typography ผ่าน resource กลาง; Light theme ยังครบ
- Compact/Comfortable: จำใน AppSettings, เปลี่ยนขนาดข้อความและ margin โดยไม่สร้าง player ใหม่
- Ctrl+F โฟกัสค้นหากล้องใน Live/Playback
- Live: ย้าย layout/stream/Clear all ไป toolbar; inspector แยก Grid จากวิดีโอ มีชื่อ กลุ่ม สถานะ Global ID และทางไป Playback/ขยายภาพ PTZ
- Inspector ยุบและปิดปุ่มเมื่อพื้นที่ workspace ต่ำกว่า 1050 DIP เพื่อรักษาพื้นที่ภาพ
- Playback: ลด sidebar, จัด header พร้อมกลับ Live, แยกกลุ่มเลือกหลักฐานเหนือ timeline
- Live → Playback ผ่าน inspector ใช้กล้องจาก scoped catalog; Playback → Live เลือกช่องเดิม/หน้าผังเดิม ถ้ามีอยู่ ไม่เพิ่มกล้องซ้ำหรือเขียนทับช่องที่เต็ม
- Catalog ถอนกล้องออกจาก scope: หยุด playback ยกเลิกโหลดและล้างบริบท/ช่วงส่งออก
- คง renderer, PTZ, audio, API และการตรวจสิทธิ์เดิม
- ตรวจซ้ำก่อนปล่อย: ผูก playback navigation ทุกครั้งที่สร้าง Wall, ใช้ initialization task เดียว, ป้องกันสลับช่องระหว่าง render และจับ error ที่ shell

## ผลตรวจ
- Release build จาก worktree: 0 warnings / 0 errors
- Fixture regression และ workspace checks: PASS 41 / FAIL 0
- ตรวจภาพ offscreen render: Dark/Light, ภาษาไทย, 1024×640 / 1366×768 / 1600×900
- Installer 1.11.0 สร้างและ publish production feed แล้ว; ตรวจ full/delta เมื่อ 2026-10-12
- ภาพเป็น WPF render ด้วย fixture ไม่ใช่ภาพหน้าต่างใช้งานจริง; ยังไม่ทดสอบจริงเรื่อง HWND/video/audio, DPI หลายจอ, keyboard ขณะ video HWND จับ focus และ installation/update
- Velopack packaging มี warning เดิมเกี่ยวกับ OnStartup hook และไม่มี Authenticode signing

## วิธีทดสอบบนเครื่อง Client
1. ใช้เครื่องทดสอบหนึ่งเครื่อง ติดตั้ง Setup 1.11.0; ยืนยัน profile/key/ผังเก่ายังคงอยู่
2. ดู 1/4/9/16/25 ช่อง, main/sub/Auto, audio, focus/PTZ และกลับผัง
3. เลือกกล้องจาก inspector → Playback → กลับ Live; ยืนยันไม่ซ้ำ/ไม่ทับกล้องอื่น โดยเฉพาะผังหลายหน้าและผังเต็ม
4. Dark/Light + Compact/Comfortable + ภาษาไทย/อังกฤษ + Ctrl+F + F11
5. จอ 1366×768 และสองจอ DPI ต่างกัน; ตรวจเมนู/toolbar/ปุ่มไม่ถูกตัด
6. Playback seek/mark/export และ SHA256; ปิดหน้า/หน้าต่างแล้วตรวจ resource คืน

## รอบถัดไปหลังตรวจโฉมแรก
- Events: list/detail อยู่ข้างกัน รักษา filter และส่งบริบทไป Live/Playback
- Map: รายละเอียดหมุดเป็นแผงข้าง รักษา viewport
- Settings/Diagnostics: หมวดและ search, dialog/font/spacing/keyboard focus ให้สม่ำเสมอ
- สถานะ player: เหตุผลและคำสั่งแก้ไขสม่ำเสมอทุกเส้นทาง โดยไม่คาดเดาสถานะกล้อง