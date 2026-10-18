# Edge ↔ Central — How It Works, Agreements, and Remaining Work

> Since 2026-10-02 AI has changed to receiving results from cameras/NVRs/VMSs/external APIs; there is no inference on any of the three tiers.
> Current state 2026-10-17: Gateway 651549d / Client 1.14.2; Map worker hotfix closed out — see [WINDOWS-CLIENT-WORKSPACE.md](WINDOWS-CLIENT-WORKSPACE.md); external AI is received, there is no inference worker — see [EXTERNAL-AI.md](EXTERNAL-AI.md)
> This document was written for the two-tier system: "central" in the operation/link sections means **the edge's parent** — today that is the Regional (and the Regional is a child of Central in the same way); see [REGIONAL-PLAN.md](REGIONAL-PLAN.md)
> Phase 5 item D describes the current receiver; items A/C and the dated test results are history


Updated 2026-10-17 · Central → the central Regional (100) → Edge 101/102 in real use (Edge 103 reserved as a test Edge); the link has no TLS, use it over LAN/VPN
· new edges are installed from the offline kit and updated over the link with a button on the Edge Nodes page ([EDGE-KIT.md](EDGE-KIT.md)) · phase 5: AI events with JPEGs are received from the source through AI Sources; the inference worker is removed · playback is pulled from the devices (AXIS S30 / Uniview in real use · Hikvision / Dahua / ONVIF Profile G awaiting testing)

## Overview

```
Camera ─RTSP/ONVIF (LAN)─▶ Edge: Gateway + go2rtc (passthrough, pulled only when someone is watching)
                            │  Camera data + state : central reads the edge's /api/v1 with an API key issued by the edge
                            │  Video               : central's go2rtc pulls the _raw RTSP path from the edge's go2rtc
                            ▼
                     Central: Gateway + go2rtc ─▶ Windows client / external systems (central's /api/v1)
```

Principles that must not change:

1. **Camera passwords live at the edge only** — central stores just the edge's API key (sealed with the key vault) and the RTSP account of the edge's go2rtc
2. **Edge and central are the same codebase**, differing only by env (`server/shared/instance.js`)
3. **Heavy video flows only while someone is watching** — a camera row at central consumes no bandwidth until someone opens it
4. **Each field has exactly one owner**

| Data | Owner | What the other side does |
|---|---|---|
| Name, brand, coordinates, province/district, camera code, stream address, global ID | edge | central overwrites from the edge on every sync round (global ID is not overwritten once it exists) |
| Groups used for display at central, wall layout, central user permissions, client API keys | central | the edge knows nothing about them |

## How it actually works

**Adding an edge** (central → Edge Nodes → Add Edge, `POST /api/edges`)
1. central calls the edge's `/api/v1/health` — it must return `role: "edge"` and a node number that does not duplicate central's, otherwise it is rejected
2. It is recorded as a `camera_sources` row (`kind = 'edge'`, id = `vms_edge_<host>_<port>`)
3. Every camera of the edge is taken in as a `cameras` row of type `edge_relay` (id = `cam_edge_<node>_<id at the edge>`)
   - `rtsp` / `rtsp_sub` = the `rtspRaw` URL from the edge's `/api/v1/cameras/:id/streams` (falls back to `rtsp` if the edge has raw disabled)
   - `ip` = NULL → central's ONVIF / AI / scan code skips these cameras by itself
   - central's go2rtc transcodes the main path to H.264 for browsers and has a `_raw` passthrough path for clients

**Sync** (`server/vms/edge-source.js`)
- health every 60 s → the edge's `reachable` status (in memory + the `camera_sources` table)
- every 10 minutes (or the Sync button / `POST /api/edges/:id/resync`): rewrite the edge's fields, **automatically take in new cameras**,
  and put the newly taken-in cameras' latest `state.reachable`/`state.enabled` at central, plus update the ID map of the SSE feed
- **A camera that disappears from the edge is handled in two ways** (2026-09-24):
  - **Deleted by a person at the edge** → the edge records it (`camera_deletions`, `server/shared/camera-deletions.js`, kept 90 days) and sends it to central
    (link: `catalog.deleted` sent immediately after the delete · pull: `GET /api/v1/cameras/deleted`) → **central deletes the row accordingly** together with `role_devices`
  - **Vanished with no record** (deleted before this system existed, the edge DB was wiped, the edge answered incompletely) → marked `source_missing_at`, not deleted,
    but removed from go2rtc, state becomes `reachable: null`, the Cameras page shows MISSING AT EDGE, Live does not let it be selected
    · it can be deleted via the "N missing" badge on the Edge Nodes page (`DELETE /api/edges/:id/missing`, needs confirmation) · if the edge has that camera again the badge clears itself
- edge unreachable → central's `/api/v1/cameras` sets `origin.reachable = false` for that edge's cameras
  (clients show unknown status, not a downed camera)

**Removing an edge** (`DELETE /api/edges/:id`) — deletes only that edge's camera rows at central; nothing at the edge is touched; it can be added back with the same key

**PTZ** — an `edge_relay` camera forwards the command to `POST /api/v1/cameras/<id at the edge>/ptz` with the edge's key
It must pass two layers: the client's key at central must have `allow_ptz` **and** the key central holds with the edge must have `allow_ptz`

**Three camera status values** (`server/shared/camera-state.js`) — every machine has a single store, notifying listeners immediately when a value changes
- `enabled` whether the admin has enabled it (`cameras.enabled`, the on/off button on the **edge's** Cameras page) · off = removed from go2rtc, not checked, not counted as down
- `reachable` whether the camera head responds (TCP to RTSP every 15 s) · for edge cameras it uses the value **the edge reports** · `null` = unknown (edge unreachable)
- `streaming` whether go2rtc is currently pulling video (a genuinely connected producer — not `streams.*.ready`, which is always true even with no viewers)
- Exposed via `/api/v1/cameras[].state`, `/api/camera-states` (web) and SSE `camera_state` · SSE still emits `camera_status`
  (online = `reachable === true`) for clients ≤ 1.3.3

**Live status from the edge** — central keeps each edge's SSE feed `/api/v1/events` open (`ensureFeed`, reconnects by itself 2 → 60 s)
and writes `reachable`/`enabled` into central's store immediately → clients connected to central see it within the edge's check cycle (≤ 15 s)
Cameras added after the SSE feed opened also get an initial status in the sync round; there is no need to wait for the next status-change event
Feed broken = that edge's cameras are `reachable: null` · central does not take the edge's `streaming` (central has its own go2rtc)

**Build mismatch** — central's `/api/v1/health` has `edges: [{node, name, build, reachable}]` · clients ≥ 1.3.4 show a warning banner on the Home page
when an edge's build does not match central (the Edge Nodes page warns too)

**Global ID** — `TH-<2-digit province>-<3-digit node number>-<5-digit sequence>` issued at the edge when the camera is added (`server/gateway/identity.js`)
Unchanged for the life of the camera · a camera with no province selected gets the machine's province (`GATEWAY_DEFAULT_PROVINCE`, central = `10`)
central **does not issue** IDs for `edge_relay` cameras — it waits to receive the edge's during sync (previously it could issue its own if the edge had not yet, and central's number stuck permanently)

## Edge connects up by itself — link (phase 4)

For edges that central cannot reach (behind NAT) but that can reach central

**Setup** — central: Edge Nodes → Add Edge → "Edge connects up by itself" → get a token (shown once, central stores only a hash, `POST /api/edges/link`)
edge: put `centralUrl` (`ws://<central>:5173/api/edge-link`) + `centralToken` in `<stateDir>/edge.json` (outside git — the token is secret), then
`pm2 delete 3-edge-gateway` + `pm2 start ecosystem.edge.config.cjs --only 3-edge-gateway`
The `camera_sources` row for this kind of edge has `mode = 'link'` and no host/port · the 60 s health check skips it (status comes from the link)

**The link** (`server/vms/edge-link-server.js` ↔ `edge-link-client.js`) — one WebSocket, one JSON object per frame

| Direction | Messages |
|---|---|
| edge → central | `hello {node, build, name, via, platform, runner, province}` → `heartbeat` every 20 s · `catalog {cameras}` on connect, every 5 minutes and when requested · `camera_state` immediately on change · `update_status {state, build, error}` · `reply {id, ok, data \| error}` |
| central → edge | `welcome` · `rpc {id, method, params}`: `catalog.push`, `stream.open`, `stream.close`, `ptz.info`, `ptz.cmd`, `update.apply` (10 s timeout) · `update {build, platform, file, size, sha256, signature, path}` · `error` |

Silent for more than 60 s = link dead · node number duplicating central or another edge = rejected · edge reconnecting with the same token = the old link is closed

**Video** — go2rtc 1.9.14 cannot push out as `rtsp://` by itself (`unsupported scheme`) and accepts pushes only to stream names that already exist, so:
1. central creates a stream `<id>_in` (fake source `rtsp://127.0.0.1:1/edge-link-idle`) and makes the camera's normal stream pull from `_in` over loopback
2. someone opens a view (`/stream/*.mp4`, snapshot) → `ensureLinkStream` sends `stream.open` → the edge has ffmpeg read its own go2rtc
   (`-c copy`) and push to central's `_in` → central waits until it sees the pusher (≤ 8 s) and then sends video
3. `_in` has no viewer for more than 60 s → `stream.close` · link broken → the edge closes every push

**PTZ** — sent via `ptz.cmd` over the link · the edge can disable it with `GATEWAY_CENTRAL_ALLOW_PTZ=0`

**Multiple routes to central's address** — central is reached via LAN, each agency's VPN/MPLS, and NATed IPs
(the external port may not be 5173/8555); each edge sees a different address, and central does not know them itself (a routed/NATed IP is not on the machine)
- The admin records them on the Edge Nodes page (`settings.CENTRAL_ENDPOINTS`, `GET/PUT /api/edges/endpoints` — the system suggests the machine's IPs as a starting point)
- After issuing a token, choose that edge's routes → `centralUrls` in `edge.json` (`setup-edge.sh --central-url` is repeatable)
  or download it as an `edge-<number>.json` file for the flash-drive install kit ([EDGE-KIT.md](EDGE-KIT.md)) — the edge number is reserved at central when the token is issued

- The edge tries them in order; if one fails to connect it moves to the next; only after all have failed does it back off · if it drops from one that had connected, it tries that one first
- Video is pushed to the host of the address currently connected · `?rtsp=<port>` at the end of the URL = central's RTSP port on that route
- `hello.via` + the link's source IP are stored in `camera_sources.link_via` / `link_remote` → the Edge Nodes page shows which way the edge came in
- Tested (simulated instances): first address unreachable → the second is used, push goes to the second's host/port, video reaches central (HTTP 200)

**Updating an edge over the link** ([EDGE-KIT.md](EDGE-KIT.md) section 5) — central offers a signed package when the build does not match (`update` on the link)
the edge verifies the signature, downloads over HTTP with the link's token, then waits for a person to press install (Edge Nodes page at central or the edge's web page) · `edge-run`, or pm2 on Linux, swaps files and rolls back by itself
if the new version cannot connect to central within 5 minutes · status is sent back with `update_status` and shown on the Edge Nodes page

**No TLS yet** — the token and central go2rtc's RTSP account travel on the link in plain text; usable only over Tailscale/LAN
To go out on the internet, a domain + cert is needed first (`wss://` at central's end and RTSPS for push)

**Shared APIs** (both sides have all of them because it is one codebase)

| endpoint | What it is used for in the edge↔central relationship |
|---|---|
| `GET /api/v1/health` | Identity check: `role`, `node`, `build` (latest commit that touched `server/` — commits touching only client/docs do not cause a mismatch) · central adds `edges[]` so clients can compare builds |
| `GET /api/v1/cameras` | List + `globalId`, `region`, `origin`, `enabled`, `state` |
| `GET /api/v1/events` | SSE `camera_state` / `camera_status` — central keeps the edge's feed open (live status) |
| `GET /api/v1/cameras/:id/streams` | Stream URLs (`rtspRaw` that central pulls) |
| `GET/POST /api/v1/cameras/:id/ptz` | PTZ capabilities / commands |
| `GET /api/instance` | The machine's role (no login needed) |

## Common agreements (every edge uses the same set)

| Item | Value |
|---|---|
| Cross-site network | Tailscale (no TLS yet — must not run directly over the internet) |
| Central | `203.0.113.80` / Tailscale `<central-tailscale-ip>` · gateway 5173 · go2rtc RTSP 8555 |
| Node number (`GATEWAY_NODE_NUMBER`) | central `000` · Regional block heads `100`/`200`/…/`600` · Edges in a region +1 to +99 (the central region uses `101`–`103`) · `001`–`099` reserved for the old setup (`001`/`002` retired) · `997`–`999` for testing |
| Province in the global ID for cameras with no province set | central `10` (hardcoded) · edge sets `GATEWAY_DEFAULT_PROVINCE`, unset = `00` |
| Edge ports | separate machine: 5173 / 1984 / 8555 / 8556 · (5273 / 1994 / 8565 / 8566 on the central host belong to the Regional since 2026-09-30) |
| Edge `GATEWAY_PUBLIC_HOST` | An IP central can really reach — never `127.0.0.1` (it is embedded in the stream URLs sent to central) |
| Edge firewall | The gateway port and go2rtc RTSP are open to central's IP only |
| Health / sync | 60 seconds / 10 minutes |
| Time | ISO-8601 `+07:00` · no NTP set up (decided 2026-09-23) — each machine's clock may drift; do not compare cross-machine timestamps to order events |
| Province codes | `server/data/thai-regions.csv` (Department of Provincial Administration / TIS 1099) |

## Work not yet done

| Task | Why / details |
|---|---|
| **TLS for the link** | `wss://` at central + RTSPS for push — needs a domain and cert first; until then the link is usable only over Tailscale/LAN |
| **AI from other brands (next)** | Test topics/metadata and event images per model; add a native adapter once confirmed, or receive through the external API |
| **Playback from devices** | In real use: AXIS S30, Uniview NVR, Tiandy SD (Profile G), Milestone Bridge (2026-09-30), Dahua DSS Pro · **written, awaiting test hardware**: Hikvision, Dahua (cameras/NVRs), Profile G of other NVR brands · Digifort awaiting playback API docs |

## Phase 5 — AI events from the source (revised 2026-10-02)

Principle: **the source runs AI · the Edge receives the results · Regional/Central aggregate events with their images; no tier runs inference**

**A. Video recording — removed 2026-09-28** · An edge recorder was built (`gateway/recorder.js`, the Recording page, one ffmpeg per camera, 60 s files,
retention by days/quota/free disk) and then the operator decided to remove it, switching to pulling playback from the devices (AXIS S30 and Uniview NVR in real use;
Hikvision / Dahua / ONVIF Profile G written, awaiting test) · the old code can be recovered from git history (before the removing commit) · the `recordings` table and the `record_*` columns
in existing DBs may stay, nobody reads them · a new video source must provide `ranges`, `openPlayback`, `frame` as described in the header of `gateway/playback.js`

**Playback** — `server/gateway/playback.js` is the single path for both the API and the web · `edge_relay` cameras forward to the edge with the edge's key · AXIS S30 uses VAPIX/RTSP · Uniview NVR uses LAPI/RTSP replay, for channels added with either the Uniview API or ONVIF (`server/vms/device-playback.js`) · for other brands see the "Video sources by device" table below · a camera with no video source answers 501
| Route | Used for |
|---|---|
| `GET /api/v1/cameras/:id/recordings?from&to` | Time ranges that have video |
| `GET /api/v1/cameras/:id/playback.mp4?start&duration[&video=h264]` | fMP4 ≤ 3600 s · no video param = the camera's codec · `X-Playback-Start` = time of the first frame |
| `GET /api/v1/cameras/:id/playback-token` | Issues a token for only cameras in scope when the API key has `allow_playback`; the Windows client uses it to open `/playback/:id.mp4?...&video=raw` without putting the API key in the URL |
| `GET /api/v1/cameras/:id/frame.jpg?at` | Still image from the footage |
| Web: `GET /api/playback/:id/ranges`, `/api/playback/:id/token` → `/playback/:id.mp4?t=` | Central's Playback page (permission `playback.view`) |
- Link-mode edge (2026-09-28): ranges and stills run over the link (rpc) · for the video body, central sends rpc `recording.upload` and the edge **uploads the fMP4
  as an HTTP stream** to `POST /api/edge-link/playback/:session` (the link's token) → central pipes it through to the viewer without parking it on disk
  (`vms/link-playback.js`) · viewer closes = connection cut = ffmpeg at the edge stops · does not arrive within 15 s = 504
- The API key must have **"Playback"** ticked (`allow_playback`) — both the client's key at central and the key central holds with the edge (ticked at the edge)
- Windows client 1.8.4 (1.8.5 fixes chunks across gaps/midnight): the one-day timeline shows recorded ranges (click = play, mouse wheel = zoom, drag = pan), the playhead follows real time ·
  play/pause, ±30 s, previous/next range, go to time · when a 1-hour chunk finishes playing it requests the next chunk itself · every seek is a new request (`Views/PlaybackTimeline.cs`)

**Video sources by device** — `server/vms/device-playback.js` chooses by the camera's type and brand
| Device | Path | Status |
|---|---|---|
| AXIS S30 (`onvif_nvr`) | VAPIX search + RTSP `recordingid` | In real use |
| Uniview NVR (`onvif_nvr`) | LAPI search + RTSP `/cN/b<epoch>/e<epoch>/replay/` | In real use |
| Hikvision SD-card camera / NVR | ISAPI `ContentMgmt/search` + RTSP `/Streaming/tracks/<channel>01?starttime=` | Written, awaiting test hardware |
| Dahua SD-card camera / NVR | `mediaFileFind.cgi` + RTSP `/cam/playback?channel=&starttime=` | Written, awaiting test hardware |
| All other `onvif_cam` / `onvif_nvr` (Tiandy, Hi-View, generic, Milestone Bridge, SD-card cameras of AXIS/Uniview) | ONVIF Profile G: FindRecordings + FindEvents + GetReplayUri (Milestone uses its own path, see below) | Tiandy + SD card cameras work (lab, 2026-09-29) · Milestone Bridge in real use 2026-09-30 · other brands/NVRs awaiting test |
| Digifort | — | 501, awaiting playback API docs · never guess endpoints (3 wrong credentials get the account blocked and the whole set of cameras goes down) |
| Manually entered RTSP (`manual`) | — | 501, no way to query recordings |
- Profile G: ffmpeg cannot send `Range: clock=` / `Require: onvif-replay` itself → `vms/onvif-replay-proxy.js` opens a per-request intermediary at 127.0.0.1
  that adds the headers and Digest (the password is not on ffmpeg's command line) · it matches a recording to a camera by SourceId = the VideoSource/Profile token
  → camera name → only one recording; not found = 409 · devices that do not support FindEvents get a coarse range (first frame to last frame, gaps not visible)
- Time: Hikvision ISAPI / Dahua CGI are treated as the device's local time (+07:00) — Hikvision labels it `Z` even though it is local time
  if some unit is genuinely UTC, set `HIKVISION_TIME_UTC=1` in the edge's env · Profile G is UTC per the spec
- To be verified when hardware is available: Hikvision's time, Dahua's `condition.Channel` starting at 1 (some older firmware starts at 0),
  matching Profile G recordings against multi-channel NVRs and Milestone
- Tested (2026-09-28, no hardware): every parser, video source selection, the RTSP intermediary against a fake server that enforces Digest
- Tested against real hardware (2026-09-29): Tiandy `onvif_cam` + SD card (203.0.113.12) — SourceId = the profile token (`protoken_ch0001`) matches directly,
  FindEvents gives complete `RecordingHistory/Track/State`, the replay URI is `RTSP://…/replay/1/1?replaymode=onvifreplay` (uppercase),
  the camera clock is ~147 s behind the machine (WS-Security uses an offset from GetSystemDateAndTime so it passes)
  · **the web page once showed "edge did not respond within 8 seconds"**: the camera takes ~4 s to search recordings by itself + ~6 s for events, exceeding the 8 s timeout of `EdgeClient`
  → fix: recording-range/still requests may wait 45 s (`RECORDER_TIMEOUT_MS` for both pull and link), poll search results at `PT1S` intervals, remember recording + replay URI for 10 minutes,
  and do not search events again when play is pressed · result: recording range 9.4 s (first time) / 7.1 s (subsequently — the camera's own search time), first image 8.4 → 1.2 s
  · The Windows client waits up to 15 s for ranges (`GatewayClient`) — enough for this camera; if a slower unit turns up the client needs to extend this in a later release
- **Dahua DSS Pro V8.5.0 (2026-09-29, working)** · `203.0.113.50` · added at the edge (Cameras page → VMS → DAHUA DSS PRO) · type `dss_relay`, brand `dss`,
  source_ref = DSS's channelId · modules `server/vms/dss.js` (client), `dss-sessions.js` (session + status every 60 s), `dss-rtsp-relay.js`,
  `dss-playback.js`, `dss-routes.js`, `dss-ptz.js` · the login approach comes from an internal reference script
  - 2-step login with MD5 signature, `clientType: WEB` · token 30 s → keepalive `PUT /accounts/keepalive` every 20 s · channel list = `v1.1/device/channel/list` walking ID ranges
    (`device/page` = 1001) · live `MTS/Video/StartVideo` streamType 1 = 1920x1080, 2 = 704x576 · **URLs are single-use** → the local RTSP intermediary
    requests a fresh one on every connection · playback `SS/Record/QueryRecords` + `SS/Playback/StartPlaybackByFile` (ByTime = 2060) ·
    PTZ `DMS/Ptz/OperateDirect` (4 right, 3 left) / `OperateCamera` (zoom) command 1/0
  - Tested (simulated edge + central, real DSS): scan of 187 channels · every live path through go2rtc · ranges 0.2–0.6 s · stills/playback video both at the edge and via central ·
    PTZ via central → edge → DSS answers 200 · DSS presets/home not yet supported · every channel shows the PTZ panel (no field yet confirms which channels are PTZ)
- **Milestone Open Network Bridge** · Bridge `203.0.113.21:580` (XProtect 2022 R3) · **in real use since 2026-09-30 (`a36a2d8`)** after the operator fixed the Recording Server storage
  — results and the method actually used (search by GUID + time condition, `Rate-Control: no`) are in [REGIONAL-PLAN.md](REGIONAL-PLAN.md) "Milestone Playback close-out" · the items below are the 2026-09-29 diagnosis notes:
  - Generic ONVIF-style `FindRecordings` (`<Scope/>`) = `InvalidArgs` · **Milestone's own form is required**: `Scope/IncludedSources/Token` = the camera GUID
    + `RecordingInformationFilter` = `boolean(//Track[TrackType = "Video"]),<UTC time>,<ms before>,<count before>,<ms after>,<count after>` → returns a SearchToken
  - `FindEvents` = `ActionNotSupported` (use the tracks from FindRecordings as the recorded ranges instead) · `GetRecordingInformation` returns Earliest=Latest=now (unusable)
  - recording token = camera GUID · `GetReplayUri` = `rtsp://<bridge>:554/vod/<guid>` · our RTSP intermediary passes the normal `/live/` path
  - During the test the SAN was offline: FindRecordings returned 0 tracks, `/vod/` SDP `npt=0.0-0.0` then SETUP = `455 Method Not Valid in This State` — **retest when the SAN returns**
    (read-only diagnostic script: Milestone-style FindRecordings + play `/vod/` through onvif-replay-proxy) · if video comes back, a Milestone-specific path must be added to
    `onvif-profile-g-playback.js` (brand `milestone`: FindRecordings as above, no FindEvents call, token = GUID)
  - Reference: doc.milestonesys.com → Milestone Open Network Bridge → "Manage video playback"

**B. Event backbone (done 2026-09-28)** — `server/shared/ai-events.js`, the `ai_events` table in all three roles; results and images are copied along Edge → Regional → Central
- event: `type` (a-z 0-9 _ . -), `label`, `rule`, `ts` (+07:00), `trackId`, `attrs` (≤ 8 KB), `origin` camera|edge-ai, JPEG image ≤ 300 KB
  stored at `<stateDir>/ai-snapshots/<YYYYMMDD>/<id>.jpg` · deleted when older than `AI_EVENT_DAYS` (90)
- edge: `POST /api/v1/ai/events` (a single event or `{events:[…]}` ≤ 100; the key must have **allow_event_write** = tick "send events" — for trusted source APIs, with the source enabled per camera)
- both: `GET /api/v1/ai/events?since=|from&to&cameraId&type&label&origin&limit` (returns `nextSince`), `GET /api/v1/ai/events/:seq/snapshot.jpg`,
  SSE `/api/v1/events` emits `{type:'ai_event', event:{…}}` · camera scope follows the key
- central catches up by itself with a `remote_seq` cursor (unique `source_id + remote_seq`) — the live feed is only a signal:
  pull = the edge's SSE, link = the message `ai_event {seq}` + rpc `ai.since` / `ai.snapshot` · catch-up again every 60 s · images are copied and stored at central
- **Edge-down alert** (`server/vms/edge-alerts.js`): down for more than 2 minutes (`EDGE_ALERT_AFTER_MS`) → log `EDGE_DOWN`/`EDGE_UP`,
  SSE `edge_state` to every client, a red bar on every page of the central web UI (`GET /api/edge-alerts`) · link-mode edges that have never connected are counted too
- Central web: **AI Events** page (permission `menu.ai`) filters by day/camera/type/source, has images, and the "Playback" button opens Playback 10 s before the event

**C. History of the old camera-side AI poller — cancelled 2026-09-28; this is not the current external receiver** · It was built and ran in production for half a day (ONVIF metadata and Tiandy counts
sent as events) and then the operator decided to remove it: there is no `ai` option in edge.json, the poller/metadata-collector does not send into `ai_events`,
`POST /api/v1/ai/events` accepts only `origin: edge-ai`, the AI Events page has no source filter · the code in `server/gateway/analytics/` is kept
- What was kept: a fix for a fresh-install bug found during testing: `camera_analytics` on a new DB got PK `(camera_id, ts)` but the code wrote `ON CONFLICT(camera_id, rule, ts)`
  → every freshly installed machine (including edge 001) could not write counts · now a new DB creates the new PK and an old DB has its PK migrated automatically on startup

**Tests of B–C (2026-09-28)** — fresh-DB sim edge 999 (pull) + edge 998 (link) + central: events reach central in < 2 s · central goes down, 3 events sent,
→ all recovered, no duplicates · images crossed both pull and link byte-identical · key without permission = 403, wrong type/camera = 400/404 · edge down → red bar + `EDGE_DOWN`
then back → `EDGE_UP` · real Tiandy: PK migration succeeded, the increasing count became `people_count` and reached central

**D. External AI receiving (in production 2026-10-02, Gateway 10ea98f)**

- The Edge sets AI Sources per camera (device / API); receivers are off by default and can be filtered by Group
- Tiandy MODEL-A: Perimeter through AlarmInfo + the alarm image on SD matching the channel/second; waits for the image with a durable pending state
- UNV IPC2325SB: ONVIF RTSP metadata LineCrossing on channel 1 → GetSnapshotUri immediately; a live image is never used in place of an old event
- Regional/Central receive copies of events + JPEGs and filter by Edge/Group under the key's permissions; Client 1.9.4 shows the images and details
- The old inference worker, AI Rules and the Python/GPU installer are removed; the old inference settings API answers 410 and the worker's key is revoked
- The 2026-09-28 GPU detector approach is cancelled — the worker is not installed or turned back on; old DB rows/images and backups are kept
- Scope of native adapters and real results: [EXTERNAL-AI.md](EXTERNAL-AI.md); ONVIF/Profile M does not guarantee every AI type or model

**Test A (2026-09-27)** — simulated edge 999 / central 000 instances (5283/5383, fresh DB) + Tiandy 203.0.113.12:
60 s files indexed · ranges/playback (hevc copy and h264)/frame work through central · no token / token for a different name = 401 ·
key without allow_playback = 403 · range with no video = 404 · plays on the Playback page for real · found and fixed: `kill` of an exiting ffmpeg → `EPERM` crashed the gateway
· the test camera's clock is ~2 min 23 s behind the machine — the OSD on the video does not match the requested time (no NTP, per the agreement)

## Full-system audit (2026-09-28/29)

Audited 8 areas (security, central↔edge, playback, AI, web, Windows client, schema/scripts, runtime) and fixed them in the same commit · what was fixed:
- **Security** — `/hls` used to forward every path to go2rtc's API (yielding RTSP + every camera's password with any stream token) · go2rtc's API was open on 0.0.0.0 with no password →
  bound to 127.0.0.1 · the web UI stored the real password in localStorage → session token · an operator could create/view API keys beyond their camera scope · the edit/delete camera routes did not check scope ·
  `role_id` could be raised to superadmin · camera passwords leaked into logs from ffmpeg's stderr · central did not validate the scheme of URLs from the edge · no login rate limit
- **Stability** — a DB error during edge `hello` crashed central · link playback was cut at 300 s (`requestTimeout`) · ffmpeg/NVR sessions left hanging when the viewer closed before video started ·
  an old signed package could be used to downgrade an edge (added `sig2`/`issuedAt`) · the AI worker dropped events when the gateway was down for a long time / on half-saved batches (transaction + `eventId`)
- **Testing** — `node --check` on everything · eslint 0 errors · vite build · dotnet build 0 warnings · separate tests per area · simulated central+edge with a fresh DB 27/27 passed
  (login token, forged token 401, `/hls` 404, `/api/v1` 401, rate limit 429) · **not yet tested against real cameras/GPU/edge 002**
- Cleaned up data left over from the recorder: 427 `recordings` rows in edge 001's DB and old install kits (`scripts/prune-edge-kits.ps1`)

## Test notes (2026-09-23)

Tested on a single machine with a simulated edge/central and real cameras (Tiandy 203.0.113.12, Uniview 203.0.113.106):
video flows camera → edge go2rtc → central go2rtc and the raw path is still HEVC · central's DB has no camera passwords ·
re-adding produces no duplicate rows · renaming at the edge makes central follow, but groups set at central are not overwritten · delete at the edge → `missingAtSource` ·
shut down the edge → `reachable:false`, and it recovers by itself when the edge comes up · PTZ via central works, and is rejected when the edge's key lacks permission ·
central adding/scanning cameras itself gets 403 · the edge accepting `/api/edges` gets 403

**Live status + link (2026-09-23)** — tested with simulated instances (edge 997 / central 000 on ports 5584 / 5585 + separate go2rtc):
edge changes `reachable` → central forwards `camera_state` to clients within a few milliseconds · shut down the edge → cameras become `null` immediately
and recover by themselves when the edge comes up · link: edge connects → catalog arrives → opening `/stream/<id>.mp4` at central yields video (first byte ~6 s
including the time to command the push) → 60 s with no viewer closes the push · PTZ over the link gets an answer from the edge · `/api/v1/health` has `edges[]`

The simulation also found that **fresh installs had never worked** before (production did not hit it because the old DB had everything) — all now fixed:
no migration for `rtsp_sub`/`onvif_*_token`, the `api_clients` index was created before the table, a new superadmin had no `role_id`,
the `analytics_*` columns were not created when AI was off — so test with a fresh DB every time the schema is touched
