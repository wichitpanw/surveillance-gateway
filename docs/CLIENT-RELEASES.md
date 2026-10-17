# Releasing a new version of the Windows client

One script does everything, with no upload and no server restart — central serves this repo's `client-updates/` folder at `/client-updates`,
and installed clients read that feed themselves · Updated 2026-10-17 (latest release in feed: 1.14.2)
Always check `client-updates/releases.win.json` for what is actually released — the numbers in this document may lag behind.

**Version 1.8.5 (released 2026-09-29):** fixes from the whole-system audit — Playback requests video in chunks that do not extend past the end of a recording or midnight
(time no longer drifts when playing across gaps/days) · an SSE link that is silent for more than 60 s reconnects by itself · app-wide exceptions are caught (log at
`%LOCALAPPDATA%\SurveillanceGateway.Client\errors.log`) and the app no longer closes itself · closed pages no longer stay in memory · settings have a `.bak` that can really be restored ·
PTZ tooltips are complete · all strings live in `Strings.cs` (commit d03e545)

**Version 1.8.4:** the Playback page became a VMS-style recording timeline (commit 645a2a7)
· video sources: AXIS S30 / Uniview NVR work for real · Hikvision / Dahua / ONVIF Profile G are written and awaiting tests with real devices · Digifort awaits API documentation (answers 501)

**Version 1.8.3:** added the Playback page: choose a camera by group and search,
choose day / recording range / time (24-hour time bar), then play, pause or stop with libVLC · uses `GET /api/v1/cameras/:id/recordings` and
`playback-token` (a camera-bound token valid for 5 minutes, checked when the stream opens) · the **playback** permission (`allow_playback`) must be enabled for the client's API key
and for the key central uses to connect to the edge · the source supports the existing AXIS S30 / Uniview NVR video sources
· the client page has not yet been tested against real devices

**Version 1.9.1:** the Playback page has an MP4 download button; choose a range within the open day, up to 30 minutes per file,
and one job at a time per client instance · requires allow_playback, same as viewing recordings · calls a new API
GET /api/v1/cameras/:id/download.mp4?start=<ISO-8601>&duration=<1–1800> (the backend must be deployed before releasing the client)
· while downloading, the existing playback stops, the MB count is shown, and it can be cancelled · the .part file is cleaned up on cancel/failure and renamed to .mp4 when fully received

**Version 1.9.2:** separated the stream URL timeout from cancellation so it can retry, and reconnects when Playing but no frame arrives, without disturbing pause
· the fragmented MP4 structure is verified before the .part file is renamed to MP4 · before release, the backend must be deployed so that video-source failures pass through every relay, and so that download ranges spanning recording files are checked
· a range that the device cannot deliver completely from a single clip answers 416 with the maximum length so the user can choose again, instead of sending a short file and reporting success
· build and simulated regression checked; WPF / real cameras and a real recording range via Central/Regional still need confirmation
## Current release (1.14.2; feed verified 2026-10-17)

- **1.10.0:** Diagnostics, multi-monitor walls, Auto stream, AI event navigation, evidence export/SHA256 — [Verification report](WINDOWS-CLIENT-1.10.0.md)
- **1.11.0:** Shell/Live/Playback redesign, Dark/Light, Compact/Comfortable and Ctrl+F — [Workspace redesign report](WINDOWS-CLIENT-WORKSPACE.md)
- **1.12.0:** Merged-cell wall layouts (1+3, 1+5, 1+7, 1+9, 2+8, 1+12) and custom layout editor (≤ 25 cells)
- **1.13.0:** Isometric VMS-style Home landing page (`Views/IsoArt.cs`)
- **1.14.0:** VMS-style Live View layout with full-bleed 1 px grid and accordion left rail (Cameras / Views / PTZ)
- **1.14.1:** Reopen saved wall views after Clear all cells
- **1.14.2:** Harden playback and investigation state synchronization
- **Map hotfix Gateway a0d8867:** bundle MapLibre worker to fix map loading hang without requiring a new Client version

### 1.9.x history

- **1.9.3:** receives AI events from cameras / NVRs / VMS / external APIs relayed Edge → Regional / Central, with images; filter by Edge / group / origin and open full-image details
- **1.9.4:** click the Camera Library header to collapse or expand the filter section; Search, Group, Status and Favorites stay, and the camera list and layout/stream controls are never hidden
- **1.9.5 (released 2026-10-06 with Gateway d645ed9):** audio from cameras whose Edge has `audio_enabled` — a speaker button per tile that always starts muted; cameras without audio and Playback add `:no-audio` per media instead of `--no-audio` app-wide · full/delta packages are in the feed · dotnet build passes; the real window and audio are not yet tested ([CAMERA-AUDIO.md](CAMERA-AUDIO.md))
- **1.9.6–1.9.7 (2026-10-08):** separate player window when clicking a camera pin on the map
- **1.9.8 (2026-10-09):** window title, sidebar, breadcrumb, exit prompt and installer renamed to Surveillance Client; vendor branding removed

## Agreed UI history (1.8.2)

- The Home page uses a Live Wall card as the most prominent element, followed by Map and Camera details, with a Total / Online / Offline / Other panel
- The dark top bar has minimize/maximize/close buttons; the maximize button uses the work area above the taskbar, while F11 hides the top bar and places the window over the real screen edges above the taskbar
- The video wall shows Layout and Stream in the camera bar, Clear all cells beside Stream, and Wall Controls for saved views at the bottom
- Camera groups show online/total counts as `1/5`; the dark/light themes use text color tokens that passed a contrast check
- Version 1.7.3 fixed F11 to cover the taskbar and restore the previous position on exit; window edges were checked against the real screen edges, and Full / Delta were published to both addresses in Central's feed
- Version 1.7.4 asks for confirmation before quitting (the ✕ button, Alt+F4, closing from the taskbar) — it does not ask when clicking update or when Windows is shutting down
- Version 1.8.1 removed object colors, "people counting" and events from camera-side AI (as removed from the system on 2026-09-28)
- Version 1.8.2: clicking a row on the AI events page opens a popup window (`Views/EventDetailWindow`) with the full image, details, and left/right arrows to move between events

## Procedure

1. Edit the code in `client-windows/SurveillanceGateway.Client/`
2. **Bump `<Version>`** in `client-windows/SurveillanceGateway.Client/SurveillanceGateway.Client.csproj` — not bumping = nobody gets the update
   (Velopack compares version numbers, not file contents) · `-Version` builds the given number once, but the next time it reads from the csproj again
3. Build and publish (or `scripts\deploy.ps1 -ReleaseClient`, which does it together with the deploy):
   ```bash
   powershell -ExecutionPolicy Bypass -File <repo>\scripts\build-client-release.ps1
   ```
4. Commit the source along with the version number — the release files do not need to be committed (`client-updates/` is ignored; the full package is ~160 MB)
   The machine that builds is the machine that serves, so nothing needs to be moved.

Connected clients will see the new version the next time they open, or immediately if they click **Check for updates** in Settings

The build needs the .NET SDK at `%LOCALAPPDATA%\Microsoft\dotnet` (the script finds it itself) — `C:\Program Files\dotnet` has only the runtime

## Verify the release succeeded

```bash
curl -s http://203.0.113.80:5173/client-updates/releases.win.json
```
It must contain the version you just built · if not, the script wrote somewhere else — look at the `-OutputDir` it reports at the end

## Resulting files (`client-updates/`)

| File | Used by |
|---|---|
| `SurveillanceGateway-win-Setup.exe` | First-time installers — **distribute only this file** (there is a download button on central's login page) |
| `SurveillanceGateway-<ver>-full.nupkg` | Velopack when a client is too far behind to use a delta (~160 MB) |
| `SurveillanceGateway-<ver>-delta.nupkg` | Velopack when one version behind (under 1 MB up to a few MB) |
| `RELEASES`, `releases.win.json`, `assets.win.json` | Velopack index |
| `SurveillanceGateway-win-Portable.zip` | Machines that cannot install — no shortcut and **cannot update itself** |

The build is self-contained (the .NET runtime is bundled); a new machine needs only the WebView2 runtime, which Windows Server 2022 / Windows 11 already include

Download: `http://203.0.113.80:5173/client-updates/SurveillanceGateway-win-Setup.exe` or over the VPN `http://203.0.113.10:5173/…`

## Where the client is installed

```
%LOCALAPPDATA%\SurveillanceGateway\          ← everything from the installer (no admin rights needed)
  current\                           the running version — the whole folder is swapped on every update
  packages\                          downloaded .nupkg files
  Update.exe                         Velopack's updater/uninstaller
%LOCALAPPDATA%\SurveillanceGateway.Client\   ← settings, deliberately kept separate
  settings.json (+ .bak)             server address and API key (DPAPI-encrypted)
```

Uninstalling (Settings → Apps or `Update.exe --uninstall`) does not delete `SurveillanceGateway.Client\`, because the key is often the only copy on that machine.
Delete it yourself when decommissioning the machine for good · the app's name is "Surveillance Gateway Client" in both the window and the installer (`--packTitle` in `scripts/build-client-release.ps1`); the `--packId` never changes, so older installs keep updating

## Rules

- **Never kill the client while an update is being applied** — you get `Failed to resolve full path of the current executable` on launch and must reinstall with Setup.exe
- **Never delete the `.nupkg` of a version a client may still be using** — a missing intermediate forces a full download, and a missing full package for its own version means it cannot update at all
- **A build from source or the portable build cannot update itself** — the client says "no update system", not "no new version"
- The client does not restart itself — it downloads in the background and shows an **Update** button in the navbar, because on a wall display a self-restart means the video goes dark mid-shift
