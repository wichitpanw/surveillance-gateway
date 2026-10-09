<#
  สร้างชุดติดตั้ง Edge แบบ flash drive (offline) — docs/EDGE-KIT.md
  รันบน HOST (ต้องใช้ internet ตอนสร้างเท่านั้น · ไฟล์ที่โหลดเก็บ cache ไว้ รอบหน้าไม่โหลดซ้ำ)

    powershell -ExecutionPolicy Bypass -File scripts\build-edge-kit.ps1 [-Platforms windows-x64,linux-arm64] [-Out D:\gw-edge-kits]

  ผลลัพธ์: <Out>\Edge-Kit-<build>\ — ก๊อปทั้งโฟลเดอร์ลง flash drive
    install-windows.cmd / install-windows.ps1 / install-linux.sh / README-TH.txt
    <แพลตฟอร์ม>\app   โค้ด server + scripts + ecosystem จาก commit ปัจจุบัน, dist ที่ build ใหม่, node_modules, BUILD
    <แพลตฟอร์ม>\bin   node, ffmpeg, go2rtc ของแพลตฟอร์มนั้น

  build = commit ล่าสุดที่แก้ server src scripts package.json ecosystem.edge.config.cjs
  (ต้นฉบับคือ BUILD_PATHS ใน server/shared/instance.js · deploy.ps1 และ deploy-edge.sh ใช้ชุดเดียวกัน) — central เทียบเลขนี้
  โค้ดมาจาก commit (git archive) ไม่ใช่ไฟล์ที่ยังไม่ commit · หน้าเว็บ build จาก src/ ปัจจุบัน
#>
param(
  [string]$Out = 'D:\gw-edge-kits',
  [string[]]$Platforms = @('windows-x64', 'linux-arm64', 'linux-x64'),
  # เผยแพร่เป็นแพ็กเกจอัปเดตผ่านสาย link ด้วย: เซ็น app ของแต่ละแพลตฟอร์ม แล้ววางที่ <central state>\edge-updates\
  # edge แบบ link ที่ build ไม่ตรงจะได้ข้อเสนอ โหลดเอง แล้วรอคนกดติดตั้งที่หน้าเว็บของ edge (docs/EDGE-KIT.md)
  [switch]$Publish,
  [string]$SigningKey = 'D:\gw-edge-kits\signing\edge-update-key.pem',
  [string]$PublishDir = '',
  # เผยแพร่เฉพาะแพ็กเกจอัปเดตผ่านสาย link (~1 นาที) — ไม่โหลดไบนารี ไม่แพ็กชุดติดตั้ง · scripts\deploy.ps1 ใช้ทุกครั้งที่ deploy
  # ชุดติดตั้งให้ดาวน์โหลดคงรุ่นเดิม (edge ที่ติดตั้งจากชุดเก่าได้ข้อเสนอรุ่นนี้เองเมื่อต่อสาย)
  [switch]$UpdatesOnly
)
if ($UpdatesOnly) { $Publish = $true }
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $Out 'cache'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'   # bsdtar ของ Windows — แตก zip และ tar.xz ได้

# เวอร์ชันที่ใช้ — go2rtc ต้องตรงกับของ central (1.9.14 มีข้อจำกัดที่โค้ดอ้อมไว้แล้ว อย่าเปลี่ยนลอย ๆ)
$GO2RTC = 'v1.9.14'
$SQLITE3 = '5.1.7'
$FFMPEG = 'n8.1'   # BtbN FFmpeg-Builds สาขา release (static, gpl)

function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }
function Get-Cached($url, $name) {
  $file = Join-Path $cache $name
  if (-not (Test-Path $file)) {
    Write-Host "   โหลด $name"
    & curl.exe -fsSL -o "$file.part" $url
    if ($LASTEXITCODE) { throw "โหลด $url ไม่สำเร็จ" }
    Move-Item "$file.part" $file -Force
  }
  return $file
}
# แตกไฟล์เดียวจาก zip/tar.gz/tar.xz ไปไว้ที่ปลายทาง
# tar.exe ของ Windows ไม่มีตัวถอด xz (ค้างเงียบ ๆ) — คลาย .xz เป็น .tar ใน cache ก่อนด้วย xz.exe ที่มากับ Git for Windows
function Expand-One($archive, $member, $dest) {
  if ($archive -like '*.xz') {
    $plain = $archive -replace '\.xz$', ''
    if (-not (Test-Path $plain)) {
      $gitDir = Split-Path (Split-Path (Get-Command git).Source)
      $xz = @('mingw64\bin\xz.exe', 'usr\bin\xz.exe') | ForEach-Object { Join-Path $gitDir $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
      if (-not $xz) { throw 'ไม่พบ xz.exe (มากับ Git for Windows) — คลาย .tar.xz ไม่ได้' }
      cmd /c "`"$xz`" -dc `"$archive`" > `"$plain.part`""
      if ($LASTEXITCODE) { throw "คลาย $archive ไม่ได้" }
      Move-Item "$plain.part" $plain -Force
    }
    $archive = $plain
  }
  $tmp = Join-Path $cache ('x-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    & $tar -xf $archive -C $tmp $member
    if ($LASTEXITCODE) { throw "แตก $member จาก $archive ไม่ได้" }
    Copy-Item (Join-Path $tmp $member) $dest -Force
  } finally { Remove-Item $tmp -Recurse -Force }
}

New-Item -ItemType Directory -Force $cache | Out-Null
Push-Location $repo
try {
  # นิยาม build: ต้องตรงกับ BUILD_PATHS ใน server/shared/instance.js (ต้นฉบับ) ทุกตัว
  $buildPaths = @('server', 'src', 'scripts', 'package.json', 'ecosystem.edge.config.cjs')
  $build = (git log -1 --format=%h -- @buildPaths).Trim()
  $dirty = git status --porcelain -- @buildPaths
  if ($dirty) { Write-Host "คำเตือน: มีไฟล์ใน server/ src/ scripts/ ecosystem ที่ยังไม่ commit — ชุดติดตั้งใช้ของใน commit $build (หน้าเว็บ build จาก src/ ปัจจุบัน)" -ForegroundColor Yellow }
  # -UpdatesOnly ใช้โฟลเดอร์ของตัวเอง — ห้ามทับหรือลบชุดติดตั้งเต็มของ build เดียวกันที่อาจอยู่ใน $Out แล้ว
  $kit = Join-Path $Out $(if ($UpdatesOnly) { "Edge-Update-$build" } else { "Edge-Kit-$build" })
  $stage = Join-Path $Out "staging-$build"
  foreach ($d in $kit, $stage) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
  New-Item -ItemType Directory -Force $kit, $stage | Out-Null

  # ── โค้ด (ร่วมทุกแพลตฟอร์ม) ────────────────────────────────────────────────
  Step "โค้ดจาก commit $build"
  $app = Join-Path $stage 'app'
  New-Item -ItemType Directory $app | Out-Null
  $archive = Join-Path $stage 'app.tar'
  # แผนที่ออฟไลน์ .mbtiles (~860 MB) edge ไม่ใช้ — ตัดทิ้งเหมือน deploy-edge.sh
  $paths = @('server', 'scripts', 'ecosystem.edge.config.cjs', 'package.json')
  git archive --format=tar -o $archive HEAD -- @paths ':(exclude)server/map_data/*.mbtiles'
  if ($LASTEXITCODE) { throw 'git archive ไม่สำเร็จ' }
  & $tar -xf $archive -C $app
  Remove-Item $archive
  Set-Content -Path (Join-Path $app 'BUILD') -Value $build -Encoding ascii

  Step 'หน้าเว็บ (vite build)'
  npx vite build --outDir (Join-Path $app 'dist') --emptyOutDir --logLevel warn
  if ($LASTEXITCODE) { throw 'vite build ไม่สำเร็จ' }

  Step 'server/node_modules (npm ci --omit=dev)'
  Push-Location (Join-Path $app 'server')
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  $npmExit = $LASTEXITCODE
  Pop-Location
  if ($npmExit) { throw 'npm ci ไม่สำเร็จ' }

  # ── ไบนารีของแต่ละแพลตฟอร์ม ────────────────────────────────────────────────
  $nodeVer = ((Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
  Write-Host "   node $nodeVer · go2rtc $GO2RTC · sqlite3 $SQLITE3 · ffmpeg $FFMPEG"
  $ffBase = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
  $ffVer = $FFMPEG.TrimStart('n')
  $spec = @{
    'windows-x64' = @{
      node = @("https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip", "node-$nodeVer-win-x64/node.exe", 'node.exe')
      ffmpeg = @("$ffBase/ffmpeg-$FFMPEG-latest-win64-gpl-$ffVer.zip", "ffmpeg-$FFMPEG-latest-win64-gpl-$ffVer/bin/ffmpeg.exe", 'ffmpeg.exe')
      go2rtc = 'repo'
      sqlite = 'win32-x64'
    }
    'linux-arm64' = @{
      node = @("https://nodejs.org/dist/$nodeVer/node-$nodeVer-linux-arm64.tar.xz", "node-$nodeVer-linux-arm64/bin/node", 'node')
      ffmpeg = @("$ffBase/ffmpeg-$FFMPEG-latest-linuxarm64-gpl-$ffVer.tar.xz", "ffmpeg-$FFMPEG-latest-linuxarm64-gpl-$ffVer/bin/ffmpeg", 'ffmpeg')
      go2rtc = 'go2rtc_linux_arm64'
      sqlite = 'linux-arm64'
    }
    'linux-x64' = @{
      node = @("https://nodejs.org/dist/$nodeVer/node-$nodeVer-linux-x64.tar.xz", "node-$nodeVer-linux-x64/bin/node", 'node')
      ffmpeg = @("$ffBase/ffmpeg-$FFMPEG-latest-linux64-gpl-$ffVer.tar.xz", "ffmpeg-$FFMPEG-latest-linux64-gpl-$ffVer/bin/ffmpeg", 'ffmpeg')
      go2rtc = 'go2rtc_linux_amd64'
      sqlite = 'linux-x64'
    }
  }

  foreach ($p in $Platforms) {
    if (-not $spec.ContainsKey($p)) { throw "ไม่รู้จักแพลตฟอร์ม $p (มี: $($spec.Keys -join ', '))" }
    $s = $spec[$p]
    Step $p
    $dst = Join-Path $kit $p
    $bin = Join-Path $dst 'bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    robocopy $app (Join-Path $dst 'app') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "ก๊อป app ไป $p ไม่สำเร็จ" }

    # sqlite3 เป็น native module — สลับไฟล์ .node ให้ตรงแพลตฟอร์ม (prebuilt ทางการของ sqlite3)
    $sq = Get-Cached "https://github.com/TryGhost/node-sqlite3/releases/download/v$SQLITE3/sqlite3-v$SQLITE3-napi-v6-$($s.sqlite).tar.gz" "sqlite3-v$SQLITE3-napi-v6-$($s.sqlite).tar.gz"
    Expand-One $sq 'build/Release/node_sqlite3.node' (Join-Path $dst 'app\server\node_modules\sqlite3\build\Release\node_sqlite3.node')
    if ($UpdatesOnly) { continue }   # แพ็กเกจอัปเดตมีแค่ app\ — ไบนารีเป็นของชุดติดตั้ง

    $n = Get-Cached $s.node[0] (Split-Path $s.node[0] -Leaf)
    Expand-One $n $s.node[1] (Join-Path $bin $s.node[2])
    $f = Get-Cached $s.ffmpeg[0] (Split-Path $s.ffmpeg[0] -Leaf)
    Expand-One $f $s.ffmpeg[1] (Join-Path $bin $s.ffmpeg[2])
    if ($s.go2rtc -eq 'repo') {
      Copy-Item (Join-Path $repo 'go2rtc\go2rtc.exe') (Join-Path $bin 'go2rtc.exe')
    } else {
      $g = Get-Cached "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC/$($s.go2rtc)" "$($s.go2rtc)-$GO2RTC"
      Copy-Item $g (Join-Path $bin 'go2rtc')
    }

  }

  # ── ตัวติดตั้ง ──────────────────────────────────────────────────────────────
  Step 'ตัวติดตั้ง'
  $src = Join-Path $repo 'scripts\edge-kit'
  $utf8Bom = New-Object Text.UTF8Encoding $true
  $utf8 = New-Object Text.UTF8Encoding $false
  $read = { param($name) [IO.File]::ReadAllText((Join-Path $src $name)) -replace "`r`n", "`n" }
  # .cmd ต้อง CRLF · .ps1 ภาษาไทยต้อง UTF-8 BOM (PowerShell 5.1) · .sh ต้อง LF · .txt CRLF ให้ Notepad
  [IO.File]::WriteAllText((Join-Path $kit 'install-windows.cmd'), ((& $read 'install-windows.cmd') -replace "`n", "`r`n"), [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $kit 'install-windows.ps1'), ((& $read 'install-windows.ps1') -replace "`n", "`r`n"), $utf8Bom)
  [IO.File]::WriteAllText((Join-Path $kit 'uninstall-windows.cmd'), ((& $read 'uninstall-windows.cmd') -replace "`n", "`r`n"), [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $kit 'uninstall-windows.ps1'), ((& $read 'uninstall-windows.ps1') -replace "`n", "`r`n"), $utf8Bom)
  [IO.File]::WriteAllText((Join-Path $kit 'install-linux.sh'), (& $read 'install-linux.sh'), $utf8)
  [IO.File]::WriteAllText((Join-Path $kit 'uninstall-linux.sh'), (& $read 'uninstall-linux.sh'), $utf8)
  [IO.File]::WriteAllText((Join-Path $kit 'README-TH.txt'), ((& $read 'README-TH.txt') -replace "`n", "`r`n"), $utf8Bom)

  Remove-Item $stage -Recurse -Force

  # ── เผยแพร่แพ็กเกจอัปเดต (app/ อย่างเดียว — bin/ นาน ๆ เปลี่ยนที ใช้ flash drive) ─────────
  if (-not (Test-Path (Join-Path $kit "$($Platforms[0])\app\scripts\edge-kit\edge-update.pub.pem"))) {
    Write-Host 'คำเตือน: ชุดนี้ไม่มี public key สำหรับตรวจแพ็กเกจอัปเดต — edge ที่ติดตั้งจากชุดนี้จะไม่รับอัปเดตผ่านสาย link (สร้างด้วย edge-update-key.cjs --keygen แล้ว commit)' -ForegroundColor Yellow
  }
  if ($Publish) {
    Step 'เผยแพร่แพ็กเกจอัปเดต'
    if (-not (Test-Path $SigningKey)) { throw "ไม่พบกุญแจเซ็น $SigningKey — สร้างด้วย node scripts\edge-update-key.cjs --keygen" }
    if (-not $PublishDir) { $PublishDir = (node -e "console.log(require('./server/shared/instance').stateFile('edge-updates'))").Trim() }
    foreach ($p in $Platforms) {
      $pkgName = "app-$p-$build.tar.gz"
      $pkg = Join-Path $Out $pkgName
      & $tar -czf $pkg -C (Join-Path $kit "$p\app") .
      if ($LASTEXITCODE) { throw "สร้าง $pkgName ไม่สำเร็จ" }
      node scripts\edge-update-key.cjs --sign $pkg --build $build --platform $p --key $SigningKey
      if ($LASTEXITCODE) { throw "เซ็น $pkgName ไม่สำเร็จ" }
      $dest = Join-Path $PublishDir $p
      New-Item -ItemType Directory -Force $dest | Out-Null
      # วางไฟล์ก่อน manifest — central อ่าน manifest แล้วต้องเจอไฟล์ทันที · รุ่นเก่าลบทิ้ง
      Get-ChildItem $dest -Filter 'app-*.tar.gz' | Where-Object { $_.Name -ne $pkgName } | Remove-Item -Force
      Move-Item $pkg (Join-Path $dest $pkgName) -Force
      Move-Item "$pkg.manifest.json" (Join-Path $dest 'manifest.json') -Force
      Write-Host "   $p → $dest"
    }

    # ชุดติดตั้งต่อแพลตฟอร์มให้ดาวน์โหลดจากหน้า Edge Nodes ของ central (server/vms/edge-kits.js)
    # Windows = .zip (แตกด้วย Explorer ได้) · Linux = .tar.gz (แตกแล้วสิทธิ์ execute ยังอยู่)
    if ($UpdatesOnly) {
      Write-Host ''
      Write-Host "เสร็จ: เผยแพร่แพ็กเกจอัปเดต build $build แล้ว — edge แบบ link ได้ข้อเสนอภายใน 5 นาที" -ForegroundColor Green
      Remove-Item $kit -Recurse -Force   # ไม่มีไบนารี ใช้เป็นชุดติดตั้งไม่ได้ — ไม่เก็บไว้ให้สับสน
      return
    }
    Step 'เผยแพร่ชุดติดตั้งให้ดาวน์โหลดจาก central'
    $kitDir = Join-Path (Split-Path $PublishDir) 'edge-kits'
    New-Item -ItemType Directory -Force $kitDir | Out-Null
    $kits = @()
    foreach ($p in $Platforms) {
      $name = "Edge-$p-$build"
      $tmp = Join-Path $Out "pack-$name"
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
      New-Item -ItemType Directory -Force (Join-Path $tmp $name) | Out-Null
      $inner = Join-Path $tmp $name
      robocopy (Join-Path $kit $p) (Join-Path $inner $p) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
      # @(...) ครอบ — if ที่คืน array ตัวเดียวถูก PowerShell คลายเป็นข้อความ แล้ว + ต่อข้อความแทนการต่อ array
      $installers = @(if ($p -eq 'windows-x64') { 'install-windows.cmd', 'install-windows.ps1', 'uninstall-windows.cmd', 'uninstall-windows.ps1' } else { 'install-linux.sh', 'uninstall-linux.sh' })
      foreach ($f in $installers + @('README-TH.txt')) { Copy-Item (Join-Path $kit $f) $inner }
      $file = if ($p -eq 'windows-x64') { "$name.zip" } else { "$name.tar.gz" }
      $archive = Join-Path $kitDir $file
      if (Test-Path $archive) { Remove-Item $archive -Force }
      if ($p -eq 'windows-x64') { & $tar -a -cf $archive -C $tmp $name } else { & $tar -czf $archive -C $tmp $name }
      if ($LASTEXITCODE) { throw "แพ็ก $file ไม่สำเร็จ" }
      Remove-Item $tmp -Recurse -Force
      $kits += [ordered]@{ platform = $p; build = $build; file = $file; size = (Get-Item $archive).Length; sha256 = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() }
      Write-Host ("   {0} ({1:N0} MB)" -f $file, ((Get-Item $archive).Length / 1MB))
    }
    # รุ่นเก่าของแพลตฟอร์มที่เพิ่งสร้างลบทิ้ง · แพลตฟอร์มที่ไม่ได้สร้างรอบนี้เก็บรายการเดิมไว้
    $old = @()
    # PowerShell 5.1: ConvertFrom-Json ส่ง array ทั้งก้อนเป็นค่าเดียว — @(...) ตรง ๆ ได้ array ซ้อน 1 ตัว
    # แล้ว $o.platform กลายเป็นรายการทุกแพลตฟอร์ม ไม่ตรง -contains → ไม่เคยลบรุ่นเก่า · คลายด้วย ForEach-Object
    try { $parsed = Get-Content (Join-Path $kitDir 'kits.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $old = @($parsed | ForEach-Object { $_ }) } catch { }
    foreach ($o in $old) {
      if ($Platforms -contains $o.platform) {
        if ($o.file -and ($kits.file -notcontains $o.file)) { Remove-Item (Join-Path $kitDir $o.file) -Force -ErrorAction SilentlyContinue }
      } else { $kits += $o }
    }
    [IO.File]::WriteAllText((Join-Path $kitDir 'kits.json'), (ConvertTo-Json @($kits) -Depth 3), (New-Object Text.UTF8Encoding $false))
  }

  $size =(Get-ChildItem $kit -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
  Write-Host ''
  Write-Host ("เสร็จ: {0} ({1:N0} MB, build {2})" -f $kit, $size, $build) -ForegroundColor Green
  Write-Host 'ก๊อปทั้งโฟลเดอร์ลง flash drive แล้ววางไฟล์ edge-<เลข>.json จาก central ไว้ข้าง install-windows.cmd'
} finally {
  Pop-Location
}
