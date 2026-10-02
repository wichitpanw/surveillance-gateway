<#
.SYNOPSIS
    Rebuilds the offline vector map tiles from current OpenStreetMap data.

.DESCRIPTION
    The client's 3D map reads vector tiles from `server/map_data/thailand-<date>.mbtiles`, served
    by `GET /api/vector-tiles`. Those tiles are a snapshot: roads and buildings added to OSM after
    the file was built simply do not exist on the map. The first file the system shipped with was
    OSM data from 2020-02-10, which is why this script exists.

    It downloads a current Thailand extract from Geofabrik and renders it with Planetiler into the
    same OpenMapTiles schema the map style already expects, so nothing on either side needs to
    change when the tiles are refreshed.

    Everything it installs is per-user under %LOCALAPPDATA%. Nothing needs administrator rights
    and nothing touches Program Files.

    The server picks the newest `thailand-<date>.mbtiles` by filename on startup and falls back to
    the 2020 file if none exists. Rolling back is therefore: delete the new file, restart.

.PARAMETER WorkDir
    Scratch directory for the downloads and the build. Needs roughly 10 GB free.

.PARAMETER Area
    Geofabrik extract name. "thailand" by default.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-map-tiles.ps1

    Takes a few minutes on this host (48 cores): the 2026-09-08 run finished in 3m32s and produced
    a 442 MB file. Then restart the backend to pick it up.
#>

param(
    [string]$WorkDir = 'D:\map-build',
    [string]$Area = 'thailand'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$mapDataDir = Join-Path $PSScriptRoot '..\server\map_data' | Resolve-Path
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# --- Java ---------------------------------------------------------------------------------------
# Planetiler needs Java 21+. Installed per-user so this script never needs administrator rights.
$jreRoot = "$env:LOCALAPPDATA\Programs\jre21"
$java = Get-ChildItem -Path $jreRoot -Filter java.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1

if (-not $java) {
    Write-Host 'Installing Temurin JRE 21 (per-user)...'
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/adoptium/temurin21-binaries/releases/latest' `
        -Headers @{ 'User-Agent' = 'sgw-map-build' }
    $asset = $rel.assets | Where-Object { $_.name -like '*jre_x64_windows_hotspot*.zip' } | Select-Object -First 1
    $zip = Join-Path $WorkDir $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $jreRoot -Force
    $java = Get-ChildItem -Path $jreRoot -Filter java.exe -Recurse | Select-Object -First 1
}

Write-Host "java: $($java.FullName)"

# --- Planetiler ---------------------------------------------------------------------------------
$jar = Join-Path $WorkDir 'planetiler.jar'
if (-not (Test-Path $jar)) {
    Write-Host 'Downloading Planetiler...'
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/onthegomap/planetiler/releases/latest' `
        -Headers @{ 'User-Agent' = 'sgw-map-build' }
    $asset = $rel.assets | Where-Object { $_.name -eq 'planetiler.jar' } | Select-Object -First 1
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $jar -UseBasicParsing
}

# --- Build --------------------------------------------------------------------------------------
# The date in the filename is what the server sorts on, so it must be the build date and must sort
# lexically. --download fetches the OSM extract plus the water and Natural Earth data Planetiler
# needs; all of it is cached in the work directory for the next run.
$stamp = Get-Date -Format 'yyyyMMdd'
$output = Join-Path $WorkDir "$Area-$stamp.mbtiles"

Write-Host "Building $output ..."
Push-Location $WorkDir
try {
    & $java.FullName -Xmx32g -jar $jar --area=$Area --download --force --output="$Area-$stamp.mbtiles"
    if ($LASTEXITCODE -ne 0) { throw "planetiler exited with $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# --- Install ------------------------------------------------------------------------------------
# Copied, not moved: keeping the build output lets a failed rollout be re-copied without rebuilding.
$installed = Join-Path $mapDataDir "$Area-$stamp.mbtiles"
Copy-Item -Path $output -Destination $installed -Force

Write-Host ''
Write-Host "Installed: $installed ($([math]::Round((Get-Item $installed).Length / 1MB)) MB)"
Write-Host 'Restart the backend to use it:'
Write-Host "  Start-ScheduledTask -TaskName 'CCTV Gateway (pm2 resurrect at boot)'"
