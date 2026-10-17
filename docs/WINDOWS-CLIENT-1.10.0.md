# Windows Client 1.10.0 — release validation

Validated: 2026-10-11 · production feed 1.10.0 published (`bb58d2d`); current release is 1.11.0

## What was built
- **Diagnostics**: codec, resolution, FPS, lost frames, reconnects, fallback, errors, CPU/RAM, and a whitelisted JSON export that excludes URLs, keys, and credentials
- **Multi-monitor**: open a saved wall on a separate monitor, remember its position, clamp bounds when displays change, and opt-in restore at startup
- **Auto stream**: sub stream in grid cells, main stream when focused or in 1×1; manual main/sub selection remains available
- **AI event**: open Live or Playback at the event timestamp (`+07:00`), validating catalog scope and playback permission
- **Evidence**: mark start/end on the timeline and export MP4 alongside `.evidence.json` containing the Global ID, requested time range, file size, and SHA256 (note: the manifest is not a cryptographic digital signature or frame-accurate time attestation)

## Validation results
- Release build and publish from the development worktree succeeded
- Fixture checks: PASS 27 / FAIL 0
- Covered Auto stream policy, monitor bounds/default restore, diagnostics whitelist, SHA256/cleanup/cancel, event timezone/gap/race/403, and theme/localization
- Offscreen render checks: dark/light diagnostics, timeline, Playback at 900×650 and 1280×800, Thai video wall
- Not covered by automated offscreen fixtures: live multi-monitor/mixed-DPI hotplug, physical camera audio/GPU hardware decoder behavior, and end-user machine installer runs
- "Hardware decoding requested" reflects the decoder request rather than active GPU engine telemetry

## UX/UI fixes
- "Clear all" was clipped when adding Auto: moved to a separate row (later consolidated in the 1.11.0 toolbar)
- Playback controls were cramped in narrow windows: wrapped across rows
- Event detail: separated the close button in the header, constrained scrolling to the work area, and canceled pending snapshot loads when switching or closing events
- Stream label updates immediately when switching UI language

## Next steps (out of scope for 1.10.0)
1. Validate the installer on a physical workstation with dual mixed-DPI monitors and repeated wall open/close cycles
2. Unify player status reasons and recovery actions (reconnect, permission, no recording)
3. Compact/Comfortable density and `Ctrl+F` search focus (delivered in 1.11.0); native HWND focus return still requires live workstation verification
4. Harmonize font sizes, spacing, and contrast across legacy dialogs

## Packaging limitations
Velopack emits the existing warning that the startup hook lives in `OnStartup` and that Authenticode signing is not configured; verify install/update/uninstall on a test machine for full sign-off.