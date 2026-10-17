**English** | [ไทย](README.th.md)

# Surveillance Gateway

A LAN-first platform that unifies CCTV cameras from many vendors (ONVIF, NVR, RTSP, VMS) behind one API.
It runs entirely on your own network — no cloud dependency.

> **Status:** portfolio snapshot, updated October 2026. UI is mostly English with some Thai labels; the Windows client ships EN/TH.

![Central dashboard](docs/manual/images/c01-dashboard.png)

## How it works

Three tiers, one codebase:

```text
Cameras / NVRs / VMS  →  Edge (per site)  →  Regional (per region)  →  Central (national)
                                               ↓ API key                 ↓ API key
                                         Regional clients          National clients
```

| Program | Role |
|---|---|
| **Surveillance Gateway Edge** | Adds cameras, holds camera credentials and location data, relays video on request. |
| **Surveillance Gateway Regional** | Adds Edges for a region and issues API keys to clients in that region (keeps working if the Central link drops). |
| **Surveillance Gateway Central** | Adds Regionals, aggregates all cameras, issues national-level API keys. |
| **Surveillance Gateway Client** | Windows (WPF) viewer: video wall, map, camera details, playback. Connects to Central or Regional with an API key. |

Rules enforced by the API: Central adds only Regionals, Regional adds only Edges, Edges add cameras.
Every camera gets a permanent **Global ID** (`TH-<province>-<node>-<seq>`) issued once at the Edge.

## Features

- Live view through [go2rtc](https://github.com/AlexxIT/go2rtc) (H.265 transcoded to H.264, played as fragmented MP4)
- Camera onboarding: manual RTSP, ONVIF camera (with automatic Media1 → Media2 fallback, preserved service endpoints, and multi-port subnet scan), ONVIF NVR (preserving observed channel numbers), vendor API (Uniview LAPI, AXIS S30), VMS (Milestone Open Network Bridge, Dahua DSS Pro device-tree discovery)
- Dahua DSS Pro: device-tree camera discovery, live main/sub, playback, PTZ and status. One-time stream URLs go through a local RTSP relay. A DSS behind NAT that hands out its LAN address is handled automatically by falling back to the address the DSS was added with.
- Per-camera audio, off by default and enabled at the Edge. Viewers always start muted (web player and Windows client).
- Public cameras: Central can pull public HLS cameras published by government agencies, kept apart from the Edge chain and visible only to API keys that allow them.
- PTZ control, presets, camera map with pins (3D map in the client with bundled MapLibre worker)
- Playback pulled from the devices themselves (AXIS, Uniview, ONVIF Profile G, Dahua DSS, Hikvision/Dahua drivers) — the system does not record video
- Receives AI events from cameras/NVRs/VMS (e.g. perimeter, line crossing) — no inference in the gateway; see [docs/EXTERNAL-AI.md](docs/EXTERNAL-AI.md)
- Role-based access, API clients with per-group scope, atomic camera lifecycle, and audit log
- Signed (ed25519) Edge updates over a WebSocket "link"
- Offline installer kits for Windows x64, Linux x64 and Raspberry Pi 5, with matching uninstallers. The uninstallers keep the camera data and Global IDs unless asked to remove them.
- Vendor-neutral UI: no brand logo, product names only

![Edge nodes](docs/manual/images/c04-edge-nodes.png)

## Windows client

A native WPF viewer for operators (current release **1.14.2**): connect to Central or Regional with an API key, then work in tabs.

- **Video wall (VMS layout, 1.14.x)** — 1 / 4 / 9 / 16 / 25 grids plus merged-cell layouts (`1+3`, `1+5`, `1+7`, `1+9`, `2+8`, `1+12`, and a custom layout editor up to 25 cells, 1.12.0), `Auto` / `Main` / `Sub` stream policy (Auto promotes the primary merged cell to main), multi-monitor walls, accordion left rail (`Cameras` / `Views` / `PTZ`) with instant PTZ on the selected tile, and reopenable saved views after clearing (1.14.1), decoded on the workstation's own GPU
- **Investigation & Playback** — jump directly from an AI event or Live tile to Playback, mark start/end on the timeline, and export MP4 evidence with a `.evidence.json` SHA256 manifest
- **3D map & Diagnostics** — camera pins on 3D buildings served by the gateway, plus per-tile codec/FPS/reconnect diagnostics with whitelisted JSON export
- **Workspace** — isometric Home landing page (1.13.0), Graphite Dark / Light themes, Compact / Comfortable density, English / Thai UI, automatic updates

| Home | Video wall |
|---|---|
| ![Client home](docs/manual/images/w02-home.png) | ![Client video wall](docs/manual/images/w03-wall.png) |
| **Map** | **Camera details** |
| ![Client map](docs/manual/images/w05-map.png) | ![Client camera details](docs/manual/images/w06-details.png) |

See the [user guide](docs/USER-GUIDE.md), [workspace redesign notes](docs/WINDOWS-CLIENT-WORKSPACE.md), and [client notes](client-windows/README.md).

## Stack

Node.js + Express + SQLite (backend) · React + Vite + Tailwind CSS 4 + shadcn/ui (web) · .NET 8 WPF + LibVLC + WebView2 (client) · go2rtc · pm2.

## Repository layout

```
server/        backend (Express + SQLite) — same code runs Central, Regional and Edge
  gateway/     /api/v1 (API key), go2rtc sync, PTZ, global IDs, playback, SSE events
  vms/         external sources: DSS Pro, AXIS, Uniview, link transport, edge updates
  shared/      instance roles/ports/state, regions, ONVIF endpoints, DB maintenance
src/           React web UI (central / regional / edge entry points)
client-windows/  Windows client (.NET 8 / WPF)
scripts/       deploy, edge kit builders, installers, backup, simulators, check-*.cjs
docs/          documentation (see below)
```

## Documentation

| Doc | Topic |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Full user / admin / technical guide with screenshots |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Rules, workflow and pitfalls for changing the code |
| [docs/DESIGN-RATIONALE.md](docs/DESIGN-RATIONALE.md) | Why the system is shaped this way — decisions and history |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Restart, deploy, backup, logs, troubleshooting |
| [docs/EDGE-PLAN.md](docs/EDGE-PLAN.md) | Edge ↔ central design and agreements |
| [docs/REGIONAL-PLAN.md](docs/REGIONAL-PLAN.md) | Three-tier architecture |
| [docs/EDGE-KIT.md](docs/EDGE-KIT.md) / [EDGE-LINUX.md](docs/EDGE-LINUX.md) | Installing and updating Edges |
| [docs/CAMERA-QUIRKS.md](docs/CAMERA-QUIRKS.md) | Vendor-specific camera issues, and the checklist for adding a new brand / VMS / NVR |
| [docs/CAMERA-AUDIO.md](docs/CAMERA-AUDIO.md) | Per-camera audio |
| [docs/PUBLIC-CAMS.md](docs/PUBLIC-CAMS.md) | Public government cameras at Central |
| [docs/CLIENT-RELEASES.md](docs/CLIENT-RELEASES.md) | Releasing the Windows client |
| [docs/WINDOWS-CLIENT-WORKSPACE.md](docs/WINDOWS-CLIENT-WORKSPACE.md) / [WINDOWS-CLIENT-1.10.0.md](docs/WINDOWS-CLIENT-1.10.0.md) | Windows client 1.10.0 – 1.14.2 workspace, layouts, diagnostics, and investigation notes |
| [docs/EXTERNAL-AI.md](docs/EXTERNAL-AI.md) | Receiving AI events from external devices |
| [docs/architecture.html](docs/architecture.html), [pipeline.html](docs/pipeline.html), [workflow.html](docs/workflow.html), [camera-onboarding.html](docs/camera-onboarding.html), [system-flow.html](docs/system-flow.html) | Diagrams (open in a browser) |

## Quick start (development)

```bash
npm install
npm run build        # builds central / regional / edge web apps into dist/ (Node ^20.19.0 || >=22.12.0)
npm run lint
cd server && npm install && node server.js   # default port 5173
```

First login: user `superadmin`, password `superadmin` on a fresh database — **change it immediately**.

Map tiles (`server/map_data/*.mbtiles`, ~880 MB) are not included. Use the online OpenStreetMap source in Settings, or build your own MBTiles (`scripts/build-map-tiles.ps1`).
Targeted verification scripts live in `scripts/check-*.cjs` alongside `node --check`, `npm run lint`, and `npm run build`.

## License

MIT — see [LICENSE](LICENSE). Bundled third-party fonts keep their own licenses (SIL OFL, see the `licenses/` folders); go2rtc and other tools you download separately keep theirs.

powered by Warapon Wichitpan
