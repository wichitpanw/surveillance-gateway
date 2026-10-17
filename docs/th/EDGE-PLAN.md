> สถานะปัจจุบัน 2026-10-12: Gateway a0d8867 (Central/Regional ตรวจ API; ผู้ดูแลยืนยันอัปเดตแล้ว) / Client 1.11.0 (ตรวจ full/delta feed); Map worker hotfix ปิดงานแล้ว ดู [WINDOWS-CLIENT-WORKSPACE.md](WINDOWS-CLIENT-WORKSPACE.md); รับ AI ภายนอก ไม่มี inference worker
> เอกสารนี้เขียนตอนระบบสองชั้น คำว่า "central" ในหัวข้อการทำงาน/link หมายถึง **parent ของ edge** — ปัจจุบันคือ Regional (และ Regional เป็นลูกของ Central แบบเดียวกัน) ดู [REGIONAL-PLAN.md](REGIONAL-PLAN.md)

# Edge ↔ Central — การทำงาน ข้อตกลง และงานที่เหลือ

> AI ตั้งแต่ 2026-10-02 เปลี่ยนเป็นรับผลจากกล้อง/NVR/VMS/API ภายนอก ไม่มี inference ทั้งสามชั้น
> เฟส 5 ข้อ D อธิบาย receiver ปัจจุบัน; ข้อ A/C และผลทดสอบตามวันที่เดิมเป็นประวัติ


อัปเดต 2026-10-12 · Central → Regional ภาคกลาง (100) → Edge ใช้จริงแล้ว; Edge 103 เป็น Edge ทดสอบจังหวัดทดสอบที่ตั้งใจต่อภาคกลาง (สถานะสายล่าสุดยังไม่ได้ตรวจ); สาย link ไม่มี TLS ใช้ LAN/VPN
· ติดตั้ง edge ใหม่จากชุด offline และอัปเดตผ่านสายด้วยปุ่มในหน้า Edge Nodes ([EDGE-KIT.md](EDGE-KIT.md)) · เฟส 5: รับ AI event พร้อม JPEG จากต้นทางผ่าน AI Sources; ลบ inference worker แล้ว · ดูย้อนหลังดึงจากอุปกรณ์ (AXIS S30 / Uniview ใช้จริง · Hikvision / Dahua / ONVIF Profile G รอทดสอบ)

## ภาพรวม

```
กล้อง ─RTSP/ONVIF (LAN)─▶ Edge: Gateway + go2rtc (passthrough, ดึงเมื่อมีคนดู)
                            │  ข้อมูลกล้อง + สถานะ : central อ่าน /api/v1 ของ edge ด้วย API key ที่ edge ออกให้
                            │  ภาพ               : go2rtc ของ central ดึง RTSP เส้น _raw จาก go2rtc ของ edge
                            ▼
                     Central: Gateway + go2rtc ─▶ Windows client / ระบบภายนอก (/api/v1 ของ central)
```

หลักที่ห้ามเปลี่ยน:

1. **รหัสผ่านกล้องอยู่ที่ edge ที่เดียว** — central เก็บแค่ API key ของ edge (seal ด้วย key-vault) กับบัญชี RTSP ของ go2rtc ที่ edge
2. **edge กับ central คือโค้ดชุดเดียวกัน** ต่างกันที่ env (`server/shared/instance.js`)
3. **ภาพหนักวิ่งเฉพาะตอนมีคนดู** — แถวกล้องที่ central ไม่กินแบนด์วิดท์จนกว่าจะมีคนเปิด
4. **แต่ละ field มีเจ้าของฝั่งเดียว**

| ข้อมูล | เจ้าของ | ที่อีกฝั่งทำ |
|---|---|---|
| ชื่อ, ยี่ห้อ, พิกัด, จังหวัด/อำเภอ, รหัสกล้อง, ที่อยู่สตรีม, global ID | edge | central เขียนทับจาก edge ทุกรอบ sync (global ID ไม่ทับถ้ามีแล้ว) |
| กลุ่มที่ใช้แสดงผลที่ central, ผัง wall, สิทธิ์ผู้ใช้ central, API key ของ client | central | edge ไม่รู้เรื่องเลย |

## การทำงานจริง

**เพิ่ม edge** (central → Edge Nodes → Add Edge, `POST /api/edges`)
1. central เรียก `/api/v1/health` ของ edge — ต้องได้ `role: "edge"` และเลขเครื่องไม่ซ้ำกับ central ไม่งั้นปฏิเสธ
2. บันทึกเป็นแถว `camera_sources` (`kind = 'edge'`, id = `vms_edge_<host>_<port>`)
3. รับกล้องทุกตัวของ edge เป็นแถว `cameras` ชนิด `edge_relay` (id = `cam_edge_<node>_<id ที่ edge>`)
   - `rtsp` / `rtsp_sub` = URL `rtspRaw` จาก `/api/v1/cameras/:id/streams` ของ edge (ถอยไป `rtsp` ถ้า edge ปิด raw)
   - `ip` = NULL → โค้ด ONVIF / AI / สแกนของ central ข้ามกล้องพวกนี้เอง
   - go2rtc ของ central transcode เส้นหลักเป็น H.264 ให้เบราว์เซอร์ และมีเส้น `_raw` passthrough ให้ client

**Sync** (`server/vms/edge-source.js`)
- health ทุก 60 วิ → สถานะ `reachable` ของ edge (ในหน่วยความจำ + ตาราง `camera_sources`)
- ทุก 10 นาที (หรือปุ่ม Sync / `POST /api/edges/:id/resync`): เขียน field ของ edge ใหม่, **รับกล้องใหม่อัตโนมัติ**
  และนำ `state.reachable`/`state.enabled` ล่าสุดของกล้องที่เพิ่งรับเข้ามาใส่ที่ central พร้อมอัปเดตแผนที่ ID ของสาย SSE
- **กล้องที่หายจาก edge แยกสองแบบ** (2026-09-24):
  - **คนลบที่ edge** → edge จดไว้ (`camera_deletions`, `server/shared/camera-deletions.js`, เก็บ 90 วัน) แล้วส่งให้ central
    (link: `catalog.deleted` ส่งทันทีหลังลบ · pull: `GET /api/v1/cameras/deleted`) → **central ลบแถวตาม** พร้อม `role_devices`
  - **หายโดยไม่มีบันทึก** (ลบก่อนมีระบบนี้, DB ของ edge ถูกล้าง, edge ตอบไม่ครบ) → ติด `source_missing_at` ไม่ลบ
    แต่ถอดจาก go2rtc, สถานะเป็น `reachable: null`, หน้า Cameras ขึ้น MISSING AT EDGE, Live ไม่ให้เลือก
    · ลบได้ที่ป้าย "N หาย" ในหน้า Edge Nodes (`DELETE /api/edges/:id/missing`, ต้องยืนยัน) · edge มีกล้องตัวนั้นกลับมา = ป้ายหายเอง
- edge ติดต่อไม่ได้ → `/api/v1/cameras` ของ central ใส่ `origin.reachable = false` ให้กล้องของ edge นั้น
  (client แสดงเป็นไม่ทราบสถานะ ไม่ใช่กล้องดับ)

**ถอด edge** (`DELETE /api/edges/:id`) — ลบแถวกล้องของ edge นั้นที่ central เท่านั้น ของที่ edge ไม่ถูกแตะ แอดกลับด้วย key เดิมได้

**PTZ** — กล้อง `edge_relay` ส่งคำสั่งต่อไป `POST /api/v1/cameras/<id ที่ edge>/ptz` ด้วย key ของ edge
ต้องผ่านสองชั้น: key ของ client ที่ central ต้องมี `allow_ptz` **และ** key ที่ central ถือไว้กับ edge ต้องมี `allow_ptz`

**สถานะกล้องสามค่า** (`server/shared/camera-state.js`) — ทุกเครื่องมีที่เก็บเดียว แจ้งผู้ฟังทันทีเมื่อค่าเปลี่ยน
- `enabled` ผู้ดูแลเปิดใช้ไหม (`cameras.enabled`, ปุ่มเปิด/ปิดในหน้า Cameras ของ **edge**) · ปิด = ถอดจาก go2rtc ไม่เช็ค ไม่นับว่าดับ
- `reachable` หัวกล้องตอบไหม (TCP ไป RTSP ทุก 15 วิ) · กล้องจาก edge ใช้ค่าที่ **edge รายงาน** · `null` = ไม่รู้ (edge ติดต่อไม่ได้)
- `streaming` go2rtc กำลังดึงภาพอยู่ไหม (producer ที่ต่ออยู่จริง — ไม่ใช่ `streams.*.ready` ซึ่งเป็นจริงตลอดแม้ไม่มีใครดู)
- ออกทาง `/api/v1/cameras[].state`, `/api/camera-states` (เว็บ) และ SSE `camera_state` · SSE ยังส่ง `camera_status`
  (online = `reachable === true`) ให้ client ≤ 1.3.3

**สถานะสดจาก edge** — central ถือสาย SSE `/api/v1/events` ของ edge แต่ละตัวค้างไว้ (`ensureFeed`, ต่อใหม่เอง 2 → 60 วิ)
แล้วเขียน `reachable`/`enabled` ลงที่เก็บของ central ทันที → client ที่ต่อ central เห็นภายในรอบเช็คของ edge (≤ 15 วิ)
กล้องที่เพิ่มหลังเปิดสาย SSE ได้สถานะตั้งต้นในรอบ sync ด้วย; ไม่ต้องรอ event เปลี่ยนสถานะครั้งถัดไป
สายขาด = กล้องของ edge นั้น `reachable: null` · central ไม่เอา `streaming` ของ edge (central มี go2rtc ของตัวเอง)

**Build ไม่ตรง** — `/api/v1/health` ของ central มี `edges: [{node, name, build, reachable}]` · client ≥ 1.3.4 ขึ้นแถบเตือนที่หน้า Home
เมื่อ build ของ edge ไม่ตรง central (หน้า Edge Nodes ก็เตือน)

**Global ID** — `TH-<จังหวัด 2 หลัก>-<เลขเครื่อง 3 หลัก>-<ลำดับ 5 หลัก>` ออกที่ edge ตอนแอดกล้อง (`server/gateway/identity.js`)
ไม่เปลี่ยนตลอดอายุกล้อง · กล้องที่ยังไม่เลือกจังหวัดได้จังหวัดของเครื่อง (`GATEWAY_DEFAULT_PROVINCE`, central = `10`)
central **ไม่ออก** ID ให้กล้อง `edge_relay` — รอรับของ edge ตอน sync (เดิมออกเองได้ถ้า edge ยังไม่ทันออก แล้วเลขของ central ติดถาวร)

## Edge ต่อขึ้นมาเอง — link (เฟส 4)

สำหรับ edge ที่ central ต่อเข้าไปไม่ถึง (หลัง NAT) แต่ edge ออกไปหา central ได้

**ตั้ง** — central: Edge Nodes → Add Edge → "Edge ต่อขึ้นมาเอง" → ได้ token (แสดงครั้งเดียว central เก็บแค่ hash, `POST /api/edges/link`)
edge: ใส่ `centralUrl` (`ws://<central>:5173/api/edge-link`) + `centralToken` ใน `<stateDir>/edge.json` (นอก git — token เป็นความลับ) แล้ว
`pm2 delete 3-edge-gateway` + `pm2 start ecosystem.edge.config.cjs --only 3-edge-gateway`
แถว `camera_sources` ของ edge แบบนี้มี `mode = 'link'` ไม่มี host/port · health 60 วิ ข้ามมัน (สถานะมาจากสาย)

**สาย** (`server/vms/edge-link-server.js` ↔ `edge-link-client.js`) — WebSocket หนึ่งสาย JSON หนึ่งก้อนต่อ frame

| ทิศ | ข้อความ |
|---|---|
| edge → central | `hello {node, build, name, via, platform, runner, province}` → `heartbeat` ทุก 20 วิ · `catalog {cameras}` ตอนต่อ, ทุก 5 นาที และเมื่อถูกขอ · `camera_state` ทันทีที่เปลี่ยน · `update_status {state, build, error}` · `reply {id, ok, data \| error}` |
| central → edge | `welcome` · `rpc {id, method, params}`: `catalog.push`, `stream.open`, `stream.close`, `ptz.info`, `ptz.cmd`, `update.apply` (หมดเวลา 10 วิ) · `update {build, platform, file, size, sha256, signature, path}` · `error` |

เงียบเกิน 60 วิ = สายตาย · เลขเครื่องซ้ำกับ central หรือ edge อื่น = ปฏิเสธ · edge ต่อซ้ำด้วย token เดิม = ปิดสายเก่า

**ภาพ** — go2rtc 1.9.14 push ออกเป็น `rtsp://` เองไม่ได้ (`unsupported scheme`) และรับ push เฉพาะชื่อสตรีมที่มีอยู่แล้ว จึง:
1. central สร้างสตรีม `<id>_in` (ต้นทางปลอม `rtsp://127.0.0.1:1/edge-link-idle`) และให้สตรีมปกติของกล้องดึงจาก `_in` ทาง loopback
2. มีคนเปิดดู (`/stream/*.mp4`, snapshot) → `ensureLinkStream` สั่ง `stream.open` → edge ให้ ffmpeg อ่าน go2rtc ของตัวเอง
   (`-c copy`) แล้ว push ขึ้น `_in` ของ central → central รอจนเห็นผู้ push (≤ 8 วิ) แล้วค่อยส่งภาพ
3. `_in` ไม่มีผู้ดูเกิน 60 วิ → `stream.close` · สายขาด → edge ปิด push ทุกเส้น

**PTZ** — ส่งผ่าน `ptz.cmd` บนสาย · edge ปิดได้ด้วย `GATEWAY_CENTRAL_ALLOW_PTZ=0`

**ที่อยู่ของ central หลายเส้นทาง** — central ถูกเข้าถึงผ่าน LAN, VPN/MPLS ของแต่ละหน่วยงาน และ IP ที่ NAT มา
(พอร์ตภายนอกอาจไม่ใช่ 5173/8555) edge แต่ละแห่งเห็นคนละที่อยู่ และ central ไม่รู้เอง (IP ที่ถูก route/NAT มาไม่อยู่บนเครื่อง)
- ผู้ดูแลบันทึกไว้ที่หน้า Edge Nodes (`settings.CENTRAL_ENDPOINTS`, `GET/PUT /api/edges/endpoints` — ระบบเสนอ IP ของเครื่องเป็นจุดเริ่ม)
- ออก token แล้วเลือกเส้นทางของ edge นั้น → `centralUrls` ใน `edge.json` (`setup-edge.sh --central-url` ซ้ำได้)
  หรือดาวน์โหลดเป็นไฟล์ `edge-<เลข>.json` ให้ชุดติดตั้ง flash drive ([EDGE-KIT.md](EDGE-KIT.md)) — เลข edge ถูกจองที่ central ตอนออก token

- edge ลองตามลำดับ ต่อไม่ติด → อันถัดไป ครบทุกอันแล้วค่อย backoff · หลุดจากอันที่เคยต่อติด → ลองอันเดิมก่อน
- push ภาพไปที่ host ของที่อยู่ที่ต่อติดอยู่ · `?rtsp=<พอร์ต>` ท้าย URL = พอร์ต RTSP ของ central บนเส้นทางนั้น
- `hello.via` + IP ต้นทางของสาย เก็บใน `camera_sources.link_via` / `link_remote` → หน้า Edge Nodes แสดงว่า edge มาทางไหน
- ทดสอบ (instance จำลอง): ที่อยู่แรกต่อไม่ได้ → ใช้อันที่สอง, push ไป host/พอร์ตของอันที่สอง, ภาพถึง central (HTTP 200)

**อัปเดต edge ผ่านสาย link** ([EDGE-KIT.md](EDGE-KIT.md) ข้อ 5) — central เสนอแพ็กเกจที่เซ็นแล้วเมื่อ build ไม่ตรง (`update` บนสาย)
edge ตรวจลายเซ็น โหลดทาง HTTP ด้วย token ของสาย แล้วรอคนกดติดตั้ง (หน้า Edge Nodes ของ central หรือหน้าเว็บของ edge) · `edge-run` หรือ pm2 บน Linux สลับไฟล์และถอยกลับเอง
ถ้าเวอร์ชันใหม่ต่อ central ไม่ติดใน 5 นาที · สถานะส่งกลับด้วย `update_status` แสดงในหน้า Edge Nodes

**ยังไม่มี TLS** — token และบัญชี RTSP ของ go2rtc central วิ่งบนสายเป็นข้อความเปล่า ใช้ได้เฉพาะ Tailscale/LAN
ถ้าจะออก internet ต้องมีโดเมน + cert ก่อน (`wss://` ที่ปลาย central และ RTSPS สำหรับ push)

**API ที่ใช้ร่วม** (ทั้งสองฝั่งมีครบเพราะโค้ดชุดเดียว)

| endpoint | ใช้ทำอะไรในความสัมพันธ์ edge↔central |
|---|---|
| `GET /api/v1/health` | ยืนยันตัวตน: `role`, `node`, `build` (commit ล่าสุดที่แก้ `server/` — commit ที่แก้แค่ client/เอกสารไม่ทำให้ไม่ตรง) · central เพิ่ม `edges[]` ให้ client เทียบ build |
| `GET /api/v1/cameras` | รายชื่อ + `globalId`, `region`, `origin`, `enabled`, `state` |
| `GET /api/v1/events` | SSE `camera_state` / `camera_status` — central ฟังของ edge ค้างไว้ (สถานะสด) |
| `GET /api/v1/cameras/:id/streams` | URL สตรีม (`rtspRaw` ที่ central ใช้ดึง) |
| `GET/POST /api/v1/cameras/:id/ptz` | ความสามารถ PTZ / สั่ง |
| `GET /api/instance` | บทบาทของเครื่อง (ไม่ต้อง login) |

## ข้อตกลงกลาง (ทุก edge ใช้ชุดเดียวกัน)

| รายการ | ค่า |
|---|---|
| เครือข่ายข้ามไซต์ | Tailscale (ยังไม่มี TLS — ห้ามวิ่งบน internet ตรง) |
| Central | `203.0.113.80` / Tailscale `203.0.113.112` · gateway 5173 · go2rtc RTSP 8555 |
| เลขเครื่อง (`GATEWAY_NODE_NUMBER`) | central `000` · Regional ต้นบล็อก `100`/`200`/…/`600` · Edge ในภาค +1 ถึง +99 (ภาคกลางใช้ `101`–`103` แล้ว) · `001`–`099` สงวนของเดิม (`001`/`002` ยุติแล้ว) · `997`–`999` ใช้ทดสอบ |
| จังหวัดใน global ID ของกล้องที่ยังไม่ตั้งจังหวัด | central `10` (ฝังในโค้ด) · edge ตั้ง `GATEWAY_DEFAULT_PROVINCE` ไม่ตั้ง = `00` |
| พอร์ต edge | เครื่องแยก: 5173 / 1984 / 8555 / 8556 · (5273 / 1994 / 8565 / 8566 บน HOST เป็นของ Regional ตั้งแต่ 2026-09-30) |
| `GATEWAY_PUBLIC_HOST` ของ edge | IP ที่ central ต่อถึงได้จริง — ห้าม `127.0.0.1` (ฝังอยู่ใน URL สตรีมที่ส่งให้ central) |
| Firewall ของ edge | พอร์ต gateway และ RTSP ของ go2rtc เปิดให้ IP ของ central เท่านั้น |
| Health / sync | 60 วินาที / 10 นาที |
| เวลา | ISO-8601 `+07:00` · ไม่ตั้ง NTP (ตัดสินใจแล้ว 2026-09-23) — เวลาของแต่ละเครื่องอาจคลาดกันได้ อย่าใช้เวลาข้ามเครื่องเทียบลำดับเหตุการณ์ |
| รหัสจังหวัด | `server/data/thai-regions.csv` (กรมการปกครอง / มอก. 1099) |

## งานที่ปิดล่าสุด (2026-10-08–11)

- Avigilon H.265: ONVIF Media1 → Media2 fallback ใน `48f4298`; ผู้ดูแลยืนยันเมื่อ 2026-10-11 ว่าทดสอบใช้งานแล้วภาพมา
- DSS: fallback host หลัง NAT ใช้ทั้งสด/ย้อนหลัง; DSS จังหวัดทดสอบต้องใช้ `playbackType` และยืนยันย้อนหลัง 2026-10-09
- ชุดติดตั้ง Edge มีตัวถอนติดตั้ง Windows/Linux และล้างชุดเก่าตอน publish

## งานที่ยังไม่ได้ทำ

| งาน | ทำไม / รายละเอียด |
|---|---|
| **TLS ของสาย link** | `wss://` ที่ central + RTSPS สำหรับ push — ต้องมีโดเมนและ cert ก่อน จนกว่าจะมี link ใช้ได้เฉพาะ Tailscale/LAN |
| **AI จากยี่ห้ออื่น (ถัดไป)** | ทดสอบ topic/metadata และภาพประกอบต่อรุ่น; เพิ่ม native adapter เมื่อยืนยันได้ หรือรับผ่าน API ภายนอก |
| **ดูย้อนหลังจากอุปกรณ์** | ใช้จริง: AXIS S30, Uniview NVR, Tiandy SD (Profile G), Milestone Bridge (2026-09-30), Dahua DSS Pro · **เขียนแล้ว รอเครื่องทดสอบ**: Hikvision, Dahua (กล้อง/NVR), Profile G ของ NVR ยี่ห้ออื่น · Digifort รอเอกสาร API ส่วน playback |

## เฟส 5 — AI event จากต้นทาง (ปรับ 2026-10-02)

หลัก: **ต้นทางรัน AI · Edge รับผล · Regional/Central รวม event พร้อมภาพประกอบ; ไม่มี inference ทั้งสามชั้น**

**A. บันทึกภาพ — ถอดออก 2026-09-28** · เคยทำตัวบันทึกที่ edge (`gateway/recorder.js`, หน้า Recording, ffmpeg ต่อกล้อง ไฟล์ละ 60 วิ,
retention ตามวัน/quota/ดิสก์ว่าง) แล้วผู้ใช้ตัดสินใจถอดออก เปลี่ยนไปดึงย้อนหลังจากอุปกรณ์ (AXIS S30 และ Uniview NVR ใช้จริง;
Hikvision / Dahua / ONVIF Profile G เขียนแล้วรอทดสอบ) · โค้ดเดิมกู้ได้จาก git history (ก่อน commit ที่ถอด) · ตาราง `recordings` และคอลัมน์ `record_*`
ใน DB เดิมค้างไว้ได้ ไม่มีใครอ่าน · แหล่งภาพใหม่ต้องมี `ranges`, `openPlayback`, `frame` ตามหัวไฟล์ `gateway/playback.js`

**ดูย้อนหลัง** — `server/gateway/playback.js` ทางเดียวกันทั้ง API และเว็บ · กล้อง `edge_relay` ส่งต่อไป edge ด้วย key ของ edge · AXIS S30 ใช้ VAPIX/RTSP · Uniview NVR ใช้ LAPI/RTSP replay ทั้งช่องที่แอดด้วย Uniview API และ ONVIF (`server/vms/device-playback.js`) · ยี่ห้ออื่นดูตาราง "แหล่งภาพตามอุปกรณ์" ด้านล่าง · กล้องที่ยังไม่มีแหล่งภาพตอบ 501
| เส้น | ใช้ |
|---|---|
| `GET /api/v1/cameras/:id/recordings?from&to` | ช่วงที่มีภาพ |
| `GET /api/v1/cameras/:id/playback.mp4?start&duration[&video=h264]` | fMP4 ≤ 3600 วิ · ไม่ส่ง video = โคเดคของกล้อง · `X-Playback-Start` = เวลาเฟรมแรก |
| `GET /api/v1/cameras/:id/playback-token` | ออก token เฉพาะกล้องใน scope เมื่อ API key มี `allow_playback`; Windows client ใช้เปิด `/playback/:id.mp4?...&video=raw` โดยไม่ส่ง API key ใน URL |
| `GET /api/v1/cameras/:id/frame.jpg?at` | ภาพนิ่งจากไฟล์ |
| เว็บ: `GET /api/playback/:id/ranges`, `/api/playback/:id/token` → `/playback/:id.mp4?t=` | หน้า Playback ของ central (สิทธิ์ `playback.view`) |
- edge แบบ link (2026-09-28): ช่วงเวลาและภาพนิ่งวิ่งบนสาย (rpc) · ตัววิดีโอ central สั่ง rpc `recording.upload` แล้ว edge **อัปโหลด fMP4
  เป็นสตรีมทาง HTTP** ขึ้น `POST /api/edge-link/playback/:session` (token ของสาย) → central ต่อท่อไปที่ผู้ชม ไม่พักลงดิสก์
  (`vms/link-playback.js`) · ผู้ชมปิด = ตัดสาย = ffmpeg ที่ edge หยุด · ไม่มาใน 15 วิ = 504
- API key ต้องติ๊ก **"ย้อนหลัง"** (`allow_playback`) — ทั้ง key ของ client ที่ central และ key ที่ central ถือไว้กับ edge (ติ๊กที่ edge)
- Windows client 1.8.4 (1.8.5 แก้ก้อนภาพข้ามช่องว่าง/เที่ยงคืน): เส้นเวลาหนึ่งวันแสดงช่วงบันทึก (คลิก = เล่น, ล้อเมาส์ = ซูม, ลาก = เลื่อน) หัวเล่นวิ่งตามเวลาจริง ·
  เล่น/พัก, ±30 วิ, ช่วงก่อน/ถัดไป, ไปที่เวลา · เล่นจบก้อน 1 ชม. ขอก้อนถัดไปเอง · ทุก seek เป็นคำขอใหม่ (`Views/PlaybackTimeline.cs`)

**แหล่งภาพตามอุปกรณ์** — `server/vms/device-playback.js` เลือกตามชนิดและยี่ห้อของกล้อง
| อุปกรณ์ | ทาง | สถานะ |
|---|---|---|
| AXIS S30 (`onvif_nvr`) | VAPIX ค้น + RTSP `recordingid` | ใช้จริง |
| Uniview NVR (`onvif_nvr`) | LAPI ค้น + RTSP `/cN/b<epoch>/e<epoch>/replay/` | ใช้จริง |
| Hikvision กล้อง SD card / NVR | ISAPI `ContentMgmt/search` + RTSP `/Streaming/tracks/<ช่อง>01?starttime=` | เขียนแล้ว รอเครื่องทดสอบ |
| Dahua กล้อง SD card / NVR | `mediaFileFind.cgi` + RTSP `/cam/playback?channel=&starttime=` | เขียนแล้ว รอเครื่องทดสอบ |
| `onvif_cam` / `onvif_nvr` อื่นทั้งหมด (Tiandy, Hi-View, generic, Milestone Bridge, กล้อง SD card ของ AXIS/Uniview) | ONVIF Profile G: FindRecordings + FindEvents + GetReplayUri (Milestone ใช้ทางเฉพาะ ดูข้างล่าง) | กล้อง Tiandy + SD card ใช้ได้ (Office 2026-09-29) · Milestone Bridge ใช้จริง 2026-09-30 · ยี่ห้ออื่น/NVR รอทดสอบ |
| Digifort | — | 501 รอเอกสาร API ส่วน playback · ห้ามเดา endpoint (รหัสผิด 3 ครั้ง บัญชีโดนบล็อก กล้องทั้งชุดดับ) |
| RTSP ที่กรอกเอง (`manual`) | — | 501 ไม่มีทางถามบันทึก |
- Profile G: ffmpeg ส่ง `Range: clock=` / `Require: onvif-replay` เองไม่ได้ → `vms/onvif-replay-proxy.js` เปิดตัวกลางที่ 127.0.0.1 ต่อคำขอ
  ใส่ header และ Digest ให้ (รหัสไม่อยู่ใน command line ของ ffmpeg) · จับคู่ recording กับกล้องด้วย SourceId = token ของ VideoSource/Profile
  → ชื่อกล้อง → มี recording เดียว ไม่เจอ = 409 · อุปกรณ์ที่ไม่รองรับ FindEvents ได้ช่วงหยาบ (ภาพแรกถึงภาพล่าสุด ไม่เห็นช่องว่าง)
- เวลา: Hikvision ISAPI / Dahua CGI ถือเป็นเวลาท้องถิ่นของเครื่อง (+07:00) — Hikvision ติดป้าย `Z` ทั้งที่เป็นเวลาท้องถิ่น
  ถ้าเครื่องไหนเป็น UTC จริง ตั้ง `HIKVISION_TIME_UTC=1` ใน env ของ edge · Profile G เป็น UTC ตามสเปก
- ต้องยืนยันเมื่อได้เครื่อง: เวลาของ Hikvision, `condition.Channel` ของ Dahua เริ่มที่ 1 (firmware เก่าบางรุ่นเริ่ม 0),
  การจับคู่ recording ของ Profile G กับ NVR หลายช่องและ Milestone
- ทดสอบแล้ว (2026-09-28, ไม่มีเครื่อง): parser ทุกตัว, การเลือกแหล่งภาพ, ตัวกลาง RTSP กับ server ปลอมที่บังคับ Digest
- ทดสอบกับเครื่องจริง (2026-09-29): Tiandy `onvif_cam` + SD card (203.0.113.12) — SourceId = token ของ profile (`protoken_ch0001`) จับคู่ตรง,
  FindEvents ให้ `RecordingHistory/Track/State` ครบ, replay URI เป็น `RTSP://…/replay/1/1?replaymode=onvifreplay` (ตัวพิมพ์ใหญ่),
  นาฬิกากล้องช้ากว่าเครื่อง ~147 วิ (WS-Security ใช้ offset จาก GetSystemDateAndTime จึงผ่าน)
  · **หน้าเว็บเคยขึ้น "edge ไม่ตอบภายใน 8 วินาที"**: กล้องค้น recording เอง ~4 วิ + event ~6 วิ เกิน timeout 8 วิ ของ `EdgeClient`
  → แก้: คำขอช่วงบันทึก/ภาพนิ่งรอได้ 45 วิ (`RECORDER_TIMEOUT_MS` ทั้ง pull และ link), ถามผลค้นทีละ `PT1S`, จำ recording + replay URI 10 นาที,
  ตอนกดเล่นไม่ค้น event ซ้ำ · ผล: ช่วงบันทึก 9.4 วิ (ครั้งแรก) / 7.1 วิ (ครั้งถัดไป — เวลาค้นของตัวกล้อง), ภาพแรก 8.4 → 1.2 วิ
  · Windows client รอ ranges ได้ 15 วิ (`GatewayClient`) — พอสำหรับกล้องนี้ ถ้าเจอเครื่องที่ช้ากว่านี้ต้องขยายใน client รุ่นถัดไป
- **Dahua DSS Pro V8.5.0 (2026-09-29, ใช้งานได้)** · `203.0.113.50` · แอดที่ edge (หน้า Cameras → VMS → DAHUA DSS PRO) · type `dss_relay`, brand `dss`,
  source_ref = channelId ของ DSS · โมดูล `server/vms/dss.js` (client), `dss-sessions.js` (session + สถานะทุก 60 วิ), `dss-rtsp-relay.js`,
  `dss-playback.js`, `dss-routes.js`, `dss-ptz.js` · แนวทาง login มาจาก `D:\AI cam project\camera-watch\dss.py`
  - login 2 ขั้น MD5 signature, `clientType: WEB` · token 30 วิ → keepalive `PUT /accounts/keepalive` ทุก 20 วิ · รายชื่อ = `v1.1/device/channel/list` ไล่ช่วงรหัส
    (`device/page` = 1001) · สด `MTS/Video/StartVideo` streamType 1 = 1920x1080, 2 = 704x576 · **URL ใช้ได้ครั้งเดียว** → ตัวกลาง RTSP ในเครื่อง
    ขอใหม่ทุกการเชื่อมต่อ · ย้อนหลัง `SS/Record/QueryRecords` + `SS/Playback/StartPlaybackByFile` (ByTime = 2060) ·
    PTZ `DMS/Ptz/OperateDirect` (4 ขวา, 3 ซ้าย) / `OperateCamera` (ซูม) command 1/0
  - ทดสอบ (edge + central จำลอง, DSS จริง): สแกน 187 ช่อง · ภาพสดทุกเส้นผ่าน go2rtc · ranges 0.2–0.6 วิ · ภาพนิ่ง/วิดีโอย้อนหลังทั้งที่ edge และผ่าน central ·
    PTZ ผ่าน central → edge → DSS ตอบ 200 · ยังไม่รองรับ preset/home ของ DSS · ทุกช่องแสดงแผง PTZ (ยังไม่มีฟิลด์ยืนยันว่าช่องไหนเป็น PTZ)
- **Milestone Open Network Bridge** · Bridge `203.0.113.21:580` (XProtect 2022 R3) · **ใช้จริงแล้ว 2026-09-30 (`a36a2d8`)** หลังผู้ใช้แก้ storage ของ Recording Server
  — ผลและวิธีที่ใช้จริง (ค้นด้วย GUID + เงื่อนไขเวลา, `Rate-Control: no`) ดู [REGIONAL-PLAN.md](REGIONAL-PLAN.md) "ปิดงาน Milestone Playback" · ข้อด้านล่างคือบันทึกตอนวินิจฉัย 2026-09-29:
  - `FindRecordings` แบบ ONVIF ทั่วไป (`<Scope/>`) = `InvalidArgs` · **ต้องใช้รูปแบบของ Milestone**: `Scope/IncludedSources/Token` = GUID กล้อง
    + `RecordingInformationFilter` = `boolean(//Track[TrackType = "Video"]),<เวลา UTC>,<ms ก่อน>,<จำนวนก่อน>,<ms หลัง>,<จำนวนหลัง>` → ได้ SearchToken
  - `FindEvents` = `ActionNotSupported` (ใช้ track จาก FindRecordings เป็นช่วงบันทึกแทน) · `GetRecordingInformation` ตอบ Earliest=Latest=ตอนนี้ (ใช้ไม่ได้)
  - recording token = GUID กล้อง · `GetReplayUri` = `rtsp://<bridge>:554/vod/<guid>` · ตัวกลาง RTSP ของเราผ่าน `/live/` ปกติ
  - ตอนทดสอบ SAN ออฟไลน์: FindRecordings ได้ 0 track, `/vod/` SDP `npt=0.0-0.0` แล้ว SETUP = `455 Method Not Valid in This State` — **ทดสอบใหม่เมื่อ SAN กลับมา**
    (สคริปต์วินิจฉัยอ่านอย่างเดียว: FindRecordings แบบ Milestone + เล่น `/vod/` ผ่าน onvif-replay-proxy) · ถ้าได้ภาพ ต้องเพิ่มทางเฉพาะ Milestone ใน
    `onvif-profile-g-playback.js` (brand `milestone`: FindRecordings แบบข้างบน, ไม่เรียก FindEvents, token = GUID)
  - อ้างอิง: doc.milestonesys.com → Milestone Open Network Bridge → "Manage video playback"

**B. Event backbone (ทำแล้ว 2026-09-28)** — `server/shared/ai-events.js` ตาราง `ai_events` ทั้งสามบทบาท; ส่งสำเนาผลและภาพตามสาย Edge → Regional → Central
- event: `type` (a-z 0-9 _ . -), `label`, `rule`, `ts` (+07:00), `trackId`, `attrs` (≤ 8 KB), `origin` camera|edge-ai, ภาพ JPEG ≤ 300 KB
  เก็บ `<stateDir>/ai-snapshots/<YYYYMMDD>/<id>.jpg` · ลบเมื่อเก่ากว่า `AI_EVENT_DAYS` (90)
- edge: `POST /api/v1/ai/events` (event เดียวหรือ `{events:[…]}` ≤ 100, key ต้องมี **allow_event_write** = ติ๊ก "ส่ง event" — ให้ API ต้นทางที่เชื่อถือได้และเปิด source ต่อกล้อง)
- ทั้งสอง: `GET /api/v1/ai/events?since=|from&to&cameraId&type&label&origin&limit` (ตอบ `nextSince`), `GET /api/v1/ai/events/:seq/snapshot.jpg`,
  SSE `/api/v1/events` ส่ง `{type:'ai_event', event:{…}}` · ขอบเขตกล้องตาม key
- central ไล่ตามเองด้วยเคอร์เซอร์ `remote_seq` (unique `source_id + remote_seq`) — สายสดเป็นแค่สัญญาณ:
  pull = SSE ของ edge, link = ข้อความ `ai_event {seq}` + rpc `ai.since` / `ai.snapshot` · ไล่ตามอีกทุก 60 วิ · ภาพคัดลอกมาเก็บที่ central
- **แจ้งเตือน edge หลุด** (`server/vms/edge-alerts.js`): หลุดเกิน 2 นาที (`EDGE_ALERT_AFTER_MS`) → log `EDGE_DOWN`/`EDGE_UP`,
  SSE `edge_state` ถึงทุก client, แถบแดงบนทุกหน้าของเว็บ central (`GET /api/edge-alerts`) · นับ edge แบบ link ที่ไม่เคยต่อเข้ามาด้วย
- เว็บ central: หน้า **AI Events** (สิทธิ์ `menu.ai`) กรองวัน/กล้อง/ชนิด/ที่มา มีภาพประกอบ กด "ย้อนหลัง" เปิด Playback ก่อนเกิดเหตุ 10 วิ

**C. ประวัติ poller AI หัวกล้องเดิม — ยกเลิก 2026-09-28; ไม่ใช่ receiver ภายนอกปัจจุบัน** · เคยทำและขึ้น production ได้ครึ่งวัน (ONVIF metadata และยอดนับ Tiandy
ส่งเป็น event) แล้วผู้ใช้ตัดสินใจถอดออก: ไม่มีตัวเลือก `ai` ใน edge.json, poller/metadata-collector ไม่ส่งเข้า `ai_events`,
`POST /api/v1/ai/events` รับเฉพาะ `origin: edge-ai`, หน้า AI Events ไม่มีตัวกรองที่มา · โค้ด `server/gateway/analytics/` ยังเก็บไว้
- ที่ยังคงไว้: แก้บั๊กติดตั้งสดที่พบระหว่างทดสอบ: `camera_analytics` บน DB ใหม่ได้ PK `(camera_id, ts)` แต่โค้ดเขียน `ON CONFLICT(camera_id, rule, ts)`
  → ทุกเครื่องที่ติดตั้งสด (รวม edge 001) เขียนยอดไม่ได้ · ตอนนี้ DB ใหม่สร้าง PK ใหม่ และ DB เก่าถูกย้าย PK ให้เองตอนเริ่มระบบ

**ทดสอบ B–C (2026-09-28)** — sim DB ใหม่ edge 999 (pull) + edge 998 (link) + central: event ถึง central < 2 วิ · central ล่มแล้วส่ง 3 event
→ กลับมาได้ครบ ไม่ซ้ำ · ภาพข้ามทั้ง pull และ link ตรงทุกไบต์ · key ไม่มีสิทธิ์ = 403, ชนิด/กล้องผิด = 400/404 · edge หลุด → แถบแดง + `EDGE_DOWN`
แล้วกลับมา → `EDGE_UP` · Tiandy จริง: ย้าย PK สำเร็จ, ยอดที่เพิ่มขึ้นกลายเป็น `people_count` ถึง central

**D. รับ AI ภายนอก (ขึ้น production 2026-10-02, Gateway 10ea98f)**

- Edge ตั้ง AI Sources ต่อกล้อง (อุปกรณ์/API), ปิด receiver เป็นค่าเริ่มต้น และกรอง Group ได้
- Tiandy MODEL-A: Perimeter ผ่าน AlarmInfo + ภาพ Alarm บน SD ที่ตรงช่อง/วินาที; รอภาพแบบ durable pending
- UNV IPC2325SB: ONVIF RTSP metadata LineCrossing ช่อง 1 → GetSnapshotUri ทันที; ไม่ใช้ภาพสดแทนเหตุเก่า
- Regional/Central รับสำเนา event + JPEG และกรอง Edge/Group ภายใต้สิทธิ์; Client 1.9.4 ดูภาพประกอบและรายละเอียดได้
- ขอบเขต native adapter และผลจริง: [EXTERNAL-AI.md](EXTERNAL-AI.md); ONVIF/Profile M ไม่รับประกันทุก AI/รุ่น

**ทดสอบ A (2026-09-27)** — instance จำลอง edge 999 / central 000 (5283/5383, DB ใหม่) + Tiandy 203.0.113.12:
ไฟล์ 60 วิ ลงดัชนี · ranges/playback (hevc copy และ h264)/frame ผ่าน central ได้ · ไม่มี token / token ของชื่ออื่น = 401 ·
key ไม่มี allow_playback = 403 · ช่วงไม่มีภาพ = 404 · เล่นบนหน้า Playback ได้จริง · เจอและแก้: `kill` ffmpeg ที่กำลังออก → `EPERM` ทำ gateway ล้ม
· นาฬิกาของกล้องทดสอบช้ากว่าเครื่อง ~2 นาที 23 วิ — OSD บนภาพไม่ตรงเวลาที่ขอ (ไม่ตั้ง NTP ตามข้อตกลง)

## ตรวจทั้งระบบ (2026-09-28/29)

ตรวจ 8 ด้าน (security, central↔edge, playback, AI, หน้าเว็บ, Windows client, schema/สคริปต์, runtime) แล้วแก้ใน commit เดียวกัน · สิ่งที่แก้:
- **ความปลอดภัย** — `/hls` เคยส่งต่อทุก path ไป API ของ go2rtc (ได้ RTSP + รหัสกล้องทุกตัวด้วย stream token ใบใดก็ได้) · API go2rtc เปิด 0.0.0.0 ไม่มีรหัส →
  ผูก 127.0.0.1 · หน้าเว็บเก็บรหัสผ่านจริงใน localStorage → session token · operator สร้าง/ดู API key ข้ามขอบเขตกล้องได้ · route แก้/ลบกล้องไม่เช็กขอบเขต ·
  ยก `role_id` เป็น superadmin ได้ · รหัสกล้องรั่วลง log จาก stderr ของ ffmpeg · central ไม่ตรวจ scheme ของ URL จาก edge · ไม่มี rate limit ของ login
- **ความเสถียร** — DB error ตอน edge `hello` ทำ central ล่ม · playback แบบ link ถูกตัด 300 วิ (`requestTimeout`) · ffmpeg/session NVR ค้างเมื่อผู้ชมปิดก่อนภาพเริ่ม ·
  แพ็กเกจรุ่นเก่าที่เซ็นถูกใช้ถอยรุ่น edge ได้ (เพิ่ม `sig2`/`issuedAt`) · AI worker ทิ้ง event เมื่อ gateway ล่มนาน / บันทึกครึ่งก้อน (transaction + `eventId`)
- **ทดสอบ** — `node --check` ทั้งหมด · eslint 0 error · vite build · dotnet build 0 warning · test แยกของแต่ละด้าน · central+edge จำลอง DB ใหม่ 27/27 ผ่าน
  (login token, token ปลอม 401, `/hls` 404, `/api/v1` 401, rate limit 429) · **ยังไม่ได้ทดสอบกับกล้อง/GPU/edge 002 จริง**
- ล้างข้อมูลที่ค้างจากตัวบันทึก: แถว `recordings` 427 แถวใน DB ของ edge 001 และชุดติดตั้งเก่า (`scripts/prune-edge-kits.ps1`)

## บันทึกการทดสอบ (2026-09-23)

ทดสอบบนเครื่องเดียวด้วย edge/central จำลองและกล้องจริง (Tiandy 203.0.113.12, Uniview 203.0.113.106):
ภาพวิ่งกล้อง → go2rtc edge → go2rtc central และเส้น raw ยังเป็น HEVC · DB ของ central ไม่มีรหัสกล้อง ·
แอดซ้ำไม่เกิดแถวซ้ำ · เปลี่ยนชื่อที่ edge แล้ว central ตาม แต่กลุ่มที่ central ตั้งไม่ถูกทับ · ลบที่ edge → `missingAtSource` ·
ปิด edge → `reachable:false` และกลับเองเมื่อ edge ขึ้น · PTZ ผ่าน central ได้ และถูกปฏิเสธเมื่อ key ของ edge ไม่มีสิทธิ์ ·
central แอดกล้อง/สแกนเองได้ 403 · edge รับ `/api/edges` ได้ 403

**สถานะสด + link (2026-09-23)** — ทดสอบด้วย instance จำลอง (edge 997 / central 000 บนพอร์ต 5584 / 5585 + go2rtc แยก):
edge เปลี่ยน `reachable` → central ส่ง `camera_state` ต่อให้ client ภายในไม่กี่มิลลิวินาที · ปิด edge → กล้องเป็น `null` ทันที
และกลับเองเมื่อ edge ขึ้น · link: edge ต่อขึ้นมา → catalog เข้า → เปิด `/stream/<id>.mp4` ที่ central ได้ภาพ (ไบต์แรก ~6 วิ
รวมเวลาสั่ง push) → ไม่มีคนดู 60 วิ push ถูกปิด · PTZ ผ่านสาย link ได้คำตอบจาก edge · `/api/v1/health` มี `edges[]`

การจำลองยังเจอว่า **ติดตั้งสดไม่เคยใช้งานได้** มาก่อน (production ไม่เจอเพราะ DB เก่ามีของครบ) แก้แล้วทั้งหมด:
ไม่มี migration ของ `rtsp_sub`/`onvif_*_token`, index ของ `api_clients` ถูกสร้างก่อนตาราง, superadmin ใหม่ไม่มี `role_id`,
คอลัมน์ `analytics_*` ไม่ถูกสร้างเมื่อปิด AI — จึงควรทดสอบด้วย DB ใหม่ทุกครั้งที่แตะ schema
