#!/usr/bin/env bash
# backup ของ edge บน Linux — คู่กับ backup-windows.ps1 ฝั่ง Windows (หลักการเดียวกัน)
#
#   scripts/backup-edge.sh [--state-dir /var/lib/gw-edge] [--dest <state>/backups]
#
# แต่ละรอบเป็นโฟลเดอร์ <dest>/<yyyyMMdd-HHmmss>/ มี vms.db (VACUUM INTO — ห้าม cp ดิบ DB ที่เปิด WAL อยู่)
# + .gateway-key-secret, .rtsp-credentials.json, .stream-token-secret, .session-secret, .ai-worker-key, go2rtc.yaml, edge.json
# เก็บ 30 วัน แต่เหลือ 3 รอบล่าสุดเสมอ · ล้มเหลว = exit 1 (cron ส่ง log ไปที่ backup.log)
# **กู้ DB กับ .gateway-key-secret จากรอบเดียวกันเสมอ** — key ใน DB เข้ารหัสด้วยกุญแจนั้น
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="/var/lib/gw-edge"
DEST=""
KEEP_DAYS=30
KEEP_MIN=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    *) echo "ไม่รู้จัก argument: $1" >&2; exit 2 ;;
  esac
done
DEST="${DEST:-$STATE_DIR/backups}"

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="$DEST/$STAMP"
mkdir -p "$RUN"
chmod 700 "$DEST" "$RUN"
echo "=== backup $STAMP → $RUN ==="

node "$REPO/scripts/sqlite-backup.cjs" "$STATE_DIR/vms.db" "$RUN/vms.db"
echo "  vms.db ($(du -h "$RUN/vms.db" | cut -f1))"

for f in .gateway-key-secret .rtsp-credentials.json .stream-token-secret .session-secret .ai-worker-key go2rtc.yaml edge.json; do
  if [[ -f "$STATE_DIR/$f" ]]; then cp -p "$STATE_DIR/$f" "$RUN/$f"; echo "  $f"; fi
done

# เก็บกวาด: ข้าม KEEP_MIN รอบล่าสุด แล้วลบรอบที่เก่ากว่า KEEP_DAYS
mapfile -t RUNS < <(find "$DEST" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}-[0-9]{6}' | sort -r)
CUT="$(date -d "-$KEEP_DAYS days" +%Y%m%d-%H%M%S)"
for ((i = KEEP_MIN; i < ${#RUNS[@]}; i++)); do
  name="$(basename "${RUNS[$i]}")"
  if [[ "$name" < "$CUT" ]]; then rm -rf "${RUNS[$i]}"; echo "  ลบรอบเก่า $name"; fi
done

echo "เสร็จ · รวม $(du -sh "$DEST" | cut -f1)"
