<#
.SYNOPSIS
  สำรองสถานะที่สร้างใหม่จาก git ไม่ได้ ของทั้ง Central และ Edge บนโฮสต์ Windows

.DESCRIPTION
  ของที่หายแล้วหายเลย (ไม่อยู่ใน git):
    - ฐานข้อมูล SQLite: กล้อง รหัสผ่านกล้อง ผู้ใช้ API key global ID
    - .gateway-key-secret : กุญแจถอด API key ที่เก็บไว้ (และ key ของ edge ที่ central ถือ) — หายแล้ว
                            key ที่ออกไปแล้วเปิดดูซ้ำไม่ได้ central ต่อ edge ไม่ได้จนกว่าจะใส่ key ใหม่
    - .rtsp-credentials.json + go2rtc.yaml : บัญชี RTSP ของ go2rtc — หายแล้ว URL สตรีมที่แจกไปใช้ไม่ได้
    - .stream-token-secret, .session-secret, .ai-worker-key, .env
    - edge.json ของ edge : เลข edge, พอร์ต และ token ของสาย link

  แต่ละรอบเก็บเป็นโฟลเดอร์ของตัวเอง  <Dest>\<yyyyMMdd-HHmmss>\{central,edge-<node>}\...
  กู้ได้ทีละเครื่องโดยไม่ต้องไล่จับคู่ไฟล์จากชื่อ

  **ใช้ VACUUM INTO ไม่ใช่ Copy-Item** (scripts/sqlite-backup.cjs) — DB เปิดโหมด WAL และมี backend
  เขียนอยู่ตลอด การคัดลอกไฟล์ดิบอาจได้ภาพครึ่ง ๆ กลาง ๆ ที่ดูปกติจนถึงวันที่ต้องใช้จริง
  เปิดแบบอ่านอย่างเดียว จึงสำรอง DB ของ edge ได้แม้ edge รันด้วยสิทธิ์อื่น (ทดสอบ 2026-09-23)

.PARAMETER List
  แสดงรอบที่เก็บไว้ ไม่สำรองใหม่

.PARAMETER EdgeStateDir
  โฟลเดอร์สถานะของ edge บนเครื่องนี้ (ค่า stateDir ใน ecosystem.edge.config.cjs) — ไม่มีโฟลเดอร์นี้ = ข้าม edge

.EXAMPLE
  .\backup-windows.ps1
  .\backup-windows.ps1 -List
#>
[CmdletBinding()]
param(
  [switch]$List,
  [string]$EdgeStateDir = 'D:\gateway-edge',
  [string]$ProvincialStateDir = 'D:\gateway-provincial',
  [string]$RegionalStateDir = 'D:\gateway-regional',
  [string]$SourceRepo = '',
  [string]$Destination = 'D:\gateway-backups\daily',
  [switch]$SkipPrune
)

$ErrorActionPreference = 'Stop'

$Repo     = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRepo = if ($SourceRepo) { (Resolve-Path -LiteralPath $SourceRepo).Path } else { $Repo }
$Dest     = $Destination
$KeepDays = 30
# เก็บอย่างน้อยเท่านี้รอบเสมอ แม้จะเก่ากว่า KeepDays — กันกรณีเครื่องปิดไปนาน แล้วรอบแรกที่กลับมา
# ลบ backup ทุกชุดที่มีทิ้งก่อนจะมีของใหม่ครบ (เคยเกือบเกิดจริง: ชุดล่าสุดคือ 2026-08-28)
$KeepMin  = 3
$RunPattern = '^\d{8}-\d{6}$'

if ($List) {
  Write-Host "=== รอบที่เก็บไว้ใน $Dest ==="
  if (Test-Path $Dest) {
    Get-ChildItem $Dest -Directory | Where-Object { $_.Name -match $RunPattern } | Sort-Object Name -Descending |
      ForEach-Object {
        $size = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum
        $parts = (Get-ChildItem $_.FullName -Directory | ForEach-Object Name) -join ', '
        [pscustomobject]@{ Run = $_.Name; MB = [math]::Round($size / 1MB, 2); Parts = $parts }
      } | Format-Table -AutoSize
  } else { Write-Host '(ยังไม่มี)' }
  return
}

$node = (Get-Command node).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $Dest $stamp
Write-Host "=== backup $stamp → $runDir ==="
$failed = @()

# สำรองเครื่องหนึ่ง (central หรือ edge): DB ด้วย VACUUM INTO + ไฟล์ secret ที่มีอยู่
function Backup-Instance([string]$label, [string]$stateDir, [string[]]$dbs, [string[]]$files) {
  $out = Join-Path $runDir $label
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  foreach ($db in $dbs) {
    $src = Join-Path $stateDir $db
    if (-not (Test-Path $src)) { continue }
    & $node (Join-Path $Repo 'scripts\sqlite-backup.cjs') $src (Join-Path $out $db)
    if ($LASTEXITCODE -ne 0) { $script:failed += "$label\$db"; continue }
    Write-Host ("  {0}\{1} ({2} MB)" -f $label, $db, [math]::Round((Get-Item (Join-Path $out $db)).Length / 1MB, 2))
  }
  foreach ($f in $files) {
    $src = Join-Path $stateDir $f
    if (-not (Test-Path $src)) { continue }
    Copy-Item $src (Join-Path $out (Split-Path $f -Leaf)) -Force
    Write-Host "  $label\$(Split-Path $f -Leaf)"
  }
}

# ─── central (state อยู่ใน server\ + ไฟล์ที่รากของ repo) ─────────────────────
# รายการไฟล์ secret ตรงกับ scripts/edge-backup.cjs และ scripts/backup-edge.sh (+ edge.json เฉพาะ edge)
$secrets = @('.gateway-key-secret', '.rtsp-credentials.json', '.stream-token-secret', '.session-secret', '.ai-worker-key')
Backup-Instance 'central' (Join-Path $StateRepo 'server') @('vms.db') $secrets
foreach ($rel in @('.env', 'go2rtc\go2rtc.yaml')) {
  $src = Join-Path $StateRepo $rel
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $runDir "central\$(Split-Path $rel -Leaf)") -Force
    Write-Host "  central\$(Split-Path $rel -Leaf)"
  }
}

# ─── edge บนเครื่องนี้ ───────────────────────────────────────────────────────
if (Test-Path (Join-Path $EdgeStateDir 'vms.db')) {
  # edge.json = เลข edge, พอร์ต, token ของสาย link (แสดงที่ central ครั้งเดียว) — หายแล้วต้องออก token ใหม่
  Backup-Instance 'edge' $EdgeStateDir @('vms.db') ($secrets + @('go2rtc.yaml', 'edge.json'))
} else {
  Write-Host "  ข้าม edge (ไม่พบ $EdgeStateDir\vms.db)"
}

if (Test-Path (Join-Path $ProvincialStateDir 'vms.db')) {
  Backup-Instance 'provincial-edge' $ProvincialStateDir @('vms.db') ($secrets + @('go2rtc.yaml', 'edge.json'))
} else {
  Write-Host "  ข้าม Edge จังหวัดใหม่ (ไม่พบ $ProvincialStateDir\vms.db)"
}

# ─── Regional บนเครื่องนี้ (มีหลังย้าย M2 เท่านั้น) ────────────────────────
if (Test-Path (Join-Path $RegionalStateDir 'vms.db')) {
  Backup-Instance 'regional' $RegionalStateDir @('vms.db') ($secrets + @('go2rtc.yaml', 'regional.json', 'edge.json'))
} else {
  Write-Host "  ข้าม regional (ไม่พบ $RegionalStateDir\vms.db)"
}

# ─── กุญแจเซ็นแพ็กเกจอัปเดตของ edge (docs/EDGE-KIT.md) — หาย = edge ทุกตัวต้องไปอัปเดตด้วย flash drive ────
$signKey = 'D:\gw-edge-kits\signing\edge-update-key.pem'
if (Test-Path $signKey) {
  Copy-Item $signKey (Join-Path $runDir 'edge-update-key.pem') -Force
  Write-Host '  edge-update-key.pem'
}

# ─── รายการ process ของ pm2 (อ้างอิงเท่านั้น — ตอนบูตใช้ ecosystem ใน git ไม่ใช่ dump) ──
$pm2Home = if ($env:PM2_HOME) { $env:PM2_HOME } else { 'D:\gw-pm2\home' }
$dump = Join-Path $pm2Home 'dump.pm2'
if (Test-Path $dump) {
  Copy-Item $dump (Join-Path $runDir 'pm2-dump.json') -Force
  Write-Host '  pm2 dump'
}

# ─── เก็บกวาดรอบเก่า (เฉพาะโฟลเดอร์รอบ — ไฟล์แบบเก่าที่วางตรง ๆ ใน $Dest ไม่ถูกแตะ) ──
$runs = @(Get-ChildItem $Dest -Directory | Where-Object { $_.Name -match $RunPattern } | Sort-Object Name -Descending)
$cut = (Get-Date).AddDays(-$KeepDays)
$old = @($runs | Select-Object -Skip $KeepMin | Where-Object { $_.CreationTime -lt $cut })
if (-not $SkipPrune -and $old.Count -gt 0) {
  $old | Remove-Item -Recurse -Force -Confirm:$false
  Write-Host "  ลบรอบที่เก่ากว่า $KeepDays วัน $($old.Count) รอบ (เหลืออย่างน้อย $KeepMin รอบเสมอ)"
}

$total = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host "เสร็จ · รวมที่เก็บไว้ $([math]::Round($total / 1MB, 1)) MB"

if ($failed.Count -gt 0) {
  # exit code ไม่ใช่ 0 ให้ Scheduled Task ขึ้นผลว่าล้มเหลว — ไม่งั้น backup พังเงียบไปได้เป็นเดือน
  Write-Error "สำรองไม่สำเร็จ: $($failed -join ', ')"
  exit 1
}

# หมายเหตุ: ปลายทางนี้อยู่บนดิสก์ลูกเดียวกับตัวจริง จึงกันได้แค่ความผิดพลาดของคน ไม่ได้กันดิสก์เสีย
# ควรมีสำเนาที่สองออกไปนอกเครื่องด้วย
