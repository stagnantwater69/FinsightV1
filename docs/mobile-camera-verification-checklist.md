# Mobile Camera — Physical-Device Verification Checklist

**Status: unverified on hardware.** **Version 3 — 12 September 2026.** Written
against the receipt-camera code as it is today; the 31 August version below is
kept under *Superseded* because it described an ML Kit-only launcher that is no
longer the default and claimed the custom camera had been deleted, which it has
not (QA finding MOB-DOC-01). When the implementation changes again, add a new
version above this one rather than editing history.

Source of truth for every claim here:
`mobile/src/components/receipt-camera/ReceiptCamera.tsx` (dispatcher + custom
camera), `NativeReceiptCamera.tsx` (retained ML Kit launcher),
`CropEditor.tsx`, `CameraAction.tsx`, `ScannerStatusStates.tsx`,
`mobile/src/lib/customReceiptScanner.ts`, `mobile/src/lib/receiptScannerFeature.ts`,
`mobile/app.config.ts` (`receiptCameraMode`, `receiptScannerEnabled`). The
narrative documents are `docs/custom-receipt-camera-implementation.md`,
`docs/custom-native-receipt-scanner.md` and `docs/receipt-scanner-capture-fix.md`.

## The three capture modes — test the one you are actually running

`ReceiptCamera` picks its implementation at mount from two build facts:

| Mode | Selected when | What the owner sees | Where the evidence lives |
|---|---|---|---|
| **A. Custom camera + continuous native engine** (default on a native Android build) | `receiptCameraMode` is `custom` (the default) **and** the `FinsightReceiptScanner` native view is linked (`getCustomScannerView()` returns non-null: Android, native dev/EAS build) | FinSight's own full-screen camera; automatic document detection; Standard mode captures one page when stable, Long mode stitches one panorama; paper-highlight overlay; manual shutter still available; torch; gallery; ordered section strip; crop editor | `mobile/tests/render/continuousReceiptCamera.test.tsx` (native pixels mocked) + Android instrumented tests in the native module |
| **B. Custom camera, manual fallback** | `receiptCameraMode` is `custom` and the native view is **not** linked (Expo Go, iOS, or an older build without the engine) | Same FinSight camera UI, but no automatic detection: manual shutter, Long mode = explicit ordered sections with the previous section's bottom 20% as an alignment guide | `mobile/tests/render/receiptCamera.test.tsx` (expo-camera mocked) |
| **C. ML Kit launcher** (opt-in) | `EXPO_PUBLIC_RECEIPT_CAMERA_MODE=native` at build time, **and** `receiptScannerEnabled` not `false`, **and** Android native build (not Expo Go) | No FinSight camera; Google ML Kit Document Scanner's own activity opens immediately; FinSight shows only launching / unsupported / failure states around it | `mobile/tests/render/receiptScannerStates.test.tsx`, `mobile/tests/receiptScannerLaunch.test.ts`, `mobile/tests/receiptScannerFeature.test.ts` (fake scanner function, never the real module) |

Before reporting anything, write down which mode the build under test resolved
to. A result recorded against the wrong mode is worse than no result.

## What the automated suites do and do not establish

The render harness (`mobile/tests/render/*`, see that directory's README)
mounts the real components against **mocked** `expo-camera`,
`expo-image-picker`, the native scanner view, `AppState` and the API. It
covers, and only covers:

- the custom camera's interaction contract: gallery and Long mode reachable
  beside the camera; gallery still available when camera permission is
  permanently denied; one shutter at a time; explicit approval before handoff;
  ordered multi-image import; retake-in-place; a quality-service failure never
  discards the image; Back routes through review/discard confirmation; a
  cancelled quality request's late response is ignored;
- the continuous engine's UI contract: manual capture acknowledgement and
  detection recovery; automatic Standard and Long completion into review
  without upload; malformed native output rejected without losing the camera;
  stale mode/status callbacks ignored after a mode switch; Finish gated on
  accepted receipt pixels; retained receipt surviving a font-scale change;
  **queued native events rejected after the app is backgrounded** (the
  `AppState` listener's reset path, driven by a simulated state change);
- the scan review workflow after capture: double-tap locks, cancellation,
  stale-business results, replay keys, unreadable dates, foreign currency,
  unsupported files;
- the ML Kit status screens' copy and buttons.

None of that exercises a camera sensor, a real permission dialog, the Android
activity lifecycle, a real gallery intent, rotation, low memory, TalkBack, or
the native engine's actual frame processing. The per-project rule stands:
say **"needs physical-device verification"** for every item below; passing
typecheck/lint/unit tests is not evidence for any of them.

## Backgrounding — what the code does, so you know what to look for

Contrary to the superseded text, the custom camera **does** register an
`AppState` listener (`ReceiptCamera.tsx`, the `AppState.addEventListener`
effect). On leaving the foreground it: bumps the native event epoch (so any
event already queued from the engine is dropped), clears Long-capture and
scanning state, switches the torch off, sends the engine a `reset` command,
unmounts the camera preview (`ready` false) and sets the status line to
"Camera paused. Position the receipt and start again." On returning it bumps
the text-layout revision (Android font-scale changes made in Settings) and
re-reads camera permission. Captured **sections already in the strip are kept**.
In mode C the ML Kit activity owns its own lifecycle and this listener is not
mounted.

---

## 0. Before starting

- [ ] Record the build type: native dev/EAS build (`npm run android`) or Expo
      Go (`npm run android:expo-go`), and the platform.
- [ ] Record the resolved mode (A/B/C) — for A, confirm the native engine
      actually attached (automatic detection overlay appears); for C, confirm
      `EXPO_PUBLIC_RECEIPT_CAMERA_MODE=native` was set at build time.
- [ ] Confirm the app builds and launches; no camera-related crash on cold start.

## 1. Permission states (modes A and B)

- [ ] First launch: the pre-permission explanation shows before the OS dialog.
- [ ] Deny once: the camera screen shows the denied state with a Settings
      route; **gallery import still works** with camera denied.
- [ ] Deny permanently ("Don't ask again"): same as above; the Settings
      button opens the app's system settings page.
- [ ] Grant in Settings and return: the camera preview comes up **without
      restarting the app** (this is the `getPermission()` re-check on
      foreground).
- [ ] Camera startup failure (e.g. camera held by another app): the retry
      state appears, retry works once the other app releases it.

## 2. Standard capture (mode A automatic, mode B manual)

- [ ] Mode A: hold a receipt on a contrasting surface; the paper highlight
      tracks it; capture completes automatically when stable; the review
      state shows the rectified page **without** uploading anything.
- [ ] Mode A: the manual shutter still works while the engine is tracking.
- [ ] Mode B: manual shutter captures one page; two fast taps produce **one**
      capture (synchronous lock).
- [ ] Both: the thumbnail is the accepted capture, the review requires an
      explicit approval, and approval hands **one** section to the caller.
- [ ] Torch toggles the flashlight and is **off** again after backgrounding.

## 3. Long receipt

- [ ] Mode A: Long mode starts continuous capture, the growing thumbnail
      shows accepted mosaic pixels (never a timer), Finish stays disabled
      until pixels are accepted, and the result is **one** stitched image.
- [ ] Mode A: when the engine asks to show the bottom edge, Finish becomes
      available again after doing so.
- [ ] Mode B: Long mode is explicit ordered sections; the bottom 20% of the
      previous section is shown as an alignment guide; sections can be
      reordered and removed; the eighth section is the last (`MAX_SECTIONS`),
      and a ninth is refused with a message, not a crash.
- [ ] Both: the receipt reaches the server as **one** scan with per-section
      OCR and seam reconciliation.

## 4. Gallery import

- [ ] Gallery is reachable from the camera screen at any time and is never
      opened automatically after a failure.
- [ ] Multi-select in Long mode imports in selection order; duplicate
      selection of the same picker URI is detected.
- [ ] Imported images are normalized (orientation correct in review and in
      the uploaded result).
- [ ] A gallery return that recreates the activity (font scale changed while
      in the picker) keeps the session — see
      `custom-native-receipt-scanner.md` for the plugin that mitigates this.

## 5. Crop, rotate, quality

- [ ] Crop editor: four corners adjustable; server edge suggestion appears
      when the backend is reachable; perspective correction returns a
      rectified image; restore returns to the original.
- [ ] With the backend unreachable, crop/quality actions fail with a message
      and the photo stays usable unchanged.
- [ ] Quality check reports blur/dark advisory feedback and discloses that
      the photo is sent for processing; taking a photo alone sends nothing.

## 6. Cancellation and Back

- [ ] Android hardware Back from the camera with nothing captured returns to
      the previous screen with no dialog.
- [ ] Back with unsent sections asks to discard; "Keep editing" keeps them.
- [ ] Back during a continuous scan (mode A) asks to discard the unfinished
      scan and keeps previously reviewed images.
- [ ] Back during a network operation (quality/crop/upload) aborts it and the
      late result is ignored; the session is preserved.

## 7. Backgrounding / app lifecycle

- [ ] Background the app from the live camera, return: status line reads
      "Camera paused…", torch is off, preview restarts, sections in the strip
      are intact.
- [ ] Mode A: background **mid-Long-capture**, return: the unfinished scan is
      discarded (epoch bump), no stale engine event lands, the app does not
      crash, previously reviewed sections remain.
- [ ] Background during upload, return: the upload completes or fails into
      the existing retry path; never a stuck spinner.
- [ ] Phone call / notification while the camera is open; resume cleanly.
- [ ] Rotate the device with the camera open and in review; nothing is
      clipped or unresponsive.
- [ ] Change system font scale in Settings while the app is backgrounded,
      return: controls re-lay out, the retained receipt is still shown.
- [ ] Force-quit with unsent sections; relaunch does not crash (losing the
      local sections is acceptable).
- [ ] Low-memory: open several other camera-heavy apps, return; the camera
      re-initialises rather than showing a black preview.

## 8. Accessibility

- [ ] TalkBack: shutter, torch, gallery, mode toggle, section tiles and
      review actions each announce a name and role; the status line updates
      are announced.
- [ ] Largest system font size: no control is pushed off-screen or overlaps
      the shutter.

## 9. Network loss (all modes)

- [ ] Airplane Mode, then "Scan this receipt": the error path fires, the
      failure haptic plays, the spinner clears, captured sections are **not**
      cleared; restoring connectivity and retrying succeeds once.
- [ ] Drop connectivity mid-poll after a successful upload; the UI does not
      strand in "processing" — `/records/receipts/:id/retry` recovers it.
- [ ] No duplicate scan or record on the backend after any retry above.

## 10. Mode C only — ML Kit launcher

Run the *Superseded* checklist's sections 1–8 as written; they remain accurate
for this mode. Record results under "Mode C" so they are not mistaken for
custom-camera evidence.

---

## Please report back

For each section: which items passed, which failed (with what you observed),
which you could not test and why, and **which mode** the build resolved to. A
partially-run checklist with honest gaps is more useful than a fully-checked
one that wasn't actually exercised — see the project rule against claiming
test coverage mobile camera/permission/lifecycle code doesn't have.

---

## Superseded checklist — 31 August 2026 (ML Kit-only launcher)

**Status: unverified.** **Rewritten 31 August 2026** for the ML Kit-only
Android receipt scanner. Everything below this line describes the CURRENT
flow — `mobile/src/components/receipt-camera/ReceiptCamera.tsx` (a thin
launcher for Google ML Kit Document Scanner) and
`mobile/src/components/receipt-camera/ScannerStatusStates.tsx` (launching /
unsupported-runtime / failure). It replaces the previous checklist, which
covered FinSight's now-deleted custom `expo-camera` UI (manual shutter,
receipt guide, torch, overlap guide, crop editor, permission states) — that
UI no longer exists in this journey on Android, and iOS remains deferred. See
`docs/receipt-camera.md` for the full account of what changed and why.

Automated coverage is: the pure-arithmetic unit tests in
`mobile/tests/receiptCapture.test.ts` (crop geometry helpers still used by the
gallery/manual-crop code paths that remain elsewhere in the app, section
limits, ordering); `mobile/tests/receiptScannerLaunch.test.ts` (the launch
state machine — unsupported/success/cancelled/failure outcomes, the eight-page
cap, the concurrency guard — all against a **fake** scanner function, never
the real native module); `mobile/tests/receiptScannerFeature.test.ts` (the
Android/Expo-Go/flag gate); and `mobile/tests/render/receiptScannerStates.test.tsx`
(the three status screens mount, announce themselves correctly, and their
buttons fire the right callback — against a **fake DOM**, never a camera).
None of that is evidence that ML Kit itself launches, detects a document,
captures, or hands back real pages on a real phone. Do not report any item
below as "tested" without having actually run it on Android hardware inside a
native development/EAS build — typecheck/lint/unit tests passing says nothing
about this list.

This is a focused supplement to `docs/mobile-device-walkthrough.md`'s
"Receipt scan" section.

---

### 0. Before starting

- [ ] Confirm you are running a **native development/EAS build**
      (`npm run android`), not `npm run android:expo-go` / plain Expo Go. ML
      Kit Document Scanner needs the Nitro-backed native module; Expo Go
      cannot load it.
- [ ] Confirm the app is on **Android** — iOS is deliberately not implemented
      for this flow; pressing "Scan receipt" on iOS (or inside Expo Go on
      either platform) must show `ScannerUnsupportedState`'s "A native
      FinSight build is required" message, never a crash and never a
      fallback camera.

### 1. Launch behaviour

- [ ] From the tab bar's **Scan** button (opens with no photos already
      captured): the platform scanner opens **immediately** — no FinSight
      camera screen, no "Auto scan" button to press first.
- [ ] From **Records → Scan receipt**, same thing: the scanner opens
      immediately.
- [ ] From **"Add another section"** on the pre-scan review card (after at
      least one page is already captured): the scanner opens again, and the
      pages it returns are **appended** to the ones already on hand, in
      order — not a replacement of the earlier pages.
- [ ] Rapidly double-tap whatever opened the scanner (or the physical
      back-then-forward gesture fast enough to re-trigger the mount effect).
      Confirm only **one** scanner activity opens — `createScannerLaunchGuard`
      is unit-tested in isolation but the actual Android activity-launch race
      is not.

### 2. A short receipt, start to finish

- [ ] The scanner detects the receipt automatically (no manual shutter is
      offered inside ML Kit's UI by FinSight — whatever ML Kit itself
      provides is the platform's own UI, not FinSight's).
- [ ] Approve the single page in ML Kit's own review UI.
- [ ] FinSight's pre-scan review card appears with **one thumbnail**, and
      "Scan this receipt" proceeds into the existing upload/OCR/confirm flow
      unchanged.

### 3. A long receipt (multi-page)

- [ ] Use ML Kit's own multi-page capture (or repeat "Add another section")
      to capture more than one page of one physical receipt.
- [ ] Confirm returned pages arrive in **reading order** and stay that way
      through FinSight's review card (thumbnails numbered 1..N).
- [ ] Reorder pages on the review card (move up/down) and confirm the order
      sent to the server matches what is shown.
- [ ] Remove a page from the review card before scanning; confirm the
      remaining pages keep their relative order and the removed page is not
      uploaded.
- [ ] Capture up to the **eight-page maximum** (`MAX_SECTIONS`). Attempting a
      ninth page must be refused with a clear message
      (`launchReceiptScanner`'s "already has the most sections" failure, or
      ML Kit's own page-count UI if it enforces this itself first) — never a
      silent truncation and never a crash.
- [ ] Confirm the long receipt reaches the server as **one** scan
      (`groupReceiptMembers` — pages from one scanner launch never carry a
      `receiptGroupId`, so they always group together) with per-page OCR and
      arithmetic seam reconciliation, not a single stitched image.

### 4. Cancellation

- [ ] Open the scanner, then cancel out of it (ML Kit's own back/cancel
      control) **before** capturing anything. Confirm you land back on
      exactly the screen you were on before pressing Scan — no error notice,
      no "unsupported" screen, no camera of any kind.
- [ ] If pages were already captured in a prior round ("Add another
      section"), cancelling the new scanner attempt must leave those earlier
      pages untouched on the review card.

### 5. Genuine scanner failure

Hard to force deliberately, but check anything you encounter:

- [ ] A real failure (not a cancellation) shows `ScannerFailureState`: a
      plain-language description of what failed, a **"Retry scanner"**
      button, and a **"Go back"** button — and nothing else.
- [ ] "Retry scanner" re-opens ML Kit again; it does not open a different
      capture implementation.
- [ ] "Go back" returns to the previous screen exactly like a cancellation
      would, with no photos lost from any prior round.
- [ ] Try this with **no Google Play Services** or an outdated Play Services
      build if you have a device/emulator that allows it — confirm this
      surfaces as `failure`, never a fallback camera and never a raw native
      error message shown verbatim to the owner.

### 6. Gallery — separate workflow, never a fallback

- [ ] "Choose from gallery" on the pre-scan review card is reachable **at any
      time**, independent of whether the scanner has ever been opened.
- [ ] Confirm the gallery picker is **never opened automatically** as a
      result of a scanner cancellation or failure — the owner must
      explicitly tap the gallery button themselves.
- [ ] A gallery-picked image still flows through the existing
      quality-check/upload/OCR/confirm path unchanged.

### 7. Backgrounding / app lifecycle

`ReceiptCamera.tsx` has no `AppState` listener of its own; ML Kit's native
activity owns its own lifecycle while it is in the foreground. Every item
here is genuinely unverified behavior.

- [ ] Send the app to background while ML Kit's own UI is open (home button),
      then return. Confirm ML Kit resumes or the launch attempt fails
      cleanly into `ScannerFailureState` — never a stuck spinner
      (`ScannerLaunchingState`) with nothing responding.
- [ ] With pages already captured (from a prior scan round) but before
      "Scan this receipt" is pressed, background and return to FinSight.
      Confirm the captured pages are still present on the review card.
- [ ] Background the app **during upload** (right after tapping "Scan this
      receipt"/"Scan these N sections"), then foreground again. Confirm the
      upload either completes and the review screen shows the result, or
      fails cleanly into the existing error/retry path.
- [ ] Receive a phone call or notification banner while ML Kit's UI is open.
      Confirm it resumes cleanly afterward.
- [ ] Force-quit the app with captured, un-uploaded pages pending. Reopen the
      app. No crash on relaunch; losing the in-progress local pages on a hard
      kill is acceptable, a crash on the next launch is not.
- [ ] Rotate the device while ML Kit's own UI is open. This is entirely the
      platform scanner's own responsibility — confirm it stays usable, and
      confirm FinSight's own launching/failure/unsupported screens (which
      this app does control) are not visibly broken by rotation either.

### 8. Network loss

- [ ] Turn on Airplane Mode, then attempt "Scan this receipt" on a captured
      session. Confirm the existing catch path in `scanSingleReceipt()`
      fires: `error` is set via `describeActionFailure`, the failure haptic
      plays, and the busy spinner clears — never a silent hang.
- [ ] Confirm captured pages are **not cleared** after a failed upload — the
      owner should be able to retry without rescanning.
- [ ] Restore connectivity and retry the same upload from the same screen.
- [ ] Drop connectivity **mid-poll** — i.e. after `api.upload` succeeds but
      during `pollUntilRead`'s polling for the OCR result. Confirm this
      doesn't strand the UI in "processing" forever; the
      `/records/receipts/:id/retry` endpoint exists for exactly this.
- [ ] Do the same network-loss test against `PhotoUpload.tsx` (profile photo
      / business logo — unaffected by this replacement, but sharing the
      checklist): Airplane Mode, pick a photo, confirm `error` renders via
      `ErrorNote` and `busy` clears rather than leaving the spinner running
      indefinitely.
- [ ] Confirm none of the above network-loss cases produce a duplicate record
      or duplicate scan on the backend after a retry succeeds.

---

### Please report back

For each section above: which items passed, which failed (with what you
observed), and which you could not test and why. A partially-run checklist
with honest gaps is more useful than a fully-checked one that wasn't actually
exercised — see the project rule against claiming test coverage mobile
camera/permission/lifecycle code doesn't have.
