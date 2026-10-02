# Windows client (SurveillanceGateway)

โปรแกรมดูกล้องของผู้ใช้ — ต่อ **Surveillance Gateway Regional** หรือ **Surveillance Gateway Central** ด้วย API key ของเครื่องปลายทาง แล้วเล่นภาพ, ทำ video wall, ดูแผนที่, สั่ง PTZ

Client ภายในภาคควรตั้ง URL และ API key ของ Regional ภาคนั้นโดยตรง เพื่อให้ดูภาพในภาคต่อได้เมื่อสาย Regional–Central ขาด; ผู้ดูระดับประเทศใช้ Central และ key ที่ Central ออกให้
เป็น "ผู้บริโภค" ของ `/api/v1` ตัวอ้างอิง ไม่ใช่ทางเข้ากล้องอีกทาง · .NET 8 / WPF · อัปเดต 2026-09-28 (v1.8.2)

## ทำไมมีโปรแกรมนี้

กล้องส่วนใหญ่เป็น H.265 ซึ่งเบราว์เซอร์ผ่าน go2rtc เล่นไม่ได้ (go2rtc crash เมื่อส่ง H.265 ออก MSE) เซิร์ฟเวอร์จึงต้อง transcode ทุกผู้ชม
client นี้ถอด H.265 ด้วย GPU ของเครื่องผู้ใช้เอง (libVLC) เล่นเส้น `_raw` ที่ไม่ผ่าน transcode → NVENC ของเซิร์ฟเวอร์ว่าง

## Build และรัน

```bash
dotnet build SurveillanceGateway.Client/SurveillanceGateway.Client.csproj -c Release
bin\Release\net8.0-windows\win-x64\SurveillanceGateway.exe [--server=203.0.113.80:5173]
```
ใช้ `dotnet.exe` ใน `%LOCALAPPDATA%\Microsoft\dotnet` (ตั้ง `DOTNET_ROOT` ถ้ารันไฟล์ที่ build ออกมา)
ปล่อยให้ผู้ใช้: [../docs/CLIENT-RELEASES.md](../docs/CLIENT-RELEASES.md)

## คุยกับ central อย่างไร

- ทุกอย่างผ่าน `/api/v1` + `Authorization: Bearer sgw_…` — ไม่มี login ผู้ใช้ key คือตัวตน
  central กรองกล้องตาม scope ของ key ใน SQL (ที่เดียวที่บังคับได้จริง)
- `Services/GatewayClient.cs` คือสัญญาทั้งหมดในไฟล์เดียว — ให้ทีมภายนอกอ่านเป็นตัวอย่าง
- client ไม่รู้กติกาชื่อ path และไม่ประกอบ URL เอง: ขอ `GET /api/v1/cameras/:id/streams` แล้วเล่นตามที่ได้
  URL mp4 มี stream token อายุ ~5 นาที ตรวจตอนเปิดเท่านั้น renderer จึงรับ "ตัวขอ URL" ไม่ใช่ URL และขอใหม่ทุกครั้งที่ต่อใหม่
- เล่น `urls.mp4Raw` ก่อน (codec ของกล้อง ไม่ transcode) ถอยไป `urls.mp4` ถ้าไม่มี หรือถ้าเส้น raw ต่อได้แต่ไม่มีเฟรม
  (ดู [../docs/CAMERA-QUIRKS.md](../docs/CAMERA-QUIRKS.md))
- ทุกคำขอส่ง `X-Client-Instance` (GUID ต่อเครื่อง) + `X-Client-Name` → หน้า API Clients ของ central บอกได้ว่ามีกี่เครื่องใช้ key นี้อยู่
- สถานะสด: `GET /api/v1/events` (SSE) สายเดียว ป้อนจุดสถานะทุกหน้า — สถานะที่ยังไม่มีใครรายงานเป็นสีเทา ไม่ใช่ออฟไลน์
  สถานะตั้งต้นอ่านจาก `state.reachable` ใน `/api/v1/cameras` (1.3.4) — `streams.main.ready` ใช้ไม่ได้ เพราะเป็นจริงตลอดแม้กล้องถอดสาย
  client อ่าน `camera_state` เพื่อแยกออนไลน์/ออฟไลน์/Edge ติดต่อไม่ได้/รอ RTSP/ปิดใช้งาน และปรับยอด Home ตาม event
- หน้า Home ขึ้นแถบเตือนเมื่อ build ของ edge ไม่ตรง central (`edges[]` ใน `/api/v1/health`, 1.3.4)
- กล้องจาก edge มี `origin.reachable` ใน `/api/v1/cameras` (edge ติดต่อไม่ได้ ≠ กล้องดับ) และ client อ่าน field นี้
- PTZ: `GET/POST /api/v1/cameras/:id/ptz` — ปุ่ม PTZ ขึ้นเฉพาะกล้องที่หมุนได้ และ key มี `allow_ptz`

## หน้าจอ

โครงหน้าจอเหมือนเว็บ Central/Edge (`src/components/shell/AppShell.jsx`) ซึ่งยืมแบบมาจาก reference edge project:

| ส่วน | รายละเอียด |
|---|---|
| Sidebar | สีมืดเสมอ หมวด Overview / Monitoring / Devices แถบเหลืองที่หน้าที่เลือก หุบเหลือไอคอนได้ (ปุ่ม ☰) |
| Title bar / Navbar | แถบบนสีเข้มพร้อมปุ่มย่อ/ขยาย/ปิด · breadcrumb (Surveillance Gateway Client › หมวด › หน้า) · chip ที่อยู่ server + key · อัปเดต, เต็มจอ (F11), ออกจากระบบ |
| Tabs | หน้าเปิดเป็น tab และ view ถูกเก็บไว้ตลอดที่ tab เปิด (wall ที่จัดไว้ไม่หาย) · ปิด tab = ทำลาย view และหยุดถอดรหัส |
| Home | การ์ด Live Wall เด่น พร้อม Map / Camera details และแผง Total / Online / Offline / Other กับเหตุการณ์ล่าสุด |
| Video wall | 1/4/9/16/25 ช่อง, เลือกกล้อง, Layout และ Stream ในแถบกล้อง, Clear all cells ข้าง Stream, saved views ใน Wall Controls ด้านล่าง, ตัวกรองสถานะ, รายการโปรด, วนหน้าอัตโนมัติแบบกดเริ่มเอง, จุดสถานะ + fps + codec · คลิกขวาเมนูช่อง · ดับเบิลคลิกขยายภาพใน Wall เดิมพร้อม PTZ ข้างภาพเมื่อมีสิทธิ์ |
| Map | หมุดกล้องบนแผนที่ 3 มิติใน WebView2 จาก `/client-map.html` ของ central (หน้านั้นไม่ถือ key) |
| Camera details | ข้อมูลกล้อง สตรีม แทร็ก |
| Player window | หนึ่งหน้าต่างต่อกล้อง ลากไปจออื่นได้ · แผง PTZ ข้างภาพ (กดค้าง = หมุน) |
| AI events | event จาก ai-worker ของ edge 24 ชม.ล่าสุด (`GET /api/v1/ai/events`) + event ใหม่ทาง SSE · ภาพย่อโหลดทีละภาพ · คลิกแถว = `EventDetailWindow` (ภาพเต็ม, รายละเอียด, ←/→ เลื่อน, Esc ปิด) |

หน้า Home และ Camera details เลื่อนเข้าแบบ fade-transform ส่วน wall และ map ไม่ animate เพราะ **วิดีโอ (libVLC) และ WebView2 เป็น HWND —
WPF วาดทับหรือขยับ/จางไม่ได้** ด้วยเหตุผลเดียวกัน host ของเนื้อหามีได้ทีละหน้า และ view ถูกเพิ่ม/ถอดออก ไม่ใช่ซ่อนด้วย Visibility

## Design system

- `Themes/Tokens.Dark.xaml` (ธีมหลัก), `Themes/Tokens.Light.xaml`, `Themes/Controls.xaml` — สลับธีมด้วย merged dictionary ช่องแรก
- ฟอนต์ฝังใน `Assets/Fonts`: **Inter** + **Noto Sans Thai** (หัวข้อและเนื้อความ), IBM Plex Mono (ตัวเลข) · license ใน `Assets/Fonts/licenses/`
- เหลืองแบรนด์ใช้บอกสิ่งเดียวต่อครั้ง (ของที่เลือก, ปุ่มหลัก) · เขียว/เหลืองอำพัน/แดงใช้กับสถานะเท่านั้น
- ข้อความทุกตัวอยู่ใน `Services/Strings.cs` (EN/TH สลับได้ขณะรัน) — ห้ามเขียน literal ใน view
- ปุ่มขยายหน้าต่างใช้พื้นที่เหนือ taskbar; F11 ซ่อน title bar และวางหน้าต่างทับขอบจอจริงเหนือ taskbar · Settings อยู่ที่ฟันเฟืองด้านล่าง sidebar

## การเชื่อมต่อ ค่าตั้ง และ key

- หน้า Connect ตรวจที่อยู่ก่อนแล้วค่อยตรวจ key — error บอกได้ว่าผิดที่ไหน
- key เก็บต่อ server ใน `%LOCALAPPDATA%\SurveillanceGateway.Client\settings.json` เข้ารหัส DPAPI (CurrentUser) และบันทึกเมื่อ central ยอมรับแล้วเท่านั้น
- `--server=` เลือก key ที่จำไว้ของที่อยู่นั้น (ใช้กับจอ wall ที่เปิดเอง)
- key หาย: ผู้ดูแลเปิดดูซ้ำได้ที่หน้า API Clients ของ central (ปุ่มรูปตา) ถ้า key ออกหลังมีระบบเก็บคีย์
- ออกจากระบบแค่ตัดการเชื่อมต่อ · ลืม key เป็นคำสั่งแยกที่ต้องยืนยัน

## พฤติกรรมต่อใหม่ (`Video/LibVlcVideoRenderer.cs`)

- งบการลองใหม่ reset เมื่อช่องเปลี่ยนกล้อง และทุกครั้งที่เล่นสำเร็จ ("8 ครั้ง" = ล้มติดกัน 8 ครั้ง)
- มี watchdog คู่กับ error event เพราะ "ไม่มีภาพ" ไม่ได้ยิง error เสมอ
- jitter buffer 500ms ไม่ override clock ของ libVLC (ดู CAMERA-QUIRKS)

## SurveillanceGateway.VideoWallProbe

เครื่องมือวัดว่าเครื่องหนึ่งรับได้กี่สตรีม — 9 สตรีมใน 3x3 ไม่มี UI อื่น

```bash
dotnet build SurveillanceGateway.VideoWallProbe/SurveillanceGateway.VideoWallProbe.csproj -c Release
bin\Release\net8.0-windows\win-x64\SurveillanceGateway.VideoWallProbe.exe --seconds=90 --log=run.csv
```
สตรีมอ่านจาก `streams.txt` ข้าง exe (บรรทัดละ URL, `#` คือคอมเมนต์) · `--log` บันทึก CSV ทุก 5 วิ (สถานะ, เฟรม, fps, CPU, RSS)

ผล 2026-09-08 บนเครื่อง gateway: 9 กล้อง H.265 passthrough 90 วิ — 25 fps เกือบทุกช่อง, CPU 0.4–0.9%, RSS 487 MB,
decoder GPU 13%, **encoder 0%** (ถ้าผ่านเบราว์เซอร์จะเป็น NVENC 9 session)

## สิ่งที่ฝั่ง server ต้องมี

`urls.mp4Raw` มีเมื่อ central รันด้วย `GATEWAY_RAW_STREAMS=1` (ตั้งไว้ใน `ecosystem.windows.config.cjs`) — go2rtc-sync สร้างเส้น `_raw`
และ `server.js` เสิร์ฟผ่าน `/stream/<name>.mp4` แบบ `video=copy` · ปิด flag แล้ว client ยังทำงาน แค่เล่นเส้น transcode

## ยังไม่มี

- ปุ่มสลับแผนที่ดาวเทียมในหน้า Map ของ client (หน้าเว็บมีแล้ว)
- แสดงชื่อ edge ต้นทาง / global ID ของกล้องในหน้า Camera details
- ดูภาพย้อนหลัง (รอแหล่งภาพจากอุปกรณ์ที่ central)
