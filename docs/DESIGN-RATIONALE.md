# Design rationale — why the system is the way it is

This file records the reasons and history that still affect the code. It is not a manual — see [README.md](../README.md) for the current state
and [CONTRIBUTING.md](CONTRIBUTING.md) for the rules.

## New agreement: external AI

AI is done by the source (camera / NVR / VMS / external API), which processes the video itself.
Central/Regional/Edge only receive, store and forward results; the Edge inference-worker approach is cancelled.
A Tiandy perimeter camera (203.0.113.12) attached to Edge 101 was the first source, keeping its existing Global ID TH-10-101-00001.
Tiandy and UNV were tested with real cameras across all three tiers.
Test results and limitations are in [EXTERNAL-AI.md](EXTERNAL-AI.md).

## Current state

The live system is Central :5173 → Regional (central region) :5273 (node 100) → Windows Edge 101 / Ubuntu Edge 102; all four instances run the same Gateway build · Windows Client 1.9.x
Central issues nation-wide keys and accepts Regionals only; a Regional issues in-region keys and accepts Edges only, so Clients can point at the region directly when the link to Central is down.
One province can have several sites by installing separate Edges and using Remark; there is no Sub-edge.
Every camera must have a province and district when added, including VMS imports; the area of a whole group or of selected cameras can be changed, but an already-issued Global ID and the coordinates do not change with it.
Milestone playback was fixed and real recorded video was verified across all three tiers; the Bridge must be searched by GUID / specific time conditions and played with Rate-Control: no.
Update results, networking and items still awaiting real-device tests are in [REGIONAL-PLAN.md](REGIONAL-PLAN.md).

## What this system is for

It merges CCTV video from many agencies and many brands into a single entry point (`/api/v1` + API key) that other systems pull from.
Designed after the reference the reference platform specification: area edges close to the cameras → Central aggregates →
users/analytics systems pull from Central · everything runs inside the LAN/VPN, with no cloud dependency.

The main consumers are **programs holding an API key** (the Windows client, external analytics systems), not people sitting at a web page.
The Edge web page is configuration only (the Edge relays video and has no viewing page) · Central has a web **Live** page
for live view / PTZ control without installing software, while serious multi-screen viewing is still the Windows client's job.

## Condensed timeline

| Period | What happened | Traces / current status |
|---|---|---|
| Early phase | Started as a VMS/IOC: video wall, AI detection (YOLO/DeepStream), Face Recognition, Telegram | old comments and leftover tables; the AI cache folders have since been cleared |
| Next phase | Production moved to an Ubuntu VM (Hyper-V + GPU passthrough) | `ecosystem.linux.config.cjs` has since been deleted |
| Pivot | Direction changed to **API Gateway** · removed all AI that we ran ourselves · streaming core from MediaMTX → **go2rtc** | `server/gateway/`, `/api/v1`, API key |
| Shortly after | All times are `+07:00` | `server/shared/time.js` |
| Shortly after | The Gateway queries camera-side AI itself via ONVIF (people counting, cross line) | `server/gateway/analytics/` (currently off) |
| Later | Production moved back to a Windows host — the repo = what actually runs | no deploy step |
| Following month | Windows client (.NET/WPF) gained multi-screen viewing; the web UI once dropped video/maps, then Central brought back the Live page and Camera Map | `client-windows/`, `client-updates/` |
| Then | ONVIF PTZ, Inter + Noto Sans Thai fonts | `server/gateway/ptz.js` |
| **Central / Edge split** | **Split into Central / Edge** · global ID + province · cameras cleared and restarted · AI off · dark-sidebar UI · satellite map | see [docs/EDGE-PLAN.md](EDGE-PLAN.md) |
| Same day, afternoon | Central shows the map only (pinning at the edge) · client named **Surveillance Gateway Client** · three-valued camera status + live status from the edge · edge connects up by itself (link) · Live web page on Central | `server/shared/camera-state.js`, `server/vms/edge-link-*.js`, `src/components/LiveWall.jsx` |
| Next day | Offline edge install kit (Windows/Pi/Linux) downloaded from the Edge Nodes page · edge numbers reserved at Central · edge updates over the link, triggered from Central (an edge updated twice for real, no SSH/sudo) | `scripts/build-edge-kit.ps1`, `scripts/edge-kit/`, `scripts/edge-run.cjs`, `server/vms/edge-update*.js`, [docs/EDGE-KIT.md](EDGE-KIT.md) |
| Following days | Client 1.7.3 reworked Home / Wall, shows the status of every camera, F11 covers the true screen edge including the taskbar; unused build output and samples cleared | `client-windows/`, [docs/CLIENT-RELEASES.md](CLIENT-RELEASES.md) |
| AI-at-edge decision | Agreed that AI lives at the edge (Central aggregates events and runs no inference) · recording at the edge + Playback via Central | `server/shared/ai-events.js`, `server/gateway/playback.js` |
| Same day | Edge added Milestone Open Network Bridge VMS via ONVIF; tested with 2 real channels, viewable through the Client · fixed Central's pull sync so it accepts the initial status of newly added cameras; Online confirmed for all after a restart | `server/vms/edge-source.js`, [docs/CAMERA-QUIRKS.md](CAMERA-QUIRKS.md) |

## Decisions worth knowing (and why)

**Edge adds cameras, Regional adds Edges, Central adds Regionals.** Central is not on the cameras' LAN and should not hold the camera passwords of every agency.
The Edge holds the passwords and sends video as passthrough through the Regional to Central only while someone is watching; each parent holds the key/token of its children in the next tier.
Closing the add-camera API at Central (403) makes this rule independent of whether any button exists on screen.

**One codebase, three programs.** They are separated by `GATEWAY_ROLE` and the web entry (`index.html` / `regional.html` / `edge.html`) instead of separate repos,
because a bug is fixed once for all of them, and moving an edge to a real machine is just a clone + editing config (`ecosystem.edge.config.cjs`).

**Not using GB28181.** We studied a reference edge project (an open-source platform) and borrowed only its *way of working*:
the edge sends a catalog and heartbeat, pulls video when someone watches, PTZ is forwarded hop by hop, the edge screen is configuration-only, and the UI layout.
We did not take the protocol itself (SIP/RTP-PS), because our cameras and users already speak RTSP/ONVIF/HTTP.

**Global ID `TH-<province>-<machine>-<sequence>` never changes for the lifetime of a camera.** `cameras.id` is local to a machine
(go2rtc paths and logs refer to it); the global ID is the name shared by the edge, Central and the client. If it could change, Central would see the same camera as a new one.
The sequence is stored in `settings` and is not counted from remaining rows, so it is never reused even after a camera is deleted.

**Province codes come from thailand-geography-json, not the reference edge project's `civilCode.csv`.** That file was checked and its numbers are wrong
(Bueng Kan wrong for the whole province, Bangkok subdistricts from before 2019, duplicate subdistricts, municipalities mixed in as districts) — recorded in `scripts/gen-thai-regions.cjs`.

**go2rtc is the streaming core.** It accepts every brand and serves RTSP/fMP4/WebRTC from one process · it has two limitations that must be worked around:
sending H.265 out as MSE segfaults (the browser path must transcode to H.264), and its HLS is unusable (play via fMP4).
The `_raw` path (passthrough) exists for clients/Central that can decode H.265 themselves — it saves NVENC.

**AI: removed what we ran, turned off what is on the camera.** Our own inference (DeepStream, YOLO, face) was removed permanently at the pivot
because a gateway that also runs inference puts two systems with different failure modes in one process — if analytics are wanted, they should be a separate service pulling from `/api/v1`.
Reading results from camera-side AI still has code, but it is switched off with `GATEWAY_AI` to finish consolidating video first,
and it was later decided not to merge it into the system — do not turn it back on without a new agreement (CONTRIBUTING.md item 1).

**AI moved to the edge.** If AI lived at Central, it would have to pull every camera across the network all the time
(150 cameras × sub stream ≈ 80–160 Mbps), contradicting the principle "heavy video flows only while someone is watching", and when an edge drops, AI stops (an edge was in fact down for 2 days).
So the edge runs AI itself (on edges that have a GPU) and sends only events up to Central · inference stays a separate process for the reasons above.

**We do not record video ourselves — playback is pulled from the device.** We built an edge recorder (an ffmpeg per camera, 60-second files) and then removed it:
most cameras already have an NVR or SD card recording, duplicating the recording eats edge disk (~11 GB/day per camera at sub stream) and needs more upkeep.
The playback pipe (Central → edge, the link upload, the Playback page, the `playback.view` / `allow_playback` permissions) already works with AXIS S30 and Uniview NVR
· Windows client 1.8.3 added a Playback page through an API key with `allow_playback` · 1.8.4 changed it to a VMS-style timeline · 1.8.5 fixed issues found in review
· ONVIF Profile G works with Tiandy cameras that have an SD card (tested at the video source: search ~7 s, first frame ~8 s)
· Hikvision / Dahua / Profile G on other NVR brands and Milestone await tests on real devices · Digifort awaits API documentation.

**Whole-system review and closing the holes.** We found that `/hls` and go2rtc's API (open on every interface, no password) let anyone read the RTSP
with every camera's password, and that the web page kept the real password in the browser · fixed as: go2rtc API bound to `127.0.0.1` on every machine,
`/hls` forwards only playlists/segments, the web page uses a 12-hour session token, failed logins are rate-limited, camera scope is checked on every route that edits data,
and camera passwords are redacted from logs · full details in docs/EDGE-PLAN.md, section "Whole-system review" · TLS is not done yet (waiting for a domain/cert).

**A Windows client instead of viewing in the browser.** It decodes H.265 on the user's own GPU, so the server does not have to transcode for every viewer.
It updates itself from Central (`/client-updates`, Velopack) because user machines have no outbound internet.
The Central web Live page came back later for convenience — every channel on the web is one H.264 transcode on Central's GPU,
so the wall always uses the sub stream, and the edge has no viewing page at all (an edge may be a small machine with no GPU).

**Three-valued camera status, not "online".** The web page used to measure TCP while SSE used "go2rtc has a producer", which go2rtc reports as true all the time
even when nobody is watching and the camera is unplugged (an unconnected producer is just `{url}`), so every camera looked normal in the client.
It is split into `enabled` / `reachable` / `streaming` in one store (`shared/camera-state.js`) and pushed the moment it changes.
Cameras from an edge use the `reachable` that the edge reports, because Central's TCP only reaches the edge's go2rtc, which always answers.

**An edge connects up by itself (link) using WebSocket + ffmpeg push.** An edge behind NAT cannot be reached from Central in the other direction, so the edge holds a single line
and Central commands it over that line · video: go2rtc 1.9.14 cannot push out as rtsp:// (`unsupported scheme`) and accepts push only to names that already exist,
so the edge's ffmpeg pushes into the stream `<id>_in` that Central prepared with a fake source — tested on a simulated instance.

**SQLite, PM2, one big Express file, no ORM/migration tool.** Chosen so it installs on a single machine with no dependency on other services.
A large `server.js` is known debt — new modules go in separate files, but the existing file does not need to be torn apart.
Having no migration tool is why every column needs `ALTER TABLE … ADD COLUMN` and why you must test against a new DB.

**Online maps through a proxy.** OSM tiles and Esri satellite imagery go through our own `/api/osm`, `/api/sat` (same-origin, cached to disk).
Esri satellite imagery is usable without a key with attribution, but commercial use requires an ArcGIS account · MBTiles mode remains for fully offline use.

**The edge install kit does not use pm2 and does not depend on the internet.** Sites have no internet, and pm2 would need a global install plus Windows permission problems.
So the kit carries its own node/ffmpeg/go2rtc and uses `edge-run.cjs` to supervise processes from the existing ecosystem file · per-machine settings arrive as a file from Central so the technician types nothing.

**The deploy button on the Edge Nodes page uses the link, not SSH.** Users wanted to deploy from the web — if the Central web ran deploy-edge.sh itself it would have to hold an SSH key
and passwordless sudo on the edge (web compromised = root on every edge), so instead the edge installs a signed package itself: edge-run swaps the app folder,
and a Linux edge under pm2 swaps files in the repo and exits so pm2 restarts it, with a separate watchdog process ready to roll back.

**Edge updates: sign the package instead of waiting for TLS, and have a person press install at the edge.** The link is still `ws://`; if we trusted a file that merely arrives over the line,
anyone intercepting could push code to the machine — ed25519 closes this immediately without managing certificates on every path · installing stops video briefly,
so the person on site chooses the time, and `edge-run` rolls back by itself if the new version cannot connect to Central.

## Known limitations and technical debt

- **Web auth is weak by design for a LAN** — originally the password was sent as a header on every request with no session/JWT, acceptable only because it lives inside a LAN/VPN, never expose it to the internet
  · stored in the database as a scrypt hash (`server/shared/password.js`); plaintext rows from an old DB/backup are converted automatically at startup or at login
- **No TLS** — web, `/api/v1`, RTSP and the link (`ws://`) · crossing sites must go through a VPN
- **No automated test suite** and **no git remote configured on the production host** (the code backup is only the repo on that machine)
- **Backups are on the same disk as the data** — `backup-windows.ps1` covers Central + edge fully, but there is no off-machine copy yet
  the nightly task must be registered once by hand from an admin shell (command in docs/OPERATIONS.md)
- `App.jsx` holds almost all state and passes it down as props (no router/state library) — known, not a mistake
- The map in the Windows client (`src/client-map/`) still uses its own style, with no satellite button like the web page
- The Surveillance Gateway Client exists only for Windows (WPF) — a Linux client (port to Avalonia) was agreed but parked
- The admin-requiring steps of the edge kit's Windows installer have not been tried on a real machine · the Raspberry Pi kit has not been tried on a real Pi
- `server/edge-updates/` and `server/edge-kits/` are created by an admin shell — `-Publish` from an ordinary shell cannot delete old versions
- Time to first frame depends on the camera's keyframes — a sub stream with a sparse I-frame (e.g. 5 fps + GOP 10 s) makes Live Wall channels wait tens of seconds;
  set at the camera: I-frame interval ≈ fps (see docs/CAMERA-QUIRKS.md)
- `server/package.json` is still named `onvif-scanner` — a leftover name from the start of the project
- Repo cleanup: removed older-era files nobody references (the Linux VM ecosystem, `restart-backend.bat`, `windows-cutover.ps1`,
  `server/migrations/`, which the system now does itself at startup, `design-demos/`, early-era HTML pages/slides) · source documents moved out of the repo
  · old DBs in `server/` moved to `backups/` (they contain camera passwords, never in git) — everything is recoverable from git history.
  Also cleared: Windows client build output, a `demo-client` left with only `dist/node_modules`, sample images, Python cache, and empty Python folders.
  If you find an explanation that contradicts this document set, trust this document set.
- NVR channels offline at scan time: there is no profile to request RTSP from (visible only in `GetVideoSources`) — ONVIF shows them as pending channels; Uniview LAPI can add an offline channel with its name, and the Edge fills in RTSP when ONVIF finds it later.
  URLs are not guessed from neighboring channels (decision) · ONVIF does not carry the channel names set in the NVR
