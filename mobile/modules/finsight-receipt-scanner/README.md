# FinSight custom receipt scanner (Android)

Local Expo module, automatically discovered from `mobile/modules`. No paid SDK,
API credentials or network requests. Uses CameraX 1.6.0 and OpenCV 4.12.0.

`FinsightReceiptScanner` exports an Expo native view with `active`, `mode`
(`standard` / `long`), `autoCapture`, `torch`, `zoomRatio`, and `command` (`id`,
`type`) props. Increment the command id for each `capture`, `start`, `finish` or
`reset`. Events are `onStatus`, `onCapture` and `onError`; the TypeScript boundary
validates image payloads. Camera permission is handled by the caller. Output URIs
are local JPEG cache files. A Standard event keeps the untouched full-resolution
scene in `originalUri`, the unenhanced oriented crop or fallback in
`filterSourceUri`, and the selected processed image in `processedUri`.
For a composed legacy Long result, `originalUri` and `filterSourceUri` may be
the same unenhanced mosaic.

The module also exports `applyReceiptFilter(sourceUri, mode)`. Modes are
`original`, `enhanced`, `grayscale`, and `black-white`. Original validates and
returns the source file; the other modes write a new JPEG under
`cache/receipt-scanner` and return `uri`, `width`, `height`, `processingMode`,
and `transformVersion`. Processing runs on Expo's background I/O scope and
accepts only bounded images inside app-owned storage.

Build from `mobile/android`:

```
./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2
./gradlew :finsight-receipt-scanner:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64 --max-workers=2
```

Use the physical device's architecture for a device build. Expo Go cannot load
this module. iOS uses the explicitly labeled manual fallback.

The instrumented tests use synthetic OpenCV images and exercise real native
pixel processing; they do not certify physical-camera performance. See
`docs/custom-native-receipt-scanner.md` at the repository root for limitations
and the required real-device/receipt acceptance matrix.

## Live receipt feedback

The native overlay fills the detected paper with translucent mint and renders
a rolling view of the actual accepted long-scan mosaic in a right-side rail.
These are preview-only drawing operations, never inputs to the receipt JPEG
encoder. The preview bitmap is at most 240×960 and keeps the newest four
receipt-widths readable instead of shrinking the whole panorama into a thin
strip. It updates only as accepted image height changes and has at most one
queued update. Reset, stop, and detach release it.

Long mode accepts a textured visible receipt strip when both side boundaries
are reliable, including strips clipped by the top or bottom of the camera
frame. Its boundary is smoothed between frames and retained for 650 ms across
an isolated detection miss. Frame registration compensates bounded handheld
rotation, scale, and sideways drift before verifying overlap. Reverse travel,
unrelated texture, excessive drift, and gaps still fail closed without changing
the accepted mosaic. Preview work is coalesced so a busy UI renders the newest
accepted mosaic rather than permanently dropping the final update.

Standard and Batch both use `mode="standard"`. Standard passes
`autoCapture=true`; Batch passes `autoCapture=false`. A `capture` command starts
one duplicate-safe CameraX still request immediately, even when preview
detection has not found a usable boundary. Preview outlines and quality messages
guide positioning but do not gate the shutter.

After CameraX saves the JPEG, native processing applies its EXIF orientation and
detects the document on that still. Results use `transformVersion` value
`custom-still-v3`. A complete inset quadrilateral produces `cropOutcome` value
`perspective` with a conservative, clamped outward margin. A receipt clipped only
at the top or bottom can produce `visible-section` when both sides are reliable;
the crop contains visible pixels only. Side-clipped, ambiguous, missing-document,
and failed-warp cases return the full oriented frame with `original-fallback`.
`perspective` and `visible-section` include `corners`; `original-fallback` omits
them. If enhancement fails, the event returns the unenhanced base with
`processingMode` value `original` instead of discarding the capture.

The React Native host starts Long capture automatically after the native camera
reports ready. Before that handshake the primary action says Starting scan and
is disabled; afterward Finish scan is the only manual capture control. A reset
reports readiness again so discarded, malformed, or interrupted attempts can
restart without bringing back a separate Start button.

Long status events include `acceptedHeight` (0–16000 image rows). This is not
receipt completion percentage: the physical receipt length is unknown. Finish
always responds: before any pixels are accepted it explains how to begin, and
after pixels are accepted it saves exactly the captured mosaic. Automatic
completion still requires recent registered, steady bottom-edge frames.
