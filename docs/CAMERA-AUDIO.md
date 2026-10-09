# เสียงจากกล้อง (เปิดรายกล้อง)

อัปเดต: 2026-10-07 · ใช้จริงแล้วตั้งแต่ deploy 2026-10-06 (Gateway `d645ed9` ทั้งสี่ instance, Windows Client 1.9.5)
· เปิดอยู่ 1 กล้อง ณ 2026-10-07 (Tiandy 203.0.113.12 ที่ Edge 101)

## หลักการ

- **ปิดเป็นค่าตั้งต้น** — กล้องส่วนใหญ่ไม่มีไมค์ และการแปลงเสียงเป็น AAC เพิ่มงาน ffmpeg ทุกเส้น
- **ตั้งที่ Edge เท่านั้น** (เหมือน `enabled`) — หน้า Cameras → ปุ่ม "เสียง" · Regional/Central รับค่าตามรอบ sync
  และตอบ 403 ถ้าพยายามตั้งเอง
- ผู้ชมทุกช่อง (เว็บและ Windows Client) **เริ่มแบบปิดเสียงเสมอ** แล้วกดลำโพงที่ช่องภาพเอง
- ภาพย้อนหลังยังเป็นภาพอย่างเดียว (`-an` ใน `server/vms/*-playback.js`)

## เส้นทางของเสียง

| จุด | ปิดเสียง (เดิม) | เปิดเสียง |
|---|---|---|
| go2rtc source (`gateway/go2rtc-sync.js`) | `ffmpeg:<rtsp>#video=h264#hardware` | ต่อท้าย `#audio=aac` |
| สาย link Edge → Regional → Central (`vms/edge-link-client.js`) | `-c copy -an` | `-map 0:v:0 -map 0:a:0? -c copy` |
| proxy `/stream/<name>.mp4` (`server.js`) | `&video=h264` / `&video=copy` | ต่อท้าย `&audio` |
| เบราว์เซอร์ (`LivePlayer.jsx`) | `<video muted>` | ปุ่มลำโพงมุมล่างขวา |
| Windows Client (`LibVlcVideoRenderer`) | `:no-audio` ต่อ media | ปุ่มลำโพงบน tile |

ข้อเท็จจริงที่ทดสอบแล้ว (go2rtc 1.9.14, 2026-10-06):

- ไม่มี `#audio` ใน source = ffmpeg ออกแต่ภาพ
- `/api/stream.mp4` ที่มีแค่ `video=` ตัดเสียงทิ้ง ต้องขอ `&audio` ด้วย
- เส้นปกติได้ `mp4a.40.2` (AAC) · เส้น `_raw` go2rtc แปลง PCMA/PCMU เป็น **FLAC** เอง (`audio=aac` ใช้กับ `_raw` ไม่ได้)
- `#audio=aac` กับต้นทางที่ไม่มีเสียงไม่ทำให้พัง ได้ภาพอย่างเดียว
- เส้น `_raw` มีเสียงของกล้องติดมาเสมอ proxy จึงขอ `&audio` เฉพาะกล้องที่ `audio_enabled = 1`

## การเปลี่ยน fragment กับ go2rtc-sync

`bareUrl()` ตัด fragment ทิ้งก่อนเทียบ การเปิด/ปิดเสียงจึงมองไม่เห็นถ้าไม่มีตัวช่วย
sync จด sha1 ของ source ทั้งสตริงไว้ที่ `stateFile('.go2rtc-applied.json')` (hash อย่างเดียว ไม่มีรหัสกล้อง)
แล้ว PUT เมื่อ hash ต่างจากครั้งก่อน · ไม่มีไฟล์ = ถือว่าตรงกับของที่ต้องการ (ไม่ PUT ทุกเส้นหลังอัปเกรด)

ffmpeg ที่ push สาย link อยู่ใช้ค่าเสียงตอนเริ่ม — `reconcilePushAudio()` เริ่มใหม่หลังส่งรายการกล้องทุกครั้ง
(PATCH ที่ Edge เรียก `catalogSoon()` ทันที, Regional ได้รอบเมื่อ go2rtc sync มีการเปลี่ยน)

## ตรวจว่ากล้องมีเสียงไหม

ปุ่ม "เสียง" เปิด dialog ที่เรียก `POST /api/cameras/:id/audio-probe` (`ffmpeg -i` ต้นทางตรงแล้วอ่านบรรทัด `Stream #` ตอบ codec/sample rate)
· ใช้ ffmpeg ไม่ใช่ ffprobe เพราะชุดติดตั้ง edge มีแค่ ffmpeg — รุ่นแรก (b1a01f0) ได้ `spawn ...ffprobe.exe ENOENT` ที่ Edge 101
ผลที่เจอจริง:

| กล้อง | ผล |
|---|---|
| 203.0.113.12 Tiandy (Office) | `pcm_alaw` 8 kHz mono — เสียงเบา (ห้องเงียบ) |
| E8272520A1EC AXIS ผ่าน NVR 203.0.113.10 (Edge 102) | ไม่มี track · ขอ `&audio=1` ได้ `503` — ต้องเปิด audio ที่กล้อง/NVR ก่อน |

## ทดสอบ

edge-sim แบบสามชั้นกับแหล่ง `testsrc` + `sine` ที่ส่ง `pcm_alaw` (ทดสอบ 2026-10-06 ด้วย DB ใหม่):
ปิด = central ได้ `h264` · เปิด = `h264 + aac` (sub/main) และ `_raw` ได้ `h264 + flac` · ปิดกลับ = `h264` ทุกชั้น
