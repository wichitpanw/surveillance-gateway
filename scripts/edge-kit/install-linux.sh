#!/usr/bin/env bash
# ติดตั้ง / อัปเดต Surveillance Gateway Edge บน Linux (Raspberry Pi 5 arm64 หรือ x64) จากชุด flash drive — docs/EDGE-KIT.md
# ไม่ต้องใช้ internet · รัน:  sudo bash install-linux.sh
#
# ครั้งแรก: ต้องมีไฟล์ edge-<เลข>.json จากหน้า Edge Nodes ของ central วางไว้ข้างไฟล์นี้หรือที่ราก flash drive
# รันซ้ำ   : อัปเดตโปรแกรม (/opt/gw-edge) ไม่แตะข้อมูลใน state · มีไฟล์ edge-*.json ใหม่ = อัปเดตค่าจากไฟล์นั้นด้วย
#
# ทดสอบบนเครื่องที่มี edge อื่นอยู่แล้ว: --root /opt/gw-edge-test --state /var/lib/gw-edge-test --port 5183
#   --go2rtc-api 1994 --go2rtc-rtsp 8575 --service gw-edge-test
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/opt/gw-edge
STATE=/var/lib/gw-edge
PORT=5173 GO2RTC_API=1984 GO2RTC_RTSP=8555
SERVICE=gw-edge
RUN_USER=gw-edge

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --go2rtc-api) GO2RTC_API="$2"; shift 2 ;;
    --go2rtc-rtsp) GO2RTC_RTSP="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "ไม่รู้จัก argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo; echo "ติดตั้งไม่สำเร็จ: $*" >&2; exit 1; }
echo "=== Surveillance Gateway Edge — ติดตั้งจาก flash drive ==="
[[ $EUID -eq 0 ]] || fail "ต้องรันด้วย sudo:  sudo bash $0"

case "$(uname -m)" in
  aarch64|arm64) PLAT=linux-arm64 ;;
  x86_64) PLAT=linux-x64 ;;
  *) fail "สถาปัตยกรรม $(uname -m) ไม่รองรับ" ;;
esac
SRC="$KIT/$PLAT"
[[ -f "$SRC/bin/node" ]] || fail "ไม่พบ $SRC/bin/node — ชุดติดตั้งไม่มี $PLAT หรือก๊อปมาไม่ครบ"

# ── 1. ไฟล์ตั้งค่าจาก central ──────────────────────────────────────────────────
MOUNT="$(df --output=target "$KIT" 2>/dev/null | tail -1)"
mapfile -t FILES < <(find "$KIT" "${MOUNT:-$KIT}" -maxdepth 1 -type f -name 'edge-*.json' 2>/dev/null | sort -u)
INSTALLED=0; [[ -f "$STATE/edge.json" ]] && INSTALLED=1
PICK=""
if [[ ${#FILES[@]} -eq 1 ]]; then
  PICK="${FILES[0]}"
elif [[ ${#FILES[@]} -gt 1 ]]; then
  echo "พบไฟล์ตั้งค่าหลายไฟล์:"
  for i in "${!FILES[@]}"; do echo "  [$((i + 1))] $(basename "${FILES[$i]}")"; done
  read -r -p "เลือกหมายเลขไฟล์ของเครื่องนี้: " n
  [[ "$n" =~ ^[0-9]+$ && $n -ge 1 && $n -le ${#FILES[@]} ]] || fail "เลือกไม่ถูกต้อง"
  PICK="${FILES[$((n - 1))]}"
fi
if [[ -z "$PICK" && $INSTALLED -eq 0 ]]; then
  fail 'ไม่พบไฟล์ edge-<เลข>.json — ที่ central เปิด Edge Nodes → Add Edge → "Edge ต่อขึ้นมาเอง" → ออก token → ดาวน์โหลดไฟล์ แล้ววางไว้ที่ราก flash drive'
fi
[[ -n "$PICK" ]] && echo "ไฟล์ตั้งค่า: $PICK"
[[ $INSTALLED -eq 1 ]] && echo "พบการติดตั้งเดิม — จะอัปเดตโปรแกรม ข้อมูลใน $STATE ไม่ถูกแตะ"

# ── 2. ผู้ใช้ระบบ + หยุดของเดิม + ก๊อปโปรแกรม ──────────────────────────────────
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$RUN_USER"
systemctl stop "$SERVICE" 2>/dev/null || true
mkdir -p "$ROOT" "$STATE/bin"
for sub in app bin; do
  echo "ก๊อป $sub/ …"
  rm -rf "$ROOT/$sub.new" && cp -a "$SRC/$sub" "$ROOT/$sub.new"
  rm -rf "$ROOT/$sub" && mv "$ROOT/$sub.new" "$ROOT/$sub"
done
chown -R root:root "$ROOT" && chmod -R a+rX "$ROOT"
# flash drive แบบ FAT/exFAT ไม่เก็บสิทธิ์ execute — ตั้งให้ใหม่หลังก๊อป
chmod 755 "$ROOT"/bin/* "$ROOT"/app/scripts/*.sh
# อัปเดตผ่านสาย link: edge-run (ผู้ใช้ gw-edge) สลับ app ↔ app.prev เอง จึงต้องเป็นเจ้าของ $ROOT และ app/ · bin/ ยังเป็นของ root
chown "$RUN_USER": "$ROOT" && chown -R "$RUN_USER": "$ROOT/app"
rm -rf "$ROOT/app.new" "$ROOT/app.failed"
NODE="$ROOT/bin/node"
# go2rtc ไว้ใน state/bin ตามที่ ecosystem กับ setup-edge.sh คาด — setup-edge.sh เห็นเวอร์ชันตรงแล้วไม่โหลดใหม่
install -m 755 "$ROOT/bin/go2rtc" "$STATE/bin/go2rtc"
chown -R "$RUN_USER": "$STATE" && chmod 700 "$STATE"
BUILD="$(head -1 "$ROOT/app/BUILD" 2>/dev/null || true)"

# ── 2b. ai-worker (เฉพาะชุด -WithAi และเครื่องที่มีการ์ด NVIDIA + driver) ────────────────────────
# Python แบบพกพา → venv ที่ $ROOT/ai/venv → wheels จากชุด (ไม่ใช้ internet) · สร้างใหม่เมื่อ requirements เปลี่ยน
AI_READY=0
if [[ -f "$SRC/ai/python.tar.gz" ]]; then
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "ชุดนี้มี ai-worker แต่เครื่องนี้ไม่มีการ์ด NVIDIA (nvidia-smi) — ข้าม ใช้ได้แค่ AI ที่หัวกล้อง"
  else
    AI="$ROOT/ai"
    REQ_HASH="$(sha256sum "$SRC/ai/requirements.txt" | cut -d' ' -f1)"
    if [[ -x "$AI/venv/bin/python" && "$(cat "$AI/venv/.requirements" 2>/dev/null)" == "$REQ_HASH" ]]; then
      echo "ai-worker: venv เดิมตรงกับ requirements — ไม่ต้องติดตั้งใหม่"
    else
      echo "ai-worker: ติดตั้ง Python + ไลบรารี GPU (ใช้เวลาหลายนาที)…"
      rm -rf "$AI/python" "$AI/venv" && mkdir -p "$AI"
      tar -xzf "$SRC/ai/python.tar.gz" -C "$AI" || fail "แตก Python ของ ai-worker ไม่สำเร็จ"
      "$AI/python/bin/python3" -m venv "$AI/venv" || fail "สร้าง venv ของ ai-worker ไม่สำเร็จ"
      "$AI/venv/bin/python" -m pip install -q --no-index --find-links "$SRC/ai/wheels" -r "$SRC/ai/requirements.txt" \
        || fail "ติดตั้งไลบรารีของ ai-worker ไม่สำเร็จ"
      echo "$REQ_HASH" > "$AI/venv/.requirements"
    fi
    mkdir -p "$AI/models" && cp -a "$SRC/ai/models/." "$AI/models/"
    chmod -R a+rX "$AI"
    AI_READY=1
  fi
fi

# ── 3. edge.json ของเครื่องนี้ (ค่าเดิม → ค่าจาก central → ค่าที่ขึ้นกับเครื่องนี้) ─
PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -1)"
FROM="$PICK" OUT="$STATE/edge.json" STATE_DIR="$STATE" PORT="$PORT" API="$GO2RTC_API" RTSP="$GO2RTC_RTSP" \
FFMPEG="$ROOT/bin/ffmpeg" PUBLIC_IP="$PUBLIC_IP" AI_READY="$AI_READY" AI_ROOT="$ROOT/ai" "$NODE" -e '
  const fs = require("fs");
  const e = process.env;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(e.OUT, "utf8")); } catch {}
  if (e.FROM) {
    const c = JSON.parse(fs.readFileSync(e.FROM, "utf8"));
    if (!/^\d{3}$/.test(String(c.node || ""))) { console.error("ไฟล์ไม่มีเลข edge 3 หลัก"); process.exit(1); }
    if (c.role === "regional" && (!/^[1-6]00$/.test(String(c.node)) || !["central", "north", "northeast", "east", "west", "south"].includes(c.region))) {
      console.error("ไฟล์ระบุ Regional node/region ไม่ถูกต้อง"); process.exit(1);
    }
    if (c.role && !["edge", "regional"].includes(c.role)) { console.error("ไฟล์ระบุ role ไม่ถูกต้อง"); process.exit(1); }
    if (!c.centralToken || !c.centralUrls) { console.error("ไฟล์ไม่มี centralToken / centralUrls — ดาวน์โหลดใหม่จาก central"); process.exit(1); }
    for (const k of ["node", "province", "label", "centralUrls", "centralToken", "role", "region"]) if (c[k] !== undefined) cur[k] = c[k];
    delete cur.centralUrl;
  }
  if (!cur.publicHost) cur.publicHost = e.PUBLIC_IP || "";
  Object.assign(cur, { stateDir: e.STATE_DIR, port: +e.PORT, go2rtcApi: +e.API, go2rtcRtsp: +e.RTSP, ffmpeg: e.FFMPEG });
  if (cur.role === "regional") cur.aiWorker = false;
  if (e.AI_READY === "1" && cur.role !== "regional") {
    // ติดตั้งครั้งแรกเปิด ai-worker ให้เลย · ผู้ดูแลปิดเองไว้ (false) = คงไว้ตอนอัปเดต
    if (cur.aiWorker === undefined) cur.aiWorker = true;
    Object.assign(cur, { aiPython: e.AI_ROOT + "/venv/bin/python", aiModel: e.AI_ROOT + "/models/yolox_s.onnx" });
    if (cur.aiGpu === undefined) cur.aiGpu = 0;
  }
  delete cur.go2rtcBin;
  fs.writeFileSync(e.OUT, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  console.log(`edge.json: edge ${cur.node} · เว็บ :${cur.port} · go2rtc :${cur.go2rtcApi}/:${cur.go2rtcRtsp} · publicHost ${cur.publicHost}`);
' || fail "เขียน edge.json ไม่สำเร็จ"
chown "$RUN_USER": "$STATE/edge.json" && chmod 600 "$STATE/edge.json"

# go2rtc.yaml + บัญชี RTSP ของ edge (สคริปต์เดิม ไม่ทับไฟล์ที่มีอยู่ ไม่โหลดอะไรจากเน็ต)
sudo -u "$RUN_USER" env PATH="$ROOT/bin:/usr/bin:/bin" GW_EDGE_CONFIG="$STATE/edge.json" \
  bash "$ROOT/app/scripts/setup-edge.sh" --state-dir "$STATE" >/dev/null || fail "setup-edge.sh ไม่สำเร็จ"

# ── 4. systemd + backup ทุกคืน (เรียกผ่าน bash — แพ็กเกจอัปเดตที่สร้างบน Windows ไม่มีสิทธิ์ execute) ────────────────────────────────────────────────
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
# Surveillance Gateway Edge — ติดตั้งจากชุด flash drive (install-linux.sh) · อย่าแก้มือ รันตัวติดตั้งใหม่แทน
[Unit]
Description=Surveillance Gateway Edge (go2rtc + gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT/app
Environment=PATH=$ROOT/bin:/usr/bin:/bin
ExecStart=$ROOT/bin/node $ROOT/app/scripts/edge-run.cjs --config $STATE/edge.json
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
echo "0 2 * * * $RUN_USER PATH=$ROOT/bin:/usr/bin:/bin GW_EDGE_CONFIG=$STATE/edge.json /bin/bash $ROOT/app/scripts/backup-edge.sh --state-dir $STATE >> $STATE/backup.log 2>&1" \
  > "/etc/cron.d/$SERVICE-backup"
chmod 644 "/etc/cron.d/$SERVICE-backup"
echo "ตั้ง systemd $SERVICE.service และ backup ตีสองแล้ว"

# ── 5. firewall (เฉพาะเมื่อ ufw เปิดอยู่) ──────────────────────────────────────
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow "$PORT/tcp" comment 'Gateway Edge web' >/dev/null
  # คำตอบ ONVIF discovery ของกล้องในวงเดียวกัน วิ่งกลับมาที่พอร์ตสุ่ม
  SUBNET="$(ip -4 -o addr show | awk -v ip="$PUBLIC_IP" '$4 ~ "^"ip"/" {print $4}' | head -1)"
  [[ -n "$SUBNET" ]] && ufw allow from "$SUBNET" proto udp comment 'Gateway Edge ONVIF discovery' >/dev/null
  echo "ตั้ง ufw แล้ว (:$PORT/tcp${SUBNET:+, UDP จาก $SUBNET})"
fi

# ── 6. เริ่มและตรวจ ────────────────────────────────────────────────────────────
systemctl start "$SERVICE"
echo "เริ่มระบบ รอสักครู่…"
INST=""
for _ in $(seq 1 30); do
  sleep 2
  INST="$("$NODE" -e 'fetch(process.argv[1]).then((r) => r.text()).then(console.log).catch(() => {})' "http://127.0.0.1:$PORT/api/instance")"
  [[ -n "$INST" ]] && break
done
[[ -n "$INST" ]] || fail "ระบบไม่ตอบที่ :$PORT ภายใน 60 วินาที — ดู log: $STATE/logs/ และ journalctl -u $SERVICE"
echo "ระบบทำงานแล้ว: $INST${BUILD:+ (ชุดติดตั้ง $BUILD)}"
sleep 5
LINK="$(grep 'Edge link' "$STATE/logs/3-edge-gateway.log" 2>/dev/null | tail -1 || true)"
echo "สาย link: ${LINK:-ยังไม่มีข้อความ — ดูที่หน้า Edge Nodes ของ central ว่าขึ้น Online หรือไม่}"

# ── 7. เก็บกวาด ───────────────────────────────────────────────────────────────
if [[ -n "$PICK" ]]; then
  rm -f "$PICK" && echo "ลบ $(basename "$PICK") ออกจาก flash drive แล้ว (มี token)"
fi
echo
echo "เสร็จ — เปิด http://${PUBLIC_IP:-<IP ของเครื่องนี้>}:$PORT/ เพื่อแอดกล้อง"
[[ $INSTALLED -eq 0 ]] && echo "เข้าครั้งแรกด้วย superadmin / superadmin แล้วเปลี่ยนรหัสผ่านทันที"
exit 0
