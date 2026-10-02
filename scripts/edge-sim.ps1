<#
  Run a simulated edge and a test central on this machine, next to production
  (docs/EDGE-PLAN.md, phases 0-3).

    edge     http://<host>:5283   role edge, node 101   go2rtc 1996 / 8585 / 8586

    regional http://<host>:5483   role regional, node 100 go2rtc 1998 / 8605 / 8606
    central  http://<host>:5383   role central, node 000 go2rtc 1997 / 8595 / 8596

  Production (5173, go2rtc 1984/8555/8556, server\vms.db) is never touched: each instance
  keeps its database, secrets and go2rtc config under $Root\<name>. All run the code in this
  working tree, and serve the web UI from this worktree's dist (build it with the command below) so a
  test build never overwrites production's dist\.

  Fresh databases seed the default superadmin account. Change its password before exposing
  the ports beyond this machine.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\edge-sim.ps1            start everything
    powershell -ExecutionPolicy Bypass -File scripts\edge-sim.ps1 -Stop      stop everything
    ... -Root D:\some-new-dir                                               fresh databases (test schema changes)
    ... -Root D:\gateway-sandbox\north-sim -Only regional -Region north -NodeBlock 200 -PortOffset 400
    ... -Root D:\gateway-sandbox\north-sim -Only edge -Region north -NodeBlock 200 -PortOffset 400
    # The second pair uses Edge :5683, Regional :5883; point its Regional link.json to Central :5383.
    npm run build                                              web UI for the sims (in worktree)
#>
param(
    [string]$Root = 'D:\gateway-sandbox\edge-sim',
    [switch]$Stop,
    [ValidateSet('edge', 'regional', 'central')][string]$Only = '',
    [ValidateSet('central', 'north', 'northeast', 'east', 'west', 'south')][string]$Region = 'northeast',
    [ValidatePattern('^[1-6]00$')][string]$NodeBlock = '100',
    [ValidateSet(0, 400, 800, 1200)][int]$PortOffset = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$instances = @(
    @{ Name = 'edge';     Role = 'edge';     Node = [string]([int]$NodeBlock + 1); Port = 5283; Api = 1996; Rtsp = 8585; WebRtc = 8586 },
    @{ Name = 'regional'; Role = 'regional'; Region = $Region; Node = $NodeBlock; Port = 5483; Api = 1998; Rtsp = 8605; WebRtc = 8606 },
    @{ Name = 'central';  Role = 'central';  Node = '000'; Port = 5383; Api = 1997; Rtsp = 8595; WebRtc = 8596 }
)
foreach ($i in $instances) { foreach ($field in 'Port', 'Api', 'Rtsp', 'WebRtc') { $i[$field] += $PortOffset } }
$sourceApi = 1995 + $PortOffset
$sourceRtsp = 8785 + $PortOffset
if ($Only) { $instances = @($instances | Where-Object { $_.Name -eq $Only }) }

function Stop-Port([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

if ($Stop) {
    foreach ($i in $instances) { Stop-Port $i.Port; Stop-Port $i.Api }
    if (-not $Only -or $Only -eq 'edge') { Stop-Port $sourceApi }
    Write-Host "Stopped simulated $($(if ($Only) { $Only } else { 'edge, regional and central' }))."
    return
}

New-Item -ItemType Directory -Force "$Root\logs" | Out-Null
$go2rtc = "$Root\go2rtc.exe"
if (-not (Test-Path $go2rtc)) { Copy-Item "$repo\go2rtc\go2rtc.exe" $go2rtc }

# ภาพทดสอบที่อยู่นอก gateway: gateway เขียน go2rtc.yaml ของตัวเองใหม่เมื่อ sync กล้อง
if (-not $Only -or $Only -eq 'edge') {
    $sourceDir = "$Root\source"
    New-Item -ItemType Directory -Force $sourceDir | Out-Null
    $sourceYaml = @'
api:
  listen: "127.0.0.1:1995"
rtsp:
  listen: "127.0.0.1:8785"
streams:
  synthetic: 'exec:C:\ffmpeg\bin\ffmpeg.exe -hide_banner -loglevel error -re -f lavfi -i testsrc=size=320x180:rate=10 -c:v libx264 -preset ultrafast -tune zerolatency -g 10 -an -rtsp_transport tcp -f rtsp {output}'
'@
    $sourceYaml = $sourceYaml.Replace('127.0.0.1:1995', "127.0.0.1:$sourceApi").Replace('127.0.0.1:8785', "127.0.0.1:$sourceRtsp")
    [IO.File]::WriteAllText("$sourceDir\go2rtc.yaml", $sourceYaml)
    Stop-Port $sourceApi
    Start-Process -FilePath $go2rtc -ArgumentList '-config', 'go2rtc.yaml' -WorkingDirectory $sourceDir `
        -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\go2rtc-source.log" `
        -RedirectStandardError "$Root\logs\go2rtc-source.err.log"
}

foreach ($i in $instances) {
    $dir = "$Root\$($i.Name)"
    New-Item -ItemType Directory -Force $dir | Out-Null

    # One RTSP account per go2rtc, written both to its yaml and to the file the gateway reads,
    # so the URLs the gateway hands out carry the right credentials.
    $credFile = "$dir\.rtsp-credentials.json"
    if (-not (Test-Path $credFile)) {
        $pass = -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
        $cred = @{ username = "$($i.Name)sim"; password = $pass }
        [IO.File]::WriteAllText($credFile, ($cred | ConvertTo-Json -Compress))
    }
    $cred = Get-Content $credFile -Raw | ConvertFrom-Json

    $yaml = @"
# go2rtc for the simulated $($i.Name) - ports kept apart from production (1984/8555/8556)
# API has no auth: loopback only, same as production (scripts/lock-go2rtc-api.cjs)
api:
  listen: "127.0.0.1:$($i.Api)"
rtsp:
  listen: :$($i.Rtsp)
  username: $($cred.username)
  password: $($cred.password)
webrtc:
  listen: :$($i.WebRtc)
ffmpeg:
  bin: C:\ffmpeg\bin\ffmpeg.exe
log:
  level: info
"@
    [IO.File]::WriteAllText("$dir\go2rtc.yaml", $yaml)

    Stop-Port $i.Port
    Stop-Port $i.Api

    Start-Process -FilePath $go2rtc -ArgumentList '-config', 'go2rtc.yaml' -WorkingDirectory $dir `
        -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\go2rtc-$($i.Name).log" `
        -RedirectStandardError "$Root\logs\go2rtc-$($i.Name).err.log"

    # Environment for the gateway process only; Start-Process inherits it from this shell.
    $envVars = @{
        GATEWAY_ROLE         = $i.Role
        GATEWAY_NODE_NUMBER  = $i.Node
        GATEWAY_PORT         = "$($i.Port)"
        GATEWAY_STATE_DIR    = $dir
        GATEWAY_DIST_DIR     = "$repo\dist"
        GO2RTC_API_PORT      = "$($i.Api)"
        GO2RTC_RTSP_PORT     = "$($i.Rtsp)"
        GATEWAY_STREAM_CORE  = 'go2rtc'
        GATEWAY_RAW_STREAMS  = '1'
        GATEWAY_PUBLIC_HOST  = '127.0.0.1'
        TZ                   = 'Asia/Bangkok'
    }
    if ($i.Region) { $envVars.GATEWAY_REGION = $i.Region }
    # ไฟล์เชื่อมต่อสำหรับแบบจำลองอยู่ใน state ของแต่ละ instance เท่านั้น ไม่เข้า git
    $linkFile = "$dir\link.json"
    if (Test-Path $linkFile) {
        $link = Get-Content $linkFile -Raw | ConvertFrom-Json
        $envVars.GATEWAY_CENTRAL_URL = [string]$link.url
        $envVars.GATEWAY_CENTRAL_TOKEN = [string]$link.token
    }
    foreach ($k in $envVars.Keys) { Set-Item "env:$k" $envVars[$k] }
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory "$repo\server" `
        -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\$($i.Name).log" `
        -RedirectStandardError "$Root\logs\$($i.Name).err.log"
    foreach ($k in $envVars.Keys) { Remove-Item "env:$k" }

    Write-Host "$($i.Name): http://127.0.0.1:$($i.Port)  (role $($i.Role), node $($i.Node))"
}
Write-Host "Logs: $Root\logs"
