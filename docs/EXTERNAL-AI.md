# Receiving AI results from the source

Agreement 2026-10-02: cameras / NVRs / VMSs / external APIs do their own processing.
The Edge receives and converts events → Regional aggregates within the region → Central aggregates all regions.
None of the three roles runs inference; no additional video recording is made.

Current status (2026-10-07): Gateway d645ed9 runs on Central / Regional / Edge 101 / 102; Client 1.9.5 is released · the AI receive code last changed in 10ea98f (worker removed); per-release checks are at the end of this document

## Two main receive sources

- **Source device:** the Edge connects to the camera / NVR with a native adapter to receive events and fetch JPEGs; currently tested with Tiandy and UNV for the models and rules below
- **External API:** a VMS or another AI system sends a normalized event with an image to the Edge using an API key with the right permission; no automatic camera connection is opened
- In both cases the source does the AI processing; this choice decides how results are received, it does not turn on AI rules in the camera
- New cameras show External API as the default with receiving off — this does not mean an external system is already sending events

## First round

- Tiandy MODEL-A at 203.0.113.12; firmware FW-A
- Current owner of the camera: Edge 101, Office CCTV (203.0.113.12), Global ID TH-10-101-00001
  confirmed from the Regional/Central catalog (search by name/Global ID, because the parent does not store the camera IP)
  The old edge state directory is stale state that used a read-only credential for testing; the old ID is not used to overwrite the real catalog
- Verified on the real device: ONVIF does not advertise perimeter; the firmware web UI uses GET /CGI/Smart/AlarmInfo
  and AlarmItem.eventType = fielddetection was found and is converted to intrusion
- No camera rules/areas/schedules were changed, and AlarmInfoClean is not called
- One primary receive path is chosen per camera: the source device or an external API
- Native adapters for other NVR/VMS brands are not in this round; normalized events can be sent through the API

## Configuration at the Edge

Cameras must already have a camera row and its existing Global ID → AI Sources → choose the source device →
enable receiving → channel 1 → Thai wall-clock time → save

The receiver reads every 3 seconds after the previous request finishes (no overlap); up to 4 cameras at once
Connected status means AlarmInfo was read successfully; it does not confirm that the rule in the camera is enabled or that there is a new event
auth 401/403 pauses 15 minutes; other errors pause 15 seconds; status and the last read / last event times are kept
Disabling the camera or turning off the source starts no new request rounds
Receiver settings are stored in the SQLite table ai_event_sources from stateFile('vms.db'); credentials come from the camera row inside the Edge

The test camera sends Thai wall-clock time but is labeled GMT/Z, so bangkok-wall is selected; events are stored as +07:00
Select utc for sources that really send UTC — never apply the same time correction to every brand

## External API

1. Choose External API and enable receiving in that camera's AI Sources
2. Issue an API key at the Edge with allow_event_write and limit scopeGroups to the camera group
3. Send Authorization: Bearer <api-key> to the Edge's POST /api/v1/ai/events

How it works, for example: the VMS detects a vehicle crossing a line → the VMS connector converts the result and JPEG into our payload → sends an HTTP POST with the API key to the Edge → the Edge checks permissions and stores it → Regional → Central → AI Events
If the VMS cannot send this format, a connector must be written first; selecting External API alone does not create a connector or pull events automatically

Example payload (use the existing Global ID or the Edge's local cameraId; this example shows only the event data — the sender adds a base64 JPEG snapshot when an image is wanted):

~~~json
{
  "cameraId": "TH-10-101-00002",
  "eventId": "source-event-0001",
  "origin": "nvr",
  "type": "intrusion",
  "rule": "Fence zone 1",
  "ts": "2026-10-02T10:33:18+07:00",
  "attrs": {
    "detectionSource": "camera",
    "deliverySource": "nvr",
    "channel": 1
  }
}
~~~

- origin: camera / nvr / vms / api (omitted = api); the former edge-ai can still be read/forwarded to preserve history
- eventId is required, made of A-Z a-z 0-9 _ . : - and at most 64 characters
- Duplicates are suppressed within the namespace of API key + local camera ID + origin + eventId
  The same key/ID must be used when retrying; issuing a new key as a new API client counts as a new sender
- To prevent duplicate delivery across paths, set the primary source per camera; do not enable both the Tiandy collector and the API at the same time
- Answers 201 {seqs, duplicates}; may be sent as {events:[...]} with 1–100 events
- A bad batch is not stored at all; the index of the invalid entry is reported
- A key without send permission = 403; a camera out of scope / not found = 404; API receiving not enabled = 403
- A base64 JPEG snapshot ≤ 300 KB is optional; attrs including the data the system adds ≤ 8 KB
- Regional/Central do not accept external POSTs directly; they use the copies from their children via pull/link

## Forwarding and images

Regional stores events before forwarding them up to Central; the source/origin/Global ID stay unchanged
Each link's cursor and unique(source_id, remote_seq) prevent duplicate receipt
The image is ready before the event row is published, so Central cannot read a row while the image is still being saved
If the source announces that an image exists but it cannot be loaded, the cursor does not advance past it and it is retried on the next round
The next event on that link waits for that image, so check the source's error when things stall

The AI Events page is at Regional/Central; filter by day, camera, type, category and source
Playback can be opened from the event time when the source device has recordings and the playback path already supports it
GET /api/v1/ai/events and SSE /api/v1/events remain the read paths for the Client / external APIs

## Limitations that must be communicated

- AlarmInfo is a limited-size queue in the camera, not permanent history:
  if the camera–Edge link is down long enough for the queue to be overwritten, lost events cannot be recovered
- The AlarmInfo channel does not deliver person/vehicle type or start/end state completely, so the system does not fill them in itself
  Tiandy event images are fetched from the Alarm JPEGs on the SD card as described below
- Tiandy has no event UUID in the tested payload:
  the receiver de-duplicates by camera + channel + scene + rule + type + timestamp
  Two events of the same rule within the same second may be indistinguishable
- The external API is responsible for retrying and for mapping NVR/VMS channels to the correct Global ID
- This version disables worker creation in the ecosystem and GET /api/v1/ai/config answers 410
  deploy.ps1 removes the old inference processes if they are still registered; any other machine with an old process still running must stop it too, because updated code does not end the old process by itself
- The camera is already at Edge 101: after the update, enable AI Sources on the existing row
  Never add it again / change its Global ID, and never overwrite Regional with an old Edge DB

## Checks before going live

- node scripts/check-external-ai.cjs (new DB, time modes, channel filtering,
  restart retention/dedup, auth backoff, no collector polling at Central, image publication)
- node --check on every backend/script file changed
- npx eslint src/App.jsx src/components/AiSources.jsx src/components/AiEvents.jsx src/lib/app-config.js
- npm run build in the worktree
- A simulated three-tier system: a real camera, pull/link, API scope, batch atomicity, snapshots,
  Central offline then catching up, Receiver config after restart
- Check the AI Sources and AI Events screens in the simulated system

Release: commit when the user says so → deploy backup/restart Central+Regional/build/publish →
update Edge 101 → enable the receiver on the camera's existing row → confirm a real event through all three tiers


## Screen adjustments 2026-10-02

- Central/Regional can filter by the camera's owning Edge and by group together with day/camera/source, before the 500-item limit, and keep the permission scope
- The owning Edge of a camera is referenced from the source_ref path in Regional and does not change or reinterpret the existing Global ID
- AI Sources uses the sources "source device / external API" and has no brand-specific explanations on the working page
- The device driver supports the existing tiandy setting; other brands use the API, and direct-receive adapters are added when test devices are available

## Tiandy event images — verified on the real device 2026-10-02

- The model/firmware above stores Alarm-type JPEGs on an SD card with readwrite status
- This device's AlarmInfo does not send alarmCaptureImage even though the documentation says this field is optional
- The receiver searches POST /ISAPI/ContentMgmt/search (picture, ALL, channelID starting at 0)
  then GET /ISAPI/Record/DownLoad/<fileName> over HTTP Digest
- It selects only Alarm type, the same channel and the same second as the event; Manual / live images are not used as a substitute
  If multiple files are found within the same second or the search result fills a page, it waits and reports an error rather than guessing a file
- The image is decoded/scaled with FFmpeg at the Edge in memory, producing a JPEG ≤ 300 KB
  No video recording or additional inference is made; the Edge must have FFmpeg as in the existing install kit
- A native event waits until the image is obtained before being published; the ai_image_pending queue is in SQLite
  If the image has not yet landed on the SD card it retries after 5 seconds, then lengthens the wait up to 15 minutes
  It reads images for at most 4 events per round per camera; a camera with a wrong auth pauses the whole receiver for 15 minutes
  The queue persists across restarts even when the event has already dropped out of AlarmInfo
- AI Sources shows the number of events awaiting images; if the SD card / Alarm image recording has a problem, those events will not yet appear in AI Events
- Existing events recorded by the previous receiver without images are unchanged; rows already forwarded are not backfilled in this round
- A simulated system with a new DB received 26 events from the real camera with complete images Edge → Regional → Central
  Example at 12:17:23: image 234,463 bytes, the OSD matched the event time, and the SHA-256 matched at all three tiers
  The image opened in practice on the simulated Central's AI Events page
- FTP/Email does not need to be enabled for this path; Snapshot Channel 1 and the Alarm images on the SD card must exist

## UNV ONVIF — verified on a real device 2026-10-02

- MODEL-B / FW-B at 203.0.113.75
- Uses the ONVIF metadata track over RTSP to receive tns1:RuleEngine/LineDetector/Crossed
  carrying UTC time, ObjectId, LineIndex; GetRules confirms MyLineDetector1 is enabled
- Media2 GetMetadataConfigurations answers Analytics=true
- The manufacturer's website states Profile M; a test of the real service does not substitute for certification of the firmware in the ONVIF database
- The device's GetSnapshotUri returns /LAPI/V1.0/Media/Video/Streams/0/Snapshot
  verified to answer 200 image/jpeg (250,167 bytes) even though /media/flv/picture answers 409 HTTP JPEG Stream is full
- It receives the event and then fetches a snapshot immediately, rather than a JPEG attached under Profile M
  It records imageSource=onvif-event-triggered-snapshot, receivedAt, capturedAt, captureDelayMs
- It does not capture an image in place of an old event: receipt more than 3 seconds later than the event time, or an event time more than 2 seconds in the future, is rejected
  An image that finishes loading more than 5 seconds after the event time means the event is not published; there is no backfill with the current image
- Snapshots are limited to 2 concurrent events per camera; dedup by camera/channel/time/ObjectId/LineIndex
- One metadata session per camera; reconnect 15 seconds after the link drops; wrong auth pauses 15 minutes
  The session is closed when the source is disabled, switched to API, the camera is disabled/deleted, or the server stops
- At this stage it supports a single UNV camera on channel 1; it does not claim to support NVRs or every kind of AI
- No inference or video recording, and there is no need to point an Intelligent Server at the Edge for the ONVIF path
- HTTP subscription, in both ImagePushMode 0 and 1, received a real LineCrossing but with no image/URL
  The experimental Intelligent Server settings were restored to their original values; no reboot, per the user's instruction

### Tiandy with the same ONVIF approach

- The tested MODEL-A firmware returns analytics/events/media2 services, but GetEventProperties
  shows Motion/Tamper and no LineCrossing/Perimeter, and the RTSP returned by GetStreamUri has no metadata track
- So the Tiandy AlarmInfo adapter + Alarm images on the SD card is still used for this device's Perimeter
- ONVIF support must be verified per model/firmware against the event topics/metadata actually sent and the snapshot URI
  Motion is not interpreted as Perimeter, and Profile M is not claimed merely because an ONVIF service exists

References:
- https://www.onvif.org/profiles/profile-m/
- https://global.uniview.com/Products/Network_Cameras/Prime_Series/PRIMEI_Series/MODEL-B/
- https://www.onvif.org/conformant-products/

### UNV end-to-end result

- The simulated system received at least 6 real LineCrossing events with JPEGs through Edge → Regional → Central
- Example: event time 13:34:35, ObjectId 4309, LineIndex 0, image 138,369 bytes
  SHA-256 matched at all three tiers; the image opened in practice on the Central page
- The camera is set to GMT-00:00 and its clock runs about 17 seconds behind the receiver
  It reads ONVIF GetSystemDateAndTime every 60 seconds without changing the device's time
  It stores cameraClockOffsetMs; captureDelayMs is an estimate after subtracting the clock difference
  A sample older than 90 seconds, or a time measurement taking longer than 2 seconds, is not used to match images
  In the example the image fetch took 256 ms and the computed delay was 521 ms; the image OSD matched the event second
- Fixed the browser cache of snapshots after finding that an image from the earlier simulated run stuck when the same URL/seq was used
  The web UI fetches with cache=no-store; the UI image endpoint sets private,no-store
- Checked with check-external-ai.cjs (12 groups), check-uniview-ai.cjs (4 groups), node --check,
  ESLint, build, and the real AI Sources/AI Events pages in the simulated system
- This testing did not change production, did not commit, and did not reboot the camera


## Windows Client 1.9.3 and the 2026-10-02 release

- Shows the camera/NVR/VMS/API source and the former edge-ai events according to the real data
- Filters by Edge/group/source before limiting the list; SSE and images use the same API key scope
- Shows thumbnails/full images, with the image type and capture time if the source sent them
- Cancels old requests when the filter changes, preventing lists/images left over from the previous selection
- Verified the real API in the simulated system: filters, scope of the key/options/images, JPEG and no-store
- dotnet build Release passed; rendered EventsView offscreen with a real UNV image and tested selecting Edge 101 / Pilot
- The user authorized deleting the unused uniview-perimeter.js prototype, and a combined commit/deploy together with the Client
- No camera was rebooted, and camera credentials are not published in the API/packages


### Deploy result

- 2026-10-02 Gateway build 38315ff went live on Central/Regional/Edge 101/102
- The user clicked install on both Edges; /api/instance and the Regional page were checked and showed a successful install
- Client 1.9.3 released full/delta/installer, and the full-image EventDetailWindow was checked offscreen and passed
- Backup before the merge at `<backups>\daily\20261002-141316`

### Receiver enabled and Group filter

- Enabled the Tiandy 203.0.113.12 and UNV TEST at Edge 101 as source devices, channel 1; both are connected
- Central production received 30 real Tiandy events with images; the full image at 13:55:40 was opened and its OSD matched the event time
- AI Sources gained a Group filter from the camera groups within the account's scope; edited values are kept when switching groups
- Backend syntax, check-external-ai.cjs, ESLint and build passed
### Group filter in production

- Gateway build 3c273c5 matches across Central/Regional/Edge 101/102; the package passed signature/size/SHA-256
- On the real AI Sources page, selecting Office CCTV left 3 cameras, and after a UNV event test only UNV TEST remained
- The Tiandy and UNV receivers are enabled/connected after the update; Tiandy has delivered event images to Central
- UNV awaits a new vehicle pass in production; the LineCrossing result with images was checked on the real camera in the simulated system before release

## Removing the old inference (2026-10-02)

- Removed the old inference worker, the AI Rules page, the ai-config module and the Python/GPU installer
- The old inference settings API answers 410; receivers are set per camera in AI Sources
- deploy removes the old inference processes if they are still left
- The database, past events/images and old backups/secrets are kept; the old AI folder outside the project is not deleted
- New packages do not contain the worker; folder-swap Edges run only the new code, while in-place Edges may keep an unused old folder

## Verified after removing the worker — Gateway 10ea98f / Client 1.9.4

2026-10-02: backed up, then deployed Central/Regional and updated Edge 101/102 from the Regional UI; /api/instance matched on all four and the Edges were Online
All three platform packages passed signature / size / SHA-256 checks; the real AI Sources page showed Tiandy/UNV connected after the update
Checked 12 external AI cases + 4 UNV cases, a fresh DB and startup, revoking only the worker key while keeping external keys, syntax / ESLint and the web build
Client 1.9.4 released with a collapsible Camera Library filter (offscreen render; not a confirmation of the real window)
