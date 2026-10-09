# ตั้ง Surveillance Gateway Edge บน Linux (Ubuntu 24)

> สถานะปัจจุบัน 2026-10-07: Ubuntu เดิมเปลี่ยนเป็น Edge **102** ต่อ Regional ภาคกลาง node 100, เว็บ **:5173**, service **gw-edge**; Gateway d645ed9 (156 กล้อง ณ 2026-10-07) ไม่มี inference worker ใช้ AI Sources รับผลภายนอก
> รีสตาร์ตเมื่อจำเป็นด้วย `sudo systemctl restart gw-edge` ห้ามรัน pm2 ด้วยมือบนเครื่องนี้ ตาราง/ขั้นติดตั้งด้านล่างเป็นวิธีเดิมของปี 2026-09 ก่อนย้าย Regional; เครื่องใหม่ใช้ [EDGE-KIT.md](EDGE-KIT.md)

edge บน Linux คือโค้ดชุดเดียวกับที่รันบน Windows ต่างกันที่ค่าของเครื่อง (`<state>/edge.json`) และวิธีรันตอนบูต (systemd)
เครื่องแรก: `edge-ubuntu` · Tailscale `203.0.113.80` · edge `002` · ต่อกล้อง Axis (S30) ในวงที่ central เข้าไม่ถึง

อัปเดต 2026-09-24 · ภาพรวมระบบดู [EDGE-PLAN.md](EDGE-PLAN.md) · กติกาดู [../CONTRIBUTING.md](../CONTRIBUTING.md)

> **edge ใหม่ (รวม Raspberry Pi 5) ให้ใช้ชุดติดตั้ง flash drive — [EDGE-KIT.md](EDGE-KIT.md)** ไม่ต้องใช้ internet, apt, npm หรือ pm2
> เอกสารนี้คือวิธีติดตั้งเองแบบเดิม (เครื่อง edge 002) ที่ใช้ `deploy-edge.sh` ผ่าน SSH
> **อัปเดตครั้งต่อไปไม่ต้อง deploy-edge.sh แล้ว** (ตั้งแต่ `c6ecab4`) — `build-edge-kit.ps1 -Publish` แล้วกดปุ่มอัปเดตที่หน้า Edge Nodes ของ central
> edge สลับไฟล์ใน `~/gw-edge` เอง ไม่ต้องใช้ sudo ([EDGE-KIT.md](EDGE-KIT.md) ข้อ 5)

## สิ่งที่แตกต่างจาก edge บน Windows

| เรื่อง | Windows (edge 001) | Linux |
|---|---|---|
| ค่าของเครื่อง | ค่าเริ่มต้นใน `ecosystem.edge.config.cjs` | `/var/lib/gw-edge/edge.json` (นอก git, `chmod 600` — มี token) |
| go2rtc | `go2rtc/go2rtc.exe` ใน repo | `/var/lib/gw-edge/bin/go2rtc` (setup โหลดให้ตรง amd64/arm64, 1.9.14) |
| พอร์ต | 5273 / 1994 / 8565 / 8566 (อยู่ร่วมกับ central) | 5173 / 1984 / 8555 / 8556 |
| ตอนบูต | Scheduled Task → `start-gateway.cmd` | systemd `gw-edge.service` → `pm2-runtime` จาก ecosystem file |
| backup | `backup-windows.ps1` (Scheduled Task) | `scripts/backup-edge.sh` (`/etc/cron.d/gw-edge-backup` ตี 2) |
| ffmpeg | `C:\ffmpeg\bin` | `ffmpeg` จาก apt |

## 1. ติดตั้งของพื้นฐาน (sudo)

```bash
sudo apt update && sudo apt install -y ffmpeg git curl build-essential
```
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```
```bash
sudo npm i -g pm2
```

**เช็คพอร์ตชนก่อน** — เครื่องนี้เคยรัน GB28181 (a media platform on ports 18080, 18081/18554/…, MySQL 3306, Redis) · edge ใช้ 5173/1984/8555/8556
```bash
sudo ss -ltnp | grep -E ':(5173|1984|8555|8556)\b'
```
ชน = ใส่ `port` / `go2rtcApi` / `go2rtcRtsp` อื่นใน `edge.json` (ขั้น 3) ก่อน start

## 2. ส่งโค้ดไปเครื่อง Linux

repo ไม่มี git remote และประวัติมีไฟล์ใหญ่ (git bundle ~800 MB, แผนที่ออฟไลน์ .mbtiles ~880 MB ที่ edge ไม่ใช้)
จึงส่งเป็น `git archive` ของ commit ปัจจุบัน ตัดไฟล์ใหญ่ออก (~6 MB) ผ่าน SSH แล้ว build ที่ปลายทาง — จาก Git Bash บน HOST:
```bash
scripts/deploy-edge.sh deploy-user@203.0.113.80 --port 2222
```
ปลายทางไม่มี `.git` → สคริปต์เขียน commit ลงไฟล์ `BUILD` ให้ `/api/instance` รายงาน (central เทียบกับของตัวเองแล้วเตือนเมื่อไม่ตรง)
**อัปเดตรอบถัดไป** = ปุ่มอัปเดตในหน้า Edge Nodes ของ central (หลัง `-Publish`) · deploy-edge.sh + `sudo systemctl restart gw-edge`
ยังใช้ได้เมื่อจำเป็น (เช่น edge ต่อ central ไม่ได้ หรือแก้ ecosystem ซึ่งมีผลเมื่อ service restart เท่านั้น)

SSH ของเครื่องนี้ใช้พอร์ต **2222** (key `edge-deploy`) — พอร์ต 22 ขาเข้าทาง Tailscale มีตัวอื่น (`libssh_0.11.4`) ตอบแทน OpenSSH
และ `ssh.socket` ของ Ubuntu 24 ฟัง IPv6 อย่างเดียวถ้าไม่ระบุที่อยู่ → ต้องใส่ทั้ง `0.0.0.0:2222` และ `[::]:2222`
(`/etc/systemd/system/ssh.socket.d/port2222.conf`)

## 3. เตรียม state (ผู้ใช้ปกติ)

```bash
sudo mkdir -p /var/lib/gw-edge && sudo chown $USER: /var/lib/gw-edge
```
```bash
~/gw-edge/scripts/setup-edge.sh --node 002 --province 10 --public-host 203.0.113.80
```
สร้าง `edge.json`, บัญชี RTSP ของ go2rtc (`.rtsp-credentials.json`), `go2rtc.yaml` และโหลด go2rtc · รันซ้ำได้ ไม่ทับบัญชี/yaml เดิม

## 4. บริการตอนบูต + backup (sudo ครั้งเดียว)

```bash
sudo ~/gw-edge/scripts/setup-edge.sh --install-service && sudo systemctl start gw-edge
```
ตรวจ: `systemctl status gw-edge` · `journalctl -u gw-edge -f` · `curl -s localhost:5173/api/instance` → `"role":"edge","node":"002"`

pm2 ของ service ใช้ `PM2_HOME=/var/lib/gw-edge/pm2` — ดูสถานะด้วย `PM2_HOME=/var/lib/gw-edge/pm2 pm2 ls`
อย่าสั่ง `pm2 start` ด้วยมือนอก service (จะได้ชุดที่สองแย่งพอร์ต — บทเรียนเดียวกับ Windows)

## 5. ต่อกับ central

**link (แนะนำ — edge ต่อขึ้นไปเอง ไม่ต้องเปิดพอร์ตขาเข้า)**
0. (ครั้งเดียวต่อ central) Edge Nodes → กล่อง **"ที่อยู่ของ central ที่ edge ใช้ต่อได้"** → ใส่ทุกเส้นทางที่ edge ต่าง ๆ เห็น central
   (LAN, VPN/MPLS ของหน่วยงาน, IP ที่ NAT มา — ถ้าเส้นทางนั้นแมปพอร์ตใหม่ ใส่พอร์ต gateway และ RTSP ที่เห็นจากฝั่งนั้น)
1. Add Edge → "Edge ต่อขึ้นมาเอง" → ออก token → **ติ๊กเฉพาะเส้นทางที่ edge นี้เข้าถึงได้** → คัดลอกคำสั่ง Linux (token แสดงครั้งเดียว)
2. รันคำสั่งนั้นบน edge — หน้าตาแบบนี้ (ใส่ `--central-url` ได้หลายครั้ง ลองตามลำดับ):
   ```bash
   ~/gw-edge/scripts/setup-edge.sh --central-url 'ws://203.0.113.80:5173/api/edge-link' --central-url 'ws://203.0.113.112:5173/api/edge-link' --central-token ntlink_… && sudo systemctl restart gw-edge
   ```
3. log ต้องมี `[Edge link] ต่อ central (<ที่อยู่ที่ใช้>) แล้ว` · หน้า Edge Nodes ขึ้น Online พร้อม "ผ่าน <ที่อยู่> จาก <IP ของ edge>"
4. edge ต้องออกไปถึง central ที่ `<port>` (สาย link) และ `<rtspPort>` (push ภาพ) ของเส้นทางนั้น
   ภาพ push ไปที่ host ของที่อยู่ที่ต่อติด · พอร์ต RTSP ต่างจาก 8555 = ต่อท้าย URL ด้วย `?rtsp=<พอร์ต>` (หน้าเว็บใส่ให้)

**pull (ทางเลือก)** — central ต่อเข้า edge: เว็บ edge → Central Access ออก key → central → Add Edge กรอก `203.0.113.80:5173` + key
ต้องเปิดพอร์ต 5173 และ 8555 ของ edge ให้ IP ของ central (`sudo ufw allow from 203.0.113.112 to any port 5173,8555 proto tcp`)

## 6. แอดกล้อง Axis

1. เว็บ edge `http://203.0.113.80:5173` → login `superadmin`/`superadmin` → **เปลี่ยนรหัสทันที**
2. ในกล้อง Axis สร้างบัญชี **ONVIF** (Axis OS แยกบัญชี ONVIF จากบัญชีเว็บ — ไม่มีแล้ว ONVIF scan login ไม่ผ่าน)
3. Cameras → สแกน ONVIF ในวงของ Axis → แอด · ปักหมุด · ตั้งจังหวัด
4. sub stream: I-frame interval ≈ fps (ภาพเปิดเร็ว — [CAMERA-QUIRKS.md](CAMERA-QUIRKS.md))

## 7. ทดสอบให้ผ่าน

- central เห็นกล้องของ edge 002 · เปิดดูในหน้า Live และ client ได้
- ถอดสายกล้อง → central ขึ้นดับภายใน ~20 วิ · `systemctl stop gw-edge` → กล้องเป็น "ไม่รู้สถานะ" · start → กลับเอง
- ไม่มีคนดู 60 วิ → push หยุด (`ps aux | grep ffmpeg` บน edge)
- `scripts/backup-edge.sh` รันได้ และ `vms.db` ในรอบนั้นผ่าน `PRAGMA integrity_check`
- วัด CPU / network ตอนเปิดดู 1, 4, 9 กล้อง (ตัวเลขจริงไว้ประกอบการเลือกเครื่อง edge เช่น Pi 5)

## กู้คืน

`sudo systemctl stop gw-edge` → ลบ `vms.db-wal`, `vms.db-shm` → วาง `<backups>/<รอบ>/vms.db` และ `.gateway-key-secret` ของ**รอบเดียวกัน**
→ `sudo systemctl start gw-edge`
