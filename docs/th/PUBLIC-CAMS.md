# กล้อง Public (Central ดึงเอง)

เริ่มใช้ 2026-10-07 · แหล่งแรก: เทศบาลนครอุดรธานี (37 กล้อง)

## ทำไมมี

ผู้ใช้ต้องการรวมกล้องสาธารณะของหน่วยงานรัฐ (ค้นพบจาก JK World `world.tehx.dyndns.info`) เข้าระบบ
และให้ Central คุมว่า API key ใบไหนเห็นได้ · เป็นข้อยกเว้นเดียวของกฎ "Central ไม่แอดกล้องเอง" (AGENTS.md ข้อ 1)
เพราะกล้องพวกนี้ไม่มีรหัสผ่าน ไม่อยู่ในวงแลนของใคร และไม่มี Edge เป็นเจ้าของ

**ดึงจาก API ของหน่วยงานโดยตรง ไม่ผ่าน JK World** — API ของ JK World เป็นของภายในเว็บ เปลี่ยนได้ทุกเมื่อ และไม่ได้เป็นเจ้าของภาพ
ใช้ JK World เป็นแค่สารบัญหาแหล่ง (`/api/world-spots-th` บอก `source` และ `media_type` ต่อกล้อง)

## ทำงานอย่างไร

`server/vms/public-cams.js` (รันเฉพาะ `GATEWAY_ROLE=central`)
- ทุก 5 นาที + ตอน start: ดึงรายชื่อจาก `SOURCES[<แหล่ง>].listUrl` → upsert แถวใน `cameras`
  - `type = public_hls`, `brand = public`, `source_id = public:<แหล่ง>`, `source_ref` = id ฝั่งหน่วยงาน
  - id `PUB-<แหล่ง>-<ref>` · global ID ออกที่ Central ตามปกติ (`TH-41-000-xxxxx`) · จังหวัด/อำเภอตั้งต่อแหล่ง
  - `rtsp` เก็บ URL ของ HLS (ชื่อคอลัมน์เดิม) — ต้องเป็น https + host อยู่ใน `allowedHosts` + ลงท้าย `.m3u8`
  - หายจาก API = `source_missing_at` (ไม่ลบ) · กลับมา = ล้าง
- สถานะ online มาจาก API ของหน่วยงาน (ไม่ยิง TCP เอง) · ดึงไม่สำเร็จ = สถานะ `null` (ไม่รู้) ไม่ใช่ offline
- go2rtc: main = `ffmpeg:<hls>#video=h264#hardware` (ต้นทาง H.264 ผ่านตรง) · ไม่มี sub · `_raw` = `ffmpeg:<hls>#video=copy`
  `go2rtc-sync.js` ตรวจ whitelist ซ้ำก่อนส่งให้ ffmpeg
- ไม่มี PTZ, ภาพย้อนหลัง (501), เสียง, AI · ไม่ลง log ออนไลน์/ออฟไลน์ · ไม่นับใน Dashboard/Camera Map/Cameras

## สิทธิ์

- หน้าเว็บ: เมนู **Public Cam Map** (ถัดจาก AI Events) ต้องมี `menu.publiccam` — superadmin/admin ได้เอง
  คนที่มีสิทธิ์นี้ดูภาพกล้อง Public ได้ทุกตัว ไม่ขึ้นกับขอบเขตกล้องของ role · ปุ่ม "ซิงก์ตอนนี้" ต้องมี `device.manage` เพิ่ม
- Live: กล้อง Public โผล่ตามขอบเขตของ role (role ที่เห็นทุกกล้องเห็นกลุ่ม "Public · อุดรธานี")
- API key: ช่อง **กล้อง Public** ที่หน้า API Clients (`api_clients.allow_public`, ค่าตั้งต้น 0)
  - ติ๊ก = เห็นกล้อง Public ทั้งชุด ไม่ขึ้นกับ scope_groups · ไม่ติ๊ก = 404 เหมือนกล้องนอก scope แม้ key จะเห็น "ทุกกลุ่ม"
  - ติ๊กให้ได้เฉพาะคนที่มี `menu.publiccam`
  - `/api/v1/cameras` คืน `origin: { kind: 'public', source, credit, pageUrl, missingAtSource }`
- Windows client ไม่ต้องอัปเดต: แผนที่ (`client-map.html`) แยกหมุดสีม่วงจาก `origin.kind === 'public'` พร้อมคำอธิบายสี

## เพิ่มแหล่งใหม่

1. ตรวจว่าหน่วยงานมี JSON รายชื่อ + พิกัด และภาพเป็น HLS/RTSP ที่ ffmpeg อ่านได้ (หน้าเว็บของหน่วยงานมักเรียก API นี้เอง — ดู network ของหน้าแผนที่)
2. เพิ่มรายการใน `SOURCES` ของ `server/vms/public-cams.js`: `label`, `credit`, `pageUrl`, `listUrl`, `allowedHosts`, `group`, `province`, `district`, `parse()`
   - `parse()` คืน `[{ ref, name, url, lat, lng, online }]` · `ref` ต้องเป็น `[\w-]{1,40}` และคงที่ (ใช้สร้าง id/global ID)
   - เซิร์ฟเวอร์ไม่ส่ง intermediate certificate → ตั้ง `caIssuerUrl` (URL จาก AIA ของใบรับรอง) ห้ามปิดการตรวจใบรับรอง
3. แหล่งที่เป็นภาพนิ่ง (JPEG) หรือหน้าเว็บ (iframe) ยังไม่รองรับ — ต้องเพิ่มชนิดใหม่ ไม่ใช่ยัดลง `public_hls`

## ข้อควรระวัง

- **สิทธิ์ภาพเป็นของหน่วยงานต้นทาง** — หน้าเว็บแสดงเครดิต + ลิงก์ทุกครั้ง · ก่อนเปิด key ให้หน่วยงานภายนอกใช้ ควรแจ้ง/ขออนุญาตหน่วยงานต้นทาง
- ดึงแบบ on-demand: go2rtc ต่อหน่วยงานเฉพาะตอนมีคนดู · รายชื่อดึงทุก 5 นาที (เบามาก)
- www.udoncity.go.th ไม่ส่ง intermediate ของ Certum (ตรวจ 2026-10-07) — ใช้ `caIssuerUrl` ของ Certum DV TLS G2 R39 CA
  ถ้า Certum ย้าย URL ซิงก์จะล้มพร้อมข้อความในหน้า Public Cam Map (กล้องเดิมยังดูได้ เพราะ host สตรีมส่ง chain ครบ)
- `videoUrl` ของอุดรฯ เป็น `chunklist_w<session>.m3u8` — แปลงเป็น `playlist.m3u8` ไม่งั้น session หมดอายุแล้วภาพดับ
