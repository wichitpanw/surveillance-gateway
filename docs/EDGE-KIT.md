# Edge install kit on a flash drive (offline)

For new edges at sites with no internet: copy one folder to a flash drive, plug it in, double-click, done.
Supports **Windows x64** (mini PC) and **Linux arm64** (Raspberry Pi 5), plus **Linux x64** for ordinary Ubuntu machines.

An edge installed from this kit always connects to its parent in **link** mode (the edge connects up by itself — [EDGE-PLAN.md](EDGE-PLAN.md)).
Since the three-tier system (2026-09-30) an edge's parent is **its region's Regional** — every "at central" step in this document is done on the Regional's Edge Nodes page
(the install kits can be downloaded from both Central and the Regional, which mirrors them)

## Overview

```
HOST (has internet)                   central (web UI)                    site (no internet)
build-edge-kit.ps1 ──► Edge-Kit-<build>      Edge Nodes → issue token ──► edge-<number>.json
                              └──────────── flash drive ─────────────┘
                                                  └──► install-windows.cmd / install-linux.sh
```

## 1. Build the install kit (once per version — on the HOST)

```powershell
powershell -ExecutionPolicy Bypass -File <repo>\scripts\build-edge-kit.ps1
```
- Output: `D:\gw-edge-kits\Edge-Kit-<build>\`, ~1 GB (all three platforms) · build only the ones you need: `-Platforms windows-x64,linux-arm64`
- Downloaded files are kept in `D:\gw-edge-kits\cache\` and are not downloaded again next time
- The code comes from the current **commit** (not uncommitted files) · `build` = the latest commit that touched `server src scripts package.json ecosystem.edge.config.cjs`, matching BUILD_PATHS in server/shared/instance.js
- Inside each platform: `app\` (server, scripts, ecosystem, dist, node_modules, BUILD) and `bin\` (node 22, ffmpeg 8.1 static, go2rtc 1.9.14)
- `sqlite3` is native — the script swaps in the `node_sqlite3.node` matching the platform from the official prebuilt
- **`-Publish`** (use it every time you release a real version) adds two things for central:
  - `server\edge-updates\<platform>\` update package `app-<platform>-<build>.tar.gz` (~12 MB) + a signed `manifest.json` — section 5
  - `server\edge-kits\` per-OS install kits (`.zip` for Windows, `.tar.gz` for Linux, ~120 MB) + `kits.json` — downloadable from the Edge Nodes page (section 2)
  - Takes effect immediately, no restart needed · requires the signing key (section 6)
- The kit contains only the gateway and the tools for receiving AI results from the source — no Python/GPU inference

## 2. Download the install kit + issue the config file at central

Edge Nodes → the **"Download Surveillance Gateway Edge installer"** box → choose Windows (x64) / Raspberry Pi 5 (Linux arm64) / Linux (x64) → download
- Windows gets a `.zip` → extract it onto the flash drive · Linux gets a `.tar.gz` → `tar -xzf …` (keep the execute permissions)
- The kit contains only the installer for that OS + `README-TH.txt` · no secrets · the sha256 is shown so you can verify the file
- The link is a single-use ticket valid for 5 minutes (`POST /api/edge-kits/<file>/ticket` → `/edge-kit-download/<ticket>`) and requires the `device.manage` permission

Then issue the machine's config file:

Edge Nodes → **Add Edge** → "Edge connects up by itself" → name, **edge number** (the system suggests the next free number — must not repeat anywhere in the country), province code → issue token
→ tick the central routes this edge can reach → **download edge-<number>.json**

- The number is reserved at central immediately (`GET /api/edges/next-node`, `POST /api/edges/link {label, node}`)
- The file contains `node, province, label, centralUrls, centralToken` — **the token is a secret**; the installer deletes the file after installation finishes
- Put the file next to `install-windows.cmd` or at the root of the flash drive · multiple files are fine, the installer asks which one this machine uses

## 3. Install on site

| | Windows mini PC | Raspberry Pi 5 / Linux |
|---|---|---|
| Command | double-click `install-windows.cmd` (asks for admin rights) | `sudo bash install-linux.sh` |
| Program | `C:\GW-Edge\app`, `C:\GW-Edge\bin` | `/opt/gw-edge/app`, `/opt/gw-edge/bin` |
| Data (DB, secrets, edge.json) | `C:\GW-Edge\state` (readable only by SYSTEM/Administrators) | `/var/lib/gw-edge` (system user `gw-edge`, 700) |
| Start at boot | Scheduled Task **Gateway Edge** (SYSTEM) | systemd `gw-edge.service` |
| 2 a.m. backup | Scheduled Task **Gateway Edge Backup** → `edge-backup.cjs` | cron `/etc/cron.d/gw-edge-backup` → `backup-edge.sh` |
| firewall | inbound TCP 5173 + inbound UDP for node.exe (ONVIF discovery) | ufw (if enabled): 5173/tcp + UDP from the machine's subnet |
| log | `C:\GW-Edge\state\logs\` | `/var/lib/gw-edge/logs/` |

What the installer does: writes `state/edge.json` (values from the central file + standard ports 5173/1984/8555 + `publicHost` from the machine's IP
+ the kit's `go2rtcBin`/`ffmpeg`) → creates `go2rtc.yaml` and the RTSP account (`setup-edge.ps1` / `setup-edge.sh`) → starts the system
→ waits for `/api/instance` to answer → shows the latest link status message → deletes the central file

When done: open `http://<edge IP>:5173/` → log in as **superadmin / superadmin → change the password immediately** → add cameras
At central, the Edge Nodes page must show that number as Online with a build matching central.

## 4. Updating a version with a flash drive

Build a new kit (section 1) → copy it to the flash drive → run the same installer again — **no edge-<number>.json file is needed**
The installer stops the system, replaces the whole `app/` and `bin/` folders, and starts again — `state/` (DB, cameras, secrets) is not touched
If a new edge-<number>.json is present, central's token/address is replaced as well.

## 5. Updating over the link (no site visit)

```
build-edge-kit.ps1 -Publish ──► central stores the signed package ──(link: update)──► edge
                                                                edge verifies signature → downloads (HTTP + link token) → verifies sha256
                                                                → "new version available" banner on the edge web UI → a person clicks "Install now"
                                                                → edge-run: app → app.prev, extract new app → start → wait up to 5 min for the central link
                                                                   link up = success · not up = automatic rollback to app.prev (the broken version is kept in app.failed)
```
- Central offers the package when an edge connects the link (hello carries `platform`, `runner`) and checks for new packages every 5 minutes for edges that stay connected
- **You can click from central:** Edge Nodes → the edge's row showing "downloaded" → arrow button (or **Update all** when several are ready)
  → central sends `update.apply` down the link → the edge installs exactly as if clicked on its own web UI · no SSH, no sudo (`device.manage` permission)
- Or on the edge machine: open the edge's web UI → the top bar shows the version and stage → click **Install now** (requires the `system.maintain` permission)
  → video pauses for about 5–10 seconds → the bar shows the result (success / rollback with reason)
- Central's Edge Nodes page shows each edge's update status: downloading / awaiting install / success / rolled back
- Installation works two ways depending on the supervisor:
  - **edge-run** (installed from the kit): swaps the `app` ↔ `app.prev` folders
  - **pm2 on Linux** (edge 002, deploy-edge.sh style): the gateway swaps `server scripts dist ecosystem package.json BUILD` in the repo
    (the old files go to `.update-prev/`) then exits so pm2 starts the new version · the watchdog `scripts/edge-update-watchdog.cjs` (copied to `<state>/updates/`
    and run as a separate process) waits 5 minutes for the new version's `link-ok.json`; if it never appears it restores the old files and stops the gateway so pm2 starts the old version · log: `<state>/updates/watchdog.log`
    Packages without a watchdog (versions before `c6ecab4`) are rejected at download time
  - **edge 001 (pm2 on Windows)** notifies only — that repo is the central production, never swap files yourself (edge 001 was retired on 2026-09-30)
- Central does not offer a package older than the edge's build (it asks git: if the package is an ancestor of the edge's build, it is not offered)
  — for example when deploy-edge.sh went first and `-Publish` has not been run yet
- **Always run `-Publish` from an admin PowerShell** — files in `server\edge-updates\` belong to whoever created them first, and an ordinary shell cannot delete old versions
- Only `app/` is sent · whenever `bin/` (node, ffmpeg, go2rtc) changes you must use a flash drive (section 4)
- The `edge-run.cjs` supervisor itself becomes the new version on the machine's next boot
- Files on the edge: `<state>/updates/` — `pending.json`, `apply.json`, `last-result.json`, `link-ok.json`, the package
- API: central `GET /api/edge-updates` (published versions), `GET /api/edge-link/update/<platform>/<file>` (Bearer link token)
  · `POST /api/edges/<id>/update` (central orders an edge to install) · edge `GET /api/edge-update`, `POST /api/edge-update/apply`

Tested (real): edge 002 (pm2, Ubuntu), clicking the button from central → swapped `c6ecab4` → `6c051d4` → `24cd08d`, the watchdog confirmed each round in ~5 seconds
Tested (simulated instance): an edge with fake build `aaaaaaa` received the offer → downloaded 11.7 MB → clicked install → swapped to `5b2c861` successfully in 5 seconds
· shutting central down during installation → after the timeout it rolled back to the original version, and `last-result.json` reported `rolledBack: true`

## 6. Package signing key

The link has no TLS yet — so an edge trusts only packages whose manifest is signed with ed25519 and matches the public key shipped with the kit
- Private key: `D:\gw-edge-kits\signing\edge-update-key.pem` (outside git, ACL limited to the user/Administrators/SYSTEM) — `backup-windows.ps1` backs it up every night
- Public key: `scripts/edge-kit/edge-update.pub.pem` (in git, ships with every kit)
- First-time creation: `node scripts\edge-update-key.cjs --keygen` then commit the public key · manual signing: `--sign <file> --build <b> --platform <p>`
- **If the key is lost or changed, every edge rejects new packages** until it is updated by a flash drive kit that carries the new public key

## Process supervisor `scripts/edge-run.cjs`

Machines installed from the kit **do not use pm2** (it needs a global install and runs into permission problems on Windows — see docs/CONTRIBUTING.md)
`node edge-run.cjs --config <state>/edge.json` starts the apps listed in `ecosystem.edge.config.cjs` (the same file as pm2)
- A dead app is restarted within 2 s (rapid repeated deaths back off up to 30 s) · each app has its own log file, rotated at 20 MB · the supervisor's own messages are in `logs/edge-run.log`
- Kills leftover processes from the previous run according to `edge-run.pids`

Edge 102 (the original Ubuntu machine, systemd `gw-edge` → pm2-runtime) still uses the original method · edge 001 (pm2 on the HOST) is retired

## Uninstalling (Windows)

1. Remove the edge on the Regional's Edge Nodes page first — its token stops working immediately and its cameras disappear from Regional/Central
2. On the edge machine double-click `uninstall-windows.cmd` (in the install kit) → stops and removes the Scheduled Tasks `Gateway Edge` + `Gateway Edge Backup`, ends the processes under `C:\GW-Edge`, removes the `Gateway Edge*` firewall rules, deletes `app\` and `bin\`
3. By default it **keeps `state\`** (vms.db, token, camera passwords, backups) — reinstalling brings back the same cameras and Global IDs
   · `uninstall-windows.cmd -RemoveData` deletes the whole folder (asks you to type the edge number to confirm) · use `-Root` for a different install location
4. Delete any leftover `edge-<number>.json` (it holds the token)

Linux: `sudo bash uninstall-linux.sh` — removes the `gw-edge` service, the backup cron entry, the `Gateway Edge*` ufw rules and `/opt/gw-edge` · keeps `/var/lib/gw-edge` (`--remove-data` deletes it together with the `gw-edge` user)
· it refuses machines whose unit was not written by install-linux.sh — **Edge 102 (the original Ubuntu machine, pm2-runtime) is uninstalled by hand**

## Limitations / not yet tested

- The Windows installer has been tested on the HOST only with `-DryRun` (port 5173 belongs to central) — the Scheduled Task and firewall must be tried on a real mini PC
- No Raspberry Pi has been available for testing — the `linux-arm64` kit uses the official node / go2rtc / ffmpeg binaries and the sqlite3 prebuilt
- The link has no TLS yet (use it over LAN/VPN) — update packages are protected by signature, but tokens and video still travel unencrypted
- The ffmpeg in the kit is a GPL build, for internal use within an organization
- Surveillance Gateway Client exists only for Windows — on Linux use central's web Live (the Linux client is on hold)

## AI in the current kit (since 2026-10-02)

Code since Gateway 10ea98f has no inference worker or Python/GPU installer, and the old kit flags for it are gone
The installer removes the old inference keys from the config while keeping cameras and receive sources
After installing, add cameras, then enable a receiver per camera in AI Sources
