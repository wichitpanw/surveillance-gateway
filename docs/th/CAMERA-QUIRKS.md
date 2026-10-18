# CAMERA-QUIRKS — ปัญหาเฉพาะยี่ห้อ/รุ่นที่เจอแล้ว

กล้องในระบบนี้คือ "ชุด firmware" ไม่ใช่ชุดกล้อง — Tiandy, Uniview, Dahua, Hikvision และ NVR ยี่ห้อทั่วไปต่างอ้างว่ารองรับ
ONVIF/RTSP และต่างก็ทำผิดสเปกคนละมุม ไฟล์นี้บันทึกปัญหาที่เจอจริง วิธีแก้ และวิธีไล่ปัญหาตัวถัดไป · อัปเดต 2026-10-17

## หลักคิดก่อนดูรายการ

**อย่าสร้างตารางยี่ห้อที่ต้องแก้มือทุกครั้งที่มีกล้องใหม่.** ลองมาตรฐานก่อน ถ้าไม่ได้ค่อยถอยทีละชั้น
และ **ตรวจว่าได้ของจริง ไม่ใช่แค่ "ต่อได้"** — แทบทุกปัญหาข้างล่างดูเหมือนสำเร็จ: เชื่อมต่อได้, ตอบ 200, สตรีมขึ้นว่ากำลังเล่น แต่จอดำ

บันไดที่ใช้อยู่ (ไม่มีชื่อยี่ห้อในตรรกะ):

| ขั้น | คืออะไร | อยู่ที่ |
|---|---|---|
| 1 | RTSP passthrough — codec ของกล้องเอง (เส้น `_raw`) | `server/gateway/go2rtc-sync.js` |
| 2 | passthrough + ทางอ้อมตอนเจรจา (`#backchannel=0`) | เส้น `_raw` เดียวกัน |
| 3 | ffmpeg transcode เป็น H.264 | เส้นหลัก (`sourceFor()`) |

Windows client ขอขั้น 1–2 ก่อน ดูว่ามีเฟรมมาจริงไหม ถ้าไม่มีก็ถอยไปขั้น 3 เอง (`client-windows/SurveillanceGateway.Client/Video/VideoTile.cs`, `UseFallback`)
central ที่ดึงจาก edge ก็ใช้เส้น `_raw` ของ edge แล้ว transcode ที่ central

ของที่ใช้หลักเดียวกัน: `server/codec_cache.json` จำว่าแต่ละ RTSP เป็น codec อะไรจริง (ไม่เชื่อยี่ห้อ)
และตัวค้นหา AI (`server/gateway/analytics/discovery.js`, ปิดอยู่) ถาม ONVIF ทีละกล้อง ใช้ยี่ห้อแค่เป็นคำใบ้

## Checklist: แอดยี่ห้อ / VMS / NVR ใหม่

ใช้กับทั้งภาพสด ย้อนหลัง และ PTZ — สรุปจากที่ DSS จังหวัดทดสอบพังสองรอบ (2026-10-08/09)

1. **แยกโมดูลต่อยี่ห้อ** ใน `server/vms/` (client + sessions + playback) แล้วให้ `device-playback.js` เลือก — ห้ามใส่เงื่อนไขยี่ห้อในโค้ดกลาง
2. **ส่งแบบมาตรฐานก่อน ถอยเมื่ออุปกรณ์บอกชัด** — error code/ข้อความที่ระบุว่าขาดอะไร ไม่เดาล่วงหน้า ไม่ทำให้รุ่นที่ใช้ได้อยู่พัง
   (ตัวอย่าง: `StartPlaybackByFile` ส่งไม่มี `playbackType` ก่อน ได้ 1004 ที่เอ่ยชื่อฟิลด์ค่อยส่งใหม่)
3. **จำผลต่ออุปกรณ์แต่ละเครื่อง** ไว้ใน client/instance — ครั้งถัดไปไปทางที่ใช้ได้เลย อุปกรณ์อยู่ไกลทุกรอบที่เสียไปคือความช้า
   (`needsPlaybackType` ใน `DssClient`, `workedVia` ใน `dss-rtsp-relay.js`)
4. **ทุกทางถอยต้องมี log และทุกความล้มเหลวต้องบอก host:port/สาเหตุ** — ผ่าน `hideToken`/`shared/redact.js` ห้ามมี token หรือรหัส
   ปิด socket เงียบ ๆ ทำให้ปลายทางเห็นแค่ `404`/`i/o timeout` แล้วไล่ไม่ได้ (DSS relay เดิม)
5. **อุปกรณ์ส่ง URL มาเอง = คิดเรื่อง NAT เสมอ** — ลอง URL ที่ได้ก่อน แล้วสำรองด้วย host ที่ผู้ใช้กรอก พอร์ตเดิม
   (`onvif_patch.js`, `mediaCandidates()` ใน `dss.js`) · token ใช้ครั้งเดียวให้ทดสอบแค่ TCP ก่อนส่งคำขอจริง
6. **login ผิดให้หยุด ห้ามลองซ้ำอัตโนมัติ** — DSS, Digifort, Tiandy ล็อกบัญชี
7. **ทดสอบกับอุปกรณ์จริงอย่างน้อยสองแบบถ้ามี** (ในวง LAN และหลัง NAT / คนละเวอร์ชัน) แล้วยืนยันว่าได้ภาพจริง ไม่ใช่แค่ต่อได้
8. **จดลงไฟล์นี้** — อาการ, รุ่น/เวอร์ชัน, ไซต์, วันที่, สาเหตุ, ที่แก้ และสิ่งที่ยังไม่ได้ยืนยัน

## ปัญหาที่เจอแล้ว

### Milestone Open Network Bridge: H.265 ต้องรับ RTSP ผ่าน TCP

- Bridge ใช้ ONVIF เพื่ออ่านชื่อ/profile และ RTSP URI ของกล้องที่ VMS เผยแพร่ · พอร์ตมาตรฐานคือ ONVIF 580 และ RTSP 554
- ทดสอบกับ VLC: RTP ผ่าน transport เดิมเชื่อมต่อได้แต่ H.265 ค้าง `Waiting for VPS/SPS/PPS`; เปิด `Use RTP over RTSP (TCP)` แล้วภาพขึ้น
- หน้า Edge มี VMS → Milestone Open Network Bridge แยกจาก Digifort · กรอกที่อยู่และบัญชีเอง, สแกน ONVIF, import RTSP ที่ Bridge คืนจริง · เส้น `_raw` ของกล้องกลุ่มนี้บังคับ `#transport=tcp`
- ค่า Codec ในหน้า General ของ Bridge เป็นค่าที่รายงานให้ ONVIF client ไม่ได้แปลงสตรีมจริง · คง `Use configurations from devices` เพื่ออ่านค่าจริง
- ทดสอบจริง 2026-09-28: import กล้องจาก Bridge ที่ Edge แล้ว Client ดูภาพได้ 2 ช่อง; หลังแก้การส่งสถานะ Edge → Central และ restart backend ผู้ใช้ยืนยันว่าทั้งสองช่องแสดง Online ครบ
- ถ้าภาพมาแต่สถานะเป็น Unknown ให้ตรวจ `/api/v1/cameras[].state.reachable` ของ Edge และ Central แยกกัน; กล้องที่เพิ่งเพิ่มหลังสาย SSE เปิดต้องได้สถานะตั้งต้นจากรอบ sync (`server/vms/edge-source.js`)

- Playback ทดสอบกับบันทึกจริง 2026-09-30: Bridge ต้องรับ `FindRecordings` ที่มี `IncludedSources/Token` (camera GUID) และ `RecordingInformationFilter` (XPath, UTC timestamp, ช่วงเวลา/จำนวนก่อนและหลัง); Scope ว่างตอบ 400 แม้ XProtect มีภาพบันทึกแล้ว
- ผลค้นแต่ละแถวเป็นช่วงคลิปของ GUID เดียวกัน; `SourceId` เป็น anonymous จึงต้องจับคู่ด้วย `RecordingToken` และแสดงช่องว่างตามคลิปจริง ไม่ถือว่าบันทึกต่อเนื่องทั้งวัน · คำค้นที่เต็มเพดานแบ่งช่วงค้นใหม่
- RTSP replay ของ Milestone ใช้ `Range: clock=<UTC>-` และ `Rate-Control: no`; ให้ ffmpeg คุมระยะเวลาคลิป การกำหนด end ที่ RTSP เคยทำให้คลิป 5 วินาทีได้เพียง 1.8 วินาทีและค้างรอ · ทางของ ONVIF อุปกรณ์อื่นยังใช้ clock ที่มี end ตามเดิม
- ก่อนแก้ Gateway ตรวจ XProtect Recording Server ว่า storage ไม่ขึ้น `Recording (Unavailable)`; การรับ config สำเร็จหรือดูสดได้ไม่ได้ยืนยันว่าอ่านบันทึกได้

### SDP มีแต่เสียงเมื่อขอ ONVIF backchannel

- **เจอที่:** NVR `203.0.113.99:55101` (SDP บอกว่า "ONVIF RTSP Server") ทุกช่อง
- **อาการ:** เส้น `_raw` ต่อได้ค้างไว้ go2rtc มี producer ข้อมูลไหล client ขึ้นจุดเขียว 0 fps จอดำ — เส้น transcode ของกล้องเดียวกันปกติ
- **สาเหตุ:** go2rtc ใส่ `Require: www.onvif.org/ver20/backchannel` ใน DESCRIBE ถ้าไม่ห้าม ตามสเปก ONVIF อุปกรณ์ต้องตอบ SDP ที่มี video +
  audio `recvonly` + audio `sendonly` แต่ NVR นี้ตัด `m=video` ทิ้ง go2rtc ทำตาม SDP จึงได้แต่ `pcm_mulaw`
- **ทำไมไม่ฟื้นเอง:** go2rtc ลองใหม่โดยไม่ขอ backchannel เฉพาะเมื่ออุปกรณ์ตอบ `551 Option not supported` แต่อันนี้ตอบ `200 OK` พร้อม SDP ผิด
- **แก้:** `#backchannel=0` ในทุก source เส้น `_raw` (`server/gateway/go2rtc-sync.js`) ตรวจ 2026-09-08:

| กล้อง | ไม่มี flag | มี `#backchannel=0` |
|---|---|---|
| Tiandy `203.0.113.12` (LAN) | hevc 704x576 + pcm_alaw | hevc 704x576 + pcm_alaw |
| NVR (WAN) | pcm_mulaw อย่างเดียว ไม่มีภาพ | h264 720x576 + pcm_mulaw |

ใส่ทุกเส้นเพราะไม่มีผลเสียกับกล้องที่ไม่ต้องใช้ และเส้น `_raw` ไม่ต้องการเสียงสองทาง

### go2rtc crash เมื่อส่ง H.265 ออก MSE

- **เจอที่:** กล้อง H.265 ทุกตัว (ช่วงก่อนล้างระบบ 140 จาก 182 endpoint)
- **อาการ:** go2rtc 1.9.14 ตายด้วย SIGSEGV ใน `pkg/h265/rtp.go` → `pkg/mp4/consumer.go`
- **แก้:** เส้นที่เบราว์เซอร์ใช้ต้อง `ffmpeg:<url>#video=h264#hardware` เสมอ · ส่ง H.265 ออก **RTSP** ได้ไม่ crash
  (ตรวจ 2026-09-08: ดึงต่อเนื่อง 30 วิผ่าน go2rtc แยกพอร์ต 8557 ได้ 751 เฟรม 25fps encoder 0%) — นั่นคือที่มาของเส้น `_raw`

### HLS ของ go2rtc ได้แต่เสียง

segment ออกมาเป็นเสียง mp3 ล้วนแม้ producer เป็น H.264 ปกติ — เล่นผ่าน fMP4 `/stream/<name>.mp4` แทน `/hls/*` เหลือไว้เป็นทางสำรองเท่านั้น

### ภาพฉีก/กระตุกของกล้องที่มาผ่าน WAN เมื่อ jitter buffer 200ms

- **สาเหตุ:** 200ms สมมติว่าแพ็กเก็ตมาสม่ำเสมอ ซึ่ง WAN ไม่เป็น · `--clock-jitter=0` / `--clock-synchro=0` ทำให้แย่ลง (ปิดการจัดเวลาของ libvlc ที่ live source ต้องใช้)
- **แก้:** buffer 500ms ไม่ override clock (`client-windows/SurveillanceGateway.Client/App.xaml.cs`)

### Tiandy ล็อกตัวเองเมื่อรหัสผิดซ้ำ

มี auth backoff 15 นาทีใน `server/gateway/analytics/poller.js` · บทเรียนเดียวกับ Digifort (ล็อกบัญชีเมื่อผิด 3 ครั้ง — หน้า import ยิงครั้งเดียวต่อการกด)
คือ **ลองซ้ำแรงขึ้นทำให้ปัญหาเฉพาะยี่ห้อแย่ลง**

### node-onvif พูด HTTPS ไม่ได้ / NVR หลัง NAT รายงาน address ภายใน

`server/onvif_patch.js`: `patchOnvifSoapHttps` เลือก http/https ตาม xaddr (library ใช้ http อย่างเดียว) และ
`patchOnvifNatAddressing` สร้าง URI ใหม่ด้วย host ที่ต่อได้จริงแทน address ภายในที่ NVR รายงาน

### Dahua DSS หลัง NAT ให้ URL ภาพที่ชี้ IP ภายใน (Edge 103 จังหวัดทดสอบ, 2026-10-08)

- **อาการ:** แอด DSS ด้วย IP สาธารณะ → login/รายชื่อ/สถานะปกติ แต่ภาพสดไม่มา go2rtc ขึ้น `read tcp …->127.0.0.1:<relay>: i/o timeout` ทุก 10 วิ
- **สาเหตุ:** `StartVideo` / `StartPlaybackByFile` ตอบ URL ของ media server ที่เป็น address ภายใน (อาจหลายทางคั่น `|`) — TCP ค้างจน go2rtc ตัด
- **ทำแล้ว:** `mediaCandidates()` (`server/vms/dss.js`) ลองทางที่ DSS ให้ก่อน แล้วทางเดียวกันที่เปลี่ยน host เป็นที่อยู่ที่แอดไว้ (พอร์ตเดิม)
  ภาพสดเลือกใน `dss-rtsp-relay.js`, ย้อนหลังใน `firstReachable()` · log `[DSS relay]` / `[DSS]` บอกทางที่ใช้หรือ host:port ที่ต่อไม่ได้
- ต้อง forward พอร์ต media (มักเป็น 9100/9320) ไว้ที่ address เดียวกับ API — พอร์ตภายนอกต่างจากภายในยังไม่รองรับ
- **DSS จังหวัดทดสอบต้องมี `playbackType`** ใน `StartPlaybackByFile` (1004 `Argument [data.playbackType] can not be empty`) — DSS Pro V8.5.0 ของเราไม่ต้อง
  ส่ง `'0'` แล้วภาพย้อนหลังขึ้น (ยืนยัน 2026-10-09) · ค่าอื่นไม่มีเอกสาร · `DssClient` จำไว้หลังโดนครั้งแรก

### NVR ช่องที่ออฟไลน์ตอนสแกน (Uniview NVR ที่ SITE-1-3)

- **อาการ:** ช่องที่กล้องหลุดตอนสแกนหายจาก `GetProfiles` ทั้งก้อน (ไม่ใช่แค่ไม่มี RTSP) — SITE-3 ได้ 20 จาก 28 ช่อง
- **ข้อมูลจริง (log edge 002, 2026-09-24):** `GetVideoSources` ยังรายงานครบทุกช่อง ช่องที่ไม่มีภาพเป็น `Framerate 0`, `0×0`
- **ทำแล้ว:** ผลสแกนเติมช่องจาก `GetVideoSources` ที่ไม่มี profile เป็นแถว OFFLINE (`/api/nvr/channels`, `groupOnvifProfiles`)
  **ไม่แต่ง RTSP ให้** — ไม่มี profile = ขอ `GetStreamUri` ไม่ได้ · กล้องกลับมาแล้วสแกนซ้ำ: ช่องที่แอดแล้วขึ้น ADDED
  และไม่ถูกเลือก, `bulk-add` ข้ามช่องที่ RTSP ซ้ำ (ไม่สนรหัส) จึงไม่เกิดแถวซ้ำ
- ONVIF มาตรฐานไม่มีชื่อช่อง (ชื่อที่ตั้งใน NVR) — ชื่อที่เห็นคือ token ของ VideoSource (`00200` = ช่อง 2 ของ Uniview)
- Uniview มี profile `token:16/0/0/3/1/s0` → `/unicast/c0/…` ที่ไม่ผูก VideoSource = สตรีมของตัว NVR ไม่ใช่กล้อง
  ผลสแกนติดป้าย NVR STREAM และไม่เลือกให้ (เคยถูกแอดเป็น CH 1 ของ SITE-1-3)
- RTSP ของ Uniview NVR: `/unicast/c<ช่อง>/s<0 main|1 sub|2 third>/live` — เลขช่องใน "CH n" อ่านจาก URL นี้
- **Uniview API** (LAPI) อ่าน `GET /LAPI/V1.0/Channels/System/ChannelDetailInfos` ด้วย Digest เพื่อได้ `ID`, `Name`, `Status`
  ของช่องที่ตั้งค่าไว้ · จับ `ID` กับเลข `c<ช่อง>` ใน RTSP จาก ONVIF เท่านั้น · ช่อง offline แอดเป็นแถวรอภาพโดยไม่มี RTSP ได้
  Edge ตรวจ ONVIF ซ้ำทุก 2 นาที เมื่อได้ RTSP จริงจะเติมในแถวเดิมโดยรักษา id/Global ID และส่งต่อ central ตอนนั้น
  (ทดสอบกับ NVR308-64X: LAPI 64 ช่อง, ตั้งค่า 28 ช่อง, online 19 ช่อง; ONVIF ให้ RTSP 19 ช่องตรงเลขทั้งหมด) ·
  [เอกสาร LiteAPI ของ Uniview](https://satvision-cctv.ru/upload/iblock/645/7itm221yv53sn9yj5i50tp7bfrz2dm6y/LiteAPI-Document-for-NVR-V5.03.pdf)

### Tiandy varifocal ซูมได้แค่ ContinuousMove / Uniview varifocal ซูมได้อย่างเดียว

- MODEL-A (203.0.113.12) ตอบว่ามี PTZ (pan/tilt + zoom) และ preset 256 ช่อง (ชื่อเติมช่องว่างท้าย) ตัวกล้องตายตัว หมุนไม่ได้
  แต่เลนส์ varifocal **ซูมได้ด้วย ContinuousMove** (ทดสอบ 2026-09-23 เทียบ snapshot ก่อน/หลัง ที่ความเร็ว 0.25 และ 0.5)
  - AbsoluteMove / RelativeMove ตอบ 200 แต่ไม่ขยับ · `GetStatus` รายงานซูม 0.000 ตลอด — **อย่าใช้ตำแหน่งจาก GetStatus ตัดสินว่าซูมทำงานไหม** ดูจากภาพ
  - มอเตอร์ช้า: กดสั้นกว่า ~0.5 วิ แทบไม่เห็น → หน้า Live (`PtzPad.jsx`) ขยับอย่างน้อย 0.6 วิ ต่อการกด และซูมใช้ความเร็วอย่างน้อย 50%
- Uniview varifocal ประกาศ PTZ service แต่ขอบเขต pan/tilt เป็น 0..0 → `server/gateway/ptz.js` อ่านขอบเขตแยก `panTilt` / `zoom`
- ONVIF ของ Uniview ไม่รองรับ `GetPresets` (`Optional Action Not Implemented`)

### ภาพขึ้นช้าเป็นสิบวินาที (sub stream)

- ผู้เล่น (เว็บ, client, central ที่ดึงจาก edge) เริ่มแสดงได้ที่ keyframe แรกเท่านั้น — กล้องที่ตั้ง I-frame interval ยาวทำให้รอนาน
- วัดจริง MODEL-A: sub เดิม HEVC 352×288 5 fps keyframe ห่าง > 10 วิ → ไบต์แรกที่ central 14 วิ · main 2.8 วิ
- แก้ที่กล้อง: sub ราว 640×360, 15 fps, **I-frame interval = fps** (1 วิ)
- **ระบบใช้แค่ stream 1 (main) กับ stream 2 (sub)** — stream ที่ 3 ขึ้นไปไม่ใช้ (ตกลง 2026-09-25)
  - เดิมระบบเลือก profile ที่ละเอียดต่ำสุดเป็น sub จึงได้ stream 3 ของ MODEL-A (352×288 5 fps, GovLength 100 = keyframe ทุก 20 วิ)
    ทั้งที่ผู้ใช้ตั้ง stream 2 เป็น 640×360 25 fps GovLength 50 (2 วิ) ไว้แล้ว — ตอนนี้ sub = profile แรกถัดจาก main ตามลำดับ `GetProfiles`
  - กล้องที่แอดก่อนหน้านี้ยังถือ URL ของ stream 3 จนกว่าจะ:
    - กล้องเดี่ยว (ONVIF) → เปิดแก้ที่หน้า Cameras ของ edge แล้วกดบันทึก (ระบบ probe ONVIF ใหม่)
    - ช่องของ NVR (ONVIF / Uniview API) → สแกน NVR ตัวนั้นซ้ำ ระบบอัปเดต sub ของช่องที่แอดแล้วเอง (main ไม่แตะ) ไม่ต้องกด import
  - ONVIF ที่มี profile เดียว และกล้อง RTSP ที่กรอกเอง: sub = main (เส้นเดียวกัน) — ช่องบน Live Wall จึง transcode ภาพเต็มขนาด

### Axis (P1488-LE, AXIS OS 12.11) — บัญชี ONVIF แยก, มีแค่ profile 4K

- **ONVIF ต้องใช้บัญชี ONVIF** ที่สร้างในกล้อง (System → Accounts → ONVIF accounts) — บัญชีเว็บ (root) ได้ `400 Sender not authorized`
  - **RTSP แยก path ตามบัญชี** (ทดสอบ P1488-LE 203.0.113.11 ที่ Edge 102, 2026-10-06): `onvif-media/media.amp?profile=…` รับบัญชี ONVIF
    · `axis-media/media.amp` รับบัญชีเว็บ (บัญชี ONVIF ได้ 401) · **CGI ของ VAPIX** (`/axis-cgi/jpg/image.cgi`) ใช้ได้เฉพาะบัญชีเว็บ
  - ONVIF ตอบ stream URI เป็น `127.0.0.3` — `server/onvif_patch.js` แทนด้วย IP ที่ต่อจริงแล้ว · media service อยู่ที่ `/onvif/services`
  - ยี่ห้อ `axis` ในระบบ: ONVIF ล้ม → ใช้ `axis-media/media.amp` แทนการเดา `/onvif1` · ภาพนิ่งสำรองผ่าน VAPIX (digest MD5)
- ตรวจยี่ห้อได้โดยไม่ต้องใช้รหัส: `POST /axis-cgi/basicdeviceinfo.cgi` `{"apiVersion":"1.0","method":"getAllUnrestrictedProperties"}`
  → สแกนแบบระบุวงตั้ง `brand: axis` และชื่อรุ่นให้เอง
- profile ONVIF มีแค่ `profile_1_h264` กับ `profile_1_jpeg` ที่ 3840×2160 ทั้งคู่ → ระบบข้าม JPEG และทำ sub เองด้วย `&resolution=640x360`
  (VAPIX ย่อขนาดตาม parameter ได้ ทั้ง `axis-media/media.amp` และ `onvif-media/media.amp`)
- keyframe ถี่ — ภาพแรกผ่านสาย link: sub 2.3 วิ, main 4.7 วิ

### AXIS S30 recorder (S30, 203.0.113.10 ที่ Edge 102) — ใช้บัญชีเว็บเท่านั้น

- แอดทาง API → AXIS S30 (VAPIX) ด้วยบัญชีเว็บ (`root`): ค้นกล้อง `/axis-cgi/externalipdeviceinfo/list.cgi` แล้วดูภาพ
  `rtsp://<user>:<pass>@<S30>:554/axis-media/media.amp?device=<Device ID>`
- **บัญชี ONVIF ใช้กับ S30 ไม่ได้** (ทดสอบ 2026-10-06): ONVIF device service ตอบ 401 แม้คำสั่งที่ไม่ต้อง login, media service 404,
  `onvif-media` login ผ่านแต่ตอบ 400 (ไม่มี media profile) · `axis-media` ด้วยบัญชี ONVIF = 401
- ไม่มี stream 2 ต่อกล้อง — sub คือ main + `&resolution=640x360` (`axisS30SubRtsp` ใน `server/vms/axis-s30.js`; ก่อน 2026-10-06 sub = main 1080p
  และ server แก้แถวเดิมให้ตอนเริ่ม) · ขอเสียง `&audio=1` ได้ 503 เมื่อกล้องไม่ส่งเสียงให้ S30
- สแกนหลาย host ตอบ 401 กับทุกคำสั่ง ONVIF ยกเว้น `GetSystemDateAndTime` → การสแกนใช้คำสั่งนั้นตรวจว่าเป็น ONVIF

### Avigilon (2.0C-H5SL-D1-IR, fw 3.30.0.38, 203.0.113.15) — ตั้ง H.265 แล้ว ONVIF Media 1 ปฏิเสธ GetProfiles

- ทดสอบ 2026-10-09 · ONVIF ด้วยบัญชีเว็บ (`admin`) ได้ · device/media service อยู่ `/onvif/device_service`, `/onvif/media_service`
  (Media 1 และ Media 2 ใช้ XAddr เดียวกัน)
- Media 1 `GetProfiles` ตอบ `400 InvalidConfiguration` — Detail: `Invalid VideoEncoding H265 for Media 1`
  (Media 1 ไม่มีนิยาม H.265) → `node-onvif` init ล้มทั้งตัว และระบบเคยถอยไปเดา `/onvif1` ซึ่งไม่มีภาพ
- **แก้แล้ว:** `server/onvif_patch.js` ถอยไป Media 2 (`GetServices` หา ver20/media → `GetProfiles Type=All` → `GetStreamUri`/`GetSnapshotUri` ของ Media 2)
  เฉพาะเมื่อ Media 1 ตอบ fault 400/500 ที่ไม่ใช่เรื่องสิทธิ์ · log `Media1 GetProfiles failed … trying Media2` · จำ host:port ไว้ตลอด process
  ครั้งถัดไปไป Media 2 ตรง (1 วิ → 0.1 วิ) · ใช้ได้กับกล้อง H.265 ทุกยี่ห้อที่เข้มแบบนี้ ไม่ต้องมียี่ห้อ Avigilon แยก
- RTSP: `rtsp://<user>:<pass>@<ip>/defaultPrimary?streamType=u` (HEVC 1920×1080 30fps) · `defaultSecondary?streamType=u` (HEVC 720×480)
  ทั้งคู่มีเสียง PCMU 8 kHz และ data track 2 เส้น · snapshot `http://<ip>/media/cam0/still.jpg` (digest)
- token ของ VideoSourceConfiguration (`camCfg0`) ไม่ตรงกับ VideoSource (`cam0`) — การสแกนจับคู่ด้วย `SourceToken` ด้วย (`videoSourceToken`)
  ไม่งั้นได้แถวออฟไลน์เกินหนึ่งแถว
- นาฬิกากล้องเป็นปี 2016 แม้ตั้ง NTP — WS-Security ยังผ่านเพราะ node-onvif ชดเชย `time_diff`
- **ยืนยันใช้งานจริงแล้ว 2026-10-11:** ผู้ดูแลทดสอบ Avigilon แล้วภาพมา และยืนยัน Edge ได้รับ `48f4298`; ปิดงานรอทดสอบภาพใช้งานจริงหลัง Media2 fallback · การทดสอบก่อนหน้านี้ ffmpeg ถอด HEVC → H.264 + AAC ได้
- ยังไม่ได้ยืนยันกรณี Avigilon หลัง NAT; รุ่นนี้เป็น bullet ไม่มี PTZ จึงไม่มีรายการรอทดสอบ PTZ ของรุ่นนี้

### Dahua init ONVIF ไม่ผ่าน

กล้อง "พหลฯ" (203.0.113.147) ทำให้ `node-onvif` พังตอนอ่าน `Width` ของ profile ที่ไม่มีความละเอียด — ยังไม่ได้แก้ (ใช้ RTSP ตรงได้)

### AI ที่หัวกล้อง (ตอนนี้ปิดอยู่ — เก็บไว้ใช้ตอนเปิดกลับ)

- Uniview ไม่มี LAPI คืนยอดนับ — ยอดมาทาง ONVIF metadata บน RTSP เท่านั้น และห่อ AI ครึ่งหนึ่งไว้ใต้ `UserAlarm/SmartHttpReport/*`, `UserAlarm/IVA/*`
- `GetRules` คืนช่องกฎที่สร้างไว้ล่วงหน้า ไม่ใช่กฎที่เปิด — ดู `LineEnable`/`FieldEnable` (อย่าเหมาว่าทุก `*Enable` คือสวิตช์หลัก เช่น `ShoulderEnable`)
- ชื่อกฎใน config (`MyLineDetector1`) ≠ ชื่อบนสาย (`MyLineDetectorRule`) — จับคู่ด้วย `topic` เท่านั้น
- Tiandy และ Dahua ไม่มี metadata track บน RTSP · Tiandy ให้ยอดทาง CGI
- เวลาจากกล้อง Tiandy ลงท้าย `Z` แต่เป็นเวลาบนหน้าปัด · `analytics/http-digest.js` ต้องใช้ `insecureHTTPParser` (กล้องตอบ bare LF)
- แยกสามสถานะเสมอ: ไม่มี AI / มีแต่ปิด / ถามกล้องไม่ได้

## ตัวเลือกของ go2rtc ที่ควรรู้ก่อนไล่ปัญหาถัดไป

ใส่เป็น fragment ต่อท้าย RTSP source ลองตามลำดับ:

| fragment | ผล | ใช้เมื่อ |
|---|---|---|
| `#backchannel=0` | ไม่ขอเสียงสองทางตอน DESCRIBE | ต่อได้แต่ไม่มีภาพ |
| `#media=video` | ขอเฉพาะภาพ ทิ้งเสียงทุกแทร็ก | แทร็กเสียงทำให้ session พัง (แรงกว่า backchannel=0) |
| `#timeout=30` | timeout การเชื่อมต่อ/ข้อมูล (วินาที) | กล้องตอบช้า ลิงก์ไกล |
| `#transport=tcp` / `ws://…` | บังคับ transport | UDP หาย หรือ RTSP ผ่าน WebSocket |
| `ffmpeg:<url>#video=h264` | ให้ ffmpeg เจรจาแทน | ขั้นสุดท้าย — ffmpeg ยอมรับคำตอบผิดสเปกที่ client เข้มงวดปฏิเสธ |

ถ้าผ่าน `ffmpeg:` ได้แต่ native ไม่ได้ เกือบทุกครั้งคือกล้องตอบไม่ตรงกับที่ประกาศไว้

## วิธีไล่ปัญหาตัวถัดไป

1. **ถาม go2rtc ว่าได้อะไรมา:** `curl "http://127.0.0.1:1984/api/streams?src=<path>"` (edge ใช้พอร์ต 1994) คืน SDP ตามจริง
   ไม่มี video ใน `medias` = เจรจาพลาด ไม่ใช่ถอดรหัสพลาด
2. **เทียบกับเส้น transcode ของกล้องเดียวกัน:** ถ้า `ffmpeg:` ได้ แต่ passthrough ไม่ได้ = ปัญหาการเจรจา ใช้ตารางด้านบน
3. **ทดสอบกับ go2rtc แยก ห้ามทดสอบบน production:** copy config เปลี่ยน API เป็นพอร์ตว่าง (เช่น 1985) RTSP เป็น 8557
   ใส่แค่กล้องที่ทดสอบ แล้ว `go2rtc.exe -config <ไฟล์นั้น>` — crash ในตัวทดสอบไม่กระทบใคร
4. **ตรวจด้วย ffprobe ไม่ใช่ด้วยตา:**
   `ffprobe -rtsp_transport tcp -show_entries stream=codec_type,codec_name,width,height rtsp://127.0.0.1:8557/<name>`
   ได้ `codec_type=audio` อย่างเดียว = อาการ SDP มีแต่เสียง
5. ถ้าสงสัยว่ากล้องทำ go2rtc ล้ม ให้ดู log ของ `0-go2rtc` / `1-go2rtc-edge` ระหว่างทดสอบ (ดู OPERATIONS)

## แหล่งอ้างอิง

- [go2rtc RTSP source](https://go2rtc.org/internal/rtsp/) — fragment options
- [go2rtc RTSP sources, negotiation detail](https://deepwiki.com/skrashevich/go2rtc/4.2-rtsp-sources) — DESCRIBE/SETUP, `Require:`, การลองใหม่เมื่อได้ 551
- [go2rtc two-way audio](https://deepwiki.com/skrashevich/go2rtc/8.1-two-way-audio-(backchannel))
- [ONVIF Streaming Specification](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf) — สิ่งที่ DESCRIBE แบบ backchannel ต้องตอบ
- [scrypted issue 1989](https://github.com/koush/scrypted/issues/1989) — ปัญหาเดียวกันบน Axis (ตอบ 551)
- [Multi-vendor camera integration pattern](https://www.forasoft.com/learn/video-surveillance/articles-vms/multi-vendor-interoperability-reference-pattern)

## AI event และภาพ — ยืนยัน 2026-10-02

- Tiandy MODEL-A firmware FW-A: ONVIF services มีอยู่แต่ไม่พบ Perimeter topic/metadata ที่ใช้แทน AlarmInfo ได้ ใช้ภาพ Alarm บน SD จับคู่ช่อง/วินาที ไม่จับภาพสดแทนเหตุเก่า
- UNV MODEL-B firmware FW-B: รับ LineCrossing จาก ONVIF RTSP metadata แล้ว trigger GetSnapshotUri; /media/flv/picture ตอบ HTTP JPEG Stream is full แต่ URI snapshot ที่ ONVIF คืนตอบ JPEG ได้
- Profile M ไม่ได้แนบ JPEG ให้โดยอัตโนมัติ และการมี ONVIF ไม่รับประกันว่า AI กฎเดียวกันรองรับทุกยี่ห้อ
- UNV ต้องชดเชยเวลาเครื่อง; เหตุช้ากว่า 3 วินาทีหรือภาพโหลดเกิน 5 วินาทีไม่เผยแพร่เป็นเหตุพร้อมภาพ; ไม่รีบูตกล้องเพื่อแก้ช่อง JPEG ค้างตามคำสั่งผู้ใช้
- ขอบเขตที่รองรับและหลักฐานสามชั้น: [EXTERNAL-AI.md](EXTERNAL-AI.md)

### DSS: ดึงรายชื่อกล้องจาก device tree (ทดสอบ 2026-10-15)

- `server/vms/dss.js` ใช้ `POST /brms/api/v1.0/tree/devices` พร้อม `categories: ["1"]`, `containVirtualDevice: "1"`, `resourceTypes: []` แล้วอ่าน `devices[].units[]` เฉพาะ `unitType = 1` และใช้ `channels[].channelCode` ตามที่ DSS ส่งมา
- ดึงรายละเอียด/ชื่อกลุ่ม/สถานะผ่าน `device/channel/list` ครั้งละไม่เกิน 400 ID; ไม่ไล่เลข device code หรือประกอบ channel ID เอง จึงรองรับหลายช่องของ NVR และเลขที่อยู่นอกช่วงเดิมได้
- ไม่กรอง offline; ไม่ส่ง device tree ดิบออก API เพราะมี credential ของอุปกรณ์ ไม่แก้ source_ref หรือ Global ID ของกล้องเดิม
- tree ผิดรูป, สิทธิ์ไม่พอ, API ไม่รองรับ หรือรายละเอียดช่องขาด → ตอบ error ไม่ใช้รายการที่ขาดและไม่ fallback กลับไปเดา ID
- ทดสอบอ่านจริงกับ DSS `203.0.113.50` ด้วยบัญชีเดิมของ Edge: 187 ช่อง ตรงรายการเดิมทั้งหมด รวม offline 30 ช่อง; หนึ่งรอบหลัง login ใช้ประมาณ 128 ms เทียบวิธีเดิม 1000 ms (เป็นผลวัดครั้งเดียว ไม่ใช่ benchmark); ยังไม่ได้ทดสอบ DSS จังหวัดทดสอบหรือทุก role/version
- fixture `node scripts/check-dss-discovery.cjs`: loopback พอร์ตสุ่ม ไม่แตะ DB/อุปกรณ์จริง; ตรวจหลายช่อง/ID ซ้ำ/ช่อง alarm/offline, batch 805 ช่อง, response ผิดรูป/ขาด/สิทธิ์ไม่พอ/API ไม่รองรับ
- จุดเริ่มต้นของ endpoint/payload: [source client](https://github.com/borlafu/dahua-dss-client/blob/main/dahua_dss/client.py) และ [device tree fields](https://github.com/borlafu/dahua-dss-client/blob/main/dahua_dss/cli.py); รูปแบบและผลนับยืนยันกับ DSS จริงข้างต้น ไม่ได้มาจากการ decompile DPSDK ที่ยังไม่เสร็จ
### ONVIF: SourceToken และ XAddr เต็ม (2026-10-15)

- จัดกลุ่ม main/sub ด้วย `VideoSourceConfiguration.SourceToken` ของกล้องจริงก่อน configuration token; อุปกรณ์เก่าที่ไม่ส่ง SourceToken ใช้ fallback เดิม และ Milestone profile ที่ไม่มี source ยังแยกกัน
- rescan จับคู่ profile URI อื่นของกล้องเดียวกันด้วย เพื่อรู้จักแถวที่เคยเก็บ sub เป็น main; bulk import กันซ้ำด้วย main/sub/profiles ไม่รวม/ลบแถวเก่าที่เคยซ้ำหรือเปลี่ยน Global ID เอง
- multicast discovery เก็บ XAddrs ที่ใช้ได้ทั้งหมด (สูงสุด 16) พร้อม scheme/host/port/path/query; hostname และ IPv6 ไม่ถูกตัดด้วย IPv4 regex และ HTTPS ไม่มี port ใช้ 443
- ส่ง XAddrs ผ่านฟอร์มไป probe/import แล้วเก็บ JSON ใน `cameras.onvif_xaddrs`; มี migration สำหรับ DB ใหม่/เดิม ใช้ต่อเมื่อ snapshot/PTZ/status หรือเปิดฟอร์มใหม่ ไม่ส่ง endpoint ให้ผู้ไม่มี `device.secrets` หรือผ่าน SAFE_CAMERA_COLUMNS ของ `/api/v1`
- endpoint ที่เก็บห้ามมี user/password ใน URL; query อาจมีข้อมูลลับจึงอยู่ใน CAMERA_SECRET_FIELDS เมื่อผู้ไม่มี secrets แก้ metadata ให้ละ field นี้เพื่อคง DB เดิม
- SOAP คง query ของ service endpoint; ลอง XAddr ที่พบก่อน HTTP/HTTPS path มาตรฐานเดิม ถ้าคนเปลี่ยน host/port ในฟอร์มให้ใช้ปลายทางที่แก้แล้ว
- ไม่เปลี่ยน subnet unicast scanner, นโยบาย NAT, auth retry หรือเพิ่ม HTTP Digest รอบนี้
- หลักฐาน: `node scripts/check-onvif-source-grouping.cjs` และ `node scripts/check-onvif-endpoints.cjs` เป็น fixtures (HTTP/HTTPS loopback พอร์ตสุ่ม, DB memory); ไม่ใช่การทดสอบกล้องจริง, browser หรือ native Client