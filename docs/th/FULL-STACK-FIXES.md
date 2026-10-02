# แผนและผลแก้ Full Stack

วันที่ 2026-10-01 · ฐานโค้ด 9b45ad0 · พัฒนาใน D:\gateway-dev · production ยังเป็น 9b45ad0

## เป้าหมายและขอบเขต

แก้ข้อบกพร่องจาก review เพื่อเตรียมบูรณาการกล้องหน่วยงาน ไม่เพิ่ม AI, TLS/SSO, ระบบบันทึกภาพ หรือฟีเจอร์นอก review

1. ปิดช่องยกระดับสิทธิ์และข้อมูลข้ามบัญชี
2. ทำผล download ให้เชื่อถือได้และตรวจช่วงที่อุปกรณ์ส่งได้
3. กู้ Edge ได้เมื่อ update ล้มระหว่างสลับไฟล์
4. แก้ flow เว็บและ reconnect ของ Windows client
5. ตรวจ regression และ build ในสภาพแยกจาก production

## แก้แล้วใน worktree

- user PUT/DELETE ตรวจสิทธิ์และ camera scope ของบัญชีเป้าหมาย แม้ role ไม่เปลี่ยน
- API key reveal/enable ตรวจ flags ที่ผู้จัดการต้องมีอยู่เอง
- legacy username/password header ใช้ throttle ร่วมกับ /api/login
- settings แยก public map/private Telegram และกัน internal settings จาก POST
- ผู้มี device.manage แต่ไม่มี device.secrets แก้ metadata ได้โดยไม่เปลี่ยน connection/credential หรือ probe ใหม่
- เปลี่ยน session แล้ว remount app/reset ข้อมูลทุกบัญชี; response/body/401 เก่าไม่ข้าม session; Dashboard logs แสดงตามสิทธิ์
- แก้ toast API, grouping ด้วย object ไม่มี prototype และตรวจ response ก่อนรายงานการลบสำเร็จ
- HTTP download/upload จบเมื่อ stdout จบและ source process exit 0 เท่านั้น; source failure ทำให้ response/upload ขาดเพื่อให้ client ปฏิเสธไฟล์
- สัญญาณ success/failure ส่งผ่าน relay 1–2 ชั้นได้; relay มี process completion events ชัดเจน
- Download ส่ง complete=1 ตลอดเส้นทาง; AXIS/Uniview/DSS ปฏิเสธช่วงที่คร่อม clip แรกด้วย HTTP 416 พร้อมความยาวสูงสุดให้เลือกใหม่
- Windows client ตรวจโครงสร้าง fMP4 ก่อน rename .part ไม่รับ header-only/fragment ที่ขาด
- Renderer แยก timeout/cancel/stale attempt, reconnect เมื่อไม่มี frame 12 วินาที, ไม่ reconnect ขณะ pause และคืน retry budget เมื่อมี frame จริง
- Edge runner rollback ได้แม้ app ย้ายไป app.prev แล้วแต่ app.new ย้ายล้ม รวม restart รุ่นเดิมเมื่อเสียก่อนสลับ
- Windows client version 1.9.2 สำหรับ release ชุดแก้

## ผลตรวจ

- backend/script syntax 78 ไฟล์: ผ่าน
- ESLint src: 0 errors, 4 hook warnings เดิม
- Vite build Central/Regional/Edge/client-map ไป review-dist: ผ่าน ไม่แตะ dist production
- dotnet Release build client 1.9.2: ผ่าน 0 warnings/errors
- git diff --check: ผ่าน
- isolated actual backend handlers: user permissions/scope, key flags, shared throttle, settings filtering/internal key rejection, credential preservation ผ่าน deny/allow
- frontend actual apiFetch/handlers: account reset, stale responses/body/401, token rotation, FormData, prototype groups, logs gate, mutation failures และ toast flow ผ่าน
- actual playback/link/relay: source exit 0/1, empty stream, one/two relay hops, strict clip duration ผ่าน
- actual update function ใน VM/filesystem stub: success, second rename failure, pre-swap failure และ health-check rollback ผ่าน
- renderer source ใน isolated test: timeout, cancel, stale request, no-frame/pause/resume, retry budget และ reentrant fallback ผ่าน
- fMP4 validation: header-only/truncated boxes ถูกปฏิเสธและคง destination เดิม; ไฟล์ fragmented H.264/H.265 จาก ffmpeg จริงผ่าน

## ข้อจำกัดและขั้นต่อไป

- ยังไม่ได้ตรวจ UI หลัง login, WPF/GPU จริง หรือกล้อง/NVR และการตัดสาย topology จริงในรอบแก้
- การตรวจ fMP4 รับรองโครงสร้างไฟล์ ไม่รับรอง codec ทุก frame หรือความยาวภาพจริงในกรณีอุปกรณ์จบปกติแต่ส่งภาพสั้นเอง
- ยังไม่ต่อหลาย recording clips เป็นไฟล์เดียว; การเลือกช่วงเกิน clip ที่ adapter รองรับจะถูกปฏิเสธอย่างชัดเจน ผู้ใช้ต้องเลือกช่วงใหม่
- Build แสดง warning ว่า Node 22.6.0 ต่ำกว่ารุ่นที่ Vite รองรับ พร้อม warning Browserslist/chunk size; build ผ่าน แต่ควรวางงาน toolchain แยกก่อนใช้เป็น pipeline ระยะยาว ไม่เปลี่ยน runtime production ในงานนี้
- ผู้ใช้อนุญาต commit/deploy/release client ชุดนี้แล้วเมื่อ 2026-10-01; ผล deployment ต้องตรวจหลังสคริปต์เสร็จ
- ลำดับ deploy: commit -> fast-forward production -> deploy.ps1 -ReleaseClient (backup/restart/build/publish Edge/client) -> ตรวจ builds/feed/hashes -> acceptance test กับหน่วยงานนำร่อง
