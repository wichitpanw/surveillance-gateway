<#
.SYNOPSIS
  เก็บกวาดชุดติดตั้ง/แพ็กเกจ edge รุ่นเก่า — ค่าเริ่มต้นแค่แสดงรายการ (dry-run) ลบจริงเมื่อส่ง -Apply เท่านั้น

.DESCRIPTION
  build-edge-kit.ps1 สร้างโฟลเดอร์ใหม่ทุกรอบ (D:\gw-edge-kits\GW-Edge-Kit-<build>, GW-Edge-Update-<build>, staging-*, pack-*)
  และชุดให้ดาวน์โหลดใน server\edge-kits\ — ไม่มีอะไรลบรุ่นเก่าใน D:\gw-edge-kits จึงโตขึ้นเรื่อย ๆ (~1.5 GB ต่อชุด -WithAi)

  เก็บเสมอ (ไม่แตะไม่ว่ากรณีใด):
    - D:\gw-edge-kits\signing   กุญแจเซ็นแพ็กเกจอัปเดต — หาย = edge ทุกตัวต้องอัปเดตด้วย flash drive (agents.md ข้อ 4)
    - D:\gw-edge-kits\cache     ไฟล์ node/ffmpeg/go2rtc/wheels ที่โหลดไว้ (ลบแล้วรอบหน้าต้องโหลดใหม่)
    - ไฟล์ .pem ทุกไฟล์
    - ชุดใน server\edge-kits ที่ kits.json ยังอ้างถึง (central กำลังเสิร์ฟให้ดาวน์โหลด) และตัว kits.json
  เก็บรุ่นใหม่สุด -Keep รุ่น (ค่าเริ่มต้น 2) ต่อกลุ่ม: GW-Edge-Kit-*, GW-Edge-Update-*, และต่อแพลตฟอร์มใน server\edge-kits
  staging-* / pack-* / app-*.tar.gz ที่ค้างจากรอบที่ล้มกลางทาง ลบได้ทั้งหมด

  รันจาก PowerShell แบบ Run as Administrator — server\edge-kits ถูกสร้างโดย shell admin (context.md)

.PARAMETER Keep
  จำนวนรุ่นล่าสุดที่เก็บไว้ต่อกลุ่ม (อย่างน้อย 1)
.PARAMETER Apply
  ลบจริง — ไม่ใส่ = แสดงรายการที่จะลบเท่านั้น
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\prune-edge-kits.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\prune-edge-kits.ps1 -Keep 3 -Apply
#>
param(
  [ValidateRange(1, 100)][int]$Keep = 2,
  [switch]$Apply,
  [string]$KitRoot = 'D:\gw-edge-kits',
  [string]$ServerKits = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $ServerKits) { $ServerKits = Join-Path $repo 'server\edge-kits' }
$protectedNames = @('signing', 'cache', 'kits.json')

# ขนาดรวมของไฟล์หรือโฟลเดอร์ (byte)
function Get-Size($item) {
  if ($item.PSIsContainer) { return [long](@(Get-ChildItem $item.FullName -Recurse -File -Force -ErrorAction SilentlyContinue) | Measure-Object Length -Sum).Sum }
  return [long]$item.Length
}

# ของที่ห้ามลบเด็ดขาด — ตรวจซ้ำตอนลบอีกรอบกันพลาดจากการแก้สคริปต์ภายหลัง
function Test-Protected($item) {
  if ($protectedNames -contains $item.Name) { return $true }
  if ($item.Name -like '*.pem') { return $true }
  # โฟลเดอร์ที่มีกุญแจลับ (.pem ที่ไม่ใช่ *.pub.pem) — ทุกชุดมี public key edge-update.pub.pem อยู่แล้ว ตัวนั้นไม่นับ
  if ($item.PSIsContainer -and @(Get-ChildItem $item.FullName -Recurse -Filter *.pem -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.pub.pem' }).Count -gt 0) { return $true }
  return $false
}

$doomed = New-Object System.Collections.ArrayList

# ── D:\gw-edge-kits ────────────────────────────────────────────────────────────
if (Test-Path $KitRoot) {
  $items = @(Get-ChildItem $KitRoot -Force | Where-Object { -not (Test-Protected $_) })
  foreach ($prefix in 'GW-Edge-Kit-', 'GW-Edge-Update-') {
    $group = @($items | Where-Object { $_.PSIsContainer -and $_.Name.StartsWith($prefix) } | Sort-Object LastWriteTime -Descending)
    foreach ($old in @($group | Select-Object -Skip $Keep)) { [void]$doomed.Add($old) }
  }
  # ของค้างจากรอบที่ล้มกลางทาง (build-edge-kit.ps1 ลบเองเมื่อสำเร็จ)
  foreach ($leftover in @($items | Where-Object { $_.Name -like 'staging-*' -or $_.Name -like 'pack-*' -or ((-not $_.PSIsContainer) -and $_.Name -like 'app-*.tar.gz*') })) {
    [void]$doomed.Add($leftover)
  }
} else {
  Write-Host "ไม่พบ $KitRoot — ข้าม"
}

# ── server\edge-kits (ชุดให้ดาวน์โหลดจากหน้า Edge Nodes) ─────────────────────
if (Test-Path $ServerKits) {
  $served = @()
  $kitsJson = Join-Path $ServerKits 'kits.json'
  if (Test-Path $kitsJson) {
    try { $served = @(@(Get-Content $kitsJson -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_.file } | Where-Object { $_ }) }
    catch { throw "อ่าน $kitsJson ไม่ได้ ($($_.Exception.Message)) — ไม่ลบอะไรใน server\edge-kits" }
  }
  $files = @(Get-ChildItem $ServerKits -File -Force | Where-Object { -not (Test-Protected $_) -and $served -notcontains $_.Name -and $_.Name -match '^GW-Edge-(.+)-[0-9a-f]{7,}\.(zip|tar\.gz)$' })
  foreach ($platform in @($files | ForEach-Object { if ($_.Name -match '^GW-Edge-(.+)-[0-9a-f]{7,}\.(zip|tar\.gz)$') { $Matches[1] } } | Sort-Object -Unique)) {
    $group = @($files | Where-Object { $_.Name -match "^GW-Edge-$([regex]::Escape($platform))-[0-9a-f]{7,}\." } | Sort-Object LastWriteTime -Descending)
    # ชุดที่ kits.json อ้างถึงนับเป็นรุ่นที่เก็บอยู่แล้ว — จึงเก็บเพิ่มอีก Keep-1 รุ่น
    foreach ($old in @($group | Select-Object -Skip ([Math]::Max(0, $Keep - 1)))) { [void]$doomed.Add($old) }
  }
} else {
  Write-Host "ไม่พบ $ServerKits — ข้าม"
}

# ── สรุป / ลบ ─────────────────────────────────────────────────────────────────
if ($doomed.Count -eq 0) {
  Write-Host "ไม่มีอะไรต้องลบ (เก็บ $Keep รุ่นล่าสุดต่อกลุ่ม)" -ForegroundColor Green
  return
}
$total = 0L
Write-Host ("{0} (เก็บ {1} รุ่นล่าสุดต่อกลุ่ม · signing / cache / .pem / ชุดใน kits.json ไม่แตะ):" -f $(if ($Apply) { 'ลบ' } else { 'จะลบ (dry-run)' }), $Keep)
foreach ($d in $doomed) {
  $size = Get-Size $d
  $total += $size
  Write-Host ("  {0,10:N0} MB  {1:yyyy-MM-dd HH:mm}  {2}" -f ($size / 1MB), $d.LastWriteTime, $d.FullName)
}
Write-Host ("รวม {0:N0} MB" -f ($total / 1MB))

if (-not $Apply) {
  Write-Host 'dry-run: ยังไม่ได้ลบอะไร — รันซ้ำด้วย -Apply เพื่อลบจริง' -ForegroundColor Yellow
  return
}
$failed = 0
foreach ($d in $doomed) {
  if (Test-Protected $d) { Write-Host "  ข้าม (ของที่ห้ามลบ): $($d.FullName)" -ForegroundColor Yellow; continue }
  try { Remove-Item -LiteralPath $d.FullName -Recurse -Force -Confirm:$false }
  catch { $failed++; Write-Host "  ลบไม่ได้: $($d.FullName) — $($_.Exception.Message)" -ForegroundColor Red }
}
if ($failed) { Write-Host "ลบไม่สำเร็จ $failed รายการ (shell ไม่ได้ยกสิทธิ์?)" -ForegroundColor Red; exit 1 }
Write-Host 'เสร็จ' -ForegroundColor Green
