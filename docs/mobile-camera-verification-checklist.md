# Mobile Camera — Physical-Device Verification Checklist

**Status: unverified.** This covers `mobile/src/components/receipt-camera/*`
(FinSight's own in-app camera, which replaced `ImagePicker.launchCameraAsync`),
`PhotoUpload.tsx`, and the receipt-scan upload path in `RecordsScreens.tsx`.
None of it has automated coverage beyond the pure-arithmetic unit tests in
`mobile/tests/receiptCapture.test.ts` (crop geometry, section limits,
ordering — see the header comment in `mobile/src/lib/receiptCapture.ts` for
why: the mobile suite has no component render harness). Camera capture,
permission dialogs, app lifecycle, and real network conditions can only be
exercised on a physical Android phone. Do not report any item below as
"tested" without having actually run it on hardware — typecheck/lint/unit
tests passing says nothing about this list.

This is a focused supplement to `docs/mobile-device-walkthrough.md`'s
"Receipt scan" section — that doc covers the whole app in one pass; this one
goes deep on the four riskiest surfaces of the new camera: capture itself,
permission states, backgrounding, and network loss.

---

## 1. Camera capture (multi-section)

The camera supports photographing a receipt as up to `MAX_SECTIONS` (8)
separate shots — for a receipt too long to fit one frame — then uploads them
together as one scan on "Finish". Nothing uploads until Finish is tapped.

- [ ] Open the scan screen; the custom camera preview appears (not the
      system camera app).
- [ ] Take one photo. The section is added to the strip at the bottom; the
      shutter does not auto-upload it.
- [ ] Take a second photo of a different part of the same long receipt.
      Confirm the overlap guide (a translucent band showing the previous
      section's bottom edge) appears before the shutter, to help line up the
      seam.
- [ ] Reorder sections in the strip (if reordering UI is present) and confirm
      the final upload preserves reading order — this is what
      `moveSection`/`sectionLabel` in `receiptCapture.ts` compute; the
      screen just has to honor it.
- [ ] Delete a captured section from the strip before finishing; the
      remaining sections keep their relative order.
- [ ] Try to exceed 8 sections. The 9th shutter press should be blocked with
      `SectionLimitNotice`, not silently accepted or crash.
- [ ] After the detected-corners overlay (`DetectedOutline`) appears on a
      capture, drag a corner in the crop editor and confirm the crop applies
      to the uploaded image, not the original framing — a bad drag should be
      visibly wrong in the confirm-and-upload preview, not just wrong after
      OCR comes back.
- [ ] Discard a capture (retake) mid-session; the discarded photo must not
      appear in the final upload.
- [ ] Tap "Finish" with at least one section captured; confirm all sections
      upload as one scan (`api.upload("/records/receipts", …)` with one
      `files` entry per section) and the review screen pre-fills from the
      combined OCR result.
- [ ] Tap "Cancel"/back before capturing anything. No orphaned local files,
      no network call.
- [ ] Take a **deliberately bad photo** (blurry, extreme angle, very poor
      light). It should still be acceptable as a section — never a crash or
      a silent drop — matching the existing rule that a bad capture is fixed
      by hand downstream, not rejected.

## 2. Permission states

`CameraPermissionState.tsx` renders three distinct states — treat all three
as separate test cases, not one "permission" case:

- [ ] **First open, before any decision (`pending`):** shows "Opening the
      camera…" with a spinner, not a flash of the denied/blocked screen.
- [ ] **Deny once (`denied`, `canAskAgain: true`):** shows "FinSight needs
      the camera" with an **"Allow camera access"** button that re-prompts
      the OS dialog, plus **"Choose from gallery instead"** and
      **"Cancel"**. Tapping "Allow camera access" must actually reopen the
      OS permission dialog, not silently no-op.
- [ ] **Deny permanently / "Don't ask again" (`blocked`):** shows the same
      screen but the primary button is **"Open Settings"** instead, and
      tapping it opens the phone's OS Settings app to FinSight's permission
      page (`Linking.openSettings()`). Confirm there is no dead "Allow
      camera access" button shown in this state — the copy explicitly says
      the in-app prompt will never reappear.
- [ ] From **any** of the three states, "Choose from gallery instead" must
      work and lead to a normal single/multi-photo gallery pick that flows
      into the same upload path — an owner who will never grant camera
      access must still be able to scan a receipt.
- [ ] Grant permission after having previously denied it (via Settings, then
      return to app): confirm the screen updates to the live camera without
      requiring an app restart.
- [ ] Revoke camera permission from OS Settings **while the app is
      backgrounded**, then foreground back into the camera screen. Confirm
      it re-checks and falls back to a permission-state screen rather than
      showing a frozen/black preview.

## 3. Backgrounding / app lifecycle

`ReceiptCamera.tsx` has no `AppState` listener — nothing in the code
currently detects backgrounding directly, so every item here is genuinely
unverified behavior, not a known-good path. This is the least test-covered
part of the flow.

- [ ] Mid-capture (camera preview open, before any shutter press), send the
      app to background (home button) and return. Confirm the preview
      resumes and does not crash or show a stale/frozen frame.
- [ ] With sections already captured but before "Finish", background and
      return. Confirm captured sections are still present in the strip —
      they must not silently disappear.
- [ ] Background the app **during the upload itself** (right after tapping
      "Finish", while the network request is in flight), then foreground
      again. Confirm the upload either completes and the review screen
      shows the result, or fails cleanly into the existing error/retry path
      — never a stuck spinner with no way forward.
- [ ] Receive a phone call or notification banner while the camera preview
      is open. Confirm the camera resumes cleanly afterward (this exercises
      the same interrupt path as backgrounding, but via the OS rather than
      the home button).
- [ ] Force-quit the app entirely (not just background) with captured,
      un-uploaded sections pending. Reopen the app. Confirm there is no
      crash on relaunch; losing the in-progress local sections on a hard
      kill is acceptable (nothing here claims persistence across process
      death) but a crash on the *next* launch would not be.
- [ ] Rotate the device (if orientation is unlocked) while the camera is
      open. Confirm the preview and controls stay usable, not clipped or
      distorted.

## 4. Network loss

- [ ] Turn on Airplane Mode, then attempt "Finish" on a captured session.
      Confirm the existing catch path in `scanPages()` fires: `error` is set
      to the network failure message via `errorMessage(err)`, the failure
      haptic plays, and the busy spinner clears — never a silent hang.
- [ ] Confirm captured sections are **not cleared** after a failed upload —
      the owner should be able to retry without re-photographing everything.
- [ ] Restore connectivity and retry the same upload from the same screen;
      it should succeed without needing to leave and re-enter the scan flow.
- [ ] Drop connectivity **mid-poll** — i.e. after `api.upload` succeeds
      (files stored) but during `pollUntilRead`'s polling for the OCR
      result. Confirm this doesn't strand the UI in "processing" forever;
      there should be a path to retry (the `/records/receipts/:id/retry`
      endpoint exists for exactly this — confirm the UI actually offers it).
- [ ] Do the same network-loss test against `PhotoUpload.tsx` (profile
      photo / business logo): Airplane Mode, pick a photo, confirm `error`
      renders via `ErrorNote` and `busy` clears rather than leaving the
      spinner running indefinitely.
- [ ] Use a throttled/flaky connection (Android Developer Options network
      throttling, or a real weak-signal location) rather than a hard
      Airplane Mode toggle at least once — a slow-but-alive connection can
      exercise timeout handling that instant disconnection doesn't.
- [ ] Confirm none of the above network-loss cases produce a duplicate
      record or duplicate scan on the backend after a retry succeeds (i.e.
      retrying doesn't resubmit and create two receipts).

---

## Please report back

For each section above: which items passed, which failed (with what you
observed), and which you could not test and why. A partially-run checklist
with honest gaps is more useful than a fully-checked one that wasn't
actually exercised — see the project rule against claiming test coverage
mobile camera/permission/lifecycle code doesn't have.
