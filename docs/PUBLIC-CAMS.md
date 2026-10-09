# Public cameras (pulled by Central)

In use since 2026-10-07 · first source: a city municipality (37 cameras)

## Why

The user wanted public cameras published by government agencies brought into the system, with Central controlling which API keys can see them.
This is the only exception to the rule "Central does not add cameras itself" (CONTRIBUTING.md section 1),
because these cameras have no password, sit on no one's LAN and have no Edge that owns them.

**Pulled from the agency's own API, not through a third-party aggregator site** — an aggregator's API is internal to that site, can change at any time, and does not own the video.
An aggregator is used only as a directory for finding sources (it lists the `source` and `media_type` per camera).

## How it works

`server/vms/public-cams.js` (runs only when `GATEWAY_ROLE=central`)
- Every 5 minutes + at start: fetch the list from `SOURCES[<source>].listUrl` → upsert rows in `cameras`
  - `type = public_hls`, `brand = public`, `source_id = public:<source>`, `source_ref` = the agency's id
  - id `PUB-<source>-<ref>` · the global ID is issued at Central as usual (`TH-<province>-000-xxxxx`) · province/district are set per source
  - `rtsp` holds the HLS URL (old column name) — it must be https, its host must be in `allowedHosts`, and it must end in `.m3u8`
  - missing from the API = `source_missing_at` (not deleted) · back again = cleared
- Online status comes from the agency's API (no TCP probe of our own) · a failed fetch = status `null` (unknown), not offline
- go2rtc: main = `ffmpeg:<hls>#video=h264#hardware` (the H.264 source passes straight through) · no sub · `_raw` = `ffmpeg:<hls>#video=copy`
  `go2rtc-sync.js` checks the whitelist again before handing the URL to ffmpeg
- No PTZ, playback (501), audio or AI · no online/offline log entries · not counted in Dashboard / Camera Map / Cameras

## Permissions

- Web: the **Public Cam Map** menu (after AI Events) needs `menu.publiccam` — superadmin/admin get it automatically
  anyone with this permission sees every public camera, regardless of the role's camera scope · the "Sync now" button also needs `device.manage`
- Live: public cameras appear according to the role's scope (a role that sees every camera sees the "Public · <city>" group)
- API key: the **Public cameras** box on the API Clients page (`api_clients.allow_public`, default 0)
  - ticked = sees the whole public set, regardless of scope_groups · not ticked = 404, like a camera outside the scope, even if the key sees "all groups"
  - only someone with `menu.publiccam` can tick it
  - `/api/v1/cameras` returns `origin: { kind: 'public', source, credit, pageUrl, missingAtSource }`
- The Windows client needs no update: its map (`client-map.html`) shows purple pins for `origin.kind === 'public'`, with a color legend

## Adding a new source

1. Check that the agency has a JSON list with coordinates, and that the video is HLS/RTSP that ffmpeg can read (the agency's own map page usually calls this API — look at the page's network traffic)
2. Add an entry to `SOURCES` in `server/vms/public-cams.js`: `label`, `credit`, `pageUrl`, `listUrl`, `allowedHosts`, `group`, `province`, `district`, `parse()`
   - `parse()` returns `[{ ref, name, url, lat, lng, online }]` · `ref` must match `[\w-]{1,40}` and stay stable (it builds the id / global ID)
   - if the server does not send its intermediate certificate, set `caIssuerUrl` (the URL from the certificate's AIA) — never turn off certificate checks
3. Sources that are still images (JPEG) or web pages (iframes) are not supported yet — they need a new type, not squeezing into `public_hls`

## Cautions

- **The video belongs to the source agency** — the web UI always shows the credit and a link · before opening a key to an outside organization, notify or ask the source agency
- Pulled on demand: go2rtc connects to the agency only while someone is watching · the list is fetched every 5 minutes (very light)
- The first source's web server does not send its CA's intermediate certificate (checked 2026-10-07) — `caIssuerUrl` points at the CA's issuer certificate
  if the CA moves that URL, the sync fails with a message on the Public Cam Map page (existing cameras still play, because the stream host sends the full chain)
- That source's `videoUrl` is `chunklist_w<session>.m3u8` — it is converted to `playlist.m3u8`, otherwise the session expires and the video goes dark
