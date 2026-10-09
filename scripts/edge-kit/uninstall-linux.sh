#!/usr/bin/env bash
# ถอนการติดตั้ง Surveillance Gateway Edge บน Linux ที่ลงด้วย install-linux.sh — docs/EDGE-KIT.md
# รัน:  sudo bash uninstall-linux.sh [--remove-data]
#
# ค่าตั้งต้น: หยุดและลบ systemd service, cron backup, ufw rule, โปรแกรม (/opt/gw-edge) แต่ **เก็บ state ไว้**
#   (/var/lib/gw-edge: vms.db = กล้อง + Global ID, edge.json = token, รหัสกล้อง, backups) — ติดตั้งซ้ำได้ ID เดิม
# --remove-data = ลบ state และผู้ใช้ระบบ gw-edge ด้วย (ถามให้พิมพ์เลข edge ยืนยัน) · ลบแล้วกู้ไม่ได้
# ติดตั้งด้วยค่าอื่น: --root / --state / --service ให้ตรงกับตอนติดตั้ง
#
# ควรถอด edge นี้ที่หน้า Edge Nodes ของ Regional ก่อน — token จะใช้ไม่ได้ และกล้องหายจากชั้นบน
set -euo pipefail

ROOT=/opt/gw-edge
STATE=/var/lib/gw-edge
SERVICE=gw-edge
RUN_USER=gw-edge
REMOVE_DATA=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --remove-data) REMOVE_DATA=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "ไม่รู้จัก argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo; echo "ถอนการติดตั้งไม่สำเร็จ: $*" >&2; exit 1; }
echo "=== Surveillance Gateway Edge — ถอนการติดตั้ง ==="
[[ $EUID -eq 0 ]] || fail "ต้องรันด้วย sudo:  sudo bash $0"

UNIT="/etc/systemd/system/$SERVICE.service"
# เครื่องที่ไม่ได้ลงจากชุด (เช่น Edge 102 ที่ใช้ gw-edge → pm2-runtime) ห้ามแตะ — unit ไม่มีบรรทัดของตัวติดตั้ง
if [[ -f "$UNIT" ]] && ! grep -q 'install-linux.sh' "$UNIT"; then
  fail "$UNIT ไม่ได้สร้างจาก install-linux.sh — เครื่องนี้ไม่ได้ติดตั้งจากชุด flash drive ถอนเองตาม docs/EDGE-KIT.md"
fi
for d in "$ROOT" "$STATE"; do
  [[ "$d" == /* && "$d" != "/" && "$(dirname "$d")" != "/" ]] || fail "path $d ไม่ปลอดภัยสำหรับลบ"
done
[[ -f "$UNIT" || -d "$ROOT" ]] || fail "ไม่พบการติดตั้งที่ $ROOT / $UNIT — ถ้าติดตั้งด้วยค่าอื่น ระบุ --root / --service"
if [[ -d "$ROOT" && ! -f "$ROOT/app/scripts/edge-run.cjs" && ! -f "$STATE/edge.json" ]]; then
  fail "$ROOT ไม่ใช่โฟลเดอร์ของ Surveillance Gateway Edge (ไม่พบ app/scripts/edge-run.cjs หรือ $STATE/edge.json) — ไม่ลบ"
fi

NODE_NO="$(grep -o '"node": *"[0-9]*"' "$STATE/edge.json" 2>/dev/null | grep -o '[0-9]\+' || true)"
echo "เครื่องนี้: edge ${NODE_NO:-(ไม่ทราบเลข)} · โปรแกรม $ROOT · ข้อมูล $STATE · service $SERVICE"
echo "ก่อนถอน: ถอด edge นี้ที่หน้า Edge Nodes ของ Regional แล้วหรือยัง? (ยังไม่ถอด = Regional ขึ้นสถานะ offline ค้างไว้)"
read -r -p "พิมพ์ y เพื่อถอนการติดตั้งต่อ: " ans
[[ "$ans" == "y" ]] || { echo "ยกเลิก"; exit 0; }

WIPE=0
if [[ $REMOVE_DATA -eq 1 ]]; then
  echo
  echo "คำเตือน: --remove-data จะลบ $STATE ถาวร — กล้อง, Global ID, รหัสกล้อง และ backup ทั้งหมดของเครื่องนี้ กู้คืนไม่ได้"
  WANT="${NODE_NO:-DELETE}"
  read -r -p "พิมพ์ $WANT เพื่อยืนยันการลบข้อมูล (อย่างอื่น = เก็บข้อมูลไว้): " typed
  if [[ "$typed" == "$WANT" ]]; then WIPE=1; else echo "ไม่ยืนยัน — จะเก็บ $STATE ไว้"; fi
fi

# ── 1. systemd + cron ─────────────────────────────────────────────────────────
if [[ -f "$UNIT" ]]; then
  systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
  echo "หยุดและลบ $SERVICE.service แล้ว"
fi
rm -f "/etc/cron.d/$SERVICE-backup"

# ── 2. process ที่ค้าง (เฉพาะไฟล์ใน $ROOT / $STATE — ไม่แตะโปรแกรมอื่น) ────────────
for _ in 1 2 3; do
  PIDS="$(for p in /proc/[0-9]*; do exe="$(readlink "$p/exe" 2>/dev/null || true)"
    [[ "$exe" == "$ROOT/"* || "$exe" == "$STATE/"* ]] && echo "${p#/proc/}"; done || true)"
  [[ -z "$PIDS" ]] && break
  kill -9 $PIDS 2>/dev/null || true
  sleep 1
done

# ── 3. ufw (rule ที่ตัวติดตั้งใส่ comment 'Gateway Edge …') ─────────────────────────
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  # ลบจากเลขมากไปน้อย — ลบแล้วเลขข้างหลังเลื่อน
  mapfile -t NUMS < <(ufw status numbered | grep '# Gateway Edge' | sed -n 's/^\[ *\([0-9]\+\)\].*/\1/p' | sort -rn)
  for n in "${NUMS[@]}"; do ufw --force delete "$n" >/dev/null; done
  echo "ลบ ufw rule ${#NUMS[@]} ข้อแล้ว"
fi

# ── 4. ไฟล์ ───────────────────────────────────────────────────────────────────
rm -rf "$ROOT"
echo "ลบโปรแกรม $ROOT แล้ว"
if [[ $WIPE -eq 1 ]]; then
  rm -rf "$STATE"
  id "$RUN_USER" >/dev/null 2>&1 && userdel "$RUN_USER" 2>/dev/null || true
  echo "ลบ $STATE และผู้ใช้ $RUN_USER แล้ว"
else
  echo "เก็บข้อมูลไว้ที่ $STATE (มี token และรหัสกล้อง — สิทธิ์ 700 ของผู้ใช้ $RUN_USER)"
  echo "  ติดตั้งซ้ำ: sudo bash install-linux.sh ได้กล้องและ Global ID เดิม · ลบทิ้ง: รันใหม่ด้วย --remove-data"
fi

echo
echo "ถอนการติดตั้งเสร็จ — ลบไฟล์ edge-<เลข>.json ใน flash drive ด้วย (มี token)"
exit 0
