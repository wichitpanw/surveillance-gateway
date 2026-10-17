# ชุดติดตั้ง edge แบบ flash drive (offline)

สำหรับ edge ใหม่ที่หน้างานไม่มี internet — ก๊อปโฟลเดอร์เดียวลง flash drive ไปเสียบ ดับเบิลคลิก จบ
รองรับ **Windows x64** (mini PC) และ **Linux arm64** (Raspberry Pi 5) · มี **Linux x64** ด้วยสำหรับเครื่อง Ubuntu ทั่วไป

edge ที่ติดตั้งด้วยชุดนี้ต่อ parent แบบ **link** (edge ต่อขึ้นมาเอง — [EDGE-PLAN.md](EDGE-PLAN.md)) เสมอ
ตั้งแต่ระบบสามชั้น (2026-09-30) parent ของ edge คือ **Regional ของภาค** — ขั้น "ที่ central" ในเอกสารนี้ทำที่หน้า Edge Nodes ของ Regional
(ดาวน์โหลดชุดติดตั้งได้จากทั้ง Central และ Regional ซึ่ง mirror ไว้)

## สถานะแพ็กเกจ (2026-10-12)

ตรวจ manifest อัปเดต windows-x64/linux-x64/linux-arm64 เป็น `a0d8867`; offline kit ใน `kits.json` ยังเป็น `5005316` ต้องอัปเดตผ่านสายหลังติดตั้ง ไม่ได้ยืนยันการติดตั้ง Raspberry Pi จริง; ผู้ดูแลให้รอทดสอบภายหลัง

## ภาพรวม

```
HOST (มี internet)                    central (หน้าเว็บ)                  หน้างาน (ไม่มี internet)
build-edge-kit.ps1 ──► Edge-Kit-<build>      Edge Nodes → ออก token ──► edge-<เลข>.json
                              └──────────── flash drive ─────────────┘
                                                  └──► install-windows.cmd / install-linux.sh
```

## 1. สร้างชุดติดตั้ง (ครั้งเดียวต่อเวอร์ชัน — ที่ HOST)

```powershell
powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\build-edge-kit.ps1
```
- ผลลัพธ์ `D:\gw-edge-kits\Edge-Kit-<build>\` ~1 GB (ทั้งสามแพลตฟอร์ม) · เลือกเฉพาะที่ใช้: `-Platforms windows-x64,linux-arm64`
- ไฟล์ที่โหลดเก็บใน `D:\gw-edge-kits\cache\` รอบหน้าไม่โหลดซ้ำ
- โค้ดมาจาก **commit** ปัจจุบัน (ไม่ใช่ไฟล์ที่ยังไม่ commit) · `build` = commit ล่าสุดที่แก้ `server src scripts package.json ecosystem.edge.config.cjs` ตรงกับ BUILD_PATHS ใน server/shared/instance.js
- ข้างในแต่ละแพลตฟอร์ม: `app\` (server, scripts, ecosystem, dist, node_modules, BUILD) และ `bin\` (node 22, ffmpeg 8.1 static, go2rtc 1.9.14)
- `sqlite3` เป็น native — สคริปต์สลับ `node_sqlite3.node` ให้ตรงแพลตฟอร์มจาก prebuilt ทางการ
- **`-Publish`** (ใช้ทุกครั้งที่ออกเวอร์ชันจริง) เพิ่มสองอย่างให้ central:
  - `server\edge-updates\<platform>\` แพ็กเกจอัปเดต `app-<platform>-<build>.tar.gz` (~12 MB) + `manifest.json` ที่เซ็นแล้ว — ข้อ 5
  - `server\edge-kits\` ชุดติดตั้งแยกต่อ OS (`.zip` Windows, `.tar.gz` Linux ~120 MB) + `kits.json` — ให้ดาวน์โหลดจากหน้า Edge Nodes (ข้อ 2)
  - มีผลทันทีไม่ต้อง restart · ต้องมีกุญแจเซ็น (ข้อ 6)
- ชุดติดตั้งมีเฉพาะ gateway และเครื่องมือรับผล AI จากต้นทาง ไม่มี Python/GPU inference

## 2. ดาวน์โหลดชุดติดตั้ง + ออกไฟล์ตั้งค่าที่ central

Edge Nodes → กล่อง **"ดาวน์โหลดตัวติดตั้ง Surveillance Gateway Edge"** → เลือก Windows (x64) / Raspberry Pi 5 (Linux arm64) / Linux (x64) → ดาวน์โหลด
- Windows ได้ `.zip` → แตกลง flash drive · Linux ได้ `.tar.gz` → `tar -xzf …` (เก็บสิทธิ์ execute ไว้)
- ในชุดมีแค่ตัวติดตั้งของ OS นั้น + `README-TH.txt` · ไม่มี secret · แสดง sha256 ให้ตรวจไฟล์
- ลิงก์เป็นตั๋วใช้ครั้งเดียว อายุ 5 นาที (`POST /api/edge-kits/<file>/ticket` → `/edge-kit-download/<ticket>`) ต้องมีสิทธิ์ `device.manage`

จากนั้นออกไฟล์ตั้งค่าของเครื่อง:

Edge Nodes → **Add Edge** → "Edge ต่อขึ้นมาเอง" → ชื่อ, **เลข edge** (ระบบเสนอเลขว่างถัดไป — ห้ามซ้ำทั้งประเทศ), รหัสจังหวัด → ออก token
→ ติ๊กเส้นทางของ central ที่ edge นี้เข้าถึงได้ → **ดาวน์โหลด edge-<เลข>.json**

- เลขถูกจองไว้ที่ central ทันที (`GET /api/edges/next-node`, `POST /api/edges/link {label, node}`)
- ไฟล์มี `node, province, label, centralUrls, centralToken` — **token เป็นความลับ** ตัวติดตั้งลบไฟล์ทิ้งหลังติดตั้งเสร็จ
- วางไฟล์ไว้ข้าง `install-windows.cmd` หรือที่ราก flash drive · หลายไฟล์ได้ ตัวติดตั้งถามว่าเครื่องนี้ใช้ไฟล์ไหน

## 3. ติดตั้งที่หน้างาน

| | Windows mini PC | Raspberry Pi 5 / Linux |
|---|---|---|
| สั่ง | ดับเบิลคลิก `install-windows.cmd` (ขอสิทธิ์ admin) | `sudo bash install-linux.sh` |
| โปรแกรม | `C:\GW-Edge\app`, `C:\GW-Edge\bin` | `/opt/gw-edge/app`, `/opt/gw-edge/bin` |
| ข้อมูล (DB, secret, edge.json) | `C:\GW-Edge\state` (อ่านได้แค่ SYSTEM/Administrators) | `/var/lib/gw-edge` (ผู้ใช้ระบบ `gw-edge`, 700) |
| เริ่มตอนบูต | Scheduled Task **Gateway Edge** (SYSTEM) | systemd `gw-edge.service` |
| backup ตีสอง | Scheduled Task **Gateway Edge Backup** → `edge-backup.cjs` | cron `/etc/cron.d/gw-edge-backup` → `backup-edge.sh` |
| firewall | TCP 5173 ขาเข้า + UDP ขาเข้าของ node.exe (ONVIF discovery) | ufw (ถ้าเปิด): 5173/tcp + UDP จากวงของเครื่อง |
| log | `C:\GW-Edge\state\logs\` | `/var/lib/gw-edge/logs/` |

ตัวติดตั้งทำ: เขียน `state/edge.json` (ค่าจากไฟล์ของ central + พอร์ตมาตรฐาน 5173/1984/8555 + `publicHost` จาก IP ของเครื่อง
+ `go2rtcBin`/`ffmpeg` ของชุดติดตั้ง) → สร้าง `go2rtc.yaml` และบัญชี RTSP (`setup-edge.ps1` / `setup-edge.sh`) → เริ่มระบบ
→ รอ `/api/instance` ตอบ → แสดงข้อความสาย link ล่าสุด → ลบไฟล์ของ central

จบแล้ว: เปิด `http://<IP ของ edge>:5173/` → login **superadmin / superadmin → เปลี่ยนรหัสทันที** → แอดกล้อง
ที่ central หน้า Edge Nodes ต้องขึ้นเลขนั้นเป็น Online และ build ตรงกับ central

## 4. อัปเดตเวอร์ชันด้วย flash drive

สร้างชุดใหม่ (ข้อ 1) → ก๊อปลง flash drive → รันตัวติดตั้งเดิมซ้ำ **ไม่ต้องมีไฟล์ edge-<เลข>.json**
ตัวติดตั้งหยุดระบบ แทนที่ `app/` กับ `bin/` ทั้งโฟลเดอร์ แล้วเริ่มใหม่ — `state/` (DB, กล้อง, secret) ไม่ถูกแตะ
มีไฟล์ edge-<เลข>.json ใหม่ = เปลี่ยน token/ที่อยู่ของ central ไปด้วย

## 5. อัปเดตผ่านสาย link (ไม่ต้องไปหน้างาน)

```
build-edge-kit.ps1 -Publish ──► central เก็บแพ็กเกจที่เซ็นแล้ว ──(สาย link: update)──► edge
                                                                edge ตรวจลายเซ็น → โหลด (HTTP + token ของสาย) → ตรวจ sha256
                                                                → แถบ "มีเวอร์ชันใหม่" บนหน้าเว็บของ edge → คนกด "ติดตั้งตอนนี้"
                                                                → edge-run: app → app.prev, แตก app ใหม่ → เปิด → รอต่อ central ติด ≤ 5 นาที
                                                                   ติด = สำเร็จ · ไม่ติด = ถอยกลับ app.prev เอง (รุ่นที่พังเก็บที่ app.failed)
```
- central เสนอเมื่อ edge ต่อสาย (hello มี `platform`, `runner`) และตรวจแพ็กเกจใหม่ทุก 5 นาทีกับ edge ที่ต่อค้างอยู่
- **กดจาก central ได้เลย:** Edge Nodes → แถวของ edge ที่ขึ้น "โหลดแล้ว" → ปุ่มลูกศร (หรือ **อัปเดตทั้งหมด** เมื่อพร้อมหลายตัว)
  → central ส่ง `update.apply` ลงสาย → edge ติดตั้งเหมือนกดที่หน้าเว็บของตัวเอง · ไม่ใช้ SSH ไม่ใช้ sudo (สิทธิ์ `device.manage`)
- หรือที่เครื่อง edge: เปิดเว็บของ edge → แถบด้านบนบอกเวอร์ชันและขั้นตอน → กด **ติดตั้งตอนนี้** (ต้องมีสิทธิ์ `system.maintain`)
  → ภาพหยุดราว 5–10 วินาที → แถบบอกผล (สำเร็จ / ถอยกลับพร้อมเหตุผล)
- หน้า Edge Nodes ของ central แสดงสถานะอัปเดตของแต่ละ edge: กำลังโหลด / รอกดติดตั้ง / สำเร็จ / ถอยกลับ
- ติดตั้งได้สองแบบตามตัวคุม:
  - **edge-run** (ติดตั้งจากชุด): สลับโฟลเดอร์ `app` ↔ `app.prev`
  - **pm2 บน Linux** (edge 002 แบบ deploy-edge.sh): gateway สลับ `server scripts dist ecosystem package.json BUILD` ใน repo
    (ของเดิมไป `.update-prev/`) แล้วปิดตัวให้ pm2 เปิดรุ่นใหม่ · ตัวเฝ้า `scripts/edge-update-watchdog.cjs` (ก๊อปไป `<state>/updates/`
    รันแยกโปรเซส) รอ `link-ok.json` ของรุ่นใหม่ 5 นาที ไม่ติด = คืนไฟล์เดิมแล้วปิด gateway ให้ pm2 เปิดรุ่นเดิม · log: `<state>/updates/watchdog.log`
    แพ็กเกจที่ไม่มีตัวเฝ้า (รุ่นก่อน `c6ecab4`) ไม่รับตั้งแต่ตอนโหลด
  - **edge 001 (pm2 บน Windows)** แจ้งอย่างเดียว — repo นั้นคือ central production ห้ามสลับไฟล์เอง (edge 001 ยุติแล้ว 2026-09-30)
- central ไม่เสนอแพ็กเกจที่เก่ากว่า build ของ edge (ถาม git: แพ็กเกจเป็นบรรพบุรุษของ build ของ edge = ไม่เสนอ)
  — เช่น deploy-edge.sh ไปก่อนแล้วยังไม่ได้ `-Publish`
- **รัน `-Publish` จาก PowerShell แบบ admin เสมอ** — ไฟล์ใน `server\edge-updates\` เป็นของผู้ที่สร้างครั้งแรก shell ธรรมดาลบรุ่นเก่าไม่ได้
- ส่งแค่ `app/` · `bin/` (node, ffmpeg, go2rtc) เปลี่ยนเมื่อไรต้องใช้ flash drive (ข้อ 4)
- ตัวคุม `edge-run.cjs` เองเป็นรุ่นใหม่ตอนเครื่องบูตครั้งถัดไป
- ไฟล์ที่ edge: `<state>/updates/` — `pending.json`, `apply.json`, `last-result.json`, `link-ok.json`, แพ็กเกจ
- API: central `GET /api/edge-updates` (เวอร์ชันที่เผยแพร่), `GET /api/edge-link/update/<platform>/<file>` (Bearer token ของสาย)
  · `POST /api/edges/<id>/update` (central สั่ง edge ติดตั้ง) · edge `GET /api/edge-update`, `POST /api/edge-update/apply`

ทดสอบแล้ว (ของจริง): edge 002 (pm2, Ubuntu) กดปุ่มจาก central → สลับ `c6ecab4` → `6c051d4` → `24cd08d` ตัวเฝ้ายืนยันรอบละ ~5 วินาที
ทดสอบแล้ว (instance จำลอง): edge build ปลอม `aaaaaaa` ได้ข้อเสนอ → โหลด 11.7 MB → กดติดตั้ง → สลับเป็น `5b2c861` สำเร็จใน 5 วินาที
· ปิด central ระหว่างติดตั้ง → ครบเวลาแล้วถอยกลับเป็นรุ่นเดิม `last-result.json` บอก `rolledBack: true`

## 6. กุญแจเซ็นแพ็กเกจ

สาย link ยังไม่มี TLS — edge จึงเชื่อแค่แพ็กเกจที่ manifest ถูกเซ็นด้วย ed25519 และตรงกับ public key ที่มากับชุดติดตั้ง
- กุญแจลับ: `D:\gw-edge-kits\signing\edge-update-key.pem` (นอก git, ACL เฉพาะผู้ใช้/Administrators/SYSTEM) — `backup-windows.ps1` สำรองให้ทุกคืน
- public key: `scripts/edge-kit/edge-update.pub.pem` (ใน git, ไปกับทุกชุด)
- สร้างครั้งแรก: `node scripts\edge-update-key.cjs --keygen` แล้ว commit public key · เซ็นเอง: `--sign <file> --build <b> --platform <p>`
- **กุญแจหาย/เปลี่ยน = edge ทุกตัวไม่รับแพ็กเกจใหม่** จนกว่าจะอัปเดตด้วย flash drive ชุดที่มี public key ใหม่

## ตัวคุมโปรเซส `scripts/edge-run.cjs`

เครื่องจากชุดติดตั้ง **ไม่ใช้ pm2** (ต้องลงแบบ global และบน Windows ติดเรื่องสิทธิ์ — ../CONTRIBUTING.md ข้อ 5)
`node edge-run.cjs --config <state>/edge.json` เปิดแอปตามรายการใน `ecosystem.edge.config.cjs` (ที่เดียวกับ pm2)
- แอปตายเปิดใหม่ใน 2 วิ (ตายเร็วติดกันหน่วงถึง 30 วิ) · log แยกไฟล์ต่อแอป หมุนที่ 20 MB · ข้อความของตัวคุมเองอยู่ใน `logs/edge-run.log`
- ปิดโปรเซสที่ค้างจากรอบก่อนตาม `edge-run.pids`

Edge 102 (Ubuntu เดิม, systemd `gw-edge` → pm2-runtime) ยังใช้วิธีเดิม · edge 001 (pm2 บน HOST) ยุติแล้ว

## ถอนการติดตั้ง (Windows)

1. ถอด edge ที่หน้า Edge Nodes ของ Regional ก่อน — token ใช้ไม่ได้ทันที กล้องหายจาก Regional/Central
2. ที่เครื่อง edge ดับเบิลคลิก `uninstall-windows.cmd` (ในชุดติดตั้ง) → หยุด/ลบ Scheduled Task `Gateway Edge` + `Gateway Edge Backup`, ปิดโปรเซสใน `C:\GW-Edge`, ลบ firewall `Gateway Edge*`, ลบ `app\` `bin\`
3. ค่าตั้งต้น **เก็บ `state\`** (vms.db, token, รหัสกล้อง, backups) — ติดตั้งซ้ำได้กล้องและ Global ID เดิม
   · `uninstall-windows.cmd -RemoveData` ลบทั้งโฟลเดอร์ (ถามให้พิมพ์เลข edge ยืนยัน) · ติดตั้งที่อื่นใช้ `-Root`
4. ลบ `edge-<เลข>.json` ที่ยังเหลือ (มี token)

Linux: `sudo bash uninstall-linux.sh` — ลบ service `gw-edge`, cron backup, ufw rule `Gateway Edge*`, `/opt/gw-edge` · เก็บ `/var/lib/gw-edge` ไว้ (`--remove-data` ลบพร้อมผู้ใช้ `gw-edge`)
· ปฏิเสธเครื่องที่ unit ไม่ได้สร้างจาก install-linux.sh — **Edge 102 (Ubuntu เดิม, pm2-runtime) ถอนเอง**

## ข้อจำกัด / ยังไม่ได้ทดสอบ

- ตัวติดตั้ง Windows ทดสอบบน HOST ได้แค่ `-DryRun` (พอร์ต 5173 เป็นของ central) — Scheduled Task และ firewall ต้องลองบน mini PC จริง
- ยังไม่มี Raspberry Pi ให้ทดสอบ — ชุด `linux-arm64` ใช้ไบนารีทางการของ node / go2rtc / ffmpeg และ sqlite3 prebuilt
- ยังไม่มี TLS บนสาย link (ใช้ผ่าน LAN/VPN) — แพ็กเกจอัปเดตกันด้วยลายเซ็น แต่ token และภาพยังวิ่งแบบไม่เข้ารหัส
- ffmpeg ในชุดเป็น build GPL ใช้ภายในองค์กร
- Surveillance Gateway Client ยังมีแค่ Windows — บน Linux ใช้เว็บ Live ของ central (client Linux พักไว้ก่อน)

## รุ่นที่เผยแพร่ตอนนี้ (ตรวจ 2026-10-11)

- แพ็กเกจอัปเดตผ่านสาย: manifest ใน `server/edge-updates/` ทั้ง Windows x64/Linux x64/Linux arm64 = `48f4298`; ผู้ดูแลยืนยัน Edge ได้รับรุ่นนี้แล้ว
- ชุดติดตั้ง offline (`server/edge-kits/kits.json`) ทั้งสามแพลตฟอร์ม = `5005316` (ชุดชื่อ `Edge-<platform>-5005316`) มีตัวถอนติดตั้ง Windows/Linux และใช้ชื่อกลางไม่มี vendor branding
- offline kit ยังไม่มี ONVIF Media2 fallback ของ `48f4298`; หลังติดตั้งต้องอัปเดตผ่านสายก่อนใช้กล้องที่ต้องใช้ Media2 หรือสร้างชุดใหม่ด้วย `build-edge-kit.ps1 -Publish` จาก shell admin
- `deploy.ps1` publish แบบ `-UpdatesOnly` จึงไม่ได้สร้าง offline kit ใหม่ทุกครั้ง; รุ่น kit กับรุ่น update ต้องตรวจแยกกัน

## AI ในชุดปัจจุบัน (ตั้งแต่ 2026-10-02)

หลังติดตั้งแอดกล้อง แล้วเปิด receiver ใน AI Sources ต่อกล้อง
