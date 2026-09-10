# FinSight custom receipt scanner (Android)

Local Expo module, automatically discovered from `mobile/modules`. No paid SDK,
API credentials or network requests. Uses CameraX 1.6.0 and OpenCV 4.12.0.

`FinsightReceiptScanner` exports an Expo native view with `active`, `mode`
(`standard` / `long`), `torch`, and `command` (`id`, `type`) props. Increment the
command id for each `capture`, `start`, `finish` or `reset`. Events are `onStatus`,
`onCapture` and `onError`; the TypeScript boundary validates image payloads.
Camera permission is handled by the caller. Output URIs are local JPEG cache
files. An original is the unenhanced rectified/composed scan, not a raw scene.

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
a thumbnail of the actual accepted long-scan mosaic at the upper left. These
are preview-only drawing operations, never inputs to the receipt JPEG encoder.
The preview bitmap is at most 192×960, is updated only as accepted image height
changes, and has at most one queued update. Reset/stop/detach release it.

Long status events include `acceptedHeight` (0–16000 image rows). This is not
receipt completion percentage: the physical receipt length is unknown. The
React Native UI waits for accepted pixels before enabling Finish; the engine
still requires a recent accepted frame and a visible bottom edge to save.
