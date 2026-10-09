<#
  ติดตั้ง / อัปเดต Surveillance Gateway Edge บน Windows x64 จากชุด flash drive (docs/EDGE-KIT.md)
  เรียกผ่าน install-windows.cmd (ขอสิทธิ์ admin ให้) — ไม่ต้องใช้ internet

  ครั้งแรก: ต้องมีไฟล์ edge-<เลข>.json ที่ดาวน์โหลดจากหน้า Edge Nodes ของ central วางไว้ข้างไฟล์นี้หรือที่ราก flash drive
  รันซ้ำ   : อัปเดตโปรแกรม (app\, bin\) ไม่แตะข้อมูลใน state\ · มีไฟล์ edge-*.json ใหม่ = อัปเดตค่าจากไฟล์นั้นด้วย

  -Root / -Port / -Go2rtcApi / -Go2rtcRtsp / -DryRun ใช้ทดสอบบนเครื่องที่มีระบบอื่นใช้พอร์ตอยู่
  (-DryRun = ไม่ตั้ง firewall/Scheduled Task ไม่เริ่มระบบ ไม่ลบไฟล์ edge.json)
#>
param(
  [string]$Root = 'C:\GW-Edge',
  [int]$Port = 5173,
  [int]$Go2rtcApi = 1984,
  [int]$Go2rtcRtsp = 8555,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$kit = $PSScriptRoot
$plat = Join-Path $kit 'windows-x64'
$state = Join-Path $Root 'state'
$stateJson = Join-Path $state 'edge.json'
$taskName = 'Gateway Edge'
$backupTask = 'Gateway Edge Backup'

function Say($msg) { Write-Host $msg }
function Fail($msg) { Write-Host ''; Write-Host "ติดตั้งไม่สำเร็จ: $msg" -ForegroundColor Red; exit 1 }
# JSON ต้องไม่มี BOM — node อ่าน edge.json ด้วย JSON.parse ซึ่งไม่รับ BOM (Set-Content ของ PowerShell 5.1 ใส่ให้)
function Write-Json($path, $obj) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false)) }

Say '=== Surveillance Gateway Edge — ติดตั้งจาก flash drive ==='
if (-not (Test-Path (Join-Path $plat 'bin\node.exe'))) { Fail "ไม่พบ $plat\bin\node.exe — ชุดติดตั้งไม่ครบ ก๊อปใหม่ทั้งโฟลเดอร์" }
if (-not $DryRun) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Fail 'ต้องรันด้วยสิทธิ์ admin — ดับเบิลคลิก install-windows.cmd' }
}

# ── 1. ไฟล์ตั้งค่าจาก central ──────────────────────────────────────────────────
$driveRoot = [IO.Path]::GetPathRoot($kit)
$files = @(Get-ChildItem -Path $kit, $driveRoot -Filter 'edge-*.json' -File -ErrorAction SilentlyContinue | Sort-Object FullName -Unique)
$installed = Test-Path $stateJson
$pick = $null
if ($files.Count -eq 1) { $pick = $files[0] }
elseif ($files.Count -gt 1) {
  Say 'พบไฟล์ตั้งค่าหลายไฟล์:'
  for ($i = 0; $i -lt $files.Count; $i++) { Say ("  [{0}] {1}" -f ($i + 1), $files[$i].Name) }
  $n = Read-Host 'เลือกหมายเลขไฟล์ของเครื่องนี้'
  if (-not ($n -match '^\d+$') -or [int]$n -lt 1 -or [int]$n -gt $files.Count) { Fail 'เลือกไม่ถูกต้อง' }
  $pick = $files[[int]$n - 1]
}
if (-not $pick -and -not $installed) {
  Fail 'ไม่พบไฟล์ edge-<เลข>.json — ที่ central เปิด Edge Nodes → Add Edge → "Edge ต่อขึ้นมาเอง" → ออก token → ดาวน์โหลดไฟล์ แล้ววางไว้ที่ราก flash drive'
}
$fromCentral = $null
if ($pick) {
  try { $fromCentral = Get-Content $pick.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail "อ่าน $($pick.Name) ไม่ได้: $($_.Exception.Message)" }
  if (-not ("$($fromCentral.node)" -match '^\d{3}$')) { Fail "$($pick.Name) ไม่มีเลข edge 3 หลัก" }
  if ($fromCentral.role -eq 'regional' -and (("$($fromCentral.node)" -notmatch '^[1-6]00$') -or ($fromCentral.region -notin @('central','north','northeast','east','west','south')))) {
    Fail "$($pick.Name) ระบุ Regional node/region ไม่ถูกต้อง"
  }
  if ($fromCentral.role -and $fromCentral.role -notin @('edge','regional')) { Fail "$($pick.Name) ระบุ role ไม่ถูกต้อง" }
  if (-not $fromCentral.centralToken -or -not $fromCentral.centralUrls) { Fail "$($pick.Name) ไม่มี centralToken / centralUrls — ดาวน์โหลดใหม่จาก central" }
  Say "ไฟล์ตั้งค่า: $($pick.FullName) (edge $($fromCentral.node))"
}
if ($installed) { Say "พบการติดตั้งเดิมที่ $Root — จะอัปเดตโปรแกรม ข้อมูลใน state\ ไม่ถูกแตะ" }

# ── 2. หยุดของเดิม แล้วก๊อปโปรแกรม ────────────────────────────────────────────
if (-not $DryRun -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  Say 'หยุด Edge ตัวเดิม…'
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep 3
}
New-Item -ItemType Directory -Force $Root, $state | Out-Null
foreach ($sub in 'app', 'bin') {
  Say "ก๊อป $sub\ …"
  robocopy (Join-Path $plat $sub) (Join-Path $Root $sub) /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "ก๊อป $sub\ ไม่สำเร็จ (robocopy $LASTEXITCODE) — ถ้าโปรแกรมยังเปิดอยู่ ให้รีสตาร์ทเครื่องแล้วรันใหม่" }
}
$node = Join-Path $Root 'bin\node.exe'
$build = (Get-Content (Join-Path $Root 'app\BUILD') -ErrorAction SilentlyContinue | Select-Object -First 1)

# ── 3. edge.json ของเครื่องนี้ ────────────────────────────────────────────────
# ลำดับ: ค่าเดิม (อัปเดต) → ค่าจากไฟล์ของ central → ค่าที่ขึ้นกับเครื่องนี้ (ทับเสมอ)
$cfg = [ordered]@{}
if ($installed) { (Get-Content $stateJson -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } }
if ($fromCentral) {
  foreach ($k in 'node', 'province', 'label', 'centralToken', 'role', 'region') { if ($null -ne $fromCentral.$k) { $cfg[$k] = $fromCentral.$k } }
  $cfg['centralUrls'] = @($fromCentral.centralUrls)   # คง array แม้มีที่อยู่เดียว
  $cfg.Remove('centralUrl')
}
if (-not $cfg['publicHost']) {
  $ip = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
  $cfg['publicHost'] = if ($ip) { $ip } else { '' }
}
$cfg['stateDir'] = $state
$cfg['port'] = $Port
$cfg['go2rtcApi'] = $Go2rtcApi
$cfg['go2rtcRtsp'] = $Go2rtcRtsp
$cfg['go2rtcBin'] = Join-Path $Root 'bin\go2rtc.exe'
$cfg['ffmpeg'] = Join-Path $Root 'bin\ffmpeg.exe'
# ถอดค่าของ inference เดิมโดยคงค่าแหล่งรับและกล้องไว้
foreach ($key in 'aiWorker', 'aiPython', 'aiModel', 'aiGpu') { $cfg.Remove($key) }
Write-Json $stateJson $cfg
# token อยู่ในไฟล์นี้ — ให้อ่านได้แค่ SYSTEM กับ Administrators
if (-not $DryRun) { icacls $state /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null }
Say "edge.json: edge $($cfg['node']) · เว็บ :$Port · go2rtc :$Go2rtcApi/:$Go2rtcRtsp · publicHost $($cfg['publicHost'])"

# go2rtc.yaml + บัญชี RTSP ของ edge (สคริปต์เดิม ไม่ทับไฟล์ที่มีอยู่)
$env:GW_EDGE_CONFIG = $stateJson
$env:PATH = "$(Join-Path $Root 'bin');$env:PATH"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'app\scripts\setup-edge.ps1') | Out-Null
if ($LASTEXITCODE) { Fail 'สร้าง go2rtc.yaml ไม่สำเร็จ' }

if ($DryRun) {
  Say ''
  Say "DryRun: ไฟล์พร้อมที่ $Root — เริ่มเองด้วย: `"$node`" `"$Root\app\scripts\edge-run.cjs`" --config `"$stateJson`""
  exit 0
}

# ── 4. firewall ───────────────────────────────────────────────────────────────
# เว็บของ edge (แอดกล้อง) + คำตอบ ONVIF discovery ที่วิ่งกลับมาหา node.exe · สาย link เป็นขาออกทั้งหมด
$rules = @(
  @{ DisplayName = "Gateway Edge web (TCP $Port)"; Protocol = 'TCP'; LocalPort = "$Port" },
  @{ DisplayName = 'Gateway Edge ONVIF discovery (UDP)'; Protocol = 'UDP'; Program = $node }
)
foreach ($r in $rules) {
  Get-NetFirewallRule -DisplayName $r.DisplayName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule @r -Direction Inbound -Action Allow -Profile Any | Out-Null
}
Say 'ตั้ง firewall แล้ว'

# ── 5. Scheduled Task: เริ่มตอนบูต + backup ทุกคืน ─────────────────────────────
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$run = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\app\scripts\edge-run.cjs`" --config `"$stateJson`"" -WorkingDirectory "$Root\app"
Register-ScheduledTask -TaskName $taskName -Action $run -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
$bak = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\app\scripts\edge-backup.cjs`" --config `"$stateJson`"" -WorkingDirectory "$Root\app"
Register-ScheduledTask -TaskName $backupTask -Action $bak -Trigger (New-ScheduledTaskTrigger -Daily -At '02:00') -Principal $principal `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries) -Force | Out-Null
Say "ตั้ง Scheduled Task '$taskName' (ตอนบูต) และ '$backupTask' (ตีสอง) แล้ว"

# ── 6. เริ่มและตรวจ ────────────────────────────────────────────────────────────
Start-ScheduledTask -TaskName $taskName
Say 'เริ่มระบบ รอสักครู่…'
$inst = $null
for ($i = 0; $i -lt 30 -and -not $inst; $i++) {
  Start-Sleep 2
  try { $inst = Invoke-RestMethod "http://127.0.0.1:$Port/api/instance" -TimeoutSec 3 } catch { }
}
if (-not $inst) { Fail "ระบบไม่ตอบที่ :$Port ภายใน 60 วินาที — ดู log ที่ $state\logs\" }
Say "ระบบทำงานแล้ว: edge $($inst.node) · build $($inst.build)$(if ($build -and $inst.build -ne $build) { " (ชุดติดตั้ง $build)" })"
Start-Sleep 5
$linkLine = Get-Content (Join-Path $state 'logs\3-edge-gateway.log') -Tail 200 -ErrorAction SilentlyContinue | Select-String 'Edge link' | Select-Object -Last 1
if ($linkLine) { Say "สาย link: $($linkLine.Line)" } else { Say 'สาย link: ยังไม่มีข้อความ — ดูที่หน้า Edge Nodes ของ central ว่าขึ้น Online หรือไม่' }

# ── 7. เก็บกวาด ───────────────────────────────────────────────────────────────
if ($pick) {
  Remove-Item $pick.FullName -Force -ErrorAction SilentlyContinue
  Say "ลบ $($pick.Name) ออกจาก flash drive แล้ว (มี token)"
}
Say ''
Say "เสร็จ — เปิด http://$($cfg['publicHost']):$Port/ เพื่อแอดกล้อง"
if (-not $installed) { Write-Host 'เข้าครั้งแรกด้วย superadmin / superadmin แล้วเปลี่ยนรหัสผ่านทันที' -ForegroundColor Yellow }
