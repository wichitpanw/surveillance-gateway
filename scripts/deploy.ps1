<#
.SYNOPSIS
  Deploy ครบในคำสั่งเดียว: backup → restart Central + Regional → รอจน /api/instance เป็น build ใหม่ →
  build หน้าเว็บ → เผยแพร่แพ็กเกจอัปเดตให้ edge แบบ link → ปล่อย Windows client (ถ้าสั่ง)

.DESCRIPTION
  ทำไมต้องมี: เดิม deploy กับ publish เป็นสองขั้นแยกกัน รอบ d8fd9d6 / 20291cb / 25e75ef (2026-09-28) restart แล้วแต่ลืม publish
  edge 002 จึงค้างที่ a934d0f ทั้งที่ central ไปไกลแล้ว · edge 001 อยู่เครื่องเดียวกันรันจาก repo ตรง จึงไม่เห็นปัญหา

  publish ครั้งเดียวต่อรุ่นก็พอ: edge ที่ออนไลน์ได้ข้อเสนอภายใน 5 นาที ที่ออฟไลน์ได้ทันทีที่กลับมาต่อสาย
  ข้ามการ publish อัตโนมัติถ้ารุ่นนี้ publish ไว้แล้ว

  ลำดับตาม AGENTS.md ข้อ 4: restart backend ก่อน build หน้าเว็บ — dist มีผลทันทีไม่ต้อง restart ถ้า build ก่อน
  หน้าเว็บใหม่จะเรียก route ที่ backend รุ่นเก่ายังไม่มีระหว่างรอ restart

  รันจาก PowerShell แบบ Run as Administrator เท่านั้น (pm2 daemon รันแบบ elevated — AGENTS.md ข้อ 5)
  ใช้ pm2 ตัวเดียวกับ Scheduled Task ตอนบูต (scripts\start-gateway.cmd): node + D:\gw-pm2\npm\...\pm2 กับ PM2_HOME=D:\gw-pm2\home

.PARAMETER ReloadEdgeConfig
  แก้ D:\gateway-edge\edge.json มา (centralUrls / publicHost ฯลฯ) หรือแก้ ecosystem.edge.config.cjs
  — pm2 restart ไม่อ่าน env ใหม่ จึง delete แล้ว start แทน
.PARAMETER ReloadRegionalConfig
  แก้ D:\gateway-regional\regional.json มา — pm2 restart ไม่อ่าน env ใหม่ จึง delete แล้ว start แทน
.PARAMETER Pm2
  entry point ของ pm2 (ไฟล์ bin/pm2 ที่รันด้วย node) หรือ pm2.cmd — ค่าเริ่มต้นตรงกับ start-gateway.cmd
.PARAMETER ReleaseClient
  ปล่อย Windows client ด้วย (scripts\build-client-release.ps1) เมื่อ <Version> ใน csproj ใหม่กว่ารุ่นที่ release ไว้
.PARAMETER InstallDependencies
  หลัง backup หยุด backend แล้วติดตั้ง server/root ตาม lockfile (ใช้เมื่อ dependency เปลี่ยน)
.PARAMETER SkipBackup
  ไม่ backup (ใช้เมื่อเพิ่ง backup ไปแล้ว)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\deploy.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\deploy.ps1 -ReloadEdgeConfig -ReleaseClient
#>
param(
  [switch]$ReloadEdgeConfig,
  [switch]$ReloadRegionalConfig,
  [switch]$ReleaseClient,
  [switch]$SkipBackup,
  [switch]$InstallDependencies,
  # ตัวเดียวกับ scripts\start-gateway.cmd (Scheduled Task ตอนบูต) — เดิมใช้ pm2.cmd ใน profile Administrator
  # ซึ่งเป็นคนละรุ่นกับตัวที่บูต (audit 2026-09-29)
  [string]$Pm2 = 'D:\gw-pm2\npm\node_modules\pm2\bin\pm2',
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [string]$Central = 'http://127.0.0.1:5173',
  [string]$Edge = 'http://127.0.0.1:5273',
  [string]$Regional = 'http://127.0.0.1:5273'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
# ตรวจ runtime ของ build ก่อนสร้างชุดติดตั้งหรือ restart service
& node (Join-Path $PSScriptRoot 'check-build-runtime.cjs')
if ($LASTEXITCODE) { throw 'Node ของ shell ไม่รองรับ build — ต้องใช้ ^20.19.0 หรือ >=22.12.0' }
function Step($msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ''; Write-Host "deploy ไม่สำเร็จ: $msg" -ForegroundColor Red; exit 1 }
# เรียก pm2 แบบเดียวกับ start-gateway.cmd (node + entry point ไม่ผ่าน shim .cmd) · ส่ง -Pm2 เป็น .cmd ก็ยังใช้ได้
function Invoke-Pm2 {
  if ($Pm2 -like '*.cmd') { & $Pm2 @args } else { & $Node $Pm2 @args }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'ต้องรันจาก PowerShell แบบ Run as Administrator — shell ธรรมดาจะไปสร้าง pm2 daemon เปล่าตัวใหม่ (AGENTS.md ข้อ 5)' }
if (-not (Test-Path $Pm2)) { Fail "ไม่พบ pm2 ที่ $Pm2 — ส่ง -Pm2 <path>" }
if ($Pm2 -notlike '*.cmd' -and -not (Test-Path $Node)) { Fail "ไม่พบ node ที่ $Node — ส่ง -Node <path>" }
# pm2 คำนวณ path ของ log ฝั่ง CLI จาก PM2_HOME — ไม่ตั้งแล้ว log ของแอปที่ start ใหม่ไปอยู่ ~\.pm2\logs
$env:PM2_HOME = 'D:\gw-pm2\home'

Push-Location $repo
try {
  $regionalConfig = 'D:\gateway-regional\regional.json'
  $hasRegional = Test-Path $regionalConfig
  $provincialConfig = 'D:\gateway-provincial\edge.json'
  $hasProvincial = Test-Path $provincialConfig
  if ($hasProvincial -and -not $PSBoundParameters.ContainsKey('Edge')) {
    $edgeSettings = Get-Content $provincialConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$edgeSettings.port -ne 5373) { Fail "$provincialConfig ต้องใช้พอร์ต 5373" }
    $Edge = 'http://127.0.0.1:5373'
  }
  if ($hasRegional) {
    $regionalSettings = Get-Content $regionalConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($regionalSettings.role -ne 'regional') { Fail "$regionalConfig ต้องมี role regional" }
    if ([int]$regionalSettings.port -ne 5273) { Fail "$regionalConfig ต้องใช้พอร์ต 5273" }
    if (-not $PSBoundParameters.ContainsKey('Regional')) { $Regional = "http://127.0.0.1:$($regionalSettings.port)" }
    if ($hasProvincial -and $Regional -eq $Edge) { Fail "Regional และ Edge ใช้ที่อยู่ $Edge ซ้ำกัน" }
  }
  # นิยาม build: ต้องตรงกับ BUILD_PATHS ใน server/shared/instance.js (ต้นฉบับ) ทุกตัว
  $buildPaths = @('server', 'src', 'scripts', 'package.json', 'ecosystem.edge.config.cjs')
  $expected = (git log -1 --format=%h -- @buildPaths).Trim()
  $dirty = git status --porcelain -- @buildPaths ecosystem.windows.config.cjs
  if ($dirty) {
    # production รันไฟล์บนดิสก์ — ของที่แก้ค้างจะขึ้นจริงด้วย แต่ build ที่แสดงยังเป็น commit เดิม (AGENTS.md หัวข้อ worktree)
    Write-Host 'คำเตือน: มีไฟล์ที่ยังไม่ commit — production จะรันไฟล์เหล่านี้ด้วย:' -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "   $_" -ForegroundColor Yellow }
  }
  Write-Host "deploy build $expected (commit ล่าสุดที่แก้ $($buildPaths -join ' '))"

  if (-not $SkipBackup) {
    Step 'backup'
    & (Join-Path $repo 'backup-windows.ps1')
    if (-not $?) { Fail 'backup ไม่สำเร็จ — ไม่ deploy ต่อ' }
  }

  if ($InstallDependencies) {
    # native module ต้องไม่ถูกโหลดอยู่ระหว่าง npm ci; ห้ามลง dependency ผ่าน junction
    foreach ($dir in @((Join-Path $repo 'node_modules'), (Join-Path $repo 'server\node_modules'))) {
      if ((Test-Path $dir) -and ((Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Fail "ห้าม npm ci ลง junction/reparse point: $dir"
      }
    }
    Step 'หยุด backend ก่อนติดตั้ง dependency ตาม lockfile'
    Invoke-Pm2 stop 2-vms-backend | Out-Null
    if ($LASTEXITCODE) { Fail 'หยุด Central ไม่สำเร็จ — ยังไม่ติดตั้ง dependency' }
    if ($hasRegional) {
      Invoke-Pm2 stop 3-regional-gateway | Out-Null
      if ($LASTEXITCODE) { Fail 'หยุด Regional ไม่สำเร็จ — Central หยุดอยู่; ยังไม่ติดตั้ง dependency' }
    }
    if (-not $hasRegional) {
      Invoke-Pm2 stop 3-edge-gateway | Out-Null
      if ($LASTEXITCODE) { Fail 'หยุด Edge เดิมไม่สำเร็จ — ยังไม่ติดตั้ง dependency' }
    }
    if ($hasProvincial) {
      Invoke-Pm2 stop 3-provincial-gateway | Out-Null
      if ($LASTEXITCODE) { Fail 'หยุด Edge จังหวัดไม่สำเร็จ — ยังไม่ติดตั้ง dependency' }
    }
    Step 'ติดตั้ง backend dependency'
    Push-Location (Join-Path $repo 'server')
    try {
      npm ci --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE) { Fail 'npm ci backend ไม่สำเร็จ — backend ยังหยุดอยู่; แก้การติดตั้งแล้วรัน deploy ซ้ำ ห้าม restart ด้วย native module ที่ติดตั้งไม่ครบ' }
      & $Node -e "require('sqlite3'); require('axios'); require('express'); require('multer'); console.log('Backend dependency smoke OK')"
      if ($LASTEXITCODE) { Fail 'dependency/native smoke ไม่ผ่าน — backend ยังหยุดอยู่' }
    } finally { Pop-Location }
    Step 'ติดตั้ง web build dependency'
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE) { Fail 'npm ci เว็บไม่สำเร็จ — backend ยังหยุดอยู่; แก้การติดตั้งแล้วรัน deploy ซ้ำ' }
  }
  Step 'restart central (2-vms-backend)'
  Invoke-Pm2 restart 2-vms-backend | Out-Null
  if ($LASTEXITCODE) { Fail 'pm2 restart 2-vms-backend ไม่สำเร็จ' }

  Step 'Edge บนโฮสต์'
  # pm2 พิมพ์คำเตือน "In-memory PM2 is out-of-date" ปนมาได้ — เอาเฉพาะบรรทัด JSON แล้วให้ node อ่าน
  # (ConvertFrom-Json ของ PowerShell 5.1 ล้มเพราะ env ใน jlist มีทั้ง username และ USERNAME — เจอจริง 2026-09-28)
  $jl = @(Invoke-Pm2 jlist 2>$null) | Where-Object { $_ -match '^\s*\[' } | Select-Object -Last 1
  $running = @(if ($jl) { $jl | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s).forEach(a=>console.log(a.name)))" })
  # ถอน process inference เดิมออกจาก daemon ก่อนเริ่ม gateway รุ่นใหม่
  foreach ($retired in '4-edge-ai', '4-provincial-ai') {
    if ($running -contains $retired) {
      Invoke-Pm2 delete $retired | Out-Null
      if ($LASTEXITCODE) { Fail "ถอน $retired ไม่สำเร็จ" }
    }
  }
  if (-not $hasRegional) {
    # ก่อน M2: Edge เดิม :5273 ยังอยู่ (M1 มี Edge จังหวัดใหม่ :5373 เพิ่มเข้ามา)
    $legacyApps = @('3-edge-gateway')
    if (-not $hasProvincial -and $ReloadEdgeConfig) {
      foreach ($app in '3-edge-gateway') { if ($running -contains $app) { Invoke-Pm2 delete $app | Out-Null } }
      Invoke-Pm2 start (Join-Path $repo 'ecosystem.edge.config.cjs') --only '3-edge-gateway' | Out-Null
    } else {
      Invoke-Pm2 restart @legacyApps | Out-Null
    }
    if ($LASTEXITCODE) { Fail 'Edge เดิม restart/start ไม่สำเร็จ' }
  } elseif ($running -contains '3-edge-gateway' -or $running -contains '1-go2rtc-edge') {
    Fail 'Edge เดิม :5273 ยังอยู่ — หยุดตาม M2 ก่อนเปิด Regional ที่พอร์ตเดียวกัน'
  }

  if ($hasProvincial) {
    $provincialApps = @('1-go2rtc-provincial', '3-provincial-gateway')
    if ($ReloadEdgeConfig) {
      foreach ($app in $provincialApps) { if ($running -contains $app) { Invoke-Pm2 delete $app | Out-Null } }
      Invoke-Pm2 start (Join-Path $repo 'ecosystem.provincial.config.cjs') | Out-Null
    } elseif ($running -contains '1-go2rtc-provincial' -and $running -contains '3-provincial-gateway') {
      Invoke-Pm2 restart @provincialApps | Out-Null
    } else {
      Invoke-Pm2 start (Join-Path $repo 'ecosystem.provincial.config.cjs') | Out-Null
    }
    if ($LASTEXITCODE) { Fail 'Edge จังหวัด restart/start ไม่สำเร็จ' }
  }

  if ($hasRegional) {
    Step 'Regional'
    $regionalApps = @('1-go2rtc-regional', '3-regional-gateway')
    if ($ReloadRegionalConfig) {
      foreach ($app in $regionalApps) { if ($running -contains $app) { Invoke-Pm2 delete $app | Out-Null } }
      Invoke-Pm2 start (Join-Path $repo 'ecosystem.regional.config.cjs') | Out-Null
    } elseif (@($regionalApps | Where-Object { $running -contains $_ }).Count -eq 2) {
      Invoke-Pm2 restart @regionalApps | Out-Null
    } else {
      Invoke-Pm2 start (Join-Path $repo 'ecosystem.regional.config.cjs') | Out-Null
    }
    if ($LASTEXITCODE) { Fail 'Regional restart/start ไม่สำเร็จ' }
  }

  Step "ตรวจว่า Central, Edge และ Regional ที่ตั้งไว้รัน $expected"
  $deadline = (Get-Date).AddSeconds(90)
  $ok = @{}
  $urls = @($Central) + @(if ($hasRegional) { $Regional; if ($hasProvincial) { $Edge } } else { $Edge; if ($hasProvincial) { 'http://127.0.0.1:5273' } })
  while ((Get-Date) -lt $deadline -and $ok.Count -lt $urls.Count) {
    foreach ($u in $urls) {
      if ($ok[$u]) { continue }
      try { if ((Invoke-RestMethod "$u/api/instance" -TimeoutSec 3).build -eq $expected) { $ok[$u] = $true; Write-Host "   $u ✓" } } catch { }
    }
    if ($ok.Count -lt $urls.Count) { Start-Sleep -Seconds 2 }
  }
  if ($ok.Count -lt $urls.Count) { Fail "ภายใน 90 วิ ยังไม่เห็น build $expected ที่ $(@($urls | Where-Object { -not $ok[$_] }) -join ', ') — ดู pm2 logs" }

  # หน้าเว็บหลัง backend ขึ้นรุ่นใหม่แล้ว (AGENTS.md ข้อ 4) — dist มีผลทันทีทั้ง central และ edge
  Step 'หน้าเว็บ (npm run build)'
  npm run build --silent
  if ($LASTEXITCODE) { Fail 'npm run build ไม่สำเร็จ — backend ขึ้นรุ่นใหม่แล้วแต่หน้าเว็บยังเป็น dist เดิม แก้แล้วรัน npm run build' }

  # publish หลังตรวจ build: แพ็กเกจที่ออกไปคือรุ่นที่ central/edge 001 ขึ้นได้จริงแล้ว
  # edge แบบ link ที่ต่อกลับมาระหว่าง restart อาจได้ข้อเสนอรุ่นเดิมก่อน — ได้รุ่นใหม่ในรอบตรวจถัดไป (ไม่เกิน 5 นาที)
  Step 'เผยแพร่แพ็กเกจอัปเดตให้ edge แบบ link'
  node (Join-Path $repo 'scripts\verify-edge-release.cjs') $expected
  if ($LASTEXITCODE -eq 0) {
    Write-Host "   รุ่น $expected เผยแพร่ไว้แล้ว — ข้าม"
  } else {
    & (Join-Path $repo 'scripts\build-edge-kit.ps1') -UpdatesOnly
    if (-not $?) { Fail 'เผยแพร่แพ็กเกจอัปเดตไม่สำเร็จ — central และ edge 001 ขึ้นรุ่นใหม่แล้ว แต่ edge แบบ link ยังไม่ได้ข้อเสนอ แก้แล้วรัน build-edge-kit.ps1 -UpdatesOnly' }
  }
  node (Join-Path $repo 'scripts\verify-edge-release.cjs') $expected
  if ($LASTEXITCODE -ne 0) { Fail 'แพ็กเกจอัปเดตไม่ครบหรือไม่ผ่านการตรวจ — ยังถือว่า deploy ไม่สำเร็จ' }

  # Windows client: เตือนเมื่อ csproj ใหม่กว่ารุ่นที่ release (ลืมขั้นนี้แล้วไม่มีเครื่องไหนได้อัปเดต — docs/CLIENT-RELEASES.md)
  $csVer = ([xml](Get-Content (Join-Path $repo 'client-windows\SurveillanceGateway.Client\SurveillanceGateway.Client.csproj'))).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
  $feed = Join-Path $repo 'client-updates\releases.win.json'
  $relVer = if (Test-Path $feed) { @((Get-Content $feed -Raw | ConvertFrom-Json).Assets | ForEach-Object { [version]$_.Version } | Sort-Object)[-1] } else { $null }
  if ($relVer -and [version]$csVer -gt $relVer) {
    if ($ReleaseClient) {
      Step "ปล่อย Windows client $csVer"
      & (Join-Path $repo 'scripts\build-client-release.ps1')
      if (-not $?) { Fail 'build-client-release.ps1 ไม่สำเร็จ' }
    } else {
      Write-Host ''
      Write-Host "หมายเหตุ: Windows client $csVer ยังไม่ release (feed มีถึง $relVer) — รันซ้ำด้วย -ReleaseClient" -ForegroundColor Yellow
    }
  }

  Write-Host ''
  Write-Host "deploy $expected เสร็จ — Regional ซิงก์และ Edge ตรวจแพ็กเกจทุก 1 นาที (ต้องรอโหลดครบก่อนติดตั้ง)" -ForegroundColor Green
} finally {
  Pop-Location
}
