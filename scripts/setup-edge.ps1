<#
  Prepare the state folder of an Edge API Gateway (run once per edge machine, before
  `pm2 start ecosystem.edge.config.cjs`). Reads the ports and folder from that file's EDGE block.

  Creates, if missing:
    <stateDir>\.rtsp-credentials.json   the account for the edge's go2rtc RTSP port
    <stateDir>\go2rtc.yaml              go2rtc config with that account and the edge's ports

  Never overwrites an existing go2rtc.yaml: go2rtc writes its stream list (with camera passwords)
  back into that file while it runs, and the gateway re-syncs it anyway.

  Usage:
    powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\setup-edge.ps1
  Another machine's config: set $env:GW_EDGE_CONFIG = '<stateDir>\edge.json' first (the kit installer does).
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$cfg = node -e "const e=require(process.argv[1]);const a=e.apps.find(x=>x.name==='3-edge-gateway').env;console.log(JSON.stringify(a))" "$repo\ecosystem.edge.config.cjs" | ConvertFrom-Json

$dir = $cfg.GATEWAY_STATE_DIR
# ffmpeg from edge.json ("ffmpeg", set by the flash-drive kit) or the one central uses on this box
$ffmpeg = if ($cfg.FFMPEG_PATH) { $cfg.FFMPEG_PATH } else { 'C:\ffmpeg\bin\ffmpeg.exe' }
New-Item -ItemType Directory -Force $dir | Out-Null

$credFile = Join-Path $dir '.rtsp-credentials.json'
if (-not (Test-Path $credFile)) {
    $pass = -join ((1..24) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    [IO.File]::WriteAllText($credFile, (@{ username = 'edge'; password = $pass } | ConvertTo-Json -Compress))
    Write-Host "Created $credFile"
}
$cred = Get-Content $credFile -Raw | ConvertFrom-Json

$yamlFile = Join-Path $dir 'go2rtc.yaml'
if (-not (Test-Path $yamlFile)) {
    $webrtc = [int]$cfg.GO2RTC_RTSP_PORT + 1
    $yaml = @"
# go2rtc of the Edge API Gateway - streams are synced in by the gateway over REST
# API has no auth: bind to loopback only - the gateway proxies what users need (scripts/lock-go2rtc-api.cjs)
api:
  listen: "127.0.0.1:$($cfg.GO2RTC_API_PORT)"
rtsp:
  listen: :$($cfg.GO2RTC_RTSP_PORT)
  username: $($cred.username)
  password: $($cred.password)
webrtc:
  listen: :$webrtc
ffmpeg:
  bin: $ffmpeg
log:
  level: info
"@
    [IO.File]::WriteAllText($yamlFile, $yaml)
    Write-Host "Created $yamlFile"
}

Write-Host "Edge state folder ready: $dir (node $($cfg.GATEWAY_NODE_NUMBER), port $($cfg.GATEWAY_PORT))"
Write-Host "Next: pm2 start $repo\ecosystem.edge.config.cjs"
