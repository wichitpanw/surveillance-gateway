# Camera audio (enabled per camera)

Updated: 2026-10-07 · in real use since the 2026-10-06 deploy (Gateway `d645ed9` on all four instances, Windows Client 1.9.5)
· enabled on 1 camera as of 2026-10-07 (a Tiandy at Edge 101)

## Principles

- **Off by default** — most cameras have no microphone, and converting audio to AAC adds ffmpeg work on every stream
- **Set at the Edge only** (like `enabled`) — Cameras page → "Audio" button · Regional/Central take the value from the sync
  and answer 403 if anyone tries to set it there
- Every viewer (web and Windows Client) **always starts muted**; the user clicks the speaker on the tile
- Playback stays video-only (`-an` in `server/vms/*-playback.js`)

## The audio path

| Point | Audio off (before) | Audio on |
|---|---|---|
| go2rtc source (`gateway/go2rtc-sync.js`) | `ffmpeg:<rtsp>#video=h264#hardware` | append `#audio=aac` |
| Link Edge → Regional → Central (`vms/edge-link-client.js`) | `-c copy -an` | `-map 0:v:0 -map 0:a:0? -c copy` |
| Proxy `/stream/<name>.mp4` (`server.js`) | `&video=h264` / `&video=copy` | append `&audio` |
| Browser (`LivePlayer.jsx`) | `<video muted>` | speaker button bottom right |
| Windows Client (`LibVlcVideoRenderer`) | `:no-audio` per media | speaker button on the tile |

Facts confirmed by testing (go2rtc 1.9.14, 2026-10-06):

- No `#audio` in the source = ffmpeg outputs video only
- `/api/stream.mp4` with only `video=` drops the audio; `&audio` must be requested too
- The normal stream gets `mp4a.40.2` (AAC) · on the `_raw` stream go2rtc converts PCMA/PCMU to **FLAC** itself (`audio=aac` cannot be used on `_raw`)
- `#audio=aac` on a source with no audio does not break anything; you get video only
- The `_raw` stream always carries the camera's audio, so the proxy asks for `&audio` only for cameras with `audio_enabled = 1`

## Fragment changes and go2rtc-sync

`bareUrl()` strips the fragment before comparing, so turning audio on/off would be invisible without help.
The sync records a sha1 of each whole source string in `stateFile('.go2rtc-applied.json')` (hash only, no camera passwords)
and PUTs when the hash differs from last time · no file = treated as matching (no PUT of every stream after an upgrade)

An ffmpeg already pushing over the link keeps the audio setting it started with — `reconcilePushAudio()` restarts it after every camera list is sent
(a PATCH at the Edge calls `catalogSoon()` immediately; the Regional gets its turn when the go2rtc sync changes something)

## Checking whether a camera has audio

The "Audio" button opens a dialog that calls `POST /api/cameras/:id/audio-probe` (`ffmpeg -i` on the source, reading the `Stream #` line for codec/sample rate)
· it uses ffmpeg, not ffprobe, because the edge install kit ships only ffmpeg — the first version (b1a01f0) hit `spawn ...ffprobe.exe ENOENT` at Edge 101
Real results:

| Camera | Result |
|---|---|
| Tiandy (site office) | `pcm_alaw` 8 kHz mono — quiet audio (a quiet room) |
| AXIS through an S30 recorder (Edge 102) | no track · `&audio=1` gets `503` — audio must be enabled on the camera/recorder first |

## Testing

A three-tier edge-sim with a `testsrc` + `sine` source sending `pcm_alaw` (tested 2026-10-06 with a fresh DB):
off = central gets `h264` · on = `h264 + aac` (sub/main) and `_raw` gets `h264 + flac` · off again = `h264` on every tier
