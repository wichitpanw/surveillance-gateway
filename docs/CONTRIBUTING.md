# Contributing to Surveillance Gateway — rules for people and AI editing this repo

Read this file before changing anything. The system overview is in [README.md](../README.md); the reasoning behind the design is in [DESIGN-RATIONALE.md](DESIGN-RATIONALE.md).
Operational commands (restart, backup, logs) are in [docs/OPERATIONS.md](OPERATIONS.md).

## External AI agreement

AI results are received from cameras / NVRs / VMSs / external APIs. Central, Regional and Edge do not run inference.
Edge receives and converts events → Regional aggregates within the region → Central aggregates all regions; the receiving sources are configured under AI Sources.
This agreement supersedes the older "AI on the Edge GPU" items and the older prohibition on merging camera-side AI.
Details, limitations and tests: [docs/EXTERNAL-AI.md](EXTERNAL-AI.md)
New cameras of supported brands appear in AI Sources, but the receiver must be enabled separately for each camera.

## 1. What to know before touching anything

- **This repo may be a production deployment.** A host can run code straight from the checkout directory.
  There is no separate deploy step: edit the file and restart = live immediately.
- **Three programs, one codebase**: Central, Regional and Edge. A host can run Central (5173) and Regional (5273) from the same `server/` directory.
  Fixing the backend once affects both → restart both `2-vms-backend` and `3-regional-gateway`, then publish/update Edges that run on separate machines.
- **The three-tier system is live** — see [docs/REGIONAL-PLAN.md](REGIONAL-PLAN.md).
  Central :5173 → Regional :5273 (node 100) → Edges on separate machines (101/102); an Ubuntu Edge uses :5173, not :5373 · state is separate per instance
  · A Regional issues API keys to Clients in its region that connect to the Regional URL directly, and live view must keep working even when the Regional–Central link is down
  · Central issues keys for nation-wide viewers · AI events across Regionals are parked
  · Regional nodes use 100/200/.../600, Edges in a region use +1 to +99, 001–099 are reserved for legacy nodes
- **System model: Edge adds cameras · Regional adds Edges · Central adds Regionals** — do not add a path for Central to add cameras directly
  (`edgeOnly` / `centralOnly` routes in `server/server.js` enforce this)
  - Data owned by the Edge (name, coordinates, province, global ID, `enabled`) is edited at the Edge only — Central sync overwrites it.
    Pinning at Central returns 403 (`pinAtEdge`) · Central does not issue global IDs for `edge_relay` cameras
  - **The Edge has no viewing UI** (Live / live-view button) — the Edge relays video; viewing happens at Central and in the client
  - A child connects to its parent in one of two ways: pull (the parent connects into the child with an API key) and link (the child opens a WebSocket upward — `server/vms/edge-link-*.js`); an Edge must connect to a Regional only
  - Every way of adding a camera must specify a province and a district that match each other; the area of a whole group / selected cameras can be changed at the Edge via `PATCH /api/cameras/region`, with the Global ID and coordinates unchanged
  - One province can have several Edges, use Remark to identify the site, do not add Sub-edges; 99 Edges per region 
  - An Edge holds full-resolution video and sends only events upward; Central aggregates events / search / forwarding and **does not run inference and does not store video**
  - **The system does not record video itself** — the Edge recorder was removed · playback is pulled from the device via
    `localSource` in `server/gateway/playback.js` · AXIS S30 (VAPIX/RTSP) and Uniview NVR (LAPI/RTSP replay) are supported
    · Hikvision / Dahua / ONVIF Profile G (SD-card cameras, other NVR brands, Milestone) are written and awaiting tests against real devices
    (`server/vms/device-playback.js` selects the path) · Dahua DSS Pro (VMS) works (`server/vms/dss*.js`) · Digifort returns 501 pending API documentation · do not bring the recorder back without agreement
  - **Camera-side AI is not merged into the system** — no option in edge.json, nothing sent into `ai_events`, `POST /api/v1/ai/events`
    accepts only `origin: edge-ai` · the code in `server/gateway/analytics/` stays, do not delete it, but do not wire it back in without agreement
  - Full plan and ordering: [docs/EDGE-PLAN.md](EDGE-PLAN.md), section "Phase 5"

## 2. Language

- Reply to users in the project's working language, concisely — technical terms, file names, function names and error messages stay in English
- Function-level code comments are written in English (except `.cmd` files, which must be ASCII — see section 6)
- Commit messages are in English: the first line states the outcome, followed by a paragraph explaining why
- Always use metric units · if you do not know, say you do not know — do not guess

## 3. Rules that must not be broken

1. Central's port `5173` is fixed — clients and every external system depend on it
2. SQLite only — the DB file location comes from `stateFile('vms.db')` (`server/shared/instance.js`); never hard-code a path
3. **Camera passwords must never cross `/api/v1`** — `cameras.rtsp` has the password embedded, `onvifPass` is plaintext
   every query in `server/gateway/index.js` must list columns as a whitelist (`SAFE_CAMERA_COLUMNS`); never `SELECT *`
4. `/api/v1` must stay **above** `app.use('/api', checkAuth)` — move it below and every v1 request will be asked for a username/password
5. Keep the text **"powered by Warapon Wichitpan"** everywhere it already appears
6. A new screen = a new file in `src/components/` (dialogs in `src/components/modals/`); never stuff it into `App.jsx`
7. **A camera's Global ID must never change** once issued (`server/gateway/identity.js`) — Central binds walls/permissions to it
   · in the three-tier system the province Edge issues `TH-<province>-<node>-<sequence>` once, and Regional/Central pass the same value along
   · province/district/site are location data and are not embedded in the global ID
8. State files (`vms.db*`, `.gateway-key-secret`, `.stream-token-secret`, `.rtsp-credentials.json`, `go2rtc.yaml`, `backups/`)
   **must never enter git** — they contain camera passwords or keys
9. Commit only when the user asks · never push / force / rewrite history

## 4. Standard workflow

### Multi-step work: do it in a worktree, not in the production checkout

pm2 runs the files in the production checkout as they are on disk, **including uncommitted edits** — restarting while a change is half-finished
means production runs half-baked code even though `build` still shows the old commit (this really happened). So develop in a separate worktree (branch `dev/*`,
with `node_modules` and `go2rtc` as junctions to the real ones), test with `scripts/edge-sim.ps1`, then merge into master when it is time to deploy.

### Changing the backend (`server/`)

```bash
node --check server/server.js            # and any other file you changed
```
Then commit, and have the user deploy with a single command (requires an admin shell — see section 5):
```bash
powershell -ExecutionPolicy Bypass -File <repo>\scripts\deploy.ps1
```
It does everything: backup → restart Central + Regional → wait until `/api/instance` on both reports the new build → `npm run build` →
**publish the update package to link-mode edges** (`build-edge-kit.ps1 -UpdatesOnly`) · if `edge.json` changed = `-ReloadEdgeConfig` ·
to release the client too = `-ReleaseClient` · **never skip the publish step** — restarting alone leaves link-mode edges on the old version (this really happened)
The Edge Nodes page shows a yellow badge when the published version does not match Central.

### Changing the web UI (`src/`)

```bash
npx eslint <changed files>
npm run build            # produces dist/ — both Central (index.html) and Edge (edge.html) use the same dist, effective immediately, no restart
```
If the new page needs a new API, **restart the backend before building**, otherwise the new page will call routes that do not exist yet.

To try things without touching production: build into another folder, then start a simulated edge + central (ports 5283 / 5383)
```bash
npx vite build --outDir <sandbox>\edge-sim\dist --emptyOutDir
powershell -ExecutionPolicy Bypass -File <repo>\scripts\edge-sim.ps1
```
Details and caveats are in [docs/OPERATIONS.md](OPERATIONS.md), section "Testing without touching production".

### Changing the Windows client (`client-windows/`)

build → **bump `<Version>`** in `SurveillanceGateway.Client.csproj` → `scripts\build-client-release.ps1` → commit
If you do not bump the version, no machine receives the update (details in [docs/CLIENT-RELEASES.md](CLIENT-RELEASES.md)).

### Flash-drive edge install kit

A new edge is installed from an offline kit ([docs/EDGE-KIT.md](EDGE-KIT.md)): commit first → `scripts\build-edge-kit.ps1` → copy `GW-Edge-Kit-<build>` to a flash drive
- The kit uses code from the **commit**, not from uncommitted edits · the installer lives in `scripts/edge-kit/` · a machine installed from the kit runs under `scripts/edge-run.cjs`, not pm2
- **Releasing an edge version = `build-edge-kit.ps1 -Publish` (always from an elevated PowerShell)**, then press the arrow button on that edge's row in the Edge Nodes page
  — works for every kit-installed (edge-run) edge · a legacy Ubuntu Edge runs as the systemd unit `gw-edge`, not pm2
  (use `sudo systemctl restart gw-edge` · do not run `pm2` there — it will spawn an empty daemon) · a Windows Edge on its own machine receives updates through its Regional
- `-Publish` places the signed update package (`server/edge-updates/`) and the per-OS install kits
  (`server/edge-kits/`) on Central immediately; link-mode edges receive the offer themselves, then the install is triggered from Central or from the edge's web page
- The signing key `edge-update-key.pem` **must never enter git and must never be lost** (backed up by backup-windows.ps1) · the public key is in git
- Per-machine settings come from `edge-<number>.json` issued by Central (it contains a token) — never in git (`.gitignore` blocks it)

### Before touching data

- `git` stores code but **not the DB or secrets** — back up before doing anything that overwrites data
  (`node scripts/reset-cameras.cjs` backs up by itself before clearing, `.\backup-windows.ps1` backs up the whole set)
- The edge DB is created by a pm2 running elevated — an ordinary shell cannot write to it, only read

### No test suite

Verify with `node --check`, `npx eslint`, `npm run build`, `dotnet build`, and real API calls.
If you changed something a human must see (post-login web pages, client windows), tell the user plainly that you have not seen the real screen.

## 5. PM2 — the most frequent traps

- The daemon that actually runs uses `PM2_HOME` pointing to a dedicated directory and runs **elevated**
- On Windows pm2 talks over the fixed named pipe `\\.\pipe\rpc.sock` — so the `PM2_HOME` value in your shell does not choose the daemon;
  what decides is whether the shell is elevated
- **Never run pm2 from a non-elevated shell** (including an AI agent's Bash/PowerShell) — it cannot reach the daemon (`EPERM`)
  and pm2 will spawn a new empty daemon and leave it there. If you did, find the freshly created `node ... pm2\lib\Daemon.js` and kill it
- **Never `node server.js` by hand** on ports 5173/5273 — it collides with the real instance, and a process you start by hand outlives your shell
  to test, use a simulated instance on other ports with its own `GATEWAY_STATE_DIR` (see OPERATIONS)
- Never run `pm2 update` — it restarts every app · leave the warning `In-memory PM2 is out-of-date` alone
- After changing env in an ecosystem file, `restart --update-env` does not re-read the new file; you must `pm2 delete <app>` then `pm2 start <ecosystem> --only <app>`
- At boot, a Scheduled Task ("pm2 resurrect at boot") runs `scripts/start-gateway.cmd`,
  which starts both `ecosystem.windows.config.cjs` and `ecosystem.edge.config.cjs` from the files in git (it does not resurrect)
  → `pm2 save` has no effect on boot; a new app must be added to an ecosystem file

## 6. Other traps that have bitten for real

| Topic | Remember |
|---|---|
| go2rtc 1.9.14 + H.265 out as MSE | segfault — the path a browser plays must be transcoded to H.264 (`ffmpeg:…#video=h264`); do not "save" on this |
| go2rtc HLS | broken (segments are audio only) — play via fMP4 `/stream/<name>.mp4` |
| `_raw` path | passthrough with no transcode for clients/Central that can decode H.265 themselves · requires `#backchannel=0` (see CAMERA-QUIRKS) |
| Time | every timestamp is ISO-8601 `+07:00` from `server/shared/time.js`; never write a bare `YYYY-MM-DD HH:MM:SS` |
| Fresh install (new DB) | has broken in many places — every column needs `ALTER TABLE … ADD COLUMN`, never rely on an old DB · always test with a new DB when touching the schema |
| node-sqlite3 | statements can run in parallel — a schema that depends on order must be inside `db.serialize()` |
| CRLF files | most files are CRLF — a text-patching script using `\n` will not find anything; use the Edit tool or convert newlines |
| `.cmd` | comments must be ASCII (cmd.exe reads using the session's code page) · `%ERRORLEVEL%` inside parentheses is expanded at parse time |
| `.ps1` containing non-ASCII text | must be saved as UTF-8 with BOM for PowerShell 5.1 |
| The repo's `package.json` | `"type": "module"` — Node scripts in `scripts/` that use `require` must be `.cjs` |
| ONVIF behind NAT | NVRs often report an internal address or expose only HTTPS — see `server/onvif_patch.js` before concluding it is a new bug |
| Windows tar.exe | has no xz decompressor — hangs silently on `.tar.xz` · build-edge-kit.ps1 unpacks with Git's xz.exe first |
| zips made with tar.exe | non-ASCII file names are garbled in Explorer (no UTF-8 flag) — files in the install kit use ASCII names |
| PowerShell 5.1 with single-element arrays | `if` / pipelines return a single-element array as a bare value — always wrap in `@(...)` (ConvertTo-Json too) |
| NVR channels offline at scan time | missing from `GetProfiles` but `GetVideoSources` still reports them (Framerate 0) — scan results show them as OFFLINE with no RTSP · **never fabricate a URL**; rescan when the camera is back (no duplicate row is created) |
| Adding cameras via NVR/VMS | no coordinates (NULL) ever — pin them on the Map Pins page · never fill in the map center as a default |
| Camera status | use `server/shared/camera-state.js` (enabled / reachable / streaming) · **never use `streams.*.ready` to decide a camera is down** — go2rtc reports ready all the time even when the camera is unplugged · "currently pulling video" uses `active` from `listStreams()` |
| Cameras from an edge | TCP from Central only reaches the edge's go2rtc (which always answers) — `reachable` must come from the edge · edge unreachable = `null`, not `false` |
| go2rtc push | 1.9.14 cannot push out as `rtsp://` and accepts push only to stream names that already exist — the link uses ffmpeg push into `<id>_in`, which Central creates in advance (the fake source acts as the first producer; a sync PUT must not overwrite it) |
| ONVIF PTZ on some brands | answers 200 but does not move, or `GetStatus` always returns position 0 — always confirm from a before/after snapshot (CAMERA-QUIRKS) |
| go2rtc API | `api: listen` must always be `127.0.0.1:<port>` (the Node proxy is the only way in) · an API open on every interface lets anyone read RTSP with camera passwords · fix installed machines with `scripts/lock-go2rtc-api.cjs` · `/hls` may be forwarded only for playlists/segments whose names were validated; never open a path to go2rtc's `/api/*` |
| Web login | session token `s1.` (HMAC, 12 h, `shared/session-token.js`, key `.session-secret`) sent as `Authorization: Bearer` · **never store the password in the browser** · the legacy username/password headers are still accepted temporarily (logs `[Auth] legacy`) · 5 failures / 5 minutes = 429 |
| Logs | anything that may contain a stream URL must pass through `shared/redact.js` before being logged/returned in an error — ffmpeg's stderr contains `rtsp://user:pass@` |
| Build number | computed from `git log -- server src scripts package.json ecosystem.edge.config.cjs` (the main list is `BUILD_PATHS` in `shared/instance.js` · deploy.ps1 / build-edge-kit.ps1 must match) — changing only `src/` still produces a new build, otherwise link-mode edges do not get the update |
| Dahua DSS Pro | added at the edge (VMS → DAHUA DSS PRO, port 443) · **DSS live/playback URLs are single-use** — go2rtc connects to `rtsp://127.0.0.1:<DSS_RELAY_PORT>/dss/<id>/<main\|sub>` and `vms/dss-rtsp-relay.js` requests a fresh URL every time (port = gateway + 26, listens on 127.0.0.1 only) · token lives 30 s, renewed every 20 s · a wrong login = stop, never retry (DSS locks the account) · camera status comes from DSS, not TCP · playback uses `StartPlaybackByFile` (ByTime does not work) |
| Edge update package | the manifest must have `sig2` + `issuedAt` (anti-downgrade) — newer edges reject a manifest without them · always publish from the current kit code (`scripts/edge-update-key.cjs`) |
| New permissions | add the key to `MENU_KEYS`/`OP_KEYS` and `SEED_ROLES` in `server.js` — seeded roles get it on restart (INSERT OR IGNORE); roles users created themselves must be ticked by hand |
| WPF F11 full screen | `WindowState.Maximized` is limited to the work area above the taskbar even with the title bar hidden — use a `Normal` window + `SetWindowPos` to the real screen bounds, and restore the previous size on exit (`MainWindow.xaml.cs`) |

## 7. Code standards

**Web UI (`src/`)**
- React function components + hooks · one `PascalCase.jsx` file per component · import with `@/`
- Call APIs through `src/lib/api.js` (`apiFetch`) · confirmations/notifications through `appConfirm` / `toast`; never `window.confirm`/`alert`
- UI uses shadcn/ui in `src/components/ui/` and the `src/components/shell/AppShell.jsx` frame
- Each program's menu lives in `src/lib/app-config.js` — adding a page = add a menu entry there + render it in `App.jsx` by `currentTab`
- The map requests its style through `mapStyleUrl()` (`src/lib/map-style.js`) — never hard-code a port
- Pages that must fit the screen use `h-full`/`min-h-0` along the flex chain; never guess `h-[calc(100vh-Npx)]`

**Backend (`server/`)**
- Express + CommonJS, callback-style `sqlite3` (wrapped in Promises in new modules), no ORM, no migration tool
- The main routes live in `server.js` (a big file — an existing pattern, do not break up the whole file on your own); new modules go in separate files in `gateway/`, `vms/`, `shared/`
- Values that differ between Central/Edge are read only from `server/shared/instance.js`
- Authorize users with `requirePerm('<key>')` · external clients use an API key (`api_clients`)

**Windows client (`client-windows/`)**
- .NET 8 WPF · every string lives in `Services/Strings.cs` (EN/TH); never write literals in a view
- Video and WebView2 are HWNDs — WPF cannot draw over them and cannot animate them
