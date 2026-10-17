# ปล่อยเวอร์ชันใหม่ของ Windows client

สคริปต์เดียวจบ ไม่ต้องอัปโหลด ไม่ต้อง restart server — central เสิร์ฟโฟลเดอร์ `client-updates/` ของ repo นี้ที่ `/client-updates`
และ client ที่ติดตั้งแล้วอ่าน feed นั้นเอง · อัปเดต 2026-10-17 (release ล่าสุดใน feed 1.14.2; งานเปลี่ยนชื่อ/branding 2026-10-09)
รุ่นที่ release จริงดูจาก `client-updates/releases.win.json` เสมอ — ตัวเลขในเอกสารนี้อาจตามไม่ทัน

**เวอร์ชัน 1.8.5 (release 2026-09-29):** แก้ตามผลตรวจทั้งระบบ — Playback ขอภาพเป็นก้อนที่ไม่เกินปลายช่วงบันทึกและเที่ยงคืน
(เวลาไม่เพี้ยนเมื่อเล่นข้ามช่องว่าง/ข้ามวัน) · สาย SSE ที่เงียบเกิน 60 วิ ต่อใหม่เอง · จับ exception ทั้งแอป (log ที่
`%LOCALAPPDATA%\SurveillanceGateway.Client\errors.log`) ไม่ปิดตัวเอง · หน้าที่ปิดแล้วไม่ค้างในหน่วยความจำ · settings มี `.bak` ที่ใช้คืนได้จริง ·
tooltip PTZ ครบ · ข้อความทุกตัวอยู่ใน `Strings.cs` (commit d03e545)

**เวอร์ชัน 1.8.4:** หน้า Playback เปลี่ยนเป็นเส้นเวลาการบันทึกแบบ VMS (commit 645a2a7)
· แหล่งภาพ: AXIS S30 / Uniview NVR ใช้งานจริง · Hikvision / Dahua / ONVIF Profile G เขียนแล้วรอทดสอบกับเครื่องจริง · Digifort รอเอกสาร API (ตอบ 501)

**เวอร์ชัน 1.8.3:** เพิ่มหน้า Playback เลือกกล้องตามกลุ่มและค้นหา,
เลือกวัน/ช่วงบันทึก/เวลา (แถบเวลา 24 ชั่วโมง) แล้วเล่น พัก หรือหยุดด้วย libVLC · ใช้ `GET /api/v1/cameras/:id/recordings` และ
`playback-token` (token ผูกกล้อง อายุ 5 นาที ตรวจตอนเปิดสตรีม) · ต้องเปิดสิทธิ์ **ย้อนหลัง** (`allow_playback`) ให้ API key ของ client
และคีย์ที่ central ใช้ต่อ edge · ซอร์สรองรับแหล่งภาพ AXIS S30 / Uniview NVR ที่มีอยู่แล้ว
· ยังไม่ได้ทดสอบหน้า client กับอุปกรณ์จริง

**เวอร์ชัน 1.9.1:** หน้า Playback มีปุ่มดาวน์โหลด MP4 เลือกช่วงในวันที่เปิดอยู่สูงสุด 30 นาทีต่อไฟล์
และหนึ่งงานพร้อมกันต่อ client instance · ต้องมี allow_playback เหมือนดูย้อนหลัง · เรียก API ใหม่
GET /api/v1/cameras/:id/download.mp4?start=<ISO-8601>&duration=<1–1800> (ต้อง deploy backend ก่อนปล่อย client)
· ขณะดาวน์โหลดหยุดการเล่นภาพเดิม แสดงจำนวน MB และยกเลิกได้ · ไฟล์ .part ถูกล้างเมื่อยกเลิก/ล้มเหลว และย้ายเป็น .mp4 เมื่อรับครบ

**เวอร์ชัน 1.9.2:** แยก stream URL timeout จากการยกเลิกเพื่อ retry ได้ และ reconnect เมื่อ Playing แต่ไม่มี frame โดยไม่รบกวน pause
· ตรวจโครงสร้าง fragmented MP4 ก่อนย้ายไฟล์ .part เป็น MP4 · ต้อง deploy backend ที่ส่ง failure ของแหล่งภาพผ่านทุก relay และตรวจช่วงดาวน์โหลดคร่อมไฟล์บันทึกก่อน release
· ช่วงที่อุปกรณ์ส่งไม่ครบจากคลิปเดียวจะตอบ 416 พร้อมความยาวสูงสุดให้เลือกใหม่ แทนส่งไฟล์สั้นแล้วแจ้งสำเร็จ
· ตรวจ build และ regression จำลองแล้ว ยังต้องยืนยัน WPF/กล้องจริง และเลือกช่วงบันทึกจริงผ่าน Central/Regional
## รุ่นปัจจุบัน (1.14.2; ตรวจ feed 2026-10-17)

- **1.10.0:** Diagnostics, multi-monitor walls, Auto stream, AI event navigation, evidence export/SHA256 — [ผลตรวจ](WINDOWS-CLIENT-1.10.0.md)
- **1.11.0:** Shell/Live/Playback redesign, Dark/Light, Compact/Comfortable และ Ctrl+F — [ผลตรวจและการปิดงาน](WINDOWS-CLIENT-WORKSPACE.md)
- **1.12.0:** ผังรวมช่อง (1+3, 1+5, 1+7, 1+9, 2+8, 1+12) และตัวแก้ผังของเครื่อง (≤ 25 ช่อง)
- **1.13.0:** หน้า Home โฉมใหม่แบบการ์ด isometric ของ VMS (`Views/IsoArt.cs`)
- **1.14.0:** หน้า Live แบบ VMS พร้อมผังเต็มพื้นที่ (เส้นแบ่ง 1 px) และแถบซ้าย Cameras / Views / PTZ แบบ accordion
- **1.14.1:** เปิด saved wall view ซ้ำได้หลังจากกด Clear all cells
- **1.14.2:** ปรับความเสถียรการซิงก์สถานะการเล่นและการตรวจสอบย้อนหลัง
- **Map hotfix Gateway a0d8867:** bundle MapLibre worker แก้แผนที่ค้าง; ไม่ต้องออกรุ่น Client ใหม่; ผู้ดูแลยืนยันอัปเดตเรียบร้อยแล้ว 2026-10-12

### ประวัติ 1.9.x

- **1.9.3:** รับ AI event จากกล้อง/NVR/VMS/API ผ่าน Edge → Regional/Central พร้อมภาพ; กรอง Edge/กลุ่ม/ที่มาและเปิดรายละเอียดภาพเต็ม
- **1.9.4:** คลิกหัว Camera Library เพื่อหุบ/เปิดส่วนตัวกรอง; คง Search, Group, Status, Favorites และไม่ซ่อนรายชื่อกล้องหรือ layout/stream
- **1.9.5 (release 2026-10-06 พร้อม Gateway d645ed9):** เสียงจากกล้องที่ Edge เปิด `audio_enabled` — ปุ่มลำโพงต่อ tile เริ่มปิดเสียงเสมอ; กล้องไม่มีเสียงและ Playback ใส่ `:no-audio` ต่อ media แทน `--no-audio` ทั้งแอป · full/delta อยู่ใน feed แล้ว · dotnet build ผ่าน ยังไม่ได้ทดสอบหน้าต่าง/เสียงจริง ([CAMERA-AUDIO.md](CAMERA-AUDIO.md))
- **1.9.6 (2026-10-08):** ทดลองเปิดภาพเป็น popup ข้างหมุด แต่พบปัญหาภาพไม่ขึ้น จึงแทนด้วยหน้าต่างแยกใน 1.9.7
- **1.9.7 (2026-10-08):** คืนหน้าต่าง player แยกเมื่อคลิกกล้องบนแผนที่
- **1.9.8 (งาน 2026-10-09):** ชื่อหน้าต่าง/sidebar/breadcrumb/exit prompt และ installer เป็น Surveillance Gateway Client; ถอด vendor branding · `SurveillanceGateway` namespace/packId และที่อยู่ติดตั้งภายในคงเดิมเพื่อรองรับเครื่องเดิม
- ตรวจ `/client-updates/releases.win.json` เมื่อ 2026-10-11 พบ full/delta 1.9.8; การมีแพ็กเกจใน feed ไม่ยืนยันว่า Client ทุกเครื่องติดตั้งแล้ว

## ประวัติ UI ที่ตกลงแล้ว (1.8.2)

- หน้า Home ใช้การ์ด Live Wall เด่นที่สุด ตามด้วย Map และ Camera details พร้อมแผง Total / Online / Offline / Other
- แถบบนสีเข้มมีปุ่มย่อ/ขยาย/ปิด; ปุ่มขยายใช้ work area เหนือ taskbar ส่วน F11 ซ่อนแถบบนและวางหน้าต่างทับขอบจอจริงเหนือ taskbar
- Video wall แสดง Layout และ Stream ตรงแถบกล้อง, Clear all cells อยู่ข้าง Stream, Wall Controls สำหรับ saved views อยู่ล่างสุด
- กลุ่มกล้องแสดงจำนวนออนไลน์/ทั้งหมดแบบ `1/5`; ธีมมืด/สว่างใช้โทเคนสีข้อความที่ผ่านการตรวจ contrast
- เวอร์ชัน 1.7.3 แก้ F11 ให้ครอบ taskbar และคืนตำแหน่งเดิมเมื่อออก; ตรวจขอบหน้าต่างกับขอบจอจริงแล้ว และเผยแพร่ Full / Delta ใน feed ของ Central ทั้งสองที่อยู่
- เวอร์ชัน 1.7.4 ถามยืนยันก่อนออกจากโปรแกรม (ปุ่ม ✕, Alt+F4, ปิดจาก taskbar) — ไม่ถามเมื่อกดอัปเดตหรือ Windows กำลังปิดเครื่อง
- เวอร์ชัน 1.8.1 เอาสีของวัตถุ, "นับคน" และ event จาก AI หัวกล้องออก (ตามที่ถอดจากระบบ 2026-09-28)
- เวอร์ชัน 1.8.2 คลิกแถวในหน้า AI events = หน้าต่าง popup (`Views/EventDetailWindow`) ภาพเต็ม รายละเอียด ลูกศรซ้าย-ขวาเลื่อน event

## ขั้นตอน

1. แก้โค้ดใน `client-windows/SurveillanceGateway.Client/`
2. **ขึ้น `<Version>`** ใน `client-windows/SurveillanceGateway.Client/SurveillanceGateway.Client.csproj` — ไม่ขึ้น = ไม่มีใครได้อัปเดต
   (Velopack เทียบเลขเวอร์ชัน ไม่ได้เทียบเนื้อไฟล์) · `-Version` ใช้ build เลขที่ระบุครั้งเดียวได้ แต่ครั้งต่อไปจะอ่านจาก csproj อีก
3. build และเผยแพร่ (หรือ `scripts\deploy.ps1 -ReleaseClient` ที่ทำพร้อม deploy):
   ```bash
   powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\build-client-release.ps1
   ```
4. commit ซอร์สกับเลขเวอร์ชัน — ไฟล์ release ไม่ต้อง commit (`client-updates/` ถูก ignore, full package ~160 MB)
   เครื่องที่ build คือเครื่องที่เสิร์ฟ จึงไม่ต้องย้ายอะไร

client ที่ต่ออยู่จะเห็นเวอร์ชันใหม่ตอนเปิดครั้งถัดไป หรือทันทีถ้ากด **ตรวจหาอัปเดต** ใน Settings

build ต้องใช้ .NET SDK ที่ `%LOCALAPPDATA%\Microsoft\dotnet` (สคริปต์หาให้เอง) — `C:\Program Files\dotnet` มีแต่ runtime

## ตรวจว่าปล่อยสำเร็จ

```bash
curl -s http://203.0.113.80:5173/client-updates/releases.win.json
```
ต้องมีเวอร์ชันที่เพิ่ง build · ถ้าไม่มี แปลว่าสคริปต์เขียนไปที่อื่น — ดู `-OutputDir` ที่มันรายงานตอนจบ

## ไฟล์ที่ได้ (`client-updates/`)

| ไฟล์ | ใครใช้ |
|---|---|
| `SurveillanceGateway-win-Setup.exe` | คนติดตั้งครั้งแรก — **แจกไฟล์นี้ไฟล์เดียว** (มีปุ่มดาวน์โหลดที่หน้า login ของ central) |
| `SurveillanceGateway-<ver>-full.nupkg` | Velopack เมื่อ client ตามหลังเกินกว่าจะใช้ delta (~160 MB) |
| `SurveillanceGateway-<ver>-delta.nupkg` | Velopack เมื่อตามหลังหนึ่งเวอร์ชัน (ไม่ถึง 1 MB ถึงไม่กี่ MB) |
| `RELEASES`, `releases.win.json`, `assets.win.json` | index ของ Velopack |
| `SurveillanceGateway-win-Portable.zip` | เครื่องที่ติดตั้งไม่ได้ — ไม่มี shortcut และ **อัปเดตตัวเองไม่ได้** |

build เป็น self-contained (มี .NET runtime ในตัว) เครื่องใหม่ต้องมีแค่ WebView2 runtime ซึ่ง Windows Server 2022 / Windows 11 มีอยู่แล้ว

ดาวน์โหลด: `http://203.0.113.80:5173/client-updates/SurveillanceGateway-win-Setup.exe` หรือผ่าน Tailscale `http://203.0.113.112:5173/…`

## client ติดตั้งไปที่ไหน

```
%LOCALAPPDATA%\SurveillanceGateway\          ← ของตัวติดตั้งทั้งหมด (ไม่ต้องสิทธิ์ admin)
  current\                           เวอร์ชันที่รันอยู่ — ถูกสลับทั้งโฟลเดอร์ทุกครั้งที่อัปเดต
  packages\                          .nupkg ที่ดาวน์โหลดมา
  Update.exe                         ตัวอัปเดต/ถอนการติดตั้งของ Velopack
%LOCALAPPDATA%\SurveillanceGateway.Client\   ← ค่าตั้ง แยกไว้โดยตั้งใจ
  settings.json (+ .bak)             ที่อยู่ server และ API key (เข้ารหัส DPAPI)
```

ถอนการติดตั้ง (Settings → Apps หรือ `Update.exe --uninstall`) จะไม่ลบ `SurveillanceGateway.Client\` เพราะ key มักเป็นสำเนาเดียวบนเครื่องนั้น
ลบเองเมื่อปลดเครื่องถาวร · ชื่อแอปคือ "Surveillance Gateway Client" ทั้งหน้าต่างและตอนติดตั้ง (ถึง 1.9.7 ชื่อ "Surveillance Gateway Client" · `--packId SurveillanceGateway` คงเดิม เครื่องเก่าจึงอัปเดตต่อได้) (`--packTitle` ใน `scripts/build-client-release.ps1`)

## กฎ

- **ห้าม kill client ระหว่างกำลังลงอัปเดต** — จะได้ `Failed to resolve full path of the current executable` ตอนเปิด ต้องติดตั้งใหม่ด้วย Setup.exe
- **ห้ามลบ `.nupkg` ของเวอร์ชันที่ยังอาจมี client ใช้อยู่** — ขาดตัวกลางทำให้ต้องโหลด full, ขาด full ของเวอร์ชันตัวเองทำให้อัปเดตไม่ได้เลย
- **build จากซอร์สหรือ portable อัปเดตตัวเองไม่ได้** — client บอก "ไม่มีระบบอัปเดต" ไม่ใช่ "ไม่มีเวอร์ชันใหม่"
- client ไม่ restart ตัวเอง — โหลดเบื้องหลังแล้วโชว์ปุ่ม **อัปเดต** ที่ navbar เพราะบนจอ wall การรีสตาร์ทเองคือภาพดับกลางกะ

## Release 1.10.0 (2026-10-11)

Diagnostics, multi-monitor walls, Auto stream, AI event navigation และ evidence export พร้อม SHA256 อยู่ใน release 1.10.0; ปล่อย feed รุ่น 1.10.0 ในรอบนี้. รายละเอียดและข้อจำกัด: [WINDOWS-CLIENT-1.10.0](WINDOWS-CLIENT-1.10.0.md).

## Release 1.11.0 (2026-10-11)

Workspace redesign สำหรับ Shell/Live/Playback: Graphite, density, camera inspector และการส่งบริบท Live ↔ Playback; ตรวจ fixture 41 PASS. ดู [ผลตรวจและข้อจำกัด](WINDOWS-CLIENT-WORKSPACE.md).
