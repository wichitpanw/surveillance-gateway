#!/usr/bin/env bash
# ส่งโค้ด commit ปัจจุบันไปเครื่อง edge บน Linux ผ่าน SSH แล้ว build — รันจาก Git Bash บน HOST
#
#   scripts/deploy-edge.sh deploy-user@203.0.113.80 [--port 2222] [--dir ~/gw-edge] [--no-build]
#
# ใช้ git archive ไม่ใช่ git bundle: ประวัติของ repo มีไฟล์ใหญ่จากยุคก่อน (bundle ~800 MB) และแผนที่ออฟไลน์
# .mbtiles (~880 MB) ที่ edge ไม่ใช้ (แผนที่ของ edge ใช้ไทล์ออนไลน์ผ่าน proxy) — ตัดทิ้งแล้วเหลือไม่กี่สิบ MB
# ปลายทางจึงไม่มี .git → เขียน commit ลงไฟล์ BUILD ให้ server/shared/instance.js อ่านแทน
# (central เทียบ build ของ edge แล้วเตือนเมื่อไม่ตรง — deploy แล้วต้องได้เลขเดียวกับ central)
#
# แตกทับโฟลเดอร์เดิม: node_modules และ dist ยังอยู่ แต่ไฟล์ที่ถูกลบจาก repo จะค้างอยู่ปลายทาง
# ไม่ restart service เอง — สั่ง `sudo systemctl restart gw-edge` บนเครื่องนั้นหลัง deploy (ต้องใช้รหัส sudo)
set -euo pipefail

TARGET="" PORT=22 DIR='~/gw-edge' BUILD_WEB=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --no-build) BUILD_WEB=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[[ -n "$TARGET" ]] || { echo "ใช้: scripts/deploy-edge.sh <user@host> [--port N] [--dir PATH]" >&2; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# นิยามเดียวกับ BUILD_PATHS ใน server/shared/instance.js (ต้นฉบับ) — ไม่ใช่ HEAD
BUILD_PATHS=(server src ai-worker scripts package.json ecosystem.edge.config.cjs)
COMMIT="$(git log -1 --format=%h -- "${BUILD_PATHS[@]}")"
if ! git diff --quiet HEAD -- . ':(exclude)BUILD'; then
  echo "คำเตือน: มีไฟล์ที่ยังไม่ commit — ส่งไปเฉพาะของใน $COMMIT" >&2
fi

SSH=(ssh -p "$PORT" -o BatchMode=yes)
[[ -f "$HOME/.ssh/id_ed25519_cctv" ]] && SSH+=(-i "$HOME/.ssh/id_ed25519_cctv")

echo "=== deploy $COMMIT → $TARGET:$DIR ==="
git archive --format=tar HEAD -- . \
  ':(exclude)server/map_data/*.mbtiles' ':(exclude)docs/presentation' ':(exclude)documents' ':(exclude)*.pdf' \
  | "${SSH[@]}" "$TARGET" "mkdir -p $DIR && tar -x -C $DIR && echo $COMMIT > $DIR/BUILD && echo 'แตกไฟล์แล้ว (BUILD '$COMMIT')'"

if [[ $BUILD_WEB -eq 1 ]]; then
  "${SSH[@]}" "$TARGET" "cd $DIR && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent && cd server && npm ci --no-audit --no-fund --loglevel=error && echo 'build เสร็จ'"
fi
echo "เสร็จ — บนเครื่องนั้น: sudo systemctl restart gw-edge แล้วเช็ค curl -s localhost:5173/api/instance (build ต้องเป็น $COMMIT)"
