# OPERATIONS — คู่มือปฏิบัติการ

ทุกอย่างที่ต้องทำกับเครื่องที่รันระบบ · อัปเดต 2026-10-17
กติกาการแก้โค้ดอยู่ใน [../CONTRIBUTING.md](../CONTRIBUTING.md)

## สถานะปัจจุบัน — 2026-10-17

- Gateway `651549d` — ตรวจ `/api/instance` ของ Central :5173 และ Regional :5273 เมื่อ 2026-10-17
- Windows Client `1.14.2` เผยแพร่ full/delta ใน `client-updates/releases.win.json` แล้ว (ตรวจ 2026-10-17); รองรับผังรวมช่อง (`1.12.0`), หน้า Home แบบ isometric (`1.13.0`), หน้า Live แบบ VMS พร้อมแถบซ้าย Cameras/Views/PTZ แบบ accordion (`1.14.0–1.14.2`)
- ตรวจ manifest แพ็กเกจอัปเดต Edge ทั้ง windows-x64/linux-x64/linux-arm64 เมื่อ 2026-10-17 = `651549d`; offline kit ยังเป็น `5005316` จึงต้องอัปเดตผ่านสายหลังติดตั้ง; ไม่ได้ตรวจ mirror ของ Regional รอบนี้
- จำนวนกล้องตามบันทึก 2026-10-07: 163 กล้อง (Edge 101 = 7, Edge 102 = 156); ไม่ใช่ยอดที่ตรวจใหม่ · Edge `103` "Edge ทดสอบ" เป็น Edge ทดสอบที่ตั้งใจต่อ Regional ภาคกลาง; ยังไม่ได้ตรวจสถานะสาย/ยอดกล้องล่าสุด
- Windows Client `1.9.4` เพิ่มการหุบตัวกรอง Camera Library; 1.9.3 เพิ่มภาพ AI Events และตัวกรอง Edge/กลุ่ม/ที่มา
- Avigilon H.265: ONVIF Media1 → Media2 fallback ใน `48f4298`; ผู้ดูแลยืนยันเมื่อ 2026-10-11 ว่าทดสอบใช้งานแล้วภาพมา
- DSS หลัง NAT รองรับ fallback ของ URL media ทั้งสด/ย้อนหลัง และจำ `playbackType` ต่อ DSS; จังหวัดทดสอบยืนยันย้อนหลัง 2026-10-09
- Public Cam อุดรธานีเพิ่มที่ Central แล้ว; หน้าผู้ใช้ถอด vendor branding; คู่มือ rebuild 2026-10-09 เพื่อปรับข้อความและภาพ
- AI Sources เป็น General และมีตัวกรอง Group; กล้องใหม่ไม่เปิด receiver อัตโนมัติ ต้องเลือกแหล่งรับและเปิดต่อกล้อง
- Tiandy MODEL-A ใช้ AlarmInfo + ภาพ Alarm บน SD; UNV IPC2325SB ใช้ ONVIF RTSP metadata LineCrossing + GetSnapshotUri สำหรับเหตุใหม่ (กล้องเดี่ยวช่อง 1)
- หลังอัปเดต receiver Tiandy/UNV ที่ Edge 101 เชื่อมต่อแล้ว; Tiandy มีภาพเหตุจริงใน Central production; UNV event พร้อมภาพทดสอบกับกล้องจริงในระบบจำลองครบสามชั้น ไม่อ้างว่าเกิดเหตุพร้อมภาพใหม่ใน production แล้ว
- เก็บภาพประกอบ event และส่งต่อได้ แต่ไม่บันทึกวิดีโอเอง; playback ดึงจากกล้อง/NVR/VMS

## ประวัติ release AI จากต้นทาง — 2026-10-02 (38315ff)

- Gateway build `38315ff` ตรงกันทั้ง Central, Regional, Windows Edge 101 และ Ubuntu Edge 102
- ผู้ใช้ติดตั้งแพ็กเกจที่ Edge ทั้งสองผ่านหน้า Regional; ยืนยัน Online / ติดตั้งสำเร็จ และ /api/instance
- Backup ก่อน merge: `D:\gateway-backups\daily\20261002-141316`
- ปล่อยแพ็กเกจ Edge Windows x64 / Linux x64 / Linux arm64; signature, size และ SHA-256 ผ่าน
- Windows Client `1.9.3` เผยแพร่ full/delta/installer แล้ว; รองรับภาพเหตุและตัวกรอง Edge/กลุ่ม/ที่มา
- รับ AI จากต้นทางตาม [EXTERNAL-AI.md](EXTERNAL-AI.md); ไม่รัน inference หรือบันทึกวิดีโอ
- กล้องที่แอดใหม่แสดงใน AI Sources แต่ receiver ต้องเปิดเป็นรายกล้อง; native UNV รอบนี้รองรับ LineCrossing กล้องเดี่ยวช่อง 1

เอกสาร Markdown/HTML ใน docs ไม่เปลี่ยน Gateway build จึงไม่ต้อง restart หรือ publish สำหรับการแก้เอกสารอย่างเดียว

## สิ่งที่รันอยู่

| pm2 app | คืออะไร | พอร์ต | ecosystem | state (DB, secret) |
|---|---|---|---|---|
| `0-go2rtc` | go2rtc ของ central | 1984 API · 8555 RTSP · 8556 WebRTC | `ecosystem.windows.config.cjs` | `go2rtc/go2rtc.yaml` |
| `2-vms-backend` | Surveillance Gateway Central | 5173 | `ecosystem.windows.config.cjs` | `server/` (`vms.db`, `.gateway-key-secret`, …) |
| `1-go2rtc-regional` | go2rtc ของ Regional | 1994 · 8565 · 8566 | `ecosystem.regional.config.cjs` | `D:\gateway-regional\go2rtc.yaml` |
| `3-regional-gateway` | Surveillance Gateway Regional ภาคกลาง (node `100`) | 5273 | `ecosystem.regional.config.cjs` | `D:\gateway-regional\` |

go2rtc API (1984 / 1994) ไม่มี auth — ฟังเฉพาะ `127.0.0.1` (gateway ส่งต่อให้ผู้ใช้ผ่าน 5173/5273) · ดูหัวข้อ "ล็อก go2rtc API" ข้างล่าง

ffmpeg อยู่ที่ `C:\ffmpeg\bin\ffmpeg.exe` · Node.js ที่ `C:\Program Files\nodejs`
.NET SDK (build client) อยู่ใน `%LOCALAPPDATA%\Microsoft\dotnet` ของ user admin ไม่ใช่ Program Files

## ประวัติงานที่ปิดและการตรวจรุ่น (2026-09-30)

- Gateway build `a36a2d8` ยืนยันตรงกันทั้ง Central, Regional และ Edge 101/102; แพ็กเกจอัปเดตทั้งสามแพลตฟอร์มผ่าน `node scripts/verify-edge-release.cjs a36a2d8`
- ผล deploy: `D:\gateway-backups\regional-migration-M0\milestone-playback-a36a2d8-result.json` (`ok: true`); transcript ชื่อเดียวกันนามสกุล `.log`
- Milestone Playback ยืนยันจริงแล้วผ่าน Regional/Central ทั้ง AXIS และ TIANDY รวม 8 คลิป พร้อม seek คนละสองช่วงเวลา; ผู้ใช้ยืนยันดูได้แล้ว · อย่าแอดกล้องใหม่เพื่อแก้ playback เพราะ Global ID เดิมต้องคงไว้
- Windows Edge 101 อยู่เครื่องใหม่; Ubuntu Edge 102 ใช้ Tailscale `203.0.113.80:5173`, service `gw-edge` (`sudo systemctl restart gw-edge` เมื่อจำเป็น) **ห้ามเรียก pm2 ด้วยมือที่ Ubuntu**
- ในรอบ 2026-09-30 AI ยังพักไว้; ปัจจุบันรับผลภายนอกและไม่มี process inference · state Edge เดิม `D:\gateway-edge` เก็บไว้พร้อม backup
- Regional mirror และ Edge ตรวจอัปเดตทุก 1 นาที; โหลดขาด retry 5/15/60 วินาทีหรือกดลองใหม่; ต้องรอแพ็กเกจโหลดครบก่อนกดติดตั้งและตรวจ build/สถานะติดตั้งหลังกลับมา online
- หน้า Cameras ของ Edge → **แก้จังหวัด–อำเภอทั้งกลุ่ม**; ถ้าเลือกข้ามกลุ่มใช้ปุ่ม **แก้จังหวัด–อำเภอ** ด้านบน → เลือกจังหวัดและอำเภอ → บันทึก; ไม่เปลี่ยน Global ID และหมุดเดิม
- กล้องเก่าที่ไม่มีจังหวัดยังต้องเลือกพื้นที่จริง; กล้องใหม่ทุกช่องทางถูกบังคับโดยหน้าเว็บและ API แล้ว
- การแก้ Markdown ไม่เปลี่ยน Gateway build และไม่ต้อง restart/publish; จำนวนกล้องในบันทึกเป็นผลตรวจ ณ เวลานั้น

## PM2

**เปิด PowerShell แบบ Run as administrator ทุกครั้ง** — daemon รัน elevated (`PM2_HOME=D:\gw-pm2\home`)
shell ธรรมดาต่อไม่ได้ (`EPERM \\.\pipe\rpc.sock`) และ pm2 จะแอบ spawn daemon เปล่าตัวใหม่ทิ้งไว้

ในเซสชันเดียว ตั้งตัวแปรครั้งเดียวแล้วใช้ `$pm2` ต่อได้ — pm2 ตัวเดียวกับ task บูต (`scripts\start-gateway.cmd`)
ไม่ใช่ `pm2.cmd` ใน profile Administrator (คนละรุ่น):

```powershell
$env:PM2_HOME = "D:\gw-pm2\home"
function pm2x { & "C:\Program Files\nodejs\node.exe" "D:\gw-pm2\npm\node_modules\pm2\bin\pm2" @args }
$pm2 = "pm2x"
```

| ต้องการ | คำสั่ง |
|---|---|
| ดูสถานะ | `& $pm2 list` |
| restart หลังแก้ `server/` | `& $pm2 restart 2-vms-backend 3-regional-gateway` |
| restart go2rtc | `& $pm2 restart 0-go2rtc 1-go2rtc-regional` (ตัดภาพทุกคนที่ดูอยู่) |
| ดู log สด | `& $pm2 logs 3-regional-gateway --lines 100` |
| เปลี่ยน env ใน ecosystem | `& $pm2 delete 3-regional-gateway` แล้ว `& $pm2 start D:\gateway-dashboard\ecosystem.regional.config.cjs --only 3-regional-gateway` |

- `PM2_HOME` ใน shell ไม่ได้เลือก daemon (Windows ใช้ pipe ตายตัว) แต่ pm2 คำนวณ path ของ log ฝั่ง CLI จากค่านี้ —
  ไม่ตั้งแล้ว `pm2 start` จะส่ง log ไป `~\.pm2\logs` (ecosystem ของ edge ตรึง log ไว้ที่ `D:\gw-pm2\home\logs` แล้วตั้งแต่ 2026-09-29)
- คำเตือน `In-memory PM2 is out-of-date` ไม่ต้องทำอะไร · **ห้าม `pm2 update`** (รีสตาร์ทยกชุด)
- **ห้าม `node server.js` ด้วยมือบน 5173/5273** — ชนพอร์ตของจริงและ process ค้างอยู่หลังปิด shell

### ตอนบูตเครื่อง

Scheduled Task **"CCTV Gateway (pm2 resurrect at boot)"** (At system start up, user admin)
รัน `D:\gateway-dashboard\scripts\start-gateway.cmd` → `startOrRestart` จาก `ecosystem.windows.config.cjs`
และ `ecosystem.edge.config.cjs` (ถ้ามีไฟล์) log ต่อท้ายที่ `D:\gw-pm2\home\boot-start.log`

- สั่งจากไฟล์ ecosystem ใน git **ไม่ได้ resurrect** — `pm2 save` จึงไม่มีผลต่อการบูต
- แอปใหม่ต้องใส่ใน ecosystem file ไม่งั้นหายหลัง reboot
- เห็นหน้าต่าง ffmpeg เด้งบน desktop = มีคนสั่ง pm2 start/restart go2rtc จาก shell ที่มีหน้าจอ
  (ใน task ไม่มี desktop จึงไม่เห็น) — ไม่กระทบการทำงาน ถ้ารำคาญให้ reboot หรือรัน task ใหม่

## Deploy

### ขั้นย้ายเป็น Central → Regional → Edge จังหวัด

แผนและเกณฑ์ทดสอบอยู่ใน [REGIONAL-PLAN.md](REGIONAL-PLAN.md) ข้อ 6–7 · ทุกคำสั่ง PM2 ในขั้นนี้ต้องใช้ PowerShell แบบ Administrator ตามหัวข้อ PM2 ด้านบน

1. **M0 — สำรองและทำบัญชีข้อมูล**: รัน `backup-windows.ps1` และตรวจว่าได้ `central/vms.db` กับ `edge/vms.db` พร้อม secret/config; ส่งออกรายการกล้อง แหล่ง NVR/VMS พิกัด wall ผู้ใช้ role และ API key ที่ต้องสร้างใหม่ ตรวจว่าอ่าน backup กลับได้ ก่อนแตะ Edge เดิม `D:\gateway-edge` ห้ามใช้ฐานข้อมูล Edge เดิมเป็นฐานข้อมูล Regional

   ถ้ารันจาก worktree ให้ระบุต้นทางจริง และเก็บ snapshot M0 แยกจาก backup รายวันที่หมุนทิ้งได้:

   ```powershell
   powershell -ExecutionPolicy Bypass -File D:\gateway-dev\backup-windows.ps1 -SourceRepo D:\gateway-dashboard -Destination D:\gateway-backups\regional-migration-M0 -SkipPrune
   ```
2. **M1 — Edge แยกเครื่อง**: ผู้ดูแลจัดหา Edge ใหม่แทน Edge 001 และแอดกล้องเอง; Ubuntu Edge 002 ใช้เครื่องเดิม ออกเลข node ตามบล็อกของภาคและเปลี่ยนปลายทาง link เป็น Regional ไม่ต้องเปิด Edge ใหม่ที่ :5373 บนเครื่อง Central
3. **M2 — สลับ :5273 เป็น Regional**: สำรองอีกครั้ง หยุด PM2 `3-edge-gateway`, `1-go2rtc-edge` ของ Edge เดิม ตรวจว่าพอร์ต 5273/1994/8565 ว่างแล้ว สร้าง `D:\gateway-regional\regional.json` ใหม่โดยใช้ `role: "regional"`, `region: "central"`, `node: "100"`, `stateDir: "D:\\gateway-regional"`, `port: 5273`, `go2rtcApi: 1994`, `go2rtcRtsp: 8565`; สร้าง `go2rtc.yaml` ของ Regional โดย API ฟัง loopback เท่านั้น เริ่ม `ecosystem.regional.config.cjs` ตรวจ `/api/instance` เป็น `regional` ออก key สำหรับ Client ที่ Regional และ token สำหรับ Edge จังหวัดจากหน้า Edge Nodes จากนั้นตั้ง Edge จังหวัดให้ link ไป Regional แล้วทดสอบตัดเฉพาะสาย Regional → Central: Client ที่ชี้ Regional ต้องยังเห็น catalog และภาพ
4. **M3 — เชื่อมประเทศ**: ที่ Central เพิ่ม Regional แบบ link/ออก token สำหรับ node `100` จากนั้นใส่ `centralUrls` และ `centralToken` ใน `regional.json` แล้ว `deploy.ps1 -ReloadRegionalConfig` ตรวจ Central เห็น global ID เดิมของ Edge จังหวัด, สิทธิ์รายภาค/จังหวัด และการกลับมาต่อสายเอง ทำจังหวัดและภาคอื่นทีละชุด

`scripts/start-gateway.cmd` จะเริ่ม Edge เดิมตราบใดที่ยังไม่มี `regional.json`; เมื่อมีไฟล์นี้จะเริ่ม Regional แทน; Edge จังหวัดบนเครื่องนี้เป็นตัวเลือกเฉพาะเมื่อมี config หลัง M2 `deploy.ps1` ปฏิเสธการทำงานถ้า PM2 ของ Edge เดิมยังอยู่ เพื่อกันการชนพอร์ต ห้ามสร้าง `regional.json` ก่อนหยุด Edge เดิมและตรวจ backup

ขั้น M1–M3 ยังต้องยืนยันกับอุปกรณ์จริง โดยเฉพาะ playback/PTZ ของ Tiandy และ DSS รวมทั้งแพ็กเกจอัปเดตที่เซ็นจริง ก่อนถือว่าพร้อมใช้งาน

| แก้อะไร | ทำอะไรต่อ |
|---|---|
| `server/**` | `node --check` → commit → **`scripts\deploy.ps1`** (shell admin: backup, restart, ตรวจ build, build เว็บ, publish ให้ edge แบบ link) |
| `src/**`, `index.html`, `edge.html` | `npm run build` (ไม่ต้อง restart) — ถ้าใช้ API ใหม่ ให้ restart backend ก่อน |
| `client-windows/**` | ขึ้น `<Version>` → `scripts\build-client-release.ps1` ([CLIENT-RELEASES.md](CLIENT-RELEASES.md)) |
| ออกเวอร์ชันให้ edge แบบ link | `deploy.ps1` publish ให้เองทุกครั้ง (หรือ `build-edge-kit.ps1 -UpdatesOnly` อย่างเดียว ~30 วิ) → รอ ≤ 5 นาที → Edge Nodes กดปุ่มลูกศรที่แถว edge · publish ครั้งเดียวต่อรุ่น — edge ที่ออฟไลน์ได้ข้อเสนอเองเมื่อกลับมาต่อสาย · ชุดติดตั้งให้ดาวน์โหลดใหม่ = `build-edge-kit.ps1 -Publish` ([EDGE-KIT.md](EDGE-KIT.md) ข้อ 5) |
| `ecosystem.*.config.cjs` | `pm2 delete` + `pm2 start … --only …` ของแอปนั้น |
| `go2rtc/go2rtc.yaml` | อย่าแก้มือ — backend ซิงก์สตรีมเข้า go2rtc เองผ่าน REST (ยกเว้นล็อก API ด้วย `scripts/lock-go2rtc-api.cjs`) |

เลข `build` = commit ล่าสุดที่แก้ `server src scripts package.json ecosystem.edge.config.cjs`
(ต้นฉบับ `BUILD_PATHS` ใน `server/shared/instance.js` — deploy.ps1, build-edge-kit.ps1, deploy-edge.sh ใช้ชุดเดียวกัน)
commit ที่แก้แค่ `docs/` หรือ `client-windows/` ไม่เปลี่ยนเลข build

ตรวจหลัง deploy:

```bash
curl http://203.0.113.80:5173/api/instance
curl http://203.0.113.80:5273/api/instance
```
ได้ `{"role":"central","node":"000",...,"build":"<commit>"}` และ `{"role":"regional","region":"central","node":"100",...,"build":"<commit>"}`
build ของ Edge 101/102 ดูที่หน้า Edge Nodes ของ Regional (หรือ `curl http://203.0.113.80:5173/api/instance` สำหรับ Edge 102)

## Backup และการกู้

| อะไร | อยู่ใน git? | backup ด้วย |
|---|---|---|
| โค้ด | ใช่ (repo local ไม่มี remote) | git |
| `server/vms.db` (central) | ไม่ | `.\backup-windows.ps1` (VACUUM INTO) |
| `D:\gateway-regional\vms.db` (Regional 100) | ไม่ | `.\backup-windows.ps1` (`-RegionalStateDir` ถ้าอยู่ที่อื่น) |
| `D:\gateway-edge\vms.db` (state ของ Edge 001 เดิม เก็บไว้อ้างอิง) | ไม่ | `.\backup-windows.ps1` สำรองเมื่อยังมีไฟล์ |
| กุญแจเซ็นแพ็กเกจ edge `D:\gw-edge-kits\signing\edge-update-key.pem` | ไม่ | `.\backup-windows.ps1` |
| Edge 101/102 (แยกเครื่อง) | ไม่ | backup ของเครื่องนั้นเองตีสอง ([EDGE-KIT.md](EDGE-KIT.md) ข้อ 3, [EDGE-LINUX.md](EDGE-LINUX.md)) |
| `.env` (Google Maps key) | ไม่ | `.\backup-windows.ps1` |

- แต่ละรอบเป็นโฟลเดอร์ `D:\gateway-backups\daily\<yyyyMMdd-HHmmss>\{central,regional,edge}\` · เก็บ 30 วัน แต่เหลือ 3 รอบล่าสุดเสมอ
  (ไฟล์แบบเก่าที่วางตรง ๆ ใน `daily\` ก่อน 2026-09-23 ไม่ถูกลบอัตโนมัติ) · `.\backup-windows.ps1 -List` ดูรอบที่มี
- สำรองไม่สำเร็จ = exit code 1 (Scheduled Task ขึ้นผลล้มเหลว ดูที่ Task Scheduler → Last Run Result)
- **ตั้ง backup รายคืน** (ครั้งเดียว ใน shell admin — ใช้บัญชี/โหมด S4U เดียวกับ task บูต ไม่ต้องมีคน login):
  ```powershell
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\gateway-dashboard\backup-windows.ps1'
  $t = New-ScheduledTaskTrigger -Daily -At 02:00
  $p = New-ScheduledTaskPrincipal -UserId 'HOST\admin' -LogonType S4U -RunLevel Limited
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName 'CCTV Backup (nightly)' -Action $a -Trigger $t -Principal $p -Settings $s
  ```
  `-StartWhenAvailable` = เครื่องปิดตอนตี 2 ก็รันทันทีที่เปิด · ทดสอบ: `Start-ScheduledTask 'CCTV Backup (nightly)'`
- backup อยู่ดิสก์ D: ลูกเดียวกับข้อมูลจริง กันความผิดพลาดได้ ไม่กันดิสก์เสีย

### Backup/restore จากหน้า System Settings

- Web backup เป็น SQLite snapshot ที่รวมข้อมูล commit ใน WAL แล้ว ไม่ใช่การคัดลอกเฉพาะ main file; เป็น DB อย่างเดียว ไม่รวม secret/config/JPEG จึงไม่แทน backup-windows.ps1
- Restore ตรวจ SQLite header, integrity และ core schema ก่อนปิด DB; ไฟล์ผิดตอบ 400 และ DB เดิมยังใช้งานได้ คอลัมน์ใหม่ที่ migration เติมได้ไม่จำเป็นต้องมีใน backup เก่า
- Backup/restore ทำซ้อนกันไม่ได้ (409); upload ใช้ชื่อชั่วคราวแยกต่อคำขอ และลบหลังใช้งาน
- ก่อนแทน DB เก็บ snapshot ชื่อ vms.db.before-restore-<เวลา>-<UUID> รวม commit ก่อนปิด connection; หากแทนไฟล์ไม่สำเร็จพยายามกู้ snapshot ก่อน restart ถ้ากู้กลับไม่ได้ log จะแจ้งให้ใช้ snapshot นี้ด้วยมือ
- Restore สำเร็จยัง restart ผ่าน supervisor เหมือนเดิม; snapshot มีข้อมูลลับ ห้ามเข้า git และต้องใช้สิทธิ์ไฟล์เช่นเดียวกับ DB
- ตรวจ regression ในพื้นที่แยก: node scripts/check-database-maintenance.cjs (fixture ใน TEMP, ไม่ใช้ DB/พอร์ต production)

- `D:\gateway-backups\vm-final` = สภาพสุดท้ายของยุค VM อย่าลบจนกว่าจะแน่ใจว่าไม่ต้องใช้ VHDX แล้ว

กู้ DB: หยุดแอปนั้น (`pm2 stop 2-vms-backend` หรือ `3-regional-gateway`) → ลบ `vms.db-wal`, `vms.db-shm` → วาง `<รอบ>\central\vms.db`
(หรือ `regional\vms.db` ไปที่ `D:\gateway-regional`) เป็น `vms.db` ของเครื่องนั้น พร้อม secret จากโฟลเดอร์เดียวกัน → `pm2 start` · **กู้ DB กับ `.gateway-key-secret` จากรอบเดียวกันเสมอ**
(key ใน DB ถูกเข้ารหัสด้วยกุญแจนั้น)
หน้าเว็บ central มีปุ่ม Backup/Restore ใน System Settings ทำแบบเดียวกัน (และเก็บสำเนาก่อนกู้ให้)

## ล้างกล้องทั้งหมด (เริ่มระบบใหม่)

```bash
node scripts/reset-cameras.cjs                            # central (server/vms.db)
node scripts/reset-cameras.cjs D:\gateway-regional\vms.db    # regional — shell admin เพราะไฟล์เป็นของ process elevated
```
ล้าง: กล้อง, แหล่งกล้อง (Digifort/edge/regional), ข้อมูล AI (`ai_events`, `ai_rules` และตาราง AI หัวกล้องเดิม), `camera_deletions`, log · เก็บ: user, role, API key
· ล้างที่ Central/Regional = ตัดลูกทุกตัวออกด้วย ต้องแอดลูกกลับ (Edge ยังถือกล้องและ Global ID เดิม) · กล้องจริงอยู่ที่ Edge แยกเครื่อง ล้างที่นั่น
(ไฟล์ภาพใน `ai-snapshots/` ไม่ถูกลบ — ลบเองถ้าต้องการ)
สำเนาก่อนล้างอยู่ใน `backups/` (git ignore เพราะมีรหัสกล้อง) · เสร็จแล้ว restart แอปนั้นให้ go2rtc ทิ้งสตรีมเก่า

## Log

| ของ | ที่อยู่ |
|---|---|
| pm2 | `<PM2_HOME ของคนที่ start แอปนั้น>\logs\<app>-out.log`, `-error.log` — ดูที่อยู่จริงด้วย `& $pm2 describe <app>` (บรรทัด out/error log path) หรือ `& $pm2 logs <app>` |
| การบูต | `D:\gw-pm2\home\boot-start.log` |
| event ของระบบ (login, แอดกล้อง, sync edge) | หน้าเว็บ → System Logs (ตาราง `logs`) |

ตั้งแต่ 2026-09-29 `ecosystem.edge.config.cjs` ตรึง log ของ `1-go2rtc-edge`, `3-edge-gateway` ไว้ที่
`D:\gw-pm2\home\logs\` (เดิมไปตกที่ `C:\Users\Administrator\.pm2\logs\` เมื่อ start จาก shell ที่ไม่ได้ตั้ง `PM2_HOME`)
และทุกแอปทั้งสอง ecosystem มีเวลาหน้าแต่ละบรรทัด (`log_date_format`) — มีผลหลัง `pm2 delete` + `pm2 start` ของแอปนั้น (ดู Deploy)
ไฟล์ `-error.log` สะสมข้ามยุค — ดูเวลาของบรรทัดก่อนสรุปว่าระบบมี error

## ล็อก go2rtc API

API ของ go2rtc ไม่มี auth: ใครต่อถึง 1984/1994 ได้ก็อ่าน URL กล้อง (มีรหัสผ่าน) และเพิ่ม/ลบสตรีมได้ — ต้องฟังแค่ `127.0.0.1`
gateway คุยกับ go2rtc ทาง loopback อยู่แล้ว และส่งต่อ MSE/WebRTC/snapshot ให้ผู้ใช้ผ่าน 5173/5273 ที่ตรวจ token
RTSP (8555/8565) และ WebRTC (8556/8566) ยังฟังทุก interface ตามเดิม (central/client ต้องต่อถึง)

ตัวสร้าง yaml ใหม่ (`setup-edge.ps1`, `setup-edge.sh`, `edge-sim.ps1`, ตัวติดตั้งชุด flash drive) เขียน `127.0.0.1` ให้แล้ว
ไฟล์ที่มีอยู่แก้ด้วยสคริปต์ (shell admin — ไฟล์เป็นของ process elevated · สำรอง `<ไฟล์>.bak` ก่อนเขียน · รันซ้ำได้ · ไม่พิมพ์ URL สตรีม):

```powershell
node D:\gateway-dashboard\scripts\lock-go2rtc-api.cjs --dry-run      # ดูก่อนว่าจะเปลี่ยนอะไร
node D:\gateway-dashboard\scripts\lock-go2rtc-api.cjs D:\gateway-dashboard\go2rtc\go2rtc.yaml D:\gateway-regional\go2rtc.yaml   # ไม่ใส่ไฟล์ = ค่าเดิม go2rtc\go2rtc.yaml + D:\gateway-edge\ (ไม่รวม Regional)
& $pm2 restart 0-go2rtc 1-go2rtc-regional                              # go2rtc อ่าน api.listen ตอนเริ่มเท่านั้น (ตัดภาพคนที่ดูอยู่ครู่หนึ่ง)
netstat -ano | findstr ":1984 :1994"                               # ต้องเห็น 127.0.0.1:1984 / 127.0.0.1:1994 เท่านั้น
```

สถานะ 2026-09-29: ล็อกแล้วครบทั้ง central (1984), edge 001 (1994) และ edge 002 (1984) · หลัง 2026-09-30 พอร์ต 1994 เป็นของ Regional ซึ่ง `go2rtc.yaml` ใหม่สร้างแบบ loopback ตั้งแต่ต้น (ตรวจด้วย `netstat` ข้างบน) · ถ้าเผลอ `pm2 delete` แอปของ central
ต้อง start กลับด้วย `pm2 start D:\gateway-dashboard\ecosystem.windows.config.cjs` (path ในไฟล์เป็น absolute แล้ว สั่งจากโฟลเดอร์ไหนก็ได้)
และ **วางคำสั่งทีละบรรทัด** — เคยวางสองคำสั่งติดกันเป็นบรรทัดเดียว pm2 จึงไม่ start central (ล่มจนสั่งใหม่ 2026-09-29)

**edge 002 (Linux) รันเป็น systemd `gw-edge` ไม่ใช่ pm2** (อย่ารัน `pm2` ที่นั่น — จะ spawn daemon เปล่า ปิดด้วย `pm2 kill`)
— state อยู่ `/var/lib/gw-edge` ( `--state-dir` ของ setup-edge.sh ถ้าย้ายไว้ที่อื่น):

```bash
sudo -u <ผู้ใช้ของ service> node ~/gw-edge/scripts/lock-go2rtc-api.cjs /var/lib/gw-edge/go2rtc.yaml
sudo systemctl restart gw-edge
ss -ltnp | grep ':1984'                                            # ต้องเป็น 127.0.0.1:1984
```
edge จากชุด flash drive: `node <root>/app/scripts/lock-go2rtc-api.cjs <stateDir>/go2rtc.yaml` (Windows: `<root>\state`) แล้ว restart service ของชุด
(สคริปต์ไปถึงเครื่องพร้อมแพ็กเกจอัปเดตรุ่นถัดไป)

## ตั้ง edge บนเครื่องใหม่

**edge ใหม่ที่หน้างาน ใช้ชุดติดตั้ง flash drive — [EDGE-KIT.md](EDGE-KIT.md)** (`scripts\build-edge-kit.ps1` → `install-windows.cmd` / `install-linux.sh`)
ออก token/ไฟล์ `edge-<เลข>.json` ที่ **Regional ของภาคนั้น** → Edge Nodes (ไม่ใช่ Central — Central แอดได้เฉพาะ Regional)
**เครื่อง Linux ที่ติดตั้งเองแบบเดิม (Edge 102) ใช้ [EDGE-LINUX.md](EDGE-LINUX.md)**

> ข้างล่างคือวิธีเดิมของ edge 001 บน Windows ที่ใช้ pm2 — ยุติแล้ว 2026-09-30 เก็บไว้อ้างอิงเท่านั้น

1. ติดตั้ง Node.js 22, ffmpeg (`C:\ffmpeg\bin`), pm2, git — แล้ว clone repo นี้
2. ค่าของเครื่องใส่ใน `<stateDir>\edge.json` (ไม่แก้ไฟล์ใน git): `node` (เลข edge ไม่ซ้ำทั้งประเทศ — ตาราง [EDGE-PLAN.md](EDGE-PLAN.md)),
   `province`, `publicHost` (IP ที่ central ต่อถึง เช่น Tailscale), `stateDir`, พอร์ต · ไม่มีไฟล์ = ค่าของ edge 001 บน HOST
   (ดูรายการ key ในหัว `ecosystem.edge.config.cjs`)
3. `npm install` และ `cd server && npm install` · `npm run build`
4. `powershell -ExecutionPolicy Bypass -File scripts\setup-edge.ps1` — สร้างโฟลเดอร์ state + `go2rtc.yaml`
5. `pm2 start ecosystem.edge.config.cjs` และตั้ง task ตอนบูตแบบ `start-gateway.cmd`
6. เปิดเว็บ edge → login `superadmin`/`superadmin` → **เปลี่ยนรหัส** → แอดกล้อง → Central Access ออก key
7. ที่ central → Edge Nodes → Add Edge
8. firewall ของ edge: เปิดพอร์ต gateway และ RTSP ของ go2rtc ให้ **IP ของ central เท่านั้น**

**edge ที่ central ต่อเข้าไปไม่ถึง (หลัง NAT)** — ข้ามข้อ 7–8 ใช้แบบ link แทน ([EDGE-PLAN.md](EDGE-PLAN.md) หัวข้อ link):
Regional → Edge Nodes → Add Edge → "Edge ต่อขึ้นมาเอง" → คัดลอก URL + token ไปใส่ `centralUrl` / `centralToken` ใน `<stateDir>/edge.json`
ของ edge (Linux: `scripts/setup-edge.sh --central-url … --central-token …`) แล้ว `pm2 delete 3-edge-gateway` + `pm2 start ecosystem.edge.config.cjs --only 3-edge-gateway`
edge ต้องออกไปหาพอร์ต gateway และ RTSP ของ parent ได้ (Regional ภาคกลาง: 5273 / 8565) · ยังไม่มี TLS — ผ่าน Tailscale/LAN เท่านั้น

## ทดสอบโดยไม่แตะ production

`scripts/edge-sim.ps1` เปิด Edge (5283, node 101), Regional (5483, node 100) และ Central (5383, node 000) พร้อม go2rtc แยก instance
state อยู่ใต้ `-Root` (ค่าเริ่มต้น `D:\gateway-sandbox\edge-sim`); หน้าเว็บใช้ `dist` ของ worktree ที่เรียกสคริปต์ ไม่ใช่ `<Root>\dist`
ตรวจทุกพอร์ตและเจ้าของ process ก่อนใช้ทั้ง start และ -Stop เพราะสคริปต์หยุด process ตามพอร์ต; ห้ามใช้เมื่อชนงานอื่น และห้าม npm ci ลง junction ของ worktree

```bash
cd D:\gateway-dev
npx vite build --outDir D:\gateway-dev\dist --emptyOutDir
powershell -ExecutionPolicy Bypass -File D:\gateway-dev\scripts\edge-sim.ps1 -Root D:\gateway-sandbox\audit-fresh
powershell -ExecutionPolicy Bypass -File D:\gateway-dev\scripts\edge-sim.ps1 -Root D:\gateway-sandbox\audit-fresh -Stop
```

- **ข้อมูลใน `D:\gateway-sandbox\edge-sim` ก่อน 2026-09-23 ชี้ไปพอร์ต 5273** ซึ่งตอนนี้คือ edge จริง — ลบโฟลเดอร์ `edge`, `central`
  ใน `D:\gateway-sandbox\edge-sim` ทิ้งก่อนใช้ครั้งแรก (ต้อง shell admin ถ้าเคยรันด้วยสิทธิ์ admin)
- instance จำลองที่เพิ่มกล้องจริง จะเปิด session ไปกล้องจริงเพิ่ม — ใช้เสร็จสั่ง `-Stop`
- เปิดด้วย shell ไหน ต้องปิดด้วยสิทธิ์เท่ากัน (process ของ admin shell ธรรมดาปิดไม่ได้)
- ทดสอบ DB ใหม่ = ติดตั้งสด — ใช้ตอนแตะ schema เพื่อจับคอลัมน์ที่ไม่มี migration

## แก้ปัญหาที่เจอบ่อย

| อาการ | ตรวจ |
|---|---|
| เมนูว่าง เหลือแค่ Dashboard | ผู้ใช้ไม่มี `role_id` / สิทธิ์ — `GET /api/me` ต้องมี `permissions` · logout แล้ว login ใหม่ |
| หน้าเว็บเก่า / ปุ่มใหม่ไม่ขึ้น | ลืม `npm run build` หรือเบราว์เซอร์ cache — Ctrl+F5 |
| API ใหม่ตอบ 404 | ลืม restart backend — ดู `build` ใน `/api/instance` |
| กล้องจาก edge ขึ้น "ไม่ทราบสถานะ" | ตรวจที่หน้า Edge Nodes ของ Regional (และ Regional Nodes ของ Central) ว่าสายต่ออยู่ และ `curl http://<edge>:5173/api/instance`; ถ้าภาพดูได้ ให้เทียบ `state.reachable` ของ `/api/v1/cameras` ที่ Edge กับ Central และกด Sync ที่ Edge Nodes เพื่อรับสถานะตั้งต้นของกล้องใหม่ |
| central ไม่เห็นกล้องที่เพิ่งแอดที่ edge | รอรอบ 10 นาที (link: 5 นาที) ต่อชั้น หรือกด Sync ที่ Edge Nodes ของ Regional แล้ว Regional Nodes ของ Central |
| Edge Nodes ของ Regional ขึ้นป้าย "N นอกภาค" | กล้องที่ Edge ตั้งจังหวัดนอกภาคของ Regional — รับเข้าแล้ว ใช้งานได้ (ชี้เมาส์ดูชื่อกล้อง) · ถ้าตั้งจังหวัดผิด แก้ที่ Edge · ถ้าตั้งใจ ปล่อยไว้ได้ |
| Edge Nodes ของ Regional ขึ้นป้าย "Edge นอกภาค" | `province` ใน edge.json ของ Edge นั้นอยู่นอกภาค — รับสายแล้ว ใช้งานได้ · ถ้าผิดให้แก้ `province` ใน `<state>/edge.json` แล้ว restart edge (ค่านี้ใช้เป็นจังหวัดใน global ID ของกล้องที่ยังไม่เลือกจังหวัดด้วย) |
| edge แบบ link ขึ้น "ติดต่อไม่ได้" | log ของ edge บรรทัด `[Edge link]` · token ผิด = 401 ตอนต่อ · เลขเครื่องซ้ำ = central ปฏิเสธ (ข้อความอยู่ใน log ทั้งสองฝั่ง) |
| กล้อง link เปิดแล้วจอดำ | ลูก push ขึ้นไม่ได้ — ต้องออกไปหา RTSP ของ parent ได้ (Regional 8565, Central 8555) · log ของลูกบรรทัด `push … หยุด` |
| เมนู Live ไม่ขึ้น | role ไม่มี `menu.live` (role ตั้งต้นได้เองหลัง restart backend) · PTZ บนเว็บต้องมี `device.ptz` |
| PTZ ผ่าน central ถูกปฏิเสธ | key ที่ central ถือไว้กับ edge ต้องติ๊ก "คุม PTZ" ที่หน้า Central Access ของ edge |
| กล้องต่อได้แต่จอดำ | [CAMERA-QUIRKS.md](CAMERA-QUIRKS.md) |
| `pm2` ทำอะไรก็ไม่มีผล | shell ไม่ได้ยกสิทธิ์ — มี daemon เปล่าเกิดใหม่ ปิด `node … pm2\lib\Daemon.js` ตัวที่เพิ่งเกิด |
| แผนที่ว่าง | ต้องต่อเน็ตได้ (ไทล์ OSM/Esri ผ่าน proxy + cache ใน `server/map_data/`) หรือสลับเป็น MBTiles ใน System Settings |

## สิทธิ์ API key ของ SSE

- `/api/v1/events` ปิด connection ของ key นั้นทันทีเมื่อ admin แก้สิทธิ์/disable/delete สำเร็จ; Client ต่อใหม่แล้วใช้ scope ปัจจุบัน ส่วน key อื่นยังต่อได้
- ตรวจ id + key hash + enabled และ scope จาก DB โดยตรงทุก 30 วินาที ไม่ใช้ auth cache; การแก้ DB นอก admin API จึงมีช่วงรอตรวจสูงสุดหนึ่งรอบ บวกเวลา query
- ระหว่าง refresh พักส่ง camera/AI/edge events; หากอ่าน key หรือ scope ไม่ได้ปิด SSE ไม่ใช้สิทธิ์เดิมต่อ AI callback จากรอบสิทธิ์ก่อนหน้าถูกทิ้ง
- SSE ไม่ใช่ durable queue: หลัง reconnect อ่านสถานะจาก `/api/v1/cameras` และตาม AI ที่ตกหล่นผ่าน `/api/v1/ai/events?since=` ตาม client เดิม
- Regression: `node scripts/check-gateway-events.cjs` ใช้ SQLite/HTTP fixture บน loopback และจำลองเวลาเพื่อไม่รอ 30 วินาที ไม่ใช้ DB/key production

## Playback request และภาพนิ่ง

- เปลี่ยนกล้อง/วัน หรือ seek ใหม่ จะยกเลิกสิทธิ์เขียน state ของคำขอเก่า; success/error ที่ตอบช้าไม่เปลี่ยนภาพหรือเวลาที่เลือกใหม่ และออกจากหน้าก็ไม่รับคำตอบค้าง
- ปุ่มภาพนิ่งปิดระหว่างรอ Playback ใหม่ ไม่ใช้ timestamp ของกล้อง/วันก่อนหน้า; หากเปลี่ยนบริบทระหว่างรอ token ของภาพนิ่ง จะปิด popup เปล่าและไม่เปิดภาพของบริบทเก่า
- Regression: `node scripts/check-playback-races.cjs` ใช้ handler/lifecycle จาก source กับ deferred API fixture เพื่อทดสอบ response ย้อนลำดับ ไม่เรียกอุปกรณ์จริง

## Accepted manifest state และ rollback

- updater เก็บลำดับ manifest ที่รับใน `<state>/updates/accepted-manifest.json` ผ่าน temporary file + fsync + atomic rename และ marker `accepted-manifest.initialized` เพื่อแยกเครื่องใหม่จาก state ที่หาย
- อ่าน/parse/schema ของ accepted state ผิด หรือเขียน state ไม่ได้ = ไม่รับ offer/ไม่สร้าง apply.json; runner ตรวจ accepted state ซ้ำก่อนแตกแพ็กเกจ เครื่องเก่าที่มี pending/last-result แต่ accepted หายก็ไม่ถือเป็น first install
- หาก state เสีย ให้เก็บหลักฐานแล้วกู้ accepted state ที่เชื่อถือได้ล่าสุดและแก้สิทธิ์/พื้นที่ดิสก์ ห้ามลบ accepted/marker เพื่อข้าม antirollback; state ที่สำรอง/กู้ครบเครื่องต้องรวมทั้งสองไฟล์ด้วย nightly DB backup เดิมไม่ได้รับรองว่ารวม updates state
- Rollback อัตโนมัติคืน app รุ่นเดิม แต่คงลำดับ accepted รุ่นใหม่ไว้ จึงยังไม่รับ manifest เก่า การตั้งใจ publish code เก่าต้องเซ็นด้วย issuedAt ใหม่ตามขั้นตอนเดิม
- ตัวคุม edge-run ที่รันค้างยังเป็นโค้ดตอนเริ่ม process; การสลับ app ไม่อัปเกรดตัวคุมใน memory ต้องวางแผน restart supervisor เพื่อให้การตรวจ strict ของ runner รุ่นนี้มีผลครบ
- Regression: `node scripts/check-edge-updates.cjs` ใช้ TEMP, generated test key, loopback HTTP, tar fixture และ runner/worker จำลองจริง ไม่ใช้ signing key/package/process production ต้องมี tar ใน PATH/Windows System32


### Build runtime และ dependency — รอบแก้ audit 2026-10-11

- Vite 7 ต้องใช้ Node `^20.19.0 || >=22.12.0`; Node 22.6.0 ของ shell เดิมไม่รองรับ
- `npm run build`, `scripts/deploy.ps1` และ `scripts/build-edge-kit.ps1` ตรวจ runtime ก่อนทำงาน; deploy หยุดก่อน backup/restart เมื่อ Node ของ shell ไม่ผ่าน
- Node 22.23.3 Windows x64 ผ่าน build เว็บ, SQLite native และ regression fixture; ทดสอบแยก ยังไม่ได้ติดตั้งแทน Node ของ production
- ก่อน deploy ต้องเตรียม Node ที่รองรับใน PATH ของ shell และตรวจ runtime ของ Scheduled Task/PM2; `-Node` ใน deploy อย่างเดียวไม่เปลี่ยน Node ที่ npm/npx ใช้
- Server pin Axios 1.20.0 และ Multer 2.4.0 ใน manifest/lockfile; ติดตั้งตาม lockfileในช่วง deploy ที่วางแผนไว้ ห้าม npm ci ลง junction ของ worktree
- `node scripts/check-stack.cjs` ตรวจ HTTP upload/redirect/binary/timeout/cancel กับ loopback fixture ไม่ติดต่ออุปกรณ์จริง
- Advisory ที่เหลือ และ E2E กล้องจริง/เสียง/PTZ/WPF ยังต้องตรวจต่อ; fixture ไม่รับรองอุปกรณ์ทุกยี่ห้อ


### Express dependency patch — 2026-10-11

Server lockfile อัปเดต proxy-addr 2.0.8, path-to-regexp 8.4.2, qs 6.16.0 และ body-parser 2.3.0 ภายใน semver range เดิมของ Express 5.2.1; ไม่เพิ่ม trust proxy และไม่เปลี่ยน API/schema

หลังติดตั้ง dependency ตาม lockfile ใน sandbox รัน `node scripts/check-express-dependencies.cjs` เพื่อตรวจ trust subnet, query parser, literal route patterns และ HTTP JSON/size-limit fixture; ผลนี้ไม่แทน full Gateway E2E


### SQLite/native install dependency — 2026-10-11

- Server pin sqlite3 6.0.1 และ engines Node ^20.19.0 || >=22.12.0 (ครอบคลุม native install fallback และ Vite); lockfile ใช้ tar 7.5.22/node-gyp 12.x รุ่นใหม่ ไม่ใช้ override ข้าม major ของ tar บน SQLite 5
- build-edge-kit.ps1 อ่านรุ่น SQLite จาก lockfile ใน app ที่ git archive แล้ว จึงแพ็ก native binary ตรงกับโค้ดใน commit ไม่ใช่ไฟล์แก้ค้าง
- ทดสอบ npm ci พร้อม lifecycle จริงบน Windows x64 ด้วย Node 22.23.3 และตรวจ installed binary ตรง release ทางการ; Linux x64/ARM64 ตรวจ checksum/การแตกไฟล์แล้ว ยังไม่ได้รันจริง
- SQLite 6 เป็น major upgrade และ upstream node-sqlite3 archived/unmaintained; ต้องผ่าน Gateway startup/E2E และ Linux native smoke test ก่อน production rollout ไม่ได้เปลี่ยน DB driver/schema ในรอบนี้
- Retest ข้ามรุ่น: ตั้ง CHECK_NATIVE_BASELINE_MODULE เป็น absolute path ของแพ็กเกจ sqlite3 5.1.7 ที่สำรองไว้ แล้วรัน `node scripts/check-native-dependencies.cjs` ใน sandbox ที่ติดตั้ง lockfile ใหม่; baseline ใช้เฉพาะสร้าง/อ่าน fixture ใหม่ ไม่มี DB production


### Final dependency / three-tier regression — 2026-10-11

- Removed unused @google-cloud/vertexai and @google/generative-ai: external AI ingress does not perform local inference. Server production dependency audit: 0 advisories in the tested lockfile.
- MapLibre pinned 6.4.1 for attribution XSS fix; map imports use namespace exports and custom Marker uses { element }. Central/Regional/Edge/Client Map build and grouped marker/theme/sanitizer fixtures passed.
- Web audit still reports 11 package entries (8 high, 3 moderate), including build/CLI transitive braces and postcss-selector-parser chains. No forced Tailwind major migration or shadcn downgrade. This is not a zero-advisory release.
- Fresh isolated Edge -> Regional -> Central passed ownership/scope/catalog/Global ID/audio metadata/central outage catalog/AI event dedup/JPEG hash and actual synthetic H.264 + AAC playback on Regional and Central. Viewer consumers returned to zero after closing Live.
- Linux x64/ARM64 native execution, real hardware PTZ/playback, WPF UI and complete Gateway offer-to-supervisor update E2E remain NOT TESTED on this host; existing component fixtures do not replace these release gates.
- All verification used isolated state/dependencies/dist and loopback mock devices. No production restart, deployment or dependency installation was performed.


### Deploy เมื่อ lockfile เปลี่ยน

ใช้ PowerShell แบบ Administrator และ Node ที่ผ่าน runtime guard; เรียก scripts/deploy.ps1 -InstallDependencies เพื่อ backup ก่อนหยุด Central/Regional แล้ว npm ci พร้อม native smoke จากนั้น restart/build/publish ตามลำดับเดิม หากติดตั้งล้มเหลว backend จะหยุดอยู่เพื่อไม่โหลด native module ที่ติดตั้งไม่ครบ; แก้การติดตั้งและรันคำสั่งเดิมซ้ำ ห้ามติดตั้งผ่าน worktree junction ไม่ได้แก้ runtime ของ Scheduled Task/PM2 ให้อัตโนมัติ ต้องใช้ Node ที่รองรับในตำแหน่งเดิมก่อน deploy


### Build tools audit cleanup — 2026-10-11 (หลัง ae03082)

- ถอน shadcn CLI ที่ไม่ใช้จาก manifest/lockfile; ไม่ลบ src/components/ui หรือ components.json. tailwindcss-animate อยู่ devDependencies เพราะใช้สร้าง CSS เท่านั้น.
- ย้าย Tailwind 4.3.3 + @tailwindcss/postcss 4.3.3; ถอน autoprefixer และ parser overrides เดิม. เปลี่ยน @tailwind เป็น @import และกำหนด @source เฉพาะ src กับ HTML entry.
- ถอนสาย braces/chokidar/fast-glob/micromatch ออกจาก lockfile จริง; root npm audit รวม devDependencies = 0 vulnerabilities เมื่อ 2026-10-11. ผล audit เป็นสถานะวันที่ตรวจ ต้องตรวจซ้ำก่อน release.
- คง theme/custom coarse variant/animation และเปลี่ยน shadow-sm -> shadow-xs, backdrop-blur-sm -> backdrop-blur-xs, outline-none -> outline-hidden เพื่อรักษาค่าของ Tailwind 3; rounded-sm คงเดิมเพราะมี custom theme.
- ตรวจ clean install, compiler regression และ build ครบ Central/Regional/Edge/client-map ในพื้นที่แยก. UI sandbox: login ทั้งสามชั้น, light/dark, dashboard, Live synthetic muted, Playback layout, AI Events, Camera Map layout, modal/dropdown. Dashboard font/color/nav geometry ตรง baseline. แผนที่ภาพ tiles และ WPF จริงยังไม่ได้ตรวจรอบนี้.
- Retest: node scripts/check-build-dependencies.cjs และ npm audit หลัง npm ci ใน dependency แยก; ห้ามติดตั้งลง node_modules junction หรือ build ทับ production dist. Tailwind 4 ต้องใช้ Chrome 111+, Safari 16.4+, Firefox 128+; WebView2 ใช้ Evergreen runtime.
