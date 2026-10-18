# Full Stack fix plan and results

> A record of the 1.9.2 review and release, kept as of its date. For the current state (2026-10-17: Gateway 651549d / Client 1.14.2) and external AI, see [EXTERNAL-AI.md](EXTERNAL-AI.md). Historical test results are not rewritten as results of newer releases.

Date 2026-10-01 · code base 9b45ad0 · developed in the dev worktree · production is still 9b45ad0

## Goals and scope

Fix defects found in review to prepare for integrating agency cameras; no AI, TLS/SSO, recording system or out-of-review features are added.

1. Close the privilege-escalation and cross-account data holes
2. Make download results reliable and verify the range the device can deliver
3. Let the Edge recover when an update fails during the file swap
4. Fix the web flow and the Windows client's reconnect
5. Check regression and build in isolation from production

## Fixed in the worktree

- user PUT/DELETE checks the target account's permissions and camera scope even when the role does not change
- API key reveal/enable checks the flags the manager must hold themselves
- the legacy username/password header shares the throttle with /api/login
- settings are separated into public map / private Telegram and internal settings are blocked from POST
- someone with device.manage but without device.secrets can edit metadata without changing connection/credential or triggering a new probe
- when the session changes, the app is remounted / all account data is reset; old responses/bodies/401s do not cross sessions; Dashboard logs are shown according to permission
- fixed the API toast, grouping with prototype-less objects, and checking the response before reporting a successful delete
- HTTP download/upload completes only when stdout ends and the source process exits 0; a source failure aborts the response/upload so the client rejects the file
- success/failure signals pass through 1–2 relay hops; relays have explicit process completion events
- Download sends complete=1 along the whole path; AXIS/Uniview/DSS reject ranges that straddle the first clip with HTTP 416 plus the maximum length so a new range can be chosen
- The Windows client validates the fMP4 structure before renaming .part, and does not accept header-only/truncated fragments
- The renderer separates timeout/cancel/stale attempt, reconnects when there is no frame for 12 seconds, does not reconnect while paused, and restores the retry budget when a real frame arrives
- The Edge runner can roll back even if app has been moved to app.prev but app.new failed to move, including restarting the original version when it failed before the swap
- Windows client version 1.9.2 for releasing this fix set

## Test results

- backend/script syntax, 78 files: passed
- ESLint src: 0 errors, 4 pre-existing hook warnings
- Vite build of Central/Regional/Edge/client-map to review-dist: passed, production dist untouched
- dotnet Release build of client 1.9.2: passed with 0 warnings/errors
- git diff --check: passed
- isolated actual backend handlers: user permissions/scope, key flags, shared throttle, settings filtering/internal key rejection, credential preservation passed deny/allow
- frontend actual apiFetch/handlers: account reset, stale responses/body/401, token rotation, FormData, prototype groups, logs gate, mutation failures and toast flow passed
- actual playback/link/relay: source exit 0/1, empty stream, one/two relay hops, strict clip duration passed
- actual update function in a VM/filesystem stub: success, second rename failure, pre-swap failure and health-check rollback passed
- renderer source in an isolated test: timeout, cancel, stale request, no-frame/pause/resume, retry budget and reentrant fallback passed
- fMP4 validation: header-only/truncated boxes are rejected and the existing destination is kept; fragmented H.264/H.265 files from real ffmpeg passed

## Limitations and next steps

- Not yet verified in this fix round: the post-login UI, real WPF/GPU, real cameras/NVRs, and real topology link cuts
- The fMP4 check certifies the file structure, not every frame's codec or the real video length when a device ends normally but sends a short video itself
- Multiple recording clips are not yet joined into one file; choosing a range beyond the clip the adapter supports is explicitly rejected and the user must choose a new range
- The build shows a warning that Node 22.6.0 is below the version Vite supports, plus Browserslist/chunk size warnings; the build passes, but toolchain work should be scheduled separately before using it as a long-term pipeline; the production runtime is not changed in this work
- The user authorized commit/deploy/client release of this set on 2026-10-01; the deployment result must be checked after the script finishes
- Deploy order: commit -> fast-forward production -> deploy.ps1 -ReleaseClient (backup/restart/build/publish Edge/client) -> check builds/feed/hashes -> acceptance test with the pilot agency
