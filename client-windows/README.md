# Windows client (SurveillanceGateway)

Current version: Client **1.14.2** (`SurveillanceGateway.Client.csproj`) · Gateway **651549d**
- **1.14.2** (`c361c33`): Hardened Live ↔ Playback investigation state and catalog scope cleanup
- **1.14.1** (`4b86c7f`): Reopen a saved wall view after the wall has been cleared
- **1.14.0** (`9516b91`): VMS-style Live view with 1 px tile dividers, single-row toolbar, and left-hand `Cameras` / `Views` / `PTZ` accordion rail (PTZ available immediately for the selected tile)
- **1.13.0** (`2f8a23e`): Isometric Home landing page (`Views/IsoArt.cs`)
- **1.12.0** (`e26d24f`): Merged-cell wall layouts (`1+3`, `1+5`, `1+7`, `1+9`, `2+8`, `1+12`) and custom layout editor (`WallLayoutEditorWindow`, up to 25 cells; `Auto` stream promotes the primary merged cell to `main`)
- **1.11.0** (`1a4ba1c`): Shell / Live / Playback workspace redesign, Graphite Dark & Light themes, Compact / Comfortable density, `Ctrl+F` search focus — see [docs/WINDOWS-CLIENT-WORKSPACE.md](../docs/WINDOWS-CLIENT-WORKSPACE.md)
- **1.10.0** (`bb58d2d`): Diagnostics (`DiagnosticsWindow` + whitelisted JSON export), multi-monitor walls (`MonitorWallWindow`), `Auto` stream policy, AI Event → Live/Playback navigation, and Playback evidence export with `.evidence.json` + SHA256 — see [docs/WINDOWS-CLIENT-1.10.0.md](../docs/WINDOWS-CLIENT-1.10.0.md)
- **1.9.5**: Per-tile speaker button for cameras whose Edge has audio enabled; tiles always start muted — see [docs/CAMERA-AUDIO.md](../docs/CAMERA-AUDIO.md)

The user's camera viewer — connects to **Surveillance Gateway Regional** or **Surveillance Gateway Central** with the API key of the target machine, then plays video, builds video walls, shows the map, and sends PTZ commands

Clients inside a region should be set to that region's Regional URL and API key directly, so viewing within the region continues when the Regional–Central link is down; nationwide viewers use Central and a key issued by Central
It is a "consumer" of `/api/v1` and a reference implementation, not another way into the cameras · .NET 8 / WPF · Updated October 2026 (v1.14.2)

## Why this program exists

Most cameras are H.265, which browsers cannot play through go2rtc (go2rtc crashes when sending H.265 to MSE), so the server would have to transcode for every viewer.
This client decodes H.265 on the user's own GPU (libVLC) and plays the `_raw` stream, which is not transcoded → the server's NVENC stays free

## Build and run

```bash
dotnet build SurveillanceGateway.Client/SurveillanceGateway.Client.csproj -c Release
bin\Release\net8.0-windows\win-x64\SurveillanceGateway.exe [--server=203.0.113.80:5173]
```
Use the `dotnet.exe` in `%LOCALAPPDATA%\Microsoft\dotnet` (set `DOTNET_ROOT` if you run the built executable)
Releasing to users: [../docs/CLIENT-RELEASES.md](../docs/CLIENT-RELEASES.md)

## How it talks to central

- Everything goes through `/api/v1` + `Authorization: Bearer sgw_…` — there is no user login; the key is the identity
  Central filters cameras by the key's scope in SQL (the only place it can truly be enforced)
- `Services/GatewayClient.cs` is the entire contract in one file — for outside teams to read as an example
- The client does not know path naming rules and does not build URLs itself: it asks `GET /api/v1/cameras/:id/streams` and plays what it gets
  The mp4 URL carries a stream token valid for ~5 minutes, checked only at open time, so the renderer accepts a "URL requester", not a URL, and asks again on every reconnect
- It plays `urls.mp4Raw` first (the camera's codec, no transcode) and falls back to `urls.mp4` if absent, or if the raw stream connects but has no frames
  (see [../docs/CAMERA-QUIRKS.md](../docs/CAMERA-QUIRKS.md))
- Every request sends `X-Client-Instance` (a per-machine GUID) + `X-Client-Name` → central's API Clients page can tell how many machines are using this key
- Live status: `GET /api/v1/events` (SSE), a single connection feeding the status dots on every page — a status nobody has reported yet is gray, not offline
  The initial status is read from `state.reachable` in `/api/v1/cameras` (1.3.4) — `streams.main.ready` is unusable because it stays true even when the camera is unplugged
  The client reads `camera_state` to distinguish online/offline/edge unreachable/awaiting RTSP/disabled, and adjusts the Home counts according to events
- The Home page shows a warning bar when an edge's build does not match central (`edges[]` in `/api/v1/cameras` / `/api/v1/health`, 1.3.4)
- Cameras from an edge carry `origin.reachable` in `/api/v1/cameras` (edge unreachable ≠ camera down), and the client reads this field
- PTZ: `GET/POST /api/v1/cameras/:id/ptz` — the PTZ buttons appear only for cameras that can rotate and when the key has `allow_ptz`

## Screens

The screen layout matches the Central/Edge web UI (`src/components/shell/AppShell.jsx`), whose design was borrowed from the reference edge project:

| Part | Details |
|---|---|
| Sidebar | Navigation rail (64 / 188 px, without width animation so HWNDs do not reflow) with Overview / Monitoring / Devices sections, a yellow bar on the selected page |
| Title bar / Navbar | Top bar with minimize/maximize/close buttons · breadcrumb · server address + key chip · Diagnostics, update, full screen (F11), sign out |
| Tabs | Pages open as tabs and views are kept as long as the tab is open (an arranged wall is not lost) · closing a tab = destroying the view and stopping decoding |
| Home | Isometric landing page (1.13.0) with Live Wall, Playback, Map, Camera details, AI Events, Total / Online / Offline / Other counts, and recent events |
| Video wall | VMS-style Live view (1.14.0): 1 px tile dividers, left-hand `Cameras` / `Views` / `PTZ` accordion rail, single-row toolbar · 1/4/9/16/25 grids + merged-cell layouts (`1+3`, `1+5`, `1+7`, `1+9`, `2+8`, `1+12`, custom layout editor ≤ 25 cells, 1.12.0), `Auto`/main/sub stream mode, multi-monitor secondary walls, saved views (reopenable after clearing, 1.14.1), status filter, favorites, page cycling |
| Map | Camera pins on a 3D map in WebView2 from central's `/client-map.html` (with bundled MapLibre worker) |
| Camera details | Camera information, streams, tracks |
| Player window | One window per camera, draggable to another screen · PTZ panel beside the video (hold = rotate) |
| Playback | One-day VMS-style recording timeline (`Views/PlaybackTimeline.cs`) · start/end evidence markers and MP4 + `.evidence.json` SHA256 export (`PlaybackDownloadWindow`) · header return to Live · requires `allow_playback` |
| AI events | Events from cameras / NVRs / VMS / external APIs for the last 24 hours (`GET /api/v1/ai/events`) + new events over SSE · `EventDetailWindow` supports jumping directly to Live or Playback at the event timestamp |

The Home and Camera details pages slide in with a fade-transform, while the wall and map do not animate, because **video (libVLC) and WebView2 are HWNDs —
WPF cannot draw over them or move/fade them** · for the same reason the content host shows one page at a time, and views are added/removed rather than hidden with Visibility

## Design system

- `Themes/Tokens.Dark.xaml` (main theme), `Themes/Tokens.Light.xaml`, `Themes/Controls.xaml` — the theme is switched via the first merged dictionary
- Fonts are embedded in `Assets/Fonts`: **Inter** + **Noto Sans Thai** (headings and body), IBM Plex Mono (numbers) · licenses in `Assets/Fonts/licenses/`
- The brand yellow signals one thing at a time (the selected item, the primary button) · green/amber/red are used only for status
- All strings live in `Services/Strings.cs` (EN/TH switchable at runtime) — never write literals in a view
- The maximize button uses the area above the taskbar; F11 hides the title bar and places the window over the real screen edges above the taskbar · Settings is the gear at the bottom of the sidebar

## Connection, settings and key

- The Connect page checks the address first and then the key — the error tells you where it went wrong
- The key is stored per server in `%LOCALAPPDATA%\SurveillanceGateway.Client\settings.json`, DPAPI-encrypted (CurrentUser), and saved only after central has accepted it
- `--server=` selects the remembered key for that address (used for wall displays that start themselves)
- Lost key: an administrator can view it again on central's API Clients page (the eye button), if the key was issued after the key-storage feature existed
- Signing out only disconnects · forgetting the key is a separate command that requires confirmation

## Reconnect behavior (`Video/LibVlcVideoRenderer.cs`)

- The retry budget resets when a cell changes camera and after every successful playback ("8 attempts" = 8 consecutive failures)
- There is a watchdog alongside the error event, because "no picture" does not always fire an error
- The 500 ms jitter buffer does not override libVLC's clock (see CAMERA-QUIRKS)

## SurveillanceGateway.VideoWallProbe

A tool that measures how many streams one machine can handle — 9 streams in 3x3 with no other UI

```bash
dotnet build SurveillanceGateway.VideoWallProbe/SurveillanceGateway.VideoWallProbe.csproj -c Release
bin\Release\net8.0-windows\win-x64\SurveillanceGateway.VideoWallProbe.exe --seconds=90 --log=run.csv
```
Streams are read from `streams.txt` next to the exe (one URL per line, `#` is a comment) · `--log` records a CSV every 5 s (status, frames, fps, CPU, RSS)

Result 2026-09-08 on the gateway machine: 9 H.265 passthrough cameras for 90 s — 25 fps on nearly every cell, CPU 0.4–0.9%, RSS 487 MB,
GPU decoder 13%, **encoder 0%** (through a browser it would be 9 NVENC sessions)

## What the server side needs

`urls.mp4Raw` exists when central runs with `GATEWAY_RAW_STREAMS=1` (set in `ecosystem.windows.config.cjs`) — go2rtc-sync creates the `_raw` stream
and `server.js` serves it via `/stream/<name>.mp4` with `video=copy` · with the flag off the client still works, it just plays the transcoded stream

## Not yet available

- A satellite map toggle on the client's Map page (the web UI has it)
- Showing the originating edge name / the camera's global ID on the Camera details page (searching by global ID already works in the Video wall)
- Automatic Gateway failover (Central → Regional) when the link drops — the user picks a saved Gateway by hand
- Audio in Playback (video only, by design)
- A Linux client (Avalonia) — agreed but on hold
