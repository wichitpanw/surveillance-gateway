# Plan: Three-Tier System Central → Regional → Edge (Province)

Written 2026-09-29 · **Status: the real three-tier system has been migrated · migration closed out 2026-09-30; now Gateway d645ed9 / Client 1.9.5 (2026-10-07)** · Decision maker: the system owner · Related code is in `server/vms/edge-*.js`, `server/shared/instance.js`

## Current status — 2026-10-07

- Gateway `d645ed9` matches across Central (000), the central Regional (100), Windows Edge 101 and Ubuntu Edge 102 (deployed 2026-10-06): per-camera audio, AXIS S30 640x360 sub stream
- Windows Client `1.9.5` released (per-tile speaker button); 1.9.4 collapsible Camera Library filter; 1.9.3 AI Events images and Edge / group / origin filters
- 163 cameras: Edge 101 = 7, Edge 102 = 156 · the Regional has 3 child rows: 101, 102 (Online) and **103 "Edge ทดสอบ"** (reserved 2026-10-07)
  — a **test Edge** the owner deliberately links to the central Regional although its province is in another region: the Regional now accepts out-of-region cameras with an "N out of region" badge on Edge Nodes (it used to reject the whole batch with 409), and an Edge whose own province is out of region gets an "Edge out of region" badge
- Before installing a new Edge, run `build-edge-kit.ps1 -Publish` so Central (and the Regional mirror) hand out the current offline kit, or update right after linking
- Edges receive AI from cameras / NVRs / VMS / APIs → Regional → Central with JPEGs; none of the three tiers runs inference; the old worker, AI Rules and the Python/GPU installer are removed
- AI Sources is general and has a Group filter; new cameras do not enable a receiver automatically — choose the source and enable it per camera
- Tiandy MODEL-A uses AlarmInfo + alarm images on SD; UNV IPC2325SB uses ONVIF RTSP metadata LineCrossing + GetSnapshotUri for new events (single-channel cameras, channel 1)
- After the update the Tiandy/UNV receivers at Edge 101 are connected; Tiandy has real event images in Central production; UNV events with images were tested with the real camera across all three tiers in the simulated system — no claim yet of a new production event with an image
- Event images are stored and forwarded, but the system records no video; playback is pulled from cameras / NVRs / VMS

## AI source release history — 2026-10-02 (38315ff)

- Gateway build `38315ff` matches across Central, Regional, Windows Edge 101 and Ubuntu Edge 102
- The operator installed the package on both Edges through the Regional page; Online / install success and /api/instance were confirmed
- Backup before the merge: `D:\gateway-backups\daily\20261002-141316`
- Edge packages released for Windows x64 / Linux x64 / Linux arm64; signature, size and SHA-256 passed
- Windows Client `1.9.3` published as full/delta/installer; supports event images and the Edge/group/source filters
- AI is received from the source system per [EXTERNAL-AI.md](EXTERNAL-AI.md); no inference is run and no video is recorded
- Newly added cameras appear in AI Sources but the receiver must be enabled per camera; native UNV in this round supports LineCrossing on single-channel cameras (channel 1)

## Production status and closed work (2026-09-30)

- Gateway build `a36a2d8` is running and matching across Central, Regional and Edge 101/102; Windows x64/Linux x64/Linux arm64 packages were published and signature, size and SHA-256 checks passed
- Central node `000`: `203.0.113.80:5173` / Tailscale `<central-tailscale-ip>:5173`; Regional, central region, node `100`: the same machine on port `5273`, state `D:\gateway-regional`, RTSP `8565`
- Edge `101` is a new Windows machine at the site office; Edge `102` is the existing Ubuntu machine (formerly called Edge 002), Tailscale `<edge-102-tailscale-ip>:5173`, state `/var/lib/gw-edge`, service `gw-edge`; both connect to Regional in link mode and the update install was confirmed successful
- At close-out there were 162 cameras: 6 on Edge 101 and 156 on Edge 102; these counts are as observed at close-out, not fixed values
- Central can add only Regional; the Regional Nodes page expands to show child Edges including node, Remark, status, camera count, build and sync time · the camera list shows `Regional 100 : Edge 101/102` according to the real origin
- Regional adds an Edge by choosing the province from a dropdown and has a Remark for the location; one province may have multiple Edges, each site uses its own node number and connects directly to Regional **with no Sub-edge** · the existing limit of 99 Edges per region
- Edge enforces province and district on every route for adding cameras, including NVR/API/Milestone/DSS/Digifort; the API rejects blanks and mismatched province–district pairs before import
- The Edge Cameras page has **Edit province–district for the whole group** and edits cameras selected across groups; `PATCH /api/cameras/region` accepts 1–1000 IDs, checks permissions and ownership, rejects a set containing any camera not found before writing, and changes the area in a single UPDATE without changing Global ID or coordinates
- Dashboard uses the source Regional's region when a camera has no province; it does not guess a province for existing cameras — a real area must be chosen at the Edge and synced upward
- Edge update: failed downloads retry automatically at 5/15/60 seconds and can be retried on demand; Regional mirrors and Edges check for packages every 1 minute; the API build is confirmed and the catalog confirmed readable from the DB before announcing a new version as ready, to support rollback
- Windows Client `1.9.0` can save multiple Gateways/keys and connect to one Gateway at a time; there is no automatic Central → Regional switchover yet
- Not yet verified on the real topology: cutting the Regional → Central link and keeping video flowing, and playback/PTZ across three tiers with every type of real device; the simulated test results below do not substitute for real-hardware results

### Milestone Playback close-out (2026-09-30, build a36a2d8)

- The XProtect Recording Server previously could not access `E:\STORAGE1` (`Bank directory is unavailable`); after the operator fixed the storage/Recording Server side the Bridge could read real recording lists
- Fixed the Gateway to search by camera GUID with Milestone's time condition, match by RecordingToken, and return real clip ranges; a search that hits the cap splits into sub-range searches and does not pick another camera's footage from an anonymous SourceId
- Playback uses `Rate-Control: no` and an open-ended clock Range so ffmpeg controls the length; the replay path of other-brand ONVIF devices is unchanged
- Verified real stills and video from AXIS P1468-LE / TIANDY TC-C32HS through Regional :5273 and Central :5173; two time ranges opened per camera, 8 H.264 clips in total of about 5 seconds each, and X-Playback-Start matched the requested time
- The operator confirmed **it can now be viewed**; Central, Regional, Edge 101 and Edge 102 use `a36a2d8` and the packages for all three platforms passed signature/size/SHA-256; existing cameras and Global IDs are unchanged and no re-adding is needed
- The items still awaiting real-hardware tests in the earlier list remain; this playback test confirms only two Milestone cameras and does not cover every brand or a real regional link cut

## Test and migration history (2026-09-30)

- A simulated Edge :5283 → Regional :5483 → Central :5383 (DB/secrets/ports separate from production) passed the catalog transfer, with the existing global ID `TH-40-101-00001` reaching Central
- Regional issues API keys to Clients itself: `/api/v1/health`, the camera list and a synthetic H.264 video through fMP4 work even with the simulated Central :5383 stopped; after Central is back the link reconnects and syncs by itself
- Live video from a nationwide Client via Central → Regional → Edge was tested against a synthetic stream and passed; cameras of the Regional branch show `reachable: null` at Central when Regional stops and return to `true` when the Edge reconnects
- Web role permissions by region/province at Central were tested: a Northeast-region role sees 1 camera and an East-region role sees 0
- Central reserves the next Regional number 200 after 100 is used; the role/region/node in the token are checked when the link is accepted · Windows Client build 1.9.0 passes
- All three instances start with fresh databases (`edge`, `regional`, `central` on simulated ports) · the Regional page shows its own name/menu · the role page shows the real regional scope instead of per-camera counts · a user with a per-region custom role can be created via the API, and mismatched `role`/`role_id` are rejected with 400
- Two simulated regions (Northeast 100/101 and North 200/201) can connect to the same Central; identical long source camera IDs do not collide at Central and both global IDs are unchanged; the second region's video reaches the nationwide Client
- Opening video from 3 Central streams and 1 Regional stream at once: the camera source is pulled once, and there is 1 push into Regional and 1 into Central; after all are closed the source stops in about 80 seconds after fixing the chained push closing (about 180 seconds before the fix); clients inside the region keep receiving video when Central stops watching
- Region-based roles that are cached receive new cameras automatically and drop deleted cameras across both tiers; Regional sends the relay tombstone up to Central before deleting the row, so Central does not keep it as missing at source; it rejects Edges outside the block, nested Regionals, and catalogs with provinces outside the region (the last one changed to accept with a warning on 2026-10-07)
- The playback pipe was tested against a simulated HTTP source: bytes and start time match, closing the viewer closes the lower tier, a source reset causes no unhandled error, and nonexistent cameras/recordings are rejected; this is not yet a test of recordings from a real NVR
- Regional pulled a simulated install kit from Central and the SHA-256 matched and appeared in Regional's list; the mirror was tested with copies of genuinely signed packages for Windows x64/Linux x64/Linux arm64, passing SHA-256 checks, rejecting a forged sig2, re-downloading a corrupted file, and rejecting a manifest older than the sequence previously accepted
- The real `edge-run.cjs` controller was tested with a Regional app fixture and a separate test key: it swaps app/app.prev when the new version connects to the parent, and rolls back to app.failed/app when the new version cannot connect to the parent — passed; a full Gateway package release on a pilot machine still needs confirming
- **M0 backup and inventory done**: `D:\gateway-backups\regional-migration-M0\20260930-063926` · both DBs pass `PRAGMA integrity_check` · Central 164 cameras/2 sources/7 keys, old Edge 8 cameras/1 source/2 keys; `inventory.json` holds only whitelisted metadata and `inventory.md` summarizes counts, with no passwords/keys in the inventory
- Real cameras at the old Edge: Tiandy 1, Milestone 2, DSS 5; 7 cameras have no province yet and need one assigned when re-added so that area summaries/permissions are correct
- 2026-09-30: committed Regional `e12f958` and merged the latest master work as `3a124c5`; deployed Central `203.0.113.80:5173` and Regional, central region, `203.0.113.80:5273` — both pass `/api/instance` with build `e12f958` · Regional node `100` connected to Central with status `ok` · the old Edge PM2 / AI and the Edge 001 source were removed from Central with the old state kept together with a backup · Windows Client `1.9.0` released
- Regional reserved Edge `101` for the new machine and `102` for the existing Ubuntu; configs are in `D:\gateway-sandbox\regional-edge-configs` and contain tokens, never to go into git · the default province value `10` must be changed to the real province before adding cameras if outside Bangkok
- The Ubuntu machine was moved to Edge `102` after backup/reset and Windows Edge `101` was installed; both connect to Regional `100` (for the latest status see the production status section above)
- The migration and Edge installation are done; playback/PTZ and link cuts on the real topology still need confirming per the limits above

## Latest conclusions from the system owner

- Confirmed 2026-09-30: Central may add only Regional, in both pull/link and token issuing; Regional may add only Edge, with no exception letting Edge 001–099 connect directly to Central again · the Central page is named Regional Nodes and the Regional page uses Edge Nodes · the province is chosen by name from a dropdown and the original code is kept in config
- The system is still in development with no real users: clearing camera data and re-adding is permitted once the three-tier system is ready; there is no need to preserve existing camera rows, walls, permissions or tokens during the move, but you must back up and review the list of what will be cleared before acting on real data
- The 2026-10-02 AI agreement replaces the earlier pause: events/JPEGs from the source travel Edge → Regional → Central, and the inference worker is removed
- Use blocks of 100 numbers per region (1 Regional + up to 99 Edges)
- Minimum per-region/province permissions at Central must be done before users are allowed onto the three-tier system
- Regional can issue API keys to the Windows Client and external clients that point their URL directly at Regional, seeing only the cameras in the region per Regional's catalog; Central issues keys for nationwide viewers according to the key's scope
- If the Regional ↔ Central link is cut: Regional and the province Edges in the region must keep working; a Client pointed at Regional must be able to view live/playback and control PTZ per permissions without depending on Central
- The simulated tests and the core must pass before changing `:5273`; never wipe production during development

## 1. Starting agreements (from the system owner)

- Management tiers: **country → region → province → site** · program tiers: **Central → Regional → Edge (province)**; provinces connect directly to the region
- Use **6 regions**: Central (including Bangkok/vicinity), North, Northeast, East, West, South · sites use a separate Edge machine with a Remark stating the location, no Sub-edge
- The organization has a network that interconnects the whole country · camera IPs may repeat across provinces, but each province's edge designs the IPs within its own site, and the upper tiers do not see camera IPs (they use the global ID / camera id), so it is not a problem
- **Not doing yet:** TLS, central login (AD/SSO), viewing audit logs, an escalation table for alerts · workload size (number of sites/cameras/users) is not yet certain and will be adjusted when data is available

**Existing principles that do not change:** the edge owns cameras and camera passwords · the Edge receives AI from the source · video goes to upper tiers only when someone is watching, while events/JPEGs follow the receivers that are enabled · the global ID must not change once issued, but if the camera is deleted it goes away with it · playback is pulled from the devices at the edge

## 2. New rules (docs/CONTRIBUTING.md must be updated when this is done)

| Program | Adds what | Does not |
|---|---|---|
| **Edge (province)** | Cameras (ONVIF / NVR / VMS of every kind) | Add another edge |
| **Regional (region)** | **Province Edges** in its own region | Add cameras itself (like current central) |
| **Central (country)** | **Regional** only | Add cameras itself |

- Regional is a Gateway that does **two jobs at once**: the lower side acts as the region's central (accepts province edges, issues keys/tokens to Clients in the region) and the upper side acts as an edge (connects a WebSocket up to central, sends catalog / status / video)
- No loops: central can add a regional only one way; a regional must not add central or another regional
- The regional's web UI uses the same set as central (Live, Playback, Edge Nodes, API Clients) with no add-camera button · AI Events aggregate source results with images and filter by Edge / Group

## 3. How data flows

```
Camera ─▶ Province Edge ─▶ Regional ─▶ Central ─▶ Nationwide Client
         (holds passwords, AI)  (whole region)  (whole country)
                             └────────▶ Client inside the region (still works when the link to Central is cut)
```

| Data | Method | Notes |
|---|---|---|
| Camera list (catalog) | edge → regional → central every 10 minutes + notified immediately over the link on change | global ID passes through as-is and must not be reissued along the way · two stacked tiers can delay it up to ~20 minutes if there is no immediate notification |
| Camera status (`reachable`) | forwarded tier by tier | lower tier down = `null` for the whole branch (matches the existing rule), never written as `false` |
| Live video | go2rtc stacked across three tiers, sent raw (no transcoding) | fan-out at each tier: one camera crosses the link between tiers only once regardless of how many are watching · the source is closed when no one watches for 60 s, which must stack in the right order |
| PTZ | nested rpc central → regional → edge | outer-tier timeout > inner tier + 2 s · `allow_ptz` must be enabled on both |
| Playback | ranges/stills via nested rpc · video: the edge uploads a stream up to regional and then **regional pipes it on up to central** (not parked on disk) | a new pipe connector must be written · timeouts: recording ranges 60 s, images 50 s |
| AI events | Edge → Regional → Central | results received from the source with JPEGs; no inference in any tier |
| Edge-down alert | regional alerts for its own province · central alerts on regional down + number of cameras with unknown status | time-based escalation later |
| Software update | central → regional → province edge (regional keeps the signed package to hand it on, re-checking `sig` + `sig2`) | released in rounds: pilot region → other regions |
| Users/API keys | separated by tier: regional has users and issues API keys to Clients in the region that connect directly to the Regional's `/api/v1` · central issues keys to nationwide Clients and sets per-region/province permissions | existing self-defined camera groups remain usable |

## 4. Data model

- `ROLE` gains the value `regional` (`server/shared/instance.js`) · the app name is **Surveillance Gateway Regional** · `/api/instance` and `/health` report `role: regional`
- **Regions:** `server/data/thai-region-groups.csv` (2-digit province → 6 regions) used for permissions/summaries · based on the division by the [National Statistical Office](https://www.nso.go.th/public/e-book/Statistical-Yearbook/SYB-2025/53/), merging Bangkok/vicinity with the Central region · **cameras from a VMS have no province and must have one set before being counted in summaries**
- **Node number (3 digits):** central owns the numbers for the whole country · a Regional uses the block-start number 100/200/... and Edges in the region use +1 to +99 · 001–099 are reserved for legacy and are not reissued after a reset
- `camera_sources` gains `remote_role`, `remote_region`, `node_block` · the `cameras.id` of relay cameras uses a stable hash from the node number + the lower-tier ID so it is not truncated into collisions · `global ID` keeps the form `TH-<province>-<node>-<sequence>` issued once at the Edge
- Province/district/site are place data for display and search, e.g. `Example Province / Example District / <exchange site name>`; place names are not part of the `global ID` · a site table (exchange code, name, coordinates, type) comes later when the details are ready

## 5. Development work (in order)

**Phase 0 — prepare and test with simulations (do not touch production)**
- 0.1 Extend `scripts/edge-sim.ps1` to start three tiers on this machine: central 5383 · regional 5483 · edge 5283 (fresh DB each time)
- 0.2 Region table + tests covering all 77 provinces

**Phase 1 — core: the regional role and two-way connections (size L)**
- 1.1 `ROLE=regional`: a new permission helper replacing `edgeOnly`/`centralOnly` (can accept edges: central+regional · can add cameras: edge only) and hide irrelevant menus
- 1.2 regional runs both the link server (accepting province edges) and the link client (connecting up to central) in one process · the catalog sent up must include the `edge_relay` cameras obtained from the lower tier with their original global IDs
- 1.3 central `checkEdge` accepts `role: regional` (currently enforces `edge` at `edge-source.js:175`) · the Edge Nodes page shows the type (Regional / Edge) and the total camera count
- 1.4 Hand out node number blocks · prevent loops · test duplicate id/global ID across tiers

**Phase 2 — video and commands across two tiers (size L)**
- 2.1 Live video: central pulls `_raw` from regional, regional pulls from edge · stacked reapers
- 2.2 PTZ via nested rpc · 2.3 recording ranges/stills via nested rpc · 2.4 playback video piped through two tiers (new)
- 2.5 Test with real cameras: Tiandy (Profile G), DSS (live/playback/PTZ)

**Phase 3 — permissions, alerts, summaries (size M)**
- 3.1 Central role permissions by region/province (including new cameras in the area automatically) · 3.2 two-tier alerts · 3.3 per-region/province summary dashboard

**Phase 4 — update and install (size M)**
- 4.1 regional hands on updates + release rounds · 4.2 regional install kit (issued from central) and province edge kit (issued from regional, URL pointing at regional)
- 4.3 `ecosystem.regional.config.cjs`, `start-gateway.cmd`, `deploy.ps1`, backup/prune scripts to know about regional

**Parked work:** the site table, SSO, viewing audit logs and escalation · AI events/images across Regional are done as of 2026-10-02

## 6. History of the :5273 migration plan (carried out 2026-09-30)

Before the migration **:5273 was the real Edge**: it has cameras, `1-go2rtc-edge` · the system owner permitted starting a fresh camera database, but state must be backed up and the values needed for re-adding must be surveyed before changing the role:

| Step | What to do |
|---|---|
| M0 | Back up the DB/secrets/config of Central and Edge, make the list of cameras/VMSs and the data for re-adding, record the number of walls/permissions/keys to be restarted from scratch |
| M1 | The system owner provides a new Edge machine to replace Edge 001 and adds the cameras themself · use the existing Ubuntu Edge 002, issuing a node number in the region's block and changing the destination to Regional · no need to start a province Edge on the Central machine |
| M2 | Set up Regional at **:5273** with new state and the block-start number · have the province Edges connect to Regional in link mode · check a Client pointed directly at Regional and test cutting the link to Central |
| M3 | Central adds Regional and then issues nationwide keys · check cameras/global IDs and per-region/province permissions · switch other province Edges one machine at a time after the first region passes |

Confirmed 2026-09-30: Central `203.0.113.80:5173` unchanged · Regional `203.0.113.80:5273` uses new state `D:\gateway-regional` · the old Edge's PM2 was removed before using port 5273 and `D:\gateway-edge` was kept with a backup · the old cameras at 5273 need not be moved, the operator adds them again 

Do phases 0–4 and the pass criteria that can be tested on the simulation (5383/5483/5283) before starting M0–M3 · clearing real data comes after the backup and review of the data list, and is not done during development

## 7. Pass criteria

1. central sees the cameras from two Edges through two Regionals with global IDs issued by the new Edges, not duplicated and not changed along the way
2. Live main/sub video crosses three tiers · open 3 clients at once and the camera crosses the link between tiers only once · after all are closed the source closes in ~60–120 s
3. PTZ (DSS, Tiandy) through two tiers and the camera really moves · `allow_ptz` off at either tier = rejected
4. Playback (ranges, stills, video) through two tiers · after closing the window midway there is no lingering ffmpeg/pipe
5. Cut a regional: central sees that region's cameras as `null` and it recovers by itself when reconnected · cut a province edge: regional alerts, central sees only that branch as `null`
6. An update package sent from central reaches the province edge through regional · forged signatures/old versions are rejected at every tier
7. `node --check`, eslint, build, and tests with a fresh DB pass
8. After Regional issues an API key, a Windows Client pointed at Regional can reach `/api/v1/health`, see only the region's cameras, and use live/playback/PTZ per the key's permissions; Central's key sees the nationwide cameras per its scope
9. Close the link to Central while Regional and Edge are still connected: a Client pointed at Regional still sees the catalog/status and can use the region's video; after reconnecting, Central syncs by itself without re-adding

## 8. Risks and cautions

- **:5273 is production** — never change the role of an instance that has real cameras in place (see section 6)
- **Nested timeouts:** rpc is 10 s per tier, recording ranges 45 s; if they are not adjusted to nest, the outer tier fails before the inner one
- **Two-tier playback video:** memory/pipes hang when a viewer closes midway (a lesson from the lingering-ffmpeg bug of 2026-09-29), so specific tests are needed
- **Version mismatch:** central newer than regional newer than edge during a rollout · a "protocol" version number is needed in hello, rejecting when too far apart
- **Regional link cut:** the whole region is `null` at central (intended behavior); users in the region can still use their own regional
- **No TLS:** three tiers across the organization's network are still plain text; agreed to park it, but it must be done before real use across multiple sites
- **Capacity:** the existing figures (central's 1 Gbps NIC ≈ 45–60 viewers/wall sub) continue to apply to central; regional must be calculated separately by the number of people in the region

## 9. Undecided / awaiting information

- Number of sites/cameras/users per region · regional machine specs (is a GPU needed — not if clients decode themselves)
- Site table · alert channels and timings · AI event policy across regions when work resumes
- TLS / SSO / viewing audit logs (parked)
