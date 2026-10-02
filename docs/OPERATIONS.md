# OPERATIONS — Operations Guide

Everything you need to do on the production machine (HOST, `203.0.113.80`) · updated 2026-09-30
Rules for changing code are in [CONTRIBUTING.md](CONTRIBUTING.md)

## AI source release — 2026-10-02

- Gateway build `38315ff` matches across Central, Regional, Windows Edge 101 and Ubuntu Edge 102
- The operator installed the package on both Edges through the Regional page; Online / install success and /api/instance were confirmed
- Backup before the merge: `D:\gateway-backups\daily\20261002-141316`
- Edge packages released for Windows x64 / Linux x64 / Linux arm64; signature, size and SHA-256 passed
- Windows Client `1.9.3` published as full/delta/installer; supports event images and the Edge/group/source filters
- AI is received from the source system per [EXTERNAL-AI.md](EXTERNAL-AI.md); no inference is run and no video is recorded
- Newly added cameras appear in AI Sources but the receiver must be enabled per camera; native UNV in this round supports LineCrossing on single-channel cameras (channel 1)

## What is running

| pm2 app | What it is | Ports | ecosystem | state (DB, secrets) |
|---|---|---|---|---|
| `0-go2rtc` | go2rtc for Central | 1984 API · 8555 RTSP · 8556 WebRTC | `ecosystem.windows.config.cjs` | `go2rtc/go2rtc.yaml` |
| `2-vms-backend` | Surveillance Gateway Central | 5173 | `ecosystem.windows.config.cjs` | `server/` (`vms.db`, `.gateway-key-secret`, …) |
| `1-go2rtc-regional` | go2rtc for Regional | 1994 · 8565 · 8566 | `ecosystem.regional.config.cjs` | `D:\gateway-regional\go2rtc.yaml` |
| `3-regional-gateway` | Surveillance Gateway Regional, central region (node `100`) | 5273 | `ecosystem.regional.config.cjs` | `D:\gateway-regional\` |
| `4-edge-ai` | ai-worker (YOLOX-s on GPU) — present when `aiWorker: true` in `D:\gateway-edge\edge.json` | — | `ecosystem.edge.config.cjs` | `D:\gateway-ai` (venv, models) · key `D:\gateway-edge\.ai-worker-key` |

The go2rtc API (1984 / 1994) has no auth — it listens on `127.0.0.1` only (the gateway proxies it to users via 5173/5273) · see the "Locking the go2rtc API" section below

ffmpeg is at `C:\ffmpeg\bin\ffmpeg.exe` · Node.js is at `C:\Program Files\nodejs`
The .NET SDK (for building the client) is in `%LOCALAPPDATA%\Microsoft\dotnet` of the admin user, not in Program Files

## Closed work and latest-build verification (2026-09-30)

- Gateway build `a36a2d8` confirmed to match across Central, Regional and Edge 101/102; update packages for all three platforms pass `node scripts/verify-edge-release.cjs a36a2d8`
- Deploy result: `D:\gateway-backups\regional-migration-M0\milestone-playback-a36a2d8-result.json` (`ok: true`); the transcript has the same name with a `.log` extension
- Milestone Playback was verified end to end through Regional/Central for both AXIS and TIANDY, 8 clips in total, with two seek positions each; the operator confirmed playback works · do not re-add cameras to fix playback, because the existing Global IDs must be kept
- Windows Edge 101 is on a new machine; Ubuntu Edge 102 uses Tailscale `<edge-102-tailscale-ip>:5173`, service `gw-edge` (`sudo systemctl restart gw-edge` when needed) **never call pm2 by hand on Ubuntu**
- AI is parked; the `4-edge-ai` row above is historical, not a running process · the old Edge state `D:\gateway-edge` is kept together with a backup
- Regional mirrors and Edges check for updates every 1 minute; failed downloads retry at 5/15/60 seconds or via the retry button; wait for the package to finish downloading before pressing install, and check the build/install status after the node comes back online
- Edge Cameras page → **Edit province–district for the whole group**; if the selection spans groups, use the **Edit province–district** button at the top → choose province and district → Save; Global IDs and existing pins do not change
- Old cameras with no province still need a real area chosen; new cameras added by any route are now enforced by both the web UI and the API
- Editing Markdown does not change the Gateway build and needs no restart/publish; camera counts in the notes are as observed at that time

## PM2

**Always open PowerShell with Run as administrator** — the daemon runs elevated (`PM2_HOME=D:\gw-pm2\home`)
An ordinary shell cannot connect (`EPERM \\.\pipe\rpc.sock`) and pm2 will quietly spawn a new empty daemon and leave it behind

Within one session, set the variables once and keep using `$pm2` — it is the same pm2 as the boot task (`scripts\start-gateway.cmd`),
not the `pm2.cmd` in the Administrator profile (a different version):

```powershell
$env:PM2_HOME = "D:\gw-pm2\home"
function pm2x { & "C:\Program Files\nodejs\node.exe" "D:\gw-pm2\npm\node_modules\pm2\bin\pm2" @args }
$pm2 = "pm2x"
```

| Goal | Command |
|---|---|
| Show status | `& $pm2 list` |
| Restart after changing `server/` | `& $pm2 restart 2-vms-backend 3-regional-gateway` |
| Restart go2rtc | `& $pm2 restart 0-go2rtc 1-go2rtc-regional` (cuts off everyone currently watching) |
| Follow logs live | `& $pm2 logs 3-regional-gateway --lines 100` |
| Change env in an ecosystem file | `& $pm2 delete 3-regional-gateway` then `& $pm2 start D:\gateway-dashboard\ecosystem.regional.config.cjs --only 3-regional-gateway` |

- `PM2_HOME` in the shell does not select the daemon (Windows uses a fixed pipe), but pm2 computes the CLI-side log path from it —
  if it is not set, `pm2 start` sends logs to `~\.pm2\logs` (the edge ecosystem has pinned its logs to `D:\gw-pm2\home\logs` since 2026-09-29)
- The warning `In-memory PM2 is out-of-date` needs no action · **never run `pm2 update`** (it restarts everything)
- **Never run `node server.js` by hand on 5173/5273** — it collides with the real ports and the process lingers after the shell closes

### At boot

The Scheduled Task **"CCTV Gateway (pm2 resurrect at boot)"** (At system start up, user admin)
runs `D:\gateway-dashboard\scripts\start-gateway.cmd` → `startOrRestart` from `ecosystem.windows.config.cjs`
and `ecosystem.edge.config.cjs` (if the file exists); logs are appended to `D:\gw-pm2\home\boot-start.log`

- It starts from the ecosystem files in git and **does not resurrect** — so `pm2 save` has no effect on boot
- New apps must be added to an ecosystem file or they disappear after a reboot
- If an ffmpeg window pops up on the desktop, someone ran pm2 start/restart for go2rtc from a shell with a screen
  (inside the task there is no desktop, so it is not visible) — harmless; if it bothers you, reboot or re-run the task

## Deploy

### Migration steps to Central → Regional → Province Edge

The plan and test criteria are in [REGIONAL-PLAN.md](REGIONAL-PLAN.md) sections 6–7 · every PM2 command in this phase must use an Administrator PowerShell as described in the PM2 section above

1. **M0 — back up and inventory the data**: run `backup-windows.ps1` and verify that `central/vms.db` and `edge/vms.db` were produced together with secrets/config; export the list of cameras, NVR/VMS sources, coordinates, walls, users, roles, and the API keys that must be recreated; verify the backup can be read back, before touching the old Edge `D:\gateway-edge`. Never use the old Edge database as the Regional database

   If running from a worktree, specify the real source, and keep the M0 snapshot separate from the daily backups that rotate away:

   ```powershell
   powershell -ExecutionPolicy Bypass -File D:\gateway-dev\backup-windows.ps1 -SourceRepo D:\gateway-dashboard -Destination D:\gateway-backups\regional-migration-M0 -SkipPrune
   ```
2. **M1 — separate Edge machines**: the operator provides a new Edge to replace Edge 001 and adds the cameras themself; Ubuntu Edge 002 stays on the existing machine. Assign node numbers from the region's block and change the link destination to Regional. There is no need to start a new Edge on :5373 on the Central machine
3. **M2 — switch :5273 to Regional**: back up again, stop the old Edge's PM2 apps `3-edge-gateway`, `1-go2rtc-edge`, `4-edge-ai`, verify ports 5273/1994/8565 are free, create a new `D:\gateway-regional\regional.json` using `role: "regional"`, `region: "central"`, `node: "100"`, `stateDir: "D:\\gateway-regional"`, `port: 5273`, `go2rtcApi: 1994`, `go2rtcRtsp: 8565`; create Regional's `go2rtc.yaml` with the API listening on loopback only, start `ecosystem.regional.config.cjs`, verify `/api/instance` reports `regional`, issue keys for Clients at Regional and tokens for province Edges from the Edge Nodes page. Then point the province Edges' link at Regional and test cutting only the Regional → Central link: a Client pointed at Regional must still see the catalog and video
4. **M3 — connect the country**: at Central, add Regional as link / issue a token for node `100`, then put `centralUrls` and `centralToken` in `regional.json` and run `deploy.ps1 -ReloadRegionalConfig`. Verify Central sees the existing global IDs of the province Edges, per-region/province permissions, and automatic reconnection. Do the other provinces and regions one set at a time

`scripts/start-gateway.cmd` starts the old Edge as long as there is no `regional.json`; once the file exists it starts Regional instead; a province Edge on this machine is optional and only when a config exists after M2. `deploy.ps1` refuses to run if the old Edge's PM2 apps are still present, to prevent port collisions. Never create `regional.json` before stopping the old Edge and checking the backup

Steps M1–M3 must still be verified against real devices, especially Tiandy and DSS playback/PTZ and the genuinely signed update packages, before being considered ready for use

| What you changed | What to do next |
|---|---|
| `server/**` | `node --check` → commit → **`scripts\deploy.ps1`** (admin shell: backup, restart, build check, web build, publish to link-mode edges) |
| `src/**`, `index.html`, `edge.html` | `npm run build` (no restart needed) — if it uses a new API, restart the backend first |
| `client-windows/**` | bump `<Version>` → `scripts\build-client-release.ps1` ([CLIENT-RELEASES.md](CLIENT-RELEASES.md)) |
| Releasing a version to link-mode edges | `deploy.ps1` publishes every time on its own (or `build-edge-kit.ps1 -UpdatesOnly` alone, ~30 s) → wait ≤ 5 minutes → on Edge Nodes press the arrow button on the edge's row · publish once per version — an offline edge gets the offer by itself when it reconnects · to have the install kits re-downloaded use `build-edge-kit.ps1 -Publish` ([EDGE-KIT.md](EDGE-KIT.md) section 5) |
| `ecosystem.*.config.cjs` | `pm2 delete` + `pm2 start … --only …` for that app |
| `go2rtc/go2rtc.yaml` | do not edit by hand — the backend syncs streams into go2rtc itself via REST (except locking the API with `scripts/lock-go2rtc-api.cjs`) |

The `build` number = the latest commit that touched `server src ai-worker scripts package.json ecosystem.edge.config.cjs`
(the source of truth is `BUILD_PATHS` in `server/shared/instance.js` — deploy.ps1, build-edge-kit.ps1 and deploy-edge.sh use the same set)
Commits that only touch `docs/` or `client-windows/` do not change the build number

Verify after deploy:

```bash
curl http://203.0.113.80:5173/api/instance
curl http://203.0.113.80:5273/api/instance
```
You should get `{"role":"central","node":"000",...,"build":"<commit>"}` and `{"role":"edge","node":"001",...}`

## Backup and restore

| What | In git? | Backed up by |
|---|---|---|
| Code | yes (local repo, no remote) | git |
| `server/vms.db` (central) | no | `.\backup-windows.ps1` (VACUUM INTO) |
| `D:\gateway-edge\vms.db` (edge) | no | `.\backup-windows.ps1` (since 2026-09-23 · `-EdgeStateDir` if the edge is elsewhere) |
| Secrets on both machines (`.gateway-key-secret`, `.stream-token-secret`, `.session-secret`, `.ai-worker-key`, `.rtsp-credentials.json`, `go2rtc.yaml`) + `D:\gateway-edge\edge.json` | no | `.\backup-windows.ps1` · **losing `.gateway-key-secret` = issued API keys can no longer be viewed, and central cannot connect to the edge until a new key is entered** |
| `.env` (Google Maps key) | no | `.\backup-windows.ps1` |

- Each run is a folder `D:\gateway-backups\daily\<yyyyMMdd-HHmmss>\{central,edge}\` · kept 30 days but the 3 most recent runs are always kept
  (old-style files placed directly in `daily\` before 2026-09-23 are not deleted automatically) · `.\backup-windows.ps1 -List` shows the available runs
- A failed backup = exit code 1 (the Scheduled Task shows a failed result; see Task Scheduler → Last Run Result)
- **Set up the nightly backup** (once, in an admin shell — uses the same account/S4U mode as the boot task, no one needs to be logged in):
  ```powershell
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\gateway-dashboard\backup-windows.ps1'
  $t = New-ScheduledTaskTrigger -Daily -At 02:00
  $p = New-ScheduledTaskPrincipal -UserId 'HOST\admin' -LogonType S4U -RunLevel Limited
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName 'CCTV Backup (nightly)' -Action $a -Trigger $t -Principal $p -Settings $s
  ```
  `-StartWhenAvailable` = if the machine was off at 02:00 it runs as soon as it is turned on · test: `Start-ScheduledTask 'CCTV Backup (nightly)'`
- The backups live on the same D: disk as the live data: they protect against mistakes, not against disk failure
- `D:\gateway-backups\vm-final` = the final state of the VM era; do not delete until you are sure the VHDX is no longer needed

Restoring a DB: stop that app (`pm2 stop 2-vms-backend` or `3-edge-gateway`) → delete `vms.db-wal`, `vms.db-shm` → place `<run>\central\vms.db`
(or `edge\vms.db`) as that machine's `vms.db`, together with the secrets from the same folder → `pm2 start` · **always restore the DB together with the `.gateway-key-secret` from the same run**
(the keys in the DB are encrypted with that secret)
The central web UI has Backup/Restore buttons in System Settings that do the same thing (and keep a copy before restoring).

## Clear all cameras (start the system fresh)

```bash
node scripts/reset-cameras.cjs                        # central (server/vms.db)
node scripts/reset-cameras.cjs D:\gateway-edge\vms.db    # edge — must run in an admin shell because the file belongs to an elevated process
```
Clears: cameras, camera sources (Digifort/edge), AI data (`ai_events`, `ai_rules` and the old camera-side AI tables), `camera_deletions`, logs · keeps: users, roles, API keys
(image files in `ai-snapshots/` are not deleted — delete them yourself if wanted)
A copy from before the clear is in `backups/` (git-ignored because it contains camera passwords) · afterwards restart that app so go2rtc drops the old streams

## Logs

| What | Where |
|---|---|
| pm2 | `<PM2_HOME of whoever started the app>\logs\<app>-out.log`, `-error.log` — find the real location with `& $pm2 describe <app>` (the out/error log path lines) or `& $pm2 logs <app>` |
| Boot | `D:\gw-pm2\home\boot-start.log` |
| System events (login, adding cameras, edge sync) | Web UI → System Logs (the `logs` table) |

Since 2026-09-29 `ecosystem.edge.config.cjs` pins the logs of `1-go2rtc-edge`, `3-edge-gateway`, `4-edge-ai` to
`D:\gw-pm2\home\logs\` (previously they landed in `C:\Users\Administrator\.pm2\logs\` when started from a shell without `PM2_HOME`)
and every app in both ecosystems has a timestamp in front of each line (`log_date_format`) — takes effect after `pm2 delete` + `pm2 start` of that app (see Deploy)
`-error.log` files accumulate across eras — check the timestamp of a line before concluding the system has an error

## Locking the go2rtc API

The go2rtc API has no auth: anyone who can reach 1984/1994 can read camera URLs (with passwords) and add/remove streams — it must listen on `127.0.0.1` only
The gateway already talks to go2rtc over loopback, and proxies MSE/WebRTC/snapshots to users via 5173/5273, which check tokens
RTSP (8555/8565) and WebRTC (8556/8566) still listen on all interfaces as before (central/clients need to reach them)

The new yaml generators (`setup-edge.ps1`, `setup-edge.sh`, `edge-sim.ps1`, the flash-drive kit installer) already write `127.0.0.1`
Existing files are fixed with a script (admin shell — the file belongs to an elevated process · backs up `<file>.bak` before writing · safe to re-run · does not print stream URLs):

```powershell
node D:\gateway-dashboard\scripts\lock-go2rtc-api.cjs --dry-run      # preview what would change
node D:\gateway-dashboard\scripts\lock-go2rtc-api.cjs                # go2rtc\go2rtc.yaml + D:\gateway-edge\go2rtc.yaml
& $pm2 restart 0-go2rtc 1-go2rtc-regional                              # go2rtc reads api.listen only at start (briefly cuts off viewers)
netstat -ano | findstr ":1984 :1994"                               # must show only 127.0.0.1:1984 / 127.0.0.1:1994
```

Status 2026-09-29: fully locked on central (1984), edge 001 (1994) and edge 002 (1984) · if you accidentally `pm2 delete` the central apps
start them again with `pm2 start D:\gateway-dashboard\ecosystem.windows.config.cjs` (the paths in the file are absolute now, so you can run it from any folder)
and **paste commands one line at a time** — once two commands pasted together as one line meant pm2 did not start central (outage until re-run on 2026-09-29)

**edge 002 (Linux) runs as the systemd service `gw-edge`, not pm2** (do not run `pm2` there — it spawns an empty daemon; close it with `pm2 kill`)
— state is in `/var/lib/gw-edge` (`--state-dir` of setup-edge.sh if moved elsewhere):

```bash
sudo -u <service user> node ~/gw-edge/scripts/lock-go2rtc-api.cjs /var/lib/gw-edge/go2rtc.yaml
sudo systemctl restart gw-edge
ss -ltnp | grep ':1984'                                            # must be 127.0.0.1:1984
```
Edge from a flash-drive kit: `node <root>/app/scripts/lock-go2rtc-api.cjs <stateDir>/go2rtc.yaml` (Windows: `<root>\state`) then restart the kit's service
(the script reaches the machine together with the next update package)

## Setting up an edge on a new machine

**For a new edge on site, use the flash-drive install kit — [EDGE-KIT.md](EDGE-KIT.md)** (`scripts\build-edge-kit.ps1` → `install-windows.cmd` / `install-linux.sh`)
**For a self-installed Linux machine in the old style (edge 002) use [EDGE-LINUX.md](EDGE-LINUX.md)** — below is an edge on a Windows machine using pm2 (edge 001)

1. Install Node.js 22, ffmpeg (`C:\ffmpeg\bin`), pm2, git — then clone this repo
2. Put machine-specific values in `<stateDir>\edge.json` (do not edit files in git): `node` (edge number, unique nationwide — see the table in [EDGE-PLAN.md](EDGE-PLAN.md)),
   `province`, `publicHost` (the IP central can reach, e.g. Tailscale), `stateDir`, ports · no file = edge 001's values on HOST
   (see the list of keys in the header of `ecosystem.edge.config.cjs`)
3. `npm install` and `cd server && npm install` · `npm run build`
4. `powershell -ExecutionPolicy Bypass -File scripts\setup-edge.ps1` — creates the state folder + `go2rtc.yaml`
5. `pm2 start ecosystem.edge.config.cjs` and set up a boot task like `start-gateway.cmd`
6. Open the edge web UI → log in `superadmin`/`superadmin` → **change the password** → add cameras → issue a key under Central Access
7. At central → Edge Nodes → Add Edge
8. Edge firewall: open the gateway port and go2rtc RTSP to **the central IP only**

**An edge that central cannot reach (behind NAT)** — skip steps 7–8 and use link mode instead ([EDGE-PLAN.md](EDGE-PLAN.md), link section):
central → Edge Nodes → Add Edge → "Edge connects up by itself" → copy the URL + token into `centralUrl` / `centralToken` in the edge's `<stateDir>/edge.json`
(Linux: `scripts/setup-edge.sh --central-url … --central-token …`) then `pm2 delete 3-edge-gateway` + `pm2 start ecosystem.edge.config.cjs --only 3-edge-gateway`
The edge must be able to reach central's port 5173 and RTSP 8555 · there is no TLS yet — over Tailscale/LAN only

## Testing without touching production

`scripts/edge-sim.ps1` starts a simulated edge (5283, node 999) + a test central (5383) with their own go2rtc
State is at `D:\gateway-sandbox\edge-sim`, the web UI is served from `D:\gateway-sandbox\edge-sim\dist`

```bash
npx vite build --outDir D:\gateway-sandbox\edge-sim\dist --emptyOutDir
powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\edge-sim.ps1
powershell -ExecutionPolicy Bypass -File D:\gateway-dashboard\scripts\edge-sim.ps1 -Stop
```

- **Data in `D:\gateway-sandbox\edge-sim` from before 2026-09-23 points at port 5273**, which is now the real edge — delete the `edge` and `central` folders
  in `D:\gateway-sandbox\edge-sim` before first use (needs an admin shell if it was ever run with admin rights)
- A simulated instance that adds real cameras opens extra sessions to the real cameras — run `-Stop` when finished
- Whatever shell started it, you must stop it with the same privileges (a process from an admin shell cannot be closed from an ordinary one)
- Testing with a fresh DB = a fresh install — use it when touching the schema, to catch columns that have no migration

## Common troubleshooting

| Symptom | Check |
|---|---|
| Empty menu, only Dashboard left | The user has no `role_id` / permissions — `GET /api/me` must have `permissions` · log out and log in again |
| Old web UI / new button not showing | `npm run build` was forgotten or the browser cached it — Ctrl+F5 |
| New API returns 404 | The backend was not restarted — check `build` in `/api/instance` |
| Camera from edge shows "unknown status" | Check that central can reach the edge on the Edge Nodes page and `curl http://<edge>:5273/api/instance`; if video plays, compare `state.reachable` of `/api/v1/cameras` at the Edge versus Central, and press Sync on Edge Nodes to receive the initial state of new cameras |
| Central does not see a camera just added at the edge | Wait for the 10-minute cycle (link: 5 minutes) or press Sync on the Edge Nodes page |
| Link-mode edge shows "unreachable" | The edge log lines `[Edge link]` · wrong token = 401 on connect · duplicate node number = central rejects (the message is in both sides' logs) |
| Link camera opens to a black screen | The edge cannot push up — the edge must be able to reach central's RTSP 8555 · edge log line `push … stopped` |
| Live menu missing | The role lacks `menu.live` (seed roles get it by themselves after a backend restart) · PTZ on the web needs `device.ptz` |
| PTZ via central rejected | The key central holds with the edge must have "control PTZ" ticked on the edge's Central Access page |
| Camera connects but black screen | [CAMERA-QUIRKS.md](CAMERA-QUIRKS.md) |
| `pm2` has no effect whatever you do | The shell is not elevated — an empty daemon was spawned; close the `node … pm2\lib\Daemon.js` process that just appeared |
| Blank map | Needs internet (OSM/Esri tiles through the proxy + cache in `server/map_data/`) or switch to MBTiles in System Settings |
