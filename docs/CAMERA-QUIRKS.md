# CAMERA-QUIRKS — brand/model-specific problems encountered so far

The cameras in this system are a "collection of firmware", not a collection of cameras — Tiandy, Uniview, Dahua, Hikvision and generic NVR brands all
claim to support ONVIF/RTSP, and each one violates the spec in a different corner. This file records the real problems found, how they were fixed, and how to chase the next one · Updated 2026-09-28

## Guiding principle before reading the list

**Do not build a brand table that needs hand-editing every time a new camera arrives.** Try the standard first, and only if that fails fall back one layer at a time,
and **verify you got the real thing, not just "it connects"** — nearly every problem below looks like success: it connects, answers 200, the stream shows as playing, but the screen is black.

The ladder in use (no brand names in the logic):

| Step | What it is | Where |
|---|---|---|
| 1 | RTSP passthrough — the camera's own codec (the `_raw` stream) | `server/gateway/go2rtc-sync.js` |
| 2 | passthrough + a workaround during negotiation (`#backchannel=0`) | the same `_raw` stream |
| 3 | ffmpeg transcode to H.264 | the main stream (`sourceFor()`) |

The Windows client requests steps 1–2 first, checks whether frames actually arrive, and falls back to step 3 itself if not (`client-windows/SurveillanceGateway.Client/Video/VideoTile.cs`, `UseFallback`)
A central that pulls from an edge also uses the edge's `_raw` stream and then transcodes at central.

Other things that follow the same principle: `server/codec_cache.json` remembers the real codec of each RTSP (it does not trust the brand),
and the AI discovery code (`server/gateway/analytics/discovery.js`, disabled) asks ONVIF camera by camera and uses the brand only as a hint.

## Problems encountered

### Milestone Open Network Bridge: H.265 must receive RTSP over TCP

- The Bridge uses ONVIF to read the name/profile and RTSP URI of the cameras the VMS publishes · the standard ports are ONVIF 580 and RTSP 554
- Tested with VLC: RTP over the original transport connects but H.265 hangs at `Waiting for VPS/SPS/PPS`; with `Use RTP over RTSP (TCP)` enabled the picture appears
- The Edge UI has VMS → Milestone Open Network Bridge separate from Digifort · enter the address and account yourself, scan ONVIF, and import the RTSP the Bridge actually returns · the `_raw` stream of this camera group forces `#transport=tcp`
- The Codec value on the Bridge's General page is a value reported to ONVIF clients and does not convert the real stream · keep `Use configurations from devices` to read the real values
- Real test 2026-09-28: cameras imported from the Bridge at the Edge, and the Client could view 2 channels; after fixing status delivery Edge → Central and restarting the backend, the user confirmed both channels showed Online
- If video arrives but the status is Unknown, check `/api/v1/cameras[].state.reachable` at the Edge and at Central separately; a camera added after the SSE link opened must get its initial status from the sync round (`server/vms/edge-source.js`)

- Playback tested against real recordings 2026-09-30: the Bridge must receive a `FindRecordings` with `IncludedSources/Token` (the camera GUID) and a `RecordingInformationFilter` (XPath, UTC timestamp, time range / count before and after); an empty Scope answers 400 even though XProtect already has recorded video
- Each result row is a clip range of the same GUID; `SourceId` is anonymous so rows must be matched by `RecordingToken` and gaps shown according to the real clips, never assuming continuous recording all day · a query that hits the cap splits the search range again
- Milestone's RTSP replay uses `Range: clock=<UTC>-` and `Rate-Control: no`; let ffmpeg control the clip duration — specifying the end in RTSP once made a 5-second clip last only 1.8 seconds and hang waiting · other devices' ONVIF paths still use a clock with an end as before
- Before changing the Gateway, check on the XProtect Recording Server that storage does not show `Recording (Unavailable)`; successfully receiving config or being able to watch live does not confirm that recordings can be read

### SDP contains only audio when the ONVIF backchannel is requested

- **Seen at:** NVR `203.0.113.24:55101` (SDP says "ONVIF RTSP Server"), every channel
- **Symptom:** the `_raw` stream connects and stays up, go2rtc has a producer and data flows, the client shows a green dot at 0 fps and a black screen — the same camera's transcode stream is fine
- **Cause:** go2rtc puts `Require: www.onvif.org/ver20/backchannel` in DESCRIBE unless told not to. Per the ONVIF spec the device must answer an SDP with video +
  audio `recvonly` + audio `sendonly`, but this NVR drops `m=video`; go2rtc follows the SDP and gets only `pcm_mulaw`
- **Why it does not recover by itself:** go2rtc retries without requesting the backchannel only when the device answers `551 Option not supported`, but this one answers `200 OK` with a wrong SDP
- **Fix:** `#backchannel=0` on every source of the `_raw` streams (`server/gateway/go2rtc-sync.js`) · verified 2026-09-08:

| Camera | Without the flag | With `#backchannel=0` |
|---|---|---|
| Tiandy `203.0.113.12` (LAN) | hevc 704x576 + pcm_alaw | hevc 704x576 + pcm_alaw |
| NVR (WAN) | pcm_mulaw only, no video | h264 720x576 + pcm_mulaw |

It is applied to every stream because it does no harm to cameras that do not need it, and the `_raw` stream does not need two-way audio

### go2rtc crashes when sending H.265 out as MSE

- **Seen at:** every H.265 camera (before the system reset, 140 of 182 endpoints)
- **Symptom:** go2rtc 1.9.14 dies with SIGSEGV in `pkg/h265/rtp.go` → `pkg/mp4/consumer.go`
- **Fix:** the stream the browser uses must always be `ffmpeg:<url>#video=h264#hardware` · sending H.265 out over **RTSP** does not crash
  (verified 2026-09-08: pulling continuously for 30 s through a separate go2rtc on port 8557 gave 751 frames at 25 fps, encoder 0%) — that is where the `_raw` stream comes from

### go2rtc HLS has only audio

Segments come out as pure mp3 audio even though the producer is normal H.264 — play through fMP4 `/stream/<name>.mp4` instead of `/hls/*`, which is kept only as a fallback

### Torn/stuttering video from cameras arriving over WAN with a 200 ms jitter buffer

- **Cause:** 200 ms assumes packets arrive evenly, which a WAN does not do · `--clock-jitter=0` / `--clock-synchro=0` made it worse (they disable libvlc's timing management, which live sources need)
- **Fix:** a 500 ms buffer that does not override the clock (`client-windows/SurveillanceGateway.Client/App.xaml.cs`)

### Tiandy locks itself after repeated wrong passwords

There is a 15-minute auth backoff in `server/gateway/analytics/poller.js` · the same lesson as Digifort (it locks the account after 3 failures — the import page fires once per click):
**retrying harder makes brand-specific problems worse**

### node-onvif cannot speak HTTPS / NVRs behind NAT report internal addresses

`server/onvif_patch.js`: `patchOnvifSoapHttps` chooses http/https according to the xaddr (the library uses only http), and
`patchOnvifNatAddressing` rebuilds the URI with a host that is actually reachable instead of the internal address the NVR reports

### NVR channels that are offline during a scan (Uniview NVRs at SITE-1 to SITE-3)

- **Symptom:** a channel whose camera dropped during the scan disappears from `GetProfiles` entirely (not just missing its RTSP) — SITE-3 returned 20 of 28 channels
- **Real data (edge 002 log, 2026-09-24):** `GetVideoSources` still reports every channel; channels with no picture show `Framerate 0`, `0×0`
- **Done:** the scan result fills in channels from `GetVideoSources` that have no profile as OFFLINE rows (`/api/nvr/channels`, `groupOnvifProfiles`)
  and **does not fabricate an RTSP** — no profile = `GetStreamUri` cannot be requested · when the camera comes back and the scan is repeated: already-added channels show ADDED
  and are not selected, `bulk-add` skips channels with a duplicate RTSP (ignoring credentials), so no duplicate rows appear
- Standard ONVIF has no channel name (the name set in the NVR) — the name you see is the VideoSource token (`00200` = Uniview channel 2)
- Uniview has a profile `token:16/0/0/3/1/s0` → `/unicast/c0/…` that is not tied to a VideoSource = the NVR's own stream, not a camera
  The scan result labels it NVR STREAM and does not select it (it was once added as CH 1 of SITE-1 to SITE-3)
- Uniview NVR RTSP: `/unicast/c<channel>/s<0 main|1 sub|2 third>/live` — the channel number in "CH n" is read from this URL
- **Uniview API** (LAPI) reads `GET /LAPI/V1.0/Channels/System/ChannelDetailInfos` with Digest to get `ID`, `Name`, `Status`
  of the configured channels · it matches `ID` only with the `c<channel>` number in the RTSP from ONVIF · an offline channel can be added as a row awaiting video without an RTSP
  The Edge re-checks ONVIF every 2 minutes; when a real RTSP is obtained it fills in the existing row, preserving the id/Global ID, and forwards to central at that point
  (tested with NVR308-64X: LAPI 64 channels, 28 configured, 19 online; ONVIF gave RTSP for 19 channels, all matching by number) ·
  [Uniview LiteAPI document](https://satvision-cctv.ru/upload/iblock/645/7itm221yv53sn9yj5i50tp7bfrz2dm6y/LiteAPI-Document-for-NVR-V5.03.pdf)

### Tiandy varifocal zooms only with ContinuousMove / Uniview varifocal zooms only

- The MODEL-A (203.0.113.12) reports PTZ (pan/tilt + zoom) and 256 presets (names padded with trailing spaces); the camera body is fixed and cannot rotate,
  but the varifocal lens **can zoom with ContinuousMove** (tested 2026-09-23 by comparing snapshots before/after, at speeds 0.25 and 0.5)
  - AbsoluteMove / RelativeMove answer 200 but do not move · `GetStatus` always reports zoom 0.000 — **do not use the position from GetStatus to decide whether zoom works**; judge by the image
  - The motor is slow: presses shorter than ~0.5 s are barely visible → the Live page (`PtzPad.jsx`) moves for at least 0.6 s per press and zoom uses at least 50% speed
- Uniview varifocal advertises a PTZ service but the pan/tilt bounds are 0..0 → `server/gateway/ptz.js` reads the `panTilt` / `zoom` bounds separately
- Uniview's ONVIF does not support `GetPresets` (`Optional Action Not Implemented`)

### Video takes tens of seconds to appear (sub stream)

- Players (web, client, central pulling from an edge) can start displaying only at the first keyframe — a camera with a long I-frame interval makes them wait a long time
- Measured on a real MODEL-A: the original sub was HEVC 352×288 5 fps with keyframes more than 10 s apart → first byte at central after 14 s · main 2.8 s
- Fix at the camera: sub about 640×360, 15 fps, **I-frame interval = fps** (1 s)
- **The system uses only stream 1 (main) and stream 2 (sub)** — stream 3 and above are not used (agreed 2026-09-25)
  - Previously the system picked the lowest-resolution profile as sub, so it got the MODEL-A's stream 3 (352×288 5 fps, GovLength 100 = a keyframe every 20 s)
    even though the user had already set stream 2 to 640×360 25 fps GovLength 50 (2 s) — now sub = the first profile after main in `GetProfiles` order
  - Cameras added before this still hold the stream 3 URL until:
    - a single camera (ONVIF) → open it for editing on the edge's Cameras page and click save (the system probes ONVIF again)
    - an NVR channel (ONVIF / Uniview API) → rescan that NVR; the system updates the sub of already-added channels by itself (main is untouched), no import needed
  - ONVIF with only one profile, and cameras whose RTSP was entered by hand: sub = main (the same stream) — so cells on the Live Wall transcode the full-size picture

### Axis (P1488-LE, AXIS OS 12.11) — separate ONVIF account, only a 4K profile

- **ONVIF requires an ONVIF account** created in the camera (System → Accounts → ONVIF accounts) — the web account (root) gets `400 Sender not authorized`
  - **RTSP works with both the web account and the ONVIF account** · **VAPIX CGI** (`/axis-cgi/jpg/image.cgi`) works only with the web account (an ONVIF account gets 401)
  - Brand `axis` in the system: when ONVIF fails → use `axis-media/media.amp` instead of guessing `/onvif1` · fallback still image via VAPIX (digest MD5)
- The brand can be identified without a password: `POST /axis-cgi/basicdeviceinfo.cgi` `{"apiVersion":"1.0","method":"getAllUnrestrictedProperties"}`
  → a scan with a specified range sets `brand: axis` and fills in the model name itself
- The ONVIF profiles are only `profile_1_h264` and `profile_1_jpeg`, both at 3840×2160 → the system skips JPEG and builds the sub itself with `&resolution=640x360`
  (VAPIX scales according to the parameter, on both `axis-media/media.amp` and `onvif-media/media.amp`)
- Keyframes are frequent — first picture over the link: sub 2.3 s, main 4.7 s
- When scanning many hosts, they answer 401 to every ONVIF command except `GetSystemDateAndTime` → the scan uses that command to check whether a host is ONVIF

### Dahua ONVIF init fails

A Dahua camera at one site (203.0.113.47) makes `node-onvif` break when reading the `Width` of a profile that has no resolution — not fixed yet (direct RTSP works)

### Camera-side AI (currently disabled — kept for when it is turned back on)

- Uniview has no LAPI that returns counts — counts arrive only through ONVIF metadata on RTSP, and half of the AI is wrapped under `UserAlarm/SmartHttpReport/*`, `UserAlarm/IVA/*`
- `GetRules` returns pre-created rule slots, not enabled rules — look at `LineEnable`/`FieldEnable` (do not assume every `*Enable` is the master switch, e.g. `ShoulderEnable`)
- A rule's name in config (`MyLineDetector1`) ≠ its name on the wire (`MyLineDetectorRule`) — match by `topic` only
- Tiandy and Dahua have no metadata track on RTSP · Tiandy gives counts via CGI
- Times from Tiandy cameras end in `Z` but are the on-screen local time · `analytics/http-digest.js` must use `insecureHTTPParser` (the camera answers with bare LF)
- Always distinguish three states: no AI / present but off / camera could not be queried

## go2rtc options worth knowing before chasing the next problem

Added as fragments at the end of the RTSP source, tried in order:

| fragment | Effect | Use when |
|---|---|---|
| `#backchannel=0` | does not request two-way audio at DESCRIBE | connects but no video |
| `#media=video` | requests video only, drops every audio track | an audio track breaks the session (stronger than backchannel=0) |
| `#timeout=30` | connection/data timeout (seconds) | slow camera, distant link |
| `#transport=tcp` / `ws://…` | force the transport | UDP is lost, or RTSP over WebSocket |
| `ffmpeg:<url>#video=h264` | let ffmpeg negotiate instead | last resort — ffmpeg accepts non-spec answers that strict clients reject |

If it works through `ffmpeg:` but not natively, it is almost always the camera answering differently from what it advertised.

## How to chase the next problem

1. **Ask go2rtc what it got:** `curl "http://127.0.0.1:1984/api/streams?src=<path>"` (the edge uses port 1994) returns the actual SDP
   No video in `medias` = negotiation failed, not decoding
2. **Compare with the same camera's transcode stream:** if `ffmpeg:` works but passthrough does not = a negotiation problem, use the table above
3. **Test against a separate go2rtc, never on production:** copy the config, change the API to a free port (e.g. 1985) and RTSP to 8557,
   include only the camera under test, then `go2rtc.exe -config <that file>` — a crash in the test instance affects nobody
4. **Verify with ffprobe, not by eye:**
   `ffprobe -rtsp_transport tcp -show_entries stream=codec_type,codec_name,width,height rtsp://127.0.0.1:8557/<name>`
   Getting only `codec_type=audio` = the SDP-with-only-audio symptom
5. If you suspect a camera is making go2rtc fall over, look at the `0-go2rtc` / `1-go2rtc-edge` logs during the test (see OPERATIONS)

## References

- [go2rtc RTSP source](https://go2rtc.org/internal/rtsp/) — fragment options
- [go2rtc RTSP sources, negotiation detail](https://deepwiki.com/skrashevich/go2rtc/4.2-rtsp-sources) — DESCRIBE/SETUP, `Require:`, retry on 551
- [go2rtc two-way audio](https://deepwiki.com/skrashevich/go2rtc/8.1-two-way-audio-(backchannel))
- [ONVIF Streaming Specification](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf) — what a backchannel DESCRIBE must answer
- [scrypted issue 1989](https://github.com/koush/scrypted/issues/1989) — the same problem on Axis (answers 551)
- [Multi-vendor camera integration pattern](https://www.forasoft.com/learn/video-surveillance/articles-vms/multi-vendor-interoperability-reference-pattern)
