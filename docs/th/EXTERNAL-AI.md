# รับผล AI จากต้นทาง

ข้อตกลง 2026-10-02: กล้อง / NVR / VMS / API ภายนอกประมวลผลเอง
Edge รับและแปลง event → Regional รวมภายในภาค → Central รวมทุกภาค
ทั้งสามบทบาทไม่รัน inference; ไม่มีการบันทึกวิดีโอเพิ่ม

สถานะปัจจุบัน (2026-10-12): Gateway a0d8867 (ตรวจ Central/Regional ผ่าน API; ผู้ดูแลยืนยันอัปเดตแล้ว ไม่ได้ตรวจ Edge รายเครื่อง); Client 1.11.0 เผยแพร่ full/delta ใน feed · รับ AI ภายนอก ไม่มี inference worker; ผลตรวจ AI รายรุ่นด้านล่างเป็นหลักฐานตามวันที่เดิม ไม่ใช่การทดสอบ AI ใหม่รอบนี้

## แหล่งรับหลักสองแบบ

- **อุปกรณ์ต้นทาง:** Edge เป็นฝ่ายเชื่อมต่อกล้อง/NVR โดยใช้ native adapter เพื่อรับ event และดึง JPEG; ปัจจุบันทดสอบ Tiandy และ UNV ตามรุ่น/กฎด้านล่าง
- **API ภายนอก:** VMS หรือระบบ AI อื่นเป็นฝ่ายส่ง normalized event พร้อมภาพมาที่ Edge ด้วย API key ที่มีสิทธิ์; ไม่เปิดการเชื่อมต่อกล้องอัตโนมัติ
- ทั้งสองแบบให้ต้นทางประมวลผล AI; ตัวเลือกนี้กำหนดวิธีรับผล ไม่ได้เปิดกฎ AI ในกล้อง
- กล้องใหม่แสดง API ภายนอกเป็นค่าเริ่มต้นและปิดรับอยู่ ไม่ได้หมายความว่ามีระบบภายนอกส่ง event แล้ว

## รอบแรก

- Tiandy MODEL-A ที่ 203.0.113.12; firmware FW-A
- เจ้าของกล้องปัจจุบัน: Edge 101, site office (203.0.113.12), Global ID TH-10-101-00001
  ยืนยันจาก catalog ของ Regional/Central (ต้องค้นด้วยชื่อ/Global ID เพราะ parent ไม่เก็บ IP กล้อง)
  D:\gateway-edge\vms.db เป็น state เก่าที่ใช้ credential อ่านอย่างเดียวในการทดสอบ ไม่ใช้ ID เก่าทับ catalog จริง
- ตรวจจริง: ONVIF ไม่ประกาศ perimeter; เว็บ firmware ใช้ GET /CGI/Smart/AlarmInfo
  พบ AlarmItem.eventType = fielddetection และแปลงเป็น intrusion
- ไม่มีการเปลี่ยนกฎ/พื้นที่/ตารางเวลาของกล้อง และไม่เรียก AlarmInfoClean
- เลือกแหล่งรับหลักหนึ่งทางต่อกล้อง: อุปกรณ์ต้นทาง หรือ API ภายนอก
- native adapter ของ NVR/VMS ยี่ห้ออื่นยังไม่อยู่ในรอบนี้; ส่ง normalized event ผ่าน API ได้

## ตั้งค่าที่ Edge

Cameras ต้องมีแถวกล้องและ Global ID เดิมก่อน → AI Sources → เลือกอุปกรณ์ต้นทาง →
เปิดรับ → ช่อง 1 → เวลาหน้าปัดไทย → บันทึก

ตัวรับอ่านทุก 3 วินาทีหลังคำขอก่อนหน้าจบ (ไม่ซ้อนกัน); พร้อมกันสูงสุด 4 กล้อง
สถานะเชื่อมต่อหมายถึงอ่าน AlarmInfo สำเร็จ ไม่ได้ยืนยันว่ากฎในกล้องเปิดหรือมีเหตุการณ์ใหม่
auth 401/403 พัก 15 นาที; error อื่นพัก 15 วินาที; มีสถานะและเวลาที่อ่าน/เกิดเหตุล่าสุด
ปิดใช้งานกล้องหรือปิดแหล่งรับแล้วไม่เริ่มคำขอรอบใหม่
ค่ารับเก็บใน ai_event_sources ของ SQLite จาก stateFile('vms.db'); credentials ใช้จากแถวกล้องภายใน Edge

กล้องทดลองส่งเวลาหน้าปัดไทย แต่ติด GMT/Z จึงเลือก bangkok-wall; เก็บ event เป็น +07:00
เลือก utc สำหรับแหล่งที่ส่ง UTC จริง — ห้ามใช้การแก้เวลาแบบเดียวกันกับทุกยี่ห้อ

## API ภายนอก

1. เลือก API ภายนอก และเปิดรับใน AI Sources ของกล้องนั้น
2. ออก API key ที่ Edge มี allow_event_write และจำกัด scopeGroups ตามกลุ่มกล้อง
3. ส่ง Authorization: Bearer <api-key> ไป POST /api/v1/ai/events ของ Edge

ตัวอย่างการทำงาน: VMS ตรวจรถข้ามเส้น → โปรแกรมเชื่อมต่อของ VMS แปลงผลและ JPEG เป็น payload ของเรา → ส่ง HTTP POST พร้อม API key ไป Edge → Edge ตรวจสิทธิ์/บันทึก → Regional → Central → AI Events
ถ้า VMS ส่งรูปแบบนี้ไม่ได้ ต้องเขียนตัวเชื่อมก่อน; การเลือก API ภายนอกอย่างเดียวไม่สร้างตัวเชื่อมหรือดึง event อัตโนมัติ

ตัวอย่าง payload (ใช้ Global ID เดิมหรือ local cameraId ของ Edge; ตัวอย่างนี้แสดงเฉพาะข้อมูล event ผู้ส่งต้องเติม snapshot เป็น JPEG base64 เมื่อต้องการภาพประกอบ):

~~~json
{
  "cameraId": "TH-10-101-00002",
  "eventId": "source-event-0001",
  "origin": "nvr",
  "type": "intrusion",
  "rule": "Fence zone 1",
  "ts": "2026-10-02T10:33:18+07:00",
  "attrs": {
    "detectionSource": "camera",
    "deliverySource": "nvr",
    "channel": 1
  }
}
~~~

- origin: camera / nvr / vms / api (ไม่ส่ง = api); edge-ai เดิมอ่าน/ส่งต่อได้เพื่อเก็บประวัติ
- eventId ต้องมี เป็น A-Z a-z 0-9 _ . : - ยาวไม่เกิน 64 ตัว
- กันซ้ำใน namespace ของ API key + local camera ID + origin + eventId
  ต้องใช้ key/ID เดิมเมื่อ retry; การออก key เป็น API client ใบใหม่ถือเป็นผู้ส่งใหม่
- ป้องกันส่งซ้ำข้ามทางโดยตั้งแหล่งหลักรายกล้อง ไม่เปิดทั้ง Tiandy collector และ API พร้อมกัน
- ตอบ 201 {seqs, duplicates}; ส่งเป็น {events:[...]} ได้ 1–100 event
- batch ผิดไม่บันทึกทั้งชุด; มี index ของรายการที่ผิด
- key ไม่มีสิทธิ์ส่ง = 403; กล้องนอก scope/ไม่พบ = 404; ไม่เปิดแหล่งรับ API = 403
- snapshot JPEG base64 ≤ 300 KB เป็น optional; attrs รวมข้อมูลที่ระบบเพิ่มแล้ว ≤ 8 KB
- Regional/Central ไม่รับ POST ภายนอกตรง ใช้สำเนาจากลูกผ่าน pull/link

## การส่งต่อและภาพ

Regional เก็บ event ก่อนส่งต่อขึ้น Central; ต้นทาง/origin/Global ID คงเดิม
เคอร์เซอร์แต่ละสายและ unique(source_id, remote_seq) ป้องกันรับซ้ำ
ภาพพร้อมก่อนเผยแพร่แถว event เพื่อป้องกัน Central อ่านแถวระหว่างบันทึกภาพ
ถ้าต้นทางประกาศว่ามีภาพแต่โหลดไม่ได้ จะไม่เดิน cursor ข้ามและ retry รอบถัดไป
การส่ง event ถัดไปของสายนั้นจะรอภาพดังกล่าว จึงต้องตรวจ error ของ source เมื่อค้าง

หน้า AI Events อยู่ที่ Regional/Central; กรองวัน กล้อง ชนิด ประเภทและที่มา
เปิด Playback จากเวลาเกิดเหตุได้เมื่ออุปกรณ์ต้นทางมีบันทึกและเส้น playback รองรับอยู่แล้ว
GET /api/v1/ai/events และ SSE /api/v1/events ยังเป็นทางอ่านสำหรับ Client/API ภายนอก

## ข้อจำกัดที่ต้องแจ้ง

- AlarmInfo เป็นคิวจำนวนจำกัดในกล้อง ยังไม่ใช่ประวัติถาวร:
  สายกล้อง–Edge ขาดนานแล้วคิวถูกเขียนทับจะกู้เหตุที่หายไม่ได้
- ช่องทาง AlarmInfo ไม่ส่งประเภทคนรถ/สถานะเริ่มจบครบ จึงไม่เติมข้อมูลเอง
  ภาพเหตุของ Tiandy ดึงจาก Alarm JPEG บน SD ตามรายละเอียดด้านล่าง
- Tiandy ไม่มี event UUID ใน payload ที่ทดสอบ:
  ตัวรับกันซ้ำด้วยกล้อง + channel + scene + rule + type + timestamp
  เหตุสองครั้งของกฎเดียวกันในวินาทีเดียวกันอาจแยกไม่ได้
- API ภายนอกต้องรับผิดชอบ retry และ mapping channel ของ NVR/VMS ให้ตรง Global ID
- รุ่นนี้ปิดการสร้าง worker ใน ecosystem และ GET /api/v1/ai/config ตอบ 410
- กล้องอยู่ที่ Edge 101 แล้ว: หลัง update ให้เปิด AI Sources ในแถวเดิม
  ห้ามแอดซ้ำ/เปลี่ยน Global ID และห้ามนำ DB Edge เก่าทับ Regional

## ตรวจสอบก่อนขึ้นจริง

- node scripts/check-external-ai.cjs (DB ใหม่, time modes, channel filtering,
  restart retention/dedup, auth backoff, no collector polling at Central, image publication)
- node --check ทุกไฟล์ backend/script ที่แก้
- npx eslint src/App.jsx src/components/AiSources.jsx src/components/AiEvents.jsx src/lib/app-config.js
- npm run build ใน worktree
- ระบบจำลองสามชั้น: กล้องจริง, pull/link, API scope, batch atomicity, snapshots,
  Central offline แล้วตามคืน, Receiver config หลัง restart
- ตรวจหน้าจอ AI Sources และ AI Events ในระบบจำลอง

การ release: commit เมื่อผู้ใช้สั่ง → deploy backup/restart Central+Regional/build/publish →
update Edge 101 → เปิด receiver ของกล้องแถวเดิม → ยืนยันเหตุจริงครบสามชั้น


## ปรับหน้าจอ 2026-10-02

- Central/Regional กรอง Edge เจ้าของกล้องและกลุ่มร่วมกับวัน/กล้อง/ที่มาได้ ก่อนจำกัด 500 รายการ และคงขอบเขตสิทธิ์
- Edge เจ้าของกล้องอ้างจากเส้นทาง source_ref ของ Regional ไม่เปลี่ยนหรือตีความ Global ID เดิมใหม่
- AI Sources ใช้แหล่งรับ “อุปกรณ์ต้นทาง / API ภายนอก” ไม่มีคำอธิบายเฉพาะยี่ห้อในหน้าใช้งาน
- driver device รองรับการตั้งค่าเดิม tiandy; ยี่ห้ออื่นใช้ API ได้ ส่วน adapter รับตรงเพิ่มเมื่อมีอุปกรณ์ทดสอบ

## ภาพเหตุ Tiandy — ตรวจจริง 2026-10-02

- รุ่น/firmware ข้างต้นเก็บ JPEG ชนิด Alarm บน SD ที่มีสถานะ readwrite
- AlarmInfo ของเครื่องนี้ไม่ส่ง alarmCaptureImage แม้เอกสารระบุว่า field นี้เป็น optional
- ตัวรับค้น POST /ISAPI/ContentMgmt/search (picture, ALL, channelID เริ่ม 0)
  แล้ว GET /ISAPI/Record/DownLoad/<fileName> ผ่าน HTTP Digest
- เลือกเฉพาะชนิด Alarm ช่องและวินาทีเดียวกับ event; ไม่ใช้ Manual/ภาพสดแทน
  ถ้าพบหลายไฟล์ในวินาทีเดียวหรือผลค้นเต็มหน้า จะรอและแจ้ง error ไม่เดาไฟล์
- ภาพถอดรหัส/ย่อด้วย FFmpeg ที่ Edge ในหน่วยความจำ ให้ JPEG ≤ 300 KB
  ไม่มีการบันทึกวิดีโอหรือ inference เพิ่ม; Edge ต้องมี FFmpeg ตามชุดติดตั้งเดิม
- เหตุ native รอจนได้ภาพก่อนเผยแพร่; คิว ai_image_pending อยู่ใน SQLite
  หากภาพยังไม่ลง SD จะ retry 5 วินาทีแล้วเพิ่มช่วงรอสูงสุด 15 นาที
  อ่านภาพสูงสุด 4 เหตุต่อรอบต่อกล้อง; กล้อง auth ผิดพักทั้งตัวรับ 15 นาที
  คิวคงอยู่หลัง restart แม้เหตุหลุดจาก AlarmInfo ไปแล้ว
- AI Sources แสดงจำนวนเหตุรอภาพ; หาก SD/การบันทึกภาพ Alarm มีปัญหา เหตุเหล่านั้นจะยังไม่ขึ้น AI Events
- เหตุเดิมที่บันทึกโดยตัวรับรุ่นก่อนโดยไม่มีภาพยังคงเดิม; ไม่ backfill แถวที่ส่งต่อไปแล้วในรอบนี้
- ระบบจำลอง DB ใหม่รับ 26 เหตุจากกล้องจริงพร้อมภาพครบ Edge → Regional → Central
  ตัวอย่าง 12:17:23 ภาพ 234,463 bytes, OSD ตรงเวลา event และ SHA-256 ตรงทั้งสามชั้น
  เปิดภาพบนหน้า AI Events ของ Central จำลองได้จริง
- ไม่ต้องเปิด FTP/Email สำหรับทางนี้; Snapshot Channel 1 และภาพ Alarm บน SD ต้องมีอยู่

## UNV ONVIF — ตรวจเครื่องจริง 2026-10-02

- MODEL-B / FW-B ที่ 203.0.113.75
- ใช้ ONVIF metadata track ผ่าน RTSP รับ tns1:RuleEngine/LineDetector/Crossed
  มี UTC time, ObjectId, LineIndex; GetRules ยืนยัน MyLineDetector1 เปิดอยู่
- Media2 GetMetadataConfigurations ตอบ Analytics=true
- เว็บผู้ผลิตระบุ Profile M; ผลทดสอบบริการจริงไม่ได้แทนการรับรอง firmware ในฐานข้อมูล ONVIF
- GetSnapshotUri ของเครื่องคืน /LAPI/V1.0/Media/Video/Streams/0/Snapshot
  ตรวจจริงตอบ 200 image/jpeg (250,167 bytes) แม้ /media/flv/picture ตอบ 409 HTTP JPEG Stream is full
- รับ event แล้วดึง snapshot ทันที ไม่ใช่ JPEG ที่แนบมาใน Profile M
  เก็บ imageSource=onvif-event-triggered-snapshot, receivedAt, capturedAt, captureDelayMs
- ไม่จับภาพแทนเหตุเก่า: รับช้ากว่าเวลาเหตุ 3 วินาที/เวลาเหตุล้ำอนาคตเกิน 2 วินาทีจะปฏิเสธ
  ภาพโหลดเสร็จช้ากว่าเวลาเหตุ 5 วินาทีจะไม่เผยแพร่ event; ไม่มีการ backfill ด้วยภาพปัจจุบัน
- จำกัด snapshot พร้อมกัน 2 เหตุต่อกล้อง; dedup ตามกล้อง/ช่อง/เวลา/ObjectId/LineIndex
- หนึ่ง metadata session ต่อกล้อง; ต่อใหม่หลังสายหลุด 15 วินาที; auth ผิดพัก 15 นาที
  ปิด session เมื่อปิด source, เปลี่ยนเป็น API, ปิด/ลบกล้อง หรือหยุด server
- ระยะนี้รองรับกล้อง UNV เดี่ยวช่อง 1; ไม่อ้างว่ารองรับ NVR หรือ AI ทุกชนิด
- ไม่มี inference หรือบันทึกวิดีโอ และไม่ต้องตั้ง Intelligent Server ชี้เข้า Edge สำหรับทาง ONVIF
- HTTP subscription ทั้ง ImagePushMode 0 และ 1 รับ LineCrossing จริงแต่ไม่มีภาพ/URL
  ค่าทดลอง Intelligent Server ถูกคืนค่าเดิมแล้ว; ไม่รีบูตตามคำสั่งผู้ใช้

### Tiandy กับแนวทาง ONVIF เดียวกัน

- MODEL-A firmware ที่ทดสอบคืน analytics/events/media2 services แต่ GetEventProperties
  พบ Motion/Tamper ไม่พบ LineCrossing/Perimeter และ RTSP ที่ GetStreamUri คืนไม่มี metadata track
- จึงยังคงใช้ adapter Tiandy AlarmInfo + ภาพ Alarm บน SD สำหรับ Perimeter ของเครื่องนี้
- การรองรับ ONVIF ต้องตรวจ event topic/metadata ที่ส่งจริงและ snapshot URI ต่อรุ่น/firmware
  ไม่ตีความ Motion เป็น Perimeter และไม่อ้างว่ามี Profile M เพียงเพราะมี ONVIF service

อ้างอิง:
- https://www.onvif.org/profiles/profile-m/
- https://global.uniview.com/Products/Network_Cameras/Prime_Series/PRIMEI_Series/MODEL-B/
- https://www.onvif.org/conformant-products/

### ผล end-to-end ของ UNV

- ระบบจำลองรับ LineCrossing จริงพร้อม JPEG อย่างน้อย 6 เหตุครบ Edge → Regional → Central
- ตัวอย่างเวลา event 13:34:35, ObjectId 4309, LineIndex 0, ภาพ 138,369 bytes
  SHA-256 ตรงทั้งสามชั้น; เปิดดูภาพบนหน้า Central ได้จริง
- กล้องตั้ง GMT-00:00 และนาฬิกาช้ากว่าเครื่องรับประมาณ 17 วินาที
  อ่าน ONVIF GetSystemDateAndTime ทุก 60 วินาทีโดยไม่เปลี่ยนเวลาอุปกรณ์
  เก็บ cameraClockOffsetMs; captureDelayMs เป็นค่าประมาณหลังหักส่วนต่างนาฬิกา
  sample เก่าเกิน 90 วินาทีหรือวัดเวลานานเกิน 2 วินาทีจะไม่ใช้จับคู่ภาพ
  ตัวอย่างดึงภาพใช้ 256 ms และ delay ที่คำนวณได้ 521 ms; OSD ภาพตรงวินาที event
- แก้ browser cache ของ snapshot หลังพบภาพจากระบบจำลองรอบก่อนค้างเมื่อใช้ URL/seq เดิม
  หน้าเว็บ fetch cache=no-store; endpoint ภาพ UI ตั้ง private,no-store
- ตรวจด้วย check-external-ai.cjs (12 กลุ่ม), check-uniview-ai.cjs (4 กลุ่ม), node --check,
  ESLint, build และหน้า AI Sources/AI Events จริงในระบบจำลอง
- การทดสอบนี้ไม่เปลี่ยน production, ไม่ commit, ไม่ reboot กล้อง


## Windows Client 1.9.3 และ release 2026-10-02

- แสดงที่มา camera/NVR/VMS/API และเหตุ edge-ai เดิมตามข้อมูลจริง
- กรอง Edge/กลุ่ม/ที่มาก่อนจำกัดรายการ; SSE และภาพใช้ขอบเขต API key เดียวกัน
- แสดงภาพย่อ/ภาพเต็ม พร้อมชนิดภาพและเวลาที่จับภาพถ้าต้นทางส่งมา
- ยกเลิก request เก่าเมื่อเปลี่ยนตัวกรอง ป้องกันรายการ/ภาพค้างจากการเลือกก่อนหน้า
- ตรวจ API จริงในระบบจำลอง: ตัวกรอง, scope ของ key/ตัวเลือก/ภาพ, JPEG และ no-store
- dotnet build Release ผ่าน; render EventsView แบบ offscreen ด้วยภาพ UNV จริงและทดสอบเลือก Edge 101 / Pilot
- ผู้ใช้อนุญาตลบต้นแบบ uniview-perimeter.js ที่ไม่ได้ใช้งาน และ commit/deploy รวมพร้อม Client
- ไม่มีการรีบูตกล้อง และไม่เผยแพร่รหัสกล้องใน API/แพ็กเกจ


### ผล deploy

- 2026-10-02 Gateway build 38315ff ขึ้นทั้ง Central/Regional/Edge 101/102
- ผู้ใช้กดติดตั้ง Edge ทั้งสอง; ตรวจ /api/instance และหน้า Regional ขึ้นติดตั้งสำเร็จ
- Client 1.9.3 ปล่อย full/delta/installer แล้ว และตรวจภาพเต็ม EventDetailWindow แบบ offscreen ผ่าน
- Backup ก่อน merge ที่ D:\gateway-backups\daily\20261002-141316

### เปิด receiver และ Group filter

- เปิด Tiandy 203.0.113.12 และ UNV TEST ที่ Edge 101 เป็นอุปกรณ์ต้นทาง ช่อง 1; ทั้งสองเชื่อมต่อแล้ว
- Central production รับภาพ Tiandy จริง 30 เหตุ; เปิดภาพเต็มที่เวลา 13:55:40 และ OSD ตรงเวลา event
- AI Sources เพิ่มตัวกรอง Group จากกลุ่มกล้องในขอบเขตบัญชี; คงค่าที่แก้ค้างเมื่อสลับกลุ่ม
- ตรวจ backend syntax, check-external-ai.cjs, ESLint และ build ผ่าน
### Group filter ขึ้น production

- Gateway build 3c273c5 ตรงกันทั้ง Central/Regional/Edge 101/102; แพ็กเกจผ่าน signature/size/SHA-256
- หน้า AI Sources จริงเลือก site office แล้วเหลือ 3 กล้อง และ UNV event test แล้วเหลือ UNV TEST ตัวเดียว
- ตัวรับ Tiandy และ UNV เปิดอยู่/เชื่อมต่อหลังอัปเดต; Tiandy ส่งภาพเหตุถึง Central แล้ว
- UNV รอเหตุรถผ่านรอบใหม่ใน production; ผล LineCrossing พร้อมภาพก่อน release ตรวจกล้องจริงในระบบจำลองแล้ว
## ถอด inference เดิม (2026-10-02)

- API ตั้ง inference เดิมคืน 410; ตั้ง receiver ที่ AI Sources ต่อกล้อง
- คงฐานข้อมูล, event/ภาพย้อนหลัง และ backup/secret เก่าไว้; ไม่ลบ D:\gateway-ai
- แพ็กเกจใหม่ไม่บรรจุ worker; Edge แบบสลับโฟลเดอร์ใช้เฉพาะโค้ดใหม่ ส่วน Edge แบบ in-place อาจมีโฟลเดอร์เก่าที่ไม่ถูกใช้งาน

## ยืนยันหลังถอด worker — Gateway 10ea98f / Client 1.9.4

2026-10-02: backup D:\gateway-backups\daily\20261002-220011 แล้ว deploy Central/Regional และอัปเดต Edge 101/102 ผ่าน Regional UI; /api/instance ทั้งสี่ตรงกันและ Edge Online
แพ็กเกจทั้งสามแพลตฟอร์มผ่าน signature/size/SHA-256; หน้า AI Sources จริงแสดง Tiandy/UNV เชื่อมต่อหลังอัปเดต
ตรวจ external AI 12 ชุด + UNV 4 ชุด, DB ใหม่/startup, เพิกถอนเฉพาะ key worker โดยคง key ภายนอก, syntax/ESLint และ build หน้าเว็บผ่าน
Client 1.9.4 release แล้ว หุบตัวกรอง Camera Library ได้ (render offscreen; ไม่ใช่การยืนยันหน้าต่างจริง)
