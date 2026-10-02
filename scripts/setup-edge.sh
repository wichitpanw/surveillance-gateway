#!/usr/bin/env bash
# เตรียมเครื่อง Linux (Ubuntu 24) ให้เป็น Surveillance Gateway Edge — docs/EDGE-LINUX.md
#
# ขั้นที่ไม่ต้องใช้ sudo (รันเป็นผู้ใช้ที่จะรัน edge):
#   scripts/setup-edge.sh --node 002 --public-host 203.0.113.80 \
#       [--province 10] [--central-url ws://A:5173/api/edge-link [--central-url ws://B:15173/api/edge-link?rtsp=18555 …]
#        --central-token ntlink_…] \
#       [--state-dir /var/lib/gw-edge]
#   → สร้าง/อัปเดต <state>/edge.json, .rtsp-credentials.json, go2rtc.yaml และโหลด go2rtc ให้ตรงสถาปัตยกรรม
#
# ขั้นที่ต้องใช้ sudo (ครั้งเดียว):
#   sudo scripts/setup-edge.sh --install-service [--user <ชื่อผู้ใช้>]
#   → systemd unit gw-edge.service (pm2-runtime จาก ecosystem.edge.config.cjs) + cron backup ทุกคืน
#
# รันซ้ำได้: ไม่ทับ .rtsp-credentials.json และ go2rtc.yaml ที่มีอยู่ (go2rtc เขียนรายการสตรีมกลับลงไฟล์นั้น)
# edge.json อัปเดตเฉพาะ key ที่ส่งมาในรอบนี้
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO2RTC_VERSION="v1.9.14"   # ตรงกับ go2rtc/go2rtc.exe ของ central — 1.9.14 มีข้อจำกัดที่โค้ดอ้อมไว้แล้ว อย่าเปลี่ยนลอย ๆ
STATE_DIR="/var/lib/gw-edge"
NODE_NUM="" PROVINCE="" PUBLIC_HOST="" CENTRAL_URLS="" CENTRAL_TOKEN=""
INSTALL_SERVICE=0 SERVICE_USER="${SUDO_USER:-$(id -un)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE_NUM="$2"; shift 2 ;;
    --province) PROVINCE="$2"; shift 2 ;;
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    # ใส่ซ้ำได้ = หลายเส้นทางไป central (ลองตามลำดับ) · ใส่ในรอบนี้ = แทนรายการเดิมทั้งชุด
    --central-url) CENTRAL_URLS="${CENTRAL_URLS:+$CENTRAL_URLS,}$2"; shift 2 ;;
    --central-token) CENTRAL_TOKEN="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --install-service) INSTALL_SERVICE=1; shift ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "ไม่รู้จัก argument: $1" >&2; exit 2 ;;
  esac
done

# ─── ขั้น sudo: systemd + cron ───────────────────────────────────────────────
if [[ $INSTALL_SERVICE -eq 1 ]]; then
  [[ $EUID -eq 0 ]] || { echo "--install-service ต้องรันด้วย sudo" >&2; exit 1; }
  PM2_RUNTIME="$(sudo -u "$SERVICE_USER" bash -lc 'command -v pm2-runtime' || true)"
  [[ -n "$PM2_RUNTIME" ]] || { echo "ไม่พบ pm2-runtime — ติดตั้งก่อน: sudo npm i -g pm2" >&2; exit 1; }
  NODE_BIN_DIR="$(dirname "$(sudo -u "$SERVICE_USER" bash -lc 'command -v node')")"
  mkdir -p "$STATE_DIR" && chown "$SERVICE_USER": "$STATE_DIR"
  sed -e "s#@USER@#$SERVICE_USER#g" -e "s#@REPO@#$REPO#g" -e "s#@STATE@#$STATE_DIR#g" \
      -e "s#@PM2_RUNTIME@#$PM2_RUNTIME#g" -e "s#@NODE_BIN@#$NODE_BIN_DIR#g" \
      "$REPO/scripts/gw-edge.service" > /etc/systemd/system/gw-edge.service
  systemctl daemon-reload
  systemctl enable gw-edge.service
  # backup ทุกคืนตี 2 เป็นผู้ใช้เดียวกับที่รัน edge (อ่าน DB ได้โดยไม่ต้องเป็น root)
  echo "0 2 * * * $SERVICE_USER PATH=$NODE_BIN_DIR:/usr/bin:/bin $REPO/scripts/backup-edge.sh --state-dir $STATE_DIR >> $STATE_DIR/backup.log 2>&1" \
    > /etc/cron.d/gw-edge-backup
  chmod 644 /etc/cron.d/gw-edge-backup
  echo "ติดตั้ง gw-edge.service + cron backup แล้ว — เริ่ม: sudo systemctl start gw-edge · log: journalctl -u gw-edge -f"
  exit 0
fi

# ─── ขั้นผู้ใช้ปกติ: state folder ────────────────────────────────────────────
command -v node >/dev/null || { echo "ไม่พบ node — ติดตั้ง Node.js 22 ก่อน (docs/EDGE-LINUX.md)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ไม่พบ ffmpeg — sudo apt install -y ffmpeg" >&2; exit 1; }
if [[ ! -d "$STATE_DIR" ]]; then
  mkdir -p "$STATE_DIR" 2>/dev/null || { echo "สร้าง $STATE_DIR ไม่ได้ — sudo mkdir -p $STATE_DIR && sudo chown $(id -un): $STATE_DIR" >&2; exit 1; }
fi
chmod 700 "$STATE_DIR"

# edge.json — รวมค่าที่ส่งมารอบนี้เข้ากับของเดิม (node อ่าน/เขียน JSON ให้ ไม่ต้องมี jq)
EDGE_JSON="$STATE_DIR/edge.json" \
NODE_NUM="$NODE_NUM" PROVINCE="$PROVINCE" PUBLIC_HOST="$PUBLIC_HOST" \
CENTRAL_URLS="$CENTRAL_URLS" CENTRAL_TOKEN="$CENTRAL_TOKEN" STATE_DIR="$STATE_DIR" \
node -e '
  const fs = require("fs");
  const f = process.env.EDGE_JSON;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  const set = (k, v) => { if (v) cur[k] = v; };
  set("node", process.env.NODE_NUM);
  set("province", process.env.PROVINCE);
  set("publicHost", process.env.PUBLIC_HOST);
  if (process.env.CENTRAL_URLS) { cur.centralUrls = process.env.CENTRAL_URLS.split(","); delete cur.centralUrl; }
  set("centralToken", process.env.CENTRAL_TOKEN);
  cur.stateDir = process.env.STATE_DIR;
  if (!/^\d{3}$/.test(String(cur.node || ""))) { console.error("ต้องระบุ --node <เลข 3 หลัก> อย่างน้อยครั้งแรก"); process.exit(1); }
  fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
  const shown = { ...cur, centralToken: cur.centralToken ? "(ตั้งแล้ว)" : "" };
  console.log("edge.json:", JSON.stringify(shown));
'
chmod 600 "$STATE_DIR/edge.json"

# ค่าพอร์ตที่ใช้จริง — อ่านจาก ecosystem (ค่าเริ่มต้น + edge.json) ที่เดียว
read -r API_PORT RTSP_PORT < <(GW_EDGE_CONFIG="$STATE_DIR/edge.json" node -e '
  const a = require(process.argv[1]).apps.find((x) => x.name === "3-edge-gateway").env;
  console.log(a.GO2RTC_API_PORT, a.GO2RTC_RTSP_PORT);
' "$REPO/ecosystem.edge.config.cjs")

CRED="$STATE_DIR/.rtsp-credentials.json"
if [[ ! -f "$CRED" ]]; then
  PASS="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '{"username":"edge","password":"%s"}' "$PASS" > "$CRED"
  chmod 600 "$CRED"
  echo "สร้าง $CRED"
fi
RTSP_USER="$(node -e 'console.log(require(process.argv[1]).username)' "$CRED")"
RTSP_PASS="$(node -e 'console.log(require(process.argv[1]).password)' "$CRED")"

YAML="$STATE_DIR/go2rtc.yaml"
if [[ ! -f "$YAML" ]]; then
  cat > "$YAML" <<EOF
# go2rtc ของ Surveillance Gateway Edge — สตรีมถูกซิงก์เข้ามาโดย gateway ผ่าน REST
# API ไม่มี auth — ฟังเฉพาะ loopback · gateway เป็นตัวส่งต่อให้ผู้ใช้ (scripts/lock-go2rtc-api.cjs)
api:
  listen: "127.0.0.1:$API_PORT"
rtsp:
  listen: :$RTSP_PORT
  username: $RTSP_USER
  password: $RTSP_PASS
webrtc:
  listen: ":$((RTSP_PORT + 1))"
ffmpeg:
  bin: $(command -v ffmpeg)
log:
  level: info
EOF
  chmod 600 "$YAML"
  echo "สร้าง $YAML"
fi

# go2rtc ให้ตรงสถาปัตยกรรม — เก็บใน state (นอก repo) เพราะ repo มีแค่ตัวของ Windows
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "สถาปัตยกรรม $(uname -m) ไม่รองรับ" >&2; exit 1 ;;
esac
BIN="$STATE_DIR/bin/go2rtc"
if [[ ! -x "$BIN" ]] || ! "$BIN" -version 2>/dev/null | grep -q "${GO2RTC_VERSION#v}"; then
  mkdir -p "$STATE_DIR/bin"
  echo "โหลด go2rtc $GO2RTC_VERSION ($ARCH)…"
  curl -fsSL -o "$BIN.tmp" "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION/go2rtc_linux_$ARCH"
  chmod +x "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
fi
"$BIN" -version | head -1

echo
echo "state พร้อม: $STATE_DIR (go2rtc api :$API_PORT, rtsp :$RTSP_PORT)"
echo "ต่อไป: sudo $REPO/scripts/setup-edge.sh --install-service && sudo systemctl start gw-edge"
