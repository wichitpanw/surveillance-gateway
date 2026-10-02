<#
.SYNOPSIS
    Builds an installer for the Windows client and publishes it to the gateway's update feed.

.DESCRIPTION
    Produces `SurveillanceGateway-win-Setup.exe` plus the release files that the installed client reads to
    find newer versions, and copies them into `client-updates/`, which the gateway serves at
    `/client-updates`. Publishing an update is therefore this script plus nothing.

    The build is self-contained: the .NET runtime ships inside it. A wall-display machine then
    needs no prerequisite beyond the WebView2 runtime, which Windows Server 2022 and Windows 11
    already carry. It is a bigger download for a much shorter install.

    Version numbers must increase for an update to be offered. The default comes from
    `<Version>` in SurveillanceGateway.Client.csproj; pass -Version to override it without editing the
    project (e.g. a hotfix build).

.PARAMETER Version
    Version to stamp. Defaults to the csproj's <Version>.

.PARAMETER OutputDir
    Where the release files go. Defaults to `client-updates/` in the repository, which is what
    the gateway serves.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-client-release.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-client-release.ps1 -Version 1.0.1
#>

param(
    [string]$Version,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$project = Join-Path $repo 'client-windows\SurveillanceGateway.Client\SurveillanceGateway.Client.csproj'
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'client-updates' }

# --- Tools --------------------------------------------------------------------------------------
# A `dotnet` on PATH is not enough: this host has the shared runtime in Program Files and the SDK
# installed per-user, and the runtime-only one is what PATH finds. Each candidate is asked whether
# it actually has an SDK, because that is the difference that breaks the build.
$dotnetCandidates = @(
    (Get-Command dotnet -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe",
    "$env:ProgramFiles\dotnet\dotnet.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$dotnet = $dotnetCandidates | Where-Object {
    (& $_ --list-sdks 2>$null | Measure-Object).Count -gt 0
} | Select-Object -First 1

if (-not $dotnet) { throw 'ไม่พบ .NET SDK (มีแต่ runtime) — ติดตั้งจาก https://dot.net' }

# vpk is a framework-dependent .NET 8 tool, and it looks for its runtime under DOTNET_ROOT - or,
# with that unset, under the machine-wide install, which on this host carries only .NET 3.1. Point
# it at the same installation the build just used.
$env:DOTNET_ROOT = Split-Path $dotnet -Parent

$vpk = "$env:USERPROFILE\.dotnet\tools\vpk.exe"
if (-not (Test-Path $vpk)) {
    Write-Host 'Installing Velopack CLI...'
    & $dotnet tool install -g vpk | Out-Null
}

if (-not $Version) {
    $Version = ([xml](Get-Content $project)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
}
if (-not $Version) { throw 'อ่านเลขเวอร์ชันจาก csproj ไม่ได้ — ส่ง -Version มาแทน' }

Write-Host "Building SurveillanceGateway $Version ..."

# --- Publish ------------------------------------------------------------------------------------
# Never a single-file publish: libvlc locates its ~450-DLL plugins tree by path at runtime, and a
# single-file build would extract the whole thing to temp on every launch.
$publishDir = Join-Path $env:TEMP "sgw-publish-$Version"
if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

& $dotnet publish $project `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:Version=$Version `
    -p:PublishSingleFile=false `
    -o $publishDir
if ($LASTEXITCODE -ne 0) { throw "dotnet publish exited with $LASTEXITCODE" }

# --- Pack ---------------------------------------------------------------------------------------
# vpk reads whatever is already in the output directory, so building into `client-updates`
# directly is what makes this an incremental feed rather than a full download each time: it emits
# a delta against the previous release when it finds one.
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

& $vpk pack `
    --packId SurveillanceGateway `
    --packVersion $Version `
    --packDir $publishDir `
    --mainExe SurveillanceGateway.exe `
    --packTitle 'Surveillance Gateway Client' `
    --icon (Join-Path $repo 'client-windows\SurveillanceGateway.Client\Assets\app.ico') `
    --outputDir $OutputDir
if ($LASTEXITCODE -ne 0) { throw "vpk pack exited with $LASTEXITCODE" }

Remove-Item -Recurse -Force $publishDir

Write-Host ''
Write-Host "Release in: $OutputDir"
Get-ChildItem $OutputDir | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table

Write-Host 'Installer: SurveillanceGateway-win-Setup.exe — run it on the client machine.'
Write-Host 'Connected clients see the new version at their next launch; no server restart needed.'
