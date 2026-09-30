# Mobile Camera — Physical-Device Verification Checklist

**Status: unverified on physical hardware. Version 5.1, 29 September 2026.**
Version 5.1 keeps the Version 5 capture contract and replaces the review and
camera layout: a paged review with a Retake / Left / Filter / Crop toolbar and
one check button, an Add page card, and a thumbnail that opens review.
This is the current checklist for the post-capture crop and immediate-review
workflow. Version 4 and the 31 August ML Kit checklist remain below as history;
their Batch expectations must not be used for current acceptance.

Current sources of truth:
`mobile/src/components/receipt-camera/ReceiptCamera.tsx`, `CaptureChrome.tsx`,
`PageReviewer.tsx`, `ReviewToolbar.tsx`, `CropEditor.tsx`,
`ReceiptFilterSheet.tsx`, `ScannerModeSelector.tsx`, `scannerSession.ts`,
`mobile/src/lib/reviewPager.ts`,
`mobile/src/lib/customReceiptScanner.ts`, `receiptCapture.ts`, and the Android
`FinsightReceiptScannerView` and `ReceiptVision` implementation. The current
behavioral summary is `docs/custom-native-receipt-scanner.md`.

## Version 5 implementations

| Implementation | Runtime | Current contract |
| --- | --- | --- |
| A. FinSight camera with native engine | Android native development or EAS build with `FinsightReceiptScanner` linked | Standard and Batch, live guide, full-resolution still capture, post-capture crop and enhancement, local filters |
| B. FinSight fallback camera | Expo Go, iOS, or an older build without the native engine | Standard and Batch with manual shutter and gallery; no native detection, post-capture correction, or local filters |
| C. ML Kit launcher | Opt-in Android build with `EXPO_PUBLIC_RECEIPT_CAMERA_MODE=native` | Google ML Kit owns capture; use the separate historical ML Kit checklist |

Record the implementation and mode for every result. A native Android result
must not be used as evidence for the fallback camera, or the reverse.

## What automation establishes

Automated tests can assert that the explicit shutter remains enabled after a
missing-edge status, only Standard enables unattended auto-capture, native v3
payloads have consistent crop outcomes and corners, every accepted capture
opens review, staged Batch captures require a decision, duplicate callbacks are
ignored, and local metadata is not uploaded. Synthetic native tests exercise
crop and enhancement branches without a physical camera.

Automation does not establish camera focus, real boundary accuracy, readable
thermal print, low-light behavior, sensor orientation, zoom quality, device
memory pressure, permission UI, TalkBack, or OCR accuracy. Every unchecked item
below needs a physical-device result.

## Required device matrix

| Device or runtime | Minimum coverage |
| --- | --- |
| Native Android phone whose rear camera supports a 2x ratio | Standard auto and manual capture, Batch, all three crop outcomes where reproducible, filters, review, handoff |
| Native Android phone that reports less than 2x, or a controlled build that reports that limit | 2x remains unavailable with truthful copy; 1x capture remains usable |
| Slower or lower-memory supported Android phone | Processing indicator, timeout and recovery, repeated captures, background and resume, no crash |
| Expo Go or supported non-native fallback runtime | Manual shutter, immediate review, manual Crop, no native overlay or Filter claim |

Record model, Android or iOS version, build type and commit, free storage,
camera used, reported maximum zoom ratio, receipt type, lighting, and whether
the result came from a real receipt or a synthetic fixture.

## 0. Before starting

- [ ] Install a fresh native build after Kotlin changes. A Metro reload is not
      enough.
- [ ] Record whether the app resolved to implementation A, B, or C and whether
      Standard or Batch is selected.
- [ ] Confirm the camera reaches ready state and that Gallery remains available
      if permission is denied.
- [ ] Keep an original photo or consented receipt available for comparing the
      captured frame, crop, filter result, and OCR handoff. Do not use private
      financial data without permission.

## 1. Permission, startup, and lifecycle

- [ ] First launch explains camera access before the operating-system prompt.
- [ ] Deny once and deny permanently: the camera state is recoverable, Settings
      opens when required, and Gallery still works.
- [ ] Grant permission in Settings and return without restarting: the preview
      starts and the torch is off.
- [ ] Start with the camera held by another app: Retry camera succeeds after
      that app releases it.
- [ ] Background from live camera and return: late native events are ignored,
      the torch stays off, the preview restarts, and confirmed receipts remain.
- [ ] Background while a photo is being saved or processed: no late or duplicate
      receipt appears after reset.

## 2. Live detection and shutter gating

- [ ] Implementation A, Standard: a stable, sharp, well-lit receipt with a full
      inset boundary may capture automatically after the stability interval.
- [ ] Implementation A, Standard: a partial receipt, blank scene, blur, or poor
      light does not trigger unattended auto-capture.
- [ ] Implementation A, Standard: while no full boundary is present, tap
      **Capture receipt**. If the camera is ready and no capture is in flight,
      it saves a photo and enters processing instead of ignoring the tap.
- [ ] Implementation A, Batch: hold a fully detected receipt steady past the
      Standard stability interval. Batch does not capture unattended.
- [ ] Implementation A, Batch: tap the shutter with the top or bottom outside
      the frame, with no reliable boundary, and in a side-clipped scene. Each tap
      starts a full-resolution capture.
- [ ] Implementation B: the manual shutter works without an edge-detection
      precondition; two rapid taps still create only one capture.
- [ ] While a capture or post-processing operation is active, another shutter
      tap is disabled and does not enqueue a duplicate, including when the live
      status still says the edges are not clear.
- [ ] If a requested photo never returns, the shutter frees itself within about
      15 seconds with a message to try again.
- [ ] The green border and status text follow the scene but never appear in the
      saved photo.

## 3. Post-capture crop and enhancement

- [ ] A complete, reliable document boundary returns a straightened perspective
      crop with every visible edge and all print retained.
- [ ] A long receipt whose top or bottom extends beyond the frame, while both
      sides remain safely detected, returns a crop of only the visible section.
      The review message identifies that outcome.
- [ ] Missing, ambiguous, or side-clipped boundaries return the complete camera
      frame. Review states that automatic crop could not find a reliable
      boundary and offers Crop or Retake.
- [ ] Compare the fallback to the saved still. It contains no invented edge,
      reconstructed line, filled background, or content that was outside the
      camera frame.
- [ ] A crop or enhancement failure keeps usable captured pixels rather than
      failing the shutter request or presenting an empty image.
- [ ] Processing shows progress feedback and opens review when complete. It
      never sends the photo to the network by itself.
- [ ] Inspect faint text, totals, dates, and content near each edge at full zoom.
      Record any clipped, doubled, blurred, or altered characters.

## 4. Immediate review and Standard approval

- [ ] Every Standard capture, automatic or manual, replaces the live camera with
      review immediately. A second photo cannot be taken behind the review.
- [ ] Review shows the processed image without stretching it, a `1/1` position
      with chevrons, a delete chip, Compare, and the toolbar Retake, Left, Filter
      where supported, Crop and the check button. More actions holds Check
      quality and Reset image.
- [ ] Compare shows the untouched camera photo while selected and returns to
      the edited page; it never changes what is submitted.
- [ ] Left turns only the page on screen a quarter turn counter-clockwise. A
      filter chosen afterwards is still applied to the unenhanced crop.
- [ ] Retake returns to the camera and replaces only the selected receipt.
- [ ] Crop can correct a weak automatic result; Reset image restores the
      untouched camera photo.
- [ ] Leaving Standard review keeps a truthful Receipt ready state. Reopening
      review does not replace or submit the image.
- [ ] **Use this receipt** hands off exactly once. Capture and review alone do
      not start OCR or save a financial record.

## 5. Batch confirmation and navigation

- [ ] The first Batch shutter opens review immediately. The camera is absent and
      a second capture is impossible while that photo is staged.
- [ ] The staged photo is not yet a confirmed Batch receipt. Back or Delete can
      discard it without changing earlier confirmed receipts.
- [ ] The check button on a new capture (**Keep page**) accepts only the
      current photo and returns directly to live capture. It does not call the final handoff, start OCR, or submit the
      Batch.
- [ ] After Keep page, the confirmed receipt, edits, identity, and order
      remain intact and the camera is ready for the next capture.
- [ ] Open the batch from the camera thumbnail (its badge counts kept
      receipts), swipe or use the chevron past the last page, and press the
      dashed **Add page** card. It returns to live capture without changing any
      page. The edit toolbar is disabled while the card is shown.
- [ ] Repeat capture, review, and Keep page for a second receipt. The badge and
      pager count only kept receipts as ready.
- [ ] Swiping and the Previous and Next page chevrons select the same page and
      keep the `n/N` position in step. Swiping is locked while a new capture
      waits for Keep page or discard. Move earlier and Move later (More
      actions) change only visible order.
- [ ] Retake replaces the selected receipt in place and preserves its receipt
      group identity. Rotate, Filter, Crop, and Delete affect only that receipt.
- [ ] Capture eight confirmed receipts. A ninth is refused with a clear limit
      message and no crash or silent truncation.
- [ ] **Finish batch (N)** (the check button when review is opened from the
      thumbnail) is never offered while a staged photo needs a decision, and
      hands off N kept receipt groups exactly once in visible order.
- [ ] Batch is one long receipt. Every kept capture is the next part of the
      same receipt (one receipt group, parts in capture order, at most 8). The
      Scan receipt screen shows "One long receipt in N parts", labels Part 1..N,
      and offers **Scan long receipt (N parts)**; the parts upload as one scan
      and are not stitched into one image. Standard remains one receipt.

## 6. Gallery import

- [ ] Gallery opens only after an explicit tap and remains available when camera
      permission is denied.
- [ ] A Standard gallery image opens review immediately.
- [ ] Batch Gallery accepts one photo to review at a time. The selected image
      enters the same per-capture review and Keep page boundary before
      handoff.
- [ ] Selecting the same picker asset twice does not create a duplicate receipt.
- [ ] Orientation is correct in review and in the final uploaded image.
- [ ] Change system font scale while the picker is open, then return. The camera
      or review recovers without losing confirmed receipts.

## 7. Filters and editing

- [ ] On implementation A, Filter offers Original, Enhanced, Grayscale, and
      Black and white (B&W). Each result remains readable and uses no network
      request.
- [ ] Original shows the saved post-crop color base. Enhanced improves local
      contrast without inventing strokes. Grayscale removes color. B&W does not
      erase faint characters or merge adjacent lines.
- [ ] Repeated filter changes start from the immutable color base, not the last
      lossy derivative.
- [ ] Reset image restores the untouched camera photo and its dimensions.
- [ ] A manual Crop becomes the new filter base and is enhanced with the page's
      filter (Enhanced unless another was chosen). If the local filter fails,
      the straightened photo is kept.
- [ ] Implementation B does not expose a local Filter action or imply that native
      enhancement ran.
- [ ] Crop and Check quality disclose their existing network processing. If the
      backend is unavailable, the current photo remains unchanged and usable.

## 8. Blur, low light, zoom, and limits

- [ ] In low light or blur, Standard unattended capture waits and gives useful
      guidance. The manual shutter still captures when the camera is ready.
- [ ] Review the resulting fallback at full size and record whether OCR-relevant
      text is readable. Do not mark guidance alone as a quality pass.
- [ ] Flash toggles without freezing preview and turns off on background or exit.
- [ ] On a camera reporting at least 2x, 1x and 2x both capture successfully.
      Record whether the hardware implements optical or digital zoom; FinSight
      makes no optical claim.
- [ ] On a camera reporting less than 2x, the 2x control is unavailable and the
      message is accurate.
- [ ] Exercise a near-limit image and a full eight-receipt Batch. Limits produce
      a recoverable message, preserve confirmed work, and do not crash.
- [ ] Repeat capture, filters, Retake, and Delete while watching memory, heat,
      storage growth, and cleanup. Record measurements rather than guessing.

## 9. Accessibility and layout

- [ ] TalkBack announces Close, flash, Standard and Batch tabs, Gallery,
      Capture receipt, the zoom toggle, the Review thumbnail, the page
      position, Previous and Next page, Delete page, Compare, the toolbar
      actions, Keep page, Add page, and Finish batch with correct roles and
      states.
- [ ] Processing and crop-fallback messages are announced without stealing focus
      repeatedly.
- [ ] At the largest supported font size, controls wrap without covering the
      shutter or primary review action.
- [ ] On the smallest supported phone and after rotation, the preview remains
      usable and every action is reachable.

## 10. Final handoff, network loss, and retry

- [ ] Capture and local Filter make no API request. Only disclosed Crop or Check
      quality actions may call their existing processing endpoints before final
      approval.
- [ ] Airplane Mode at **Use this receipt** or **Finish batch (N)** produces a
      recoverable error, clears the spinner, and preserves confirmed receipts.
- [ ] Restore connectivity and retry. The same local receipt is submitted once;
      no duplicate scan or financial record appears.
- [ ] Drop connectivity after upload while OCR polling. The existing retry path
      recovers without losing the captured images or creating a duplicate.
- [ ] Verify that crop-outcome and local filter-source metadata remain local;
      only supported processed and original image objects reach multipart upload.

## Implementation C

The opt-in ML Kit launcher has a different activity and approval flow. Run the
31 August ML Kit checklist retained below and label its results as implementation
C. Do not use those results to approve the FinSight camera in implementations A
or B.

## Version 5 report

For each failed or skipped item, record the implementation, mode, device,
receipt and lighting conditions, what was expected, what happened, and any image
or log evidence. Separate automated, emulator, synthetic-native, and physical
results. An incomplete but accurate report is acceptable; unchecked hardware
behavior is not a pass.

---

## Historical checklist: Version 4, 29 September 2026

The following snapshot is preserved verbatim as implementation history. It
expected Batch to keep the live camera available after capture, which the
current immediate-review and per-capture Confirm receipt contract supersedes.

**Status: unverified on hardware.** **Version 4, 29 September 2026.** Written
against the receipt-camera code as it is today; the 31 August version below is
kept under *Superseded* because it described an ML Kit-only launcher that is no
longer the default and claimed the custom camera had been deleted, which it has
not (QA finding MOB-DOC-01). When the implementation changes again, add a new
version above this one rather than editing history.

Source of truth for every claim here:
`mobile/src/components/receipt-camera/ReceiptCamera.tsx` (dispatcher + custom
camera), `NativeReceiptCamera.tsx` (retained ML Kit launcher),
`CropEditor.tsx`, `CameraAction.tsx`, `ScannerModeSelector.tsx`,
`scannerSession.ts`, `ReceiptFilterSheet.tsx`, `ScannerStatusStates.tsx`,
`mobile/src/lib/customReceiptScanner.ts`, `mobile/src/lib/receiptScannerFeature.ts`,
`mobile/src/lib/receiptFilters.ts`,
`mobile/app.config.ts` (`receiptCameraMode`, `receiptScannerEnabled`). The
narrative documents are `docs/custom-receipt-camera-implementation.md`,
`docs/custom-native-receipt-scanner.md` and `docs/receipt-scanner-capture-fix.md`.

## The three capture implementations

`ReceiptCamera` picks its implementation at mount from two build facts:

| Implementation | Selected when | What the owner sees | Where the evidence lives |
|---|---|---|---|
| **A. Custom camera + native engine** (default on a native Android build) | `receiptCameraMode` is `custom` (the default) **and** the `FinsightReceiptScanner` native view is linked (`getCustomScannerView()` returns non-null: Android, native dev/EAS build) | FinSight's full-screen camera with **Standard** and **Batch** tabs; native document detection and correction; explicit shutter; torch; gallery; batch review; crop; and on-device filters | `mobile/tests/render/continuousReceiptCamera.test.tsx` (native pixels mocked), pure bridge/session tests, and Android instrumented tests in the native module |
| **B. Custom camera, fallback engine** | `receiptCameraMode` is `custom` and the native view is **not** linked (Expo Go, iOS, or an older build without the engine) | The same **Standard** and **Batch** workflow using `expo-camera`; explicit shutter and gallery import; no native detection or local-filter control | `mobile/tests/render/receiptCamera.test.tsx` (`expo-camera` mocked) |
| **C. ML Kit launcher** (opt-in) | `EXPO_PUBLIC_RECEIPT_CAMERA_MODE=native` at build time, **and** `receiptScannerEnabled` not `false`, **and** Android native build (not Expo Go) | No FinSight camera; Google ML Kit Document Scanner's own activity opens immediately; FinSight shows only launching / unsupported / failure states around it | `mobile/tests/render/receiptScannerStates.test.tsx`, `mobile/tests/receiptScannerLaunch.test.ts`, `mobile/tests/receiptScannerFeature.test.ts` (fake scanner function, never the real module) |

Before reporting anything, record which implementation the build resolved to.
For implementations A and B, also record whether Standard or Batch was tested.

## What the automated suites do and do not establish

The render harness (`mobile/tests/render/*`, see that directory's README)
mounts the real components against **mocked** `expo-camera`,
`expo-image-picker`, the native scanner view, `AppState` and the API. It
covers, and only covers:

- the custom camera's interaction contract: only Standard and Batch tabs are
  exposed; gallery remains available when camera permission is permanently
  denied; one shutter runs at a time; review is required before handoff;
  ordered Batch import and capture create separate receipt groups; navigation,
  reordering, deletion, addition, retake-in-place and explicit Batch approval
  preserve those group boundaries;
- the native engine's UI contract: capture acknowledgement and detection
  recovery; malformed output is rejected without losing the camera; stale
  status and capture callbacks are ignored after a mode switch, receipt
  deletion/reset, and backgrounding; a retained receipt survives a font-scale
  change;
- the local-filter bridge contract: all four filter results are parsed with
  strict local-URI, dimension, processing-mode and transform-version checks;
  the review UI keeps the original available for reset. Render tests mock the
  native filter call, and therefore do not establish real pixel output;
- the pure scanner-session contract: Standard has one receipt, Batch has up to
  eight separate receipts, restored state is normalized and bounded, duplicate
  callbacks are ignored, and confirmation preserves explicit receipt groups;
- the scan review workflow after capture: double-tap locks, cancellation,
  stale-business results, replay keys, unreadable dates, foreign currency,
  unsupported files;
- the ML Kit status screens' copy and buttons.

None of that exercises a camera sensor, a real permission dialog, the Android
activity lifecycle, a real gallery intent, rotation, low memory, TalkBack, or
the native engine's actual frame processing. The per-project rule stands:
say **"needs physical-device verification"** for every item below; passing
typecheck/lint/unit tests is not evidence for any of them.

## Backgrounding behavior to verify

Contrary to the superseded text, the custom camera **does** register an
`AppState` listener (`ReceiptCamera.tsx`, the `AppState.addEventListener`
effect). On leaving the foreground it bumps the native event epoch so queued
engine events are dropped, clears in-flight capture state, switches the torch
off, sends the engine a `reset` command, unmounts the camera preview (`ready`
false) and sets the status line to
"Camera paused. Position the receipt and try again." On returning it bumps
the text-layout revision (Android font-scale changes made in Settings) and
re-reads camera permission. Captured **receipts already in the strip are kept**.
In implementation C the ML Kit activity owns its own lifecycle and this listener is not
mounted.

---

## 0. Before starting

- [ ] Record the build type: native dev/EAS build (`npm run android`) or Expo
      Go (`npm run android:expo-go`), and the platform.
- [ ] Record the resolved implementation (A/B/C). For A, confirm the native engine
      actually attached (automatic detection overlay appears); for C, confirm
      `EXPO_PUBLIC_RECEIPT_CAMERA_MODE=native` was set at build time.
- [ ] Confirm the app builds and launches; no camera-related crash on cold start.

## 1. Permission states (implementations A and B)

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

## 2. Standard capture (implementations A and B)

- [ ] Implementation A: hold a receipt on a contrasting surface; the paper highlight
      tracks it; tap **Capture receipt**; the review state shows the corrected
      page **without** uploading anything.
- [ ] Implementation B: tap **Capture receipt** to capture one page; two fast taps produce **one**
      capture (synchronous lock).
- [ ] Both: only one receipt can be present; another capture is unavailable
      until the current receipt is reviewed, replaced, deleted or confirmed.
- [ ] Both: review exposes Retake, Rotate, Crop, Delete and Check quality;
      **Use this receipt** explicitly hands one receipt to the caller.
- [ ] Torch toggles the flashlight and is **off** again after backgrounding.

## 3. Batch capture

- [ ] Select **Batch scan mode**. Each shutter press or selected gallery image
      creates a new receipt, not another page of the previous receipt.
- [ ] After each capture the live camera remains available, the count advances,
      and the newest thumbnail opens review.
- [ ] Capture eight receipts (`MAX_RECEIPTS_PER_CAPTURE_BATCH`); a ninth is
      refused with a clear message and no crash.
- [ ] Review exposes Previous receipt, Next receipt, Move earlier, Move later,
      Delete and Add receipt where applicable. Each action keeps the remaining
      receipt order and selection understandable.
- [ ] Retake replaces the selected receipt in place and preserves its receipt
      group identity.
- [ ] **Use batch (N)** requires an explicit tap and hands off N distinct,
      nonblank receipt group IDs in the visible order.
- [ ] Confirm in downstream review that N Batch captures create N separate
      receipts. They must not be stitched into one image or one receipt.

## 4. Gallery import

- [ ] Gallery is reachable from the camera screen at any time and is never
      opened automatically after a failure.
- [ ] Multi-select in Batch mode imports in selection order; every selected
      image becomes a separate receipt and a duplicate picker URI is ignored.
- [ ] Imported images are normalized (orientation correct in review and in
      the uploaded result).
- [ ] A gallery return that recreates the activity (font scale changed while
      in the picker) keeps the session — see
      `custom-native-receipt-scanner.md` for the plugin that mitigates this.

## 5. Review tools and local Android filters

- [ ] Crop editor: four corners adjustable; server edge suggestion appears
      when the backend is reachable; perspective correction returns a
      rectified image; restore returns to the original.
- [ ] In implementation A, **Filter** opens Original, Enhanced, Grayscale and
      Black and white. Applying each choice produces the expected legible local
      image without a network request.
- [ ] After applying a filter, **Reset image** restores the original image and
      dimensions. Repeated filter changes start from the saved pre-filter image,
      not from a progressively degraded derivative.
- [ ] If the installed Android build lacks the local filter bridge, the current
      image remains usable and a clear error appears. Implementation B does not
      show the Filter action.
- [ ] With the backend unreachable, crop/quality actions fail with a message
      and the photo stays usable unchanged.
- [ ] Quality check reports blur/dark advisory feedback and discloses that
      the photo is sent for processing; taking a photo alone sends nothing.
- [ ] These filter pixel checks remain **unverified on physical hardware**.
      Automated bridge/render checks and native instrumentation are not a substitute.

## 6. Cancellation and Back

- [ ] Android hardware Back from the camera with nothing captured returns to
      the previous screen with no dialog.
- [ ] Back with unsent receipts asks to discard; "Keep editing" keeps them.
- [ ] Back during an in-flight native capture leaves no late result in the
      session and keeps previously reviewed receipts.
- [ ] Back during a network operation (quality/crop/upload) aborts it and the
      late result is ignored; the session is preserved.

## 7. Backgrounding / app lifecycle

- [ ] Background the app from the live camera, return: status line reads
      "Camera paused…", torch is off, preview restarts, receipts in the strip
      are intact.
- [ ] Implementation A: background during capture, then return. No queued native status
      or capture event is accepted after the reset, the app does not crash, and
      previously reviewed receipts remain.
- [ ] Background during upload, return: the upload completes or fails into
      the existing retry path; never a stuck spinner.
- [ ] Phone call / notification while the camera is open; resume cleanly.
- [ ] Rotate the device with the camera open and in review; nothing is
      clipped or unresponsive.
- [ ] Change system font scale in Settings while the app is backgrounded,
      return: controls re-lay out, the retained receipt is still shown.
- [ ] Force-quit with an unsent session; relaunch does not crash (losing local
      receipts is acceptable).
- [ ] Low-memory: open several other camera-heavy apps, return; the camera
      re-initialises rather than showing a black preview.

## 8. Accessibility

- [ ] TalkBack: shutter, torch, gallery, Standard/Batch tabs, receipt tiles and
      review actions each announce a name and role; the status line updates
      are announced.
- [ ] Largest system font size: no control is pushed off-screen or overlaps
      the shutter.

## 9. Network loss (all implementations)

- [ ] Airplane Mode, then submit the reviewed receipt: the error path fires, the
      failure haptic plays, the spinner clears, captured receipts are **not**
      cleared; restoring connectivity and retrying succeeds once.
- [ ] Drop connectivity mid-poll after a successful upload; the UI does not
      strand in "processing" — `/records/receipts/:id/retry` recovers it.
- [ ] No duplicate scan or record on the backend after any retry above.

## 10. Implementation C only — ML Kit launcher

Run the *Superseded* checklist's sections 1–8 as written; they remain accurate
for this implementation. Record results under "Implementation C" so they are not mistaken for
custom-camera evidence.

---

## Please report back

For each section: which items passed, which failed (with what you observed),
which you could not test and why, and **which implementation and session mode**
the build resolved to. A
partially-run checklist with honest gaps is more useful than a fully-checked
one that was not actually exercised. See the project rule against claiming
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
