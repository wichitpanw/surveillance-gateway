<#
  ถอนการติดตั้ง Surveillance Gateway Edge บน Windows ที่ลงด้วย install-windows.ps1 (docs/EDGE-KIT.md)
  เรียกผ่าน uninstall-windows.cmd (ขอสิทธิ์ admin ให้)

  ค่าตั้งต้น: หยุดระบบ ลบ Scheduled Task, firewall, โปรแกรม (app\, bin\) แต่ **เก็บ state\ ไว้**
  (vms.db = กล้อง + Global ID, edge.json = token, รหัสกล้อง, backups\) — ติดตั้งซ้ำทับได้ทันทีโดยได้ ID เดิม
  -RemoveData = ลบ state\ ด้วย (ถามยืนยันด้วยเลข edge ก่อน) · ลบแล้วกู้ไม่ได้

  ควรถอด edge นี้ที่หน้า Edge Nodes ของ Regional ก่อน — token จะใช้ไม่ได้ และกล้องหายจากชั้นบน
#>
param(
  [string]$Root = 'C:\GW-Edge',
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$state = Join-Path $Root 'state'
$stateJson = Join-Path $state 'edge.json'
$taskName = 'Gateway Edge'
$backupTask = 'Gateway Edge Backup'

function Say($msg) { Write-Host $msg }
function Fail($msg) { Write-Host ''; Write-Host "ถอนการติดตั้งไม่สำเร็จ: $msg" -ForegroundColor Red; exit 1 }

Say '=== Surveillance Gateway Edge — ถอนการติดตั้ง ==='
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'ต้องรันด้วยสิทธิ์ admin — ดับเบิลคลิก uninstall-windows.cmd' }
if (-not (Test-Path $Root) -and -not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  Fail "ไม่พบการติดตั้งที่ $Root — ถ้าติดตั้งที่อื่น ระบุ -Root"
}
$rootFull = (Resolve-Path $Root -ErrorAction SilentlyContinue).Path
if ($rootFull) {
  $isDriveRoot = $rootFull.TrimEnd('\') -eq [IO.Path]::GetPathRoot($rootFull).TrimEnd('\')
  $looksLikeEdge = (Test-Path (Join-Path $rootFull 'app\scripts\edge-run.cjs')) -or (Test-Path $stateJson)
  if ($isDriveRoot -or -not $looksLikeEdge) { Fail "$Root ไม่ใช่โฟลเดอร์ของ Surveillance Gateway Edge (ไม่พบ app\scripts\edge-run.cjs หรือ state\edge.json) — ไม่ลบ" }
}

$node = $null
if (Test-Path $stateJson) {
  try { $node = "$((Get-Content $stateJson -Raw -Encoding UTF8 | ConvertFrom-Json).node)" } catch { }
}
Say "เครื่องนี้: edge $(if ($node) { $node } else { '(ไม่ทราบเลข)' }) ที่ $Root"
Say 'ก่อนถอน: ถอด edge นี้ที่หน้า Edge Nodes ของ Regional แล้วหรือยัง? (ยังไม่ถอด = Regional ขึ้นสถานะ offline ค้างไว้)'
$ans = Read-Host 'พิมพ์ y เพื่อถอนการติดตั้งต่อ'
if ($ans -ne 'y') { Say 'ยกเลิก'; exit 0 }

$wipe = $false
if ($RemoveData) {
  Write-Host ''
  Write-Host "คำเตือน: -RemoveData จะลบ $state ถาวร — กล้อง, Global ID, รหัสกล้อง และ backup ทั้งหมดของเครื่องนี้ กู้คืนไม่ได้" -ForegroundColor Yellow
  $want = if ($node) { $node } else { 'DELETE' }
  $typed = Read-Host "พิมพ์ $want เพื่อยืนยันการลบข้อมูล (อย่างอื่น = เก็บข้อมูลไว้)"
  $wipe = ($typed -eq $want)
  if (-not $wipe) { Say 'ไม่ยืนยัน — จะเก็บ state\ ไว้' }
}

# ── 1. หยุดและลบ Scheduled Task ───────────────────────────────────────────────
foreach ($t in $taskName, $backupTask) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
    Say "ลบ Scheduled Task '$t' แล้ว"
  }
}

# ── 2. ปิด process ที่ค้าง (เฉพาะไฟล์ใน $Root — ไม่แตะโปรแกรมอื่น) ────────────────
$prefix = if ($rootFull) { $rootFull.TrimEnd('\') + '\' } else { $Root.TrimEnd('\') + '\' }
for ($i = 0; $i -lt 5; $i++) {
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if (-not $procs.Count) { break }
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
}
Say 'หยุดโปรแกรมแล้ว'

# ── 3. firewall ───────────────────────────────────────────────────────────────
Get-NetFirewallRule -DisplayName 'Gateway Edge*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Say 'ลบ firewall rule แล้ว'

# ── 4. ไฟล์ ───────────────────────────────────────────────────────────────────
if ($rootFull) {
  foreach ($sub in 'app', 'bin') {
    $p = Join-Path $rootFull $sub
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
  }
  Say 'ลบโปรแกรม (app\, bin\) แล้ว'
  if ($wipe) {
    # state\ ถูกล็อกให้ SYSTEM/Administrators ตอนติดตั้ง — ยึดสิทธิ์ก่อนลบ
    takeown /f $rootFull /r /d y | Out-Null
    icacls $rootFull /grant 'Administrators:(OI)(CI)F' /t /c /q | Out-Null
    Remove-Item $rootFull -Recurse -Force
    Say "ลบ $rootFull ทั้งโฟลเดอร์แล้ว"
  } else {
    Say "เก็บข้อมูลไว้ที่ $state (มี token และรหัสกล้อง — สิทธิ์อ่านเฉพาะ SYSTEM/Administrators)"
    Say "  ติดตั้งซ้ำ: รัน install-windows.cmd ได้เลย ได้กล้องและ Global ID เดิม · ลบทิ้ง: รันใหม่ด้วย -RemoveData"
  }
}

Write-Host ''
Write-Host 'ถอนการติดตั้งเสร็จ — ลบไฟล์ edge-<เลข>.json ใน flash drive ด้วย (มี token)' -ForegroundColor Green
