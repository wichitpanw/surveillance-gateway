# Windows Client workspace redesign — released 1.11.0

Date: 2026-10-11 · branch `codex/client-workspace-redesign` · base `bb58d2d` / Client 1.10.0

## Client and Map wrap-up — 2026-10-12

- **Client 1.10.0 (`bb58d2d`)**: Diagnostics, multi-monitor walls, Auto stream policy, AI event navigation, and evidence export with SHA256
- **Client 1.11.0 (`1a4ba1c`)**: Shell / Live / Playback workspace redesign; Release build 0 warnings / 0 errors and fixture checks PASS 41 / FAIL 0
- **Gateway `a0d8867`**: Fixed the client map sticking on "Loading" because the MapLibre 6 web worker was not emitted in the Vite bundle; added `src/lib/maplibre.js` and `worker.format: 'es'` so the worker bundles cleanly with releases
- Verified `client-map` on Central and Regional in a browser: 3D buildings and roads render and the worker returns HTTP 200
- Fixing the web map on the Gateway does not require bumping the Windows Client version; reopening the Map tab or restarting the Client loads the new bundle
- Offscreen fixture and browser checks do not replace full native workstation testing for multi-monitor mixed DPI, HWND video/audio focus, or Velopack update/uninstall flows
- Raspberry Pi Linux hardware testing and the next UI pass (Events/Map side inspectors and Settings/Dialogs polish) remain separate follow-up items

## First-wave scope
Shell + Live + Playback and shared design tokens, released as Client 1.11.0. Backend APIs did not change for the workspace redesign; the MapLibre worker hotfix shipped separately in Gateway build `a0d8867`.

## What changed
- **Shell**: 64/188 px navigation rail, separated header/title/status columns, truncated long status text with tooltips, slimmer chrome height, and removed sidebar width animation so native video HWNDs do not reflow every frame
- **Themes & typography**: Graphite Dark theme and centralized typography tokens while keeping full Light theme support
- **Density (`Compact` / `Comfortable`)**: persisted in `AppSettings`, adjusting font sizes and margins without recreating video players
- **`Ctrl+F`**: focuses the camera search box in Live and Playback
- **Live**: moved layout, stream mode, and Clear all into the top toolbar; added a dedicated right-hand inspector column separated from the video grid showing camera name, group, status, Global ID, Playback shortcut, and PTZ/focus controls (subsequent commits added merged-cell custom layouts, a layout editor, and rail PTZ controls)
- **Responsive inspector**: collapses and disables the toggle when workspace width drops below 1050 DIP to preserve video area
- **Playback**: narrower camera sidebar, header back-navigation to Live, and a dedicated evidence range bar above the timeline
- **Live ↔ Playback handoff**: jumping from the Live inspector to Playback uses the scoped catalog camera; returning from Playback to Live re-selects the original tile and page if still present without duplicating the camera or overwriting a full wall
- **Catalog scope revocation**: if a camera is removed from scope during playback, playback stops, pending loads cancel, and export context clears
- Preserved existing LibVLC rendering, PTZ, audio, API contracts, and permission checks

## Validation results
- Release build from worktree: 0 warnings / 0 errors
- Fixture regression and workspace checks: PASS 41 / FAIL 0
- Offscreen render checks: Dark/Light, Thai/English, 1024×640 / 1366×768 / 1600×900
- 1.11.0 installer built and published (full + delta packages in `client-updates/releases.win.json`)

## Workstation test checklist
1. Install `Setup.exe` 1.11.0 on a test PC and confirm existing profiles, API keys, and saved walls are preserved
2. Verify 1/4/9/16/25 and custom layouts, main/sub/Auto stream switching, audio, focus/PTZ, and returning to the grid
3. Select a camera in the Live inspector → jump to Playback → return to Live; verify no duplicate tiles or overwritten slots on multi-page or full walls
4. Toggle Dark/Light, Compact/Comfortable, Thai/English, `Ctrl+F`, and `F11` full-screen
5. Test on a 1366×768 display and dual monitors with different DPI scaling; verify no toolbar buttons are clipped
6. Seek, mark start/end, and export evidence with `.evidence.json` SHA256; close views/windows and confirm VLC resources are released

## Future rounds
- **Events**: side-by-side list and detail pane preserving filters and passing context to Live/Playback
- **Map**: side panel for pin details while preserving map viewport
- **Settings / Diagnostics**: categorized settings with search and consistent dialog spacing/focus
- **Player status**: consistent status reasons and recovery actions across all playback paths