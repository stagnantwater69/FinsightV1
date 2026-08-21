# The receipt camera — what was built, and what it does not do

Implemented 8 August 2026. This is the record of what shipped, written so the
manuscript can be checked against it rather than against the plan it came from.

Its companion is `docs/multi-page-receipts-plan.md`, which decided how a
receipt could span several photographs. This document covers how those
photographs are now taken.

---

## 1. What replaced what

Before, mobile called `ImagePicker.launchCameraAsync({ quality: 0.7 })` — the
system camera app, one photograph at a time, uploaded the instant it came
back.

Now, `mobile/src/components/receipt-camera/` renders FinSight's own camera on
`expo-camera`. What that buys, in the order it matters:

| Gained | Why it could not be done before |
|---|---|
| Approval before upload | The system camera returns to the app *after* the shot; the old flow uploaded immediately, so a thumb over the lens cost an OCR pass and a wrong set of figures |
| A receipt-shaped guide | A camera app knows nothing about receipts |
| An ordered section session | Nothing said three photographs were one receipt |
| An overlap guide for long receipts | Same |
| Manual four-corner cropping | No crop step existed at all |
| Post-capture edge detection | Same |
| Capture quality 0.7 → 0.9 | 0.7 was inherited from the avatar picker |

### Corrected after seeing it on a device (8 August 2026)

The first build was screenshotted on a real phone and two things were wrong:

- **The camera was not full-screen.** It was returned from inside a navigation
  stack, so it rendered *between* the "Scan receipt" header and the tab bar,
  losing roughly a fifth of its height. It is now a `Modal` with
  `statusBarTranslucent`, which escapes both without touching navigation
  options — a `setOptions` approach has to restore the tab bar on every exit
  path, and the one that gets missed leaves the app with no navigation.
  `onRequestClose` handles the Android back button; without it the modal
  dismisses while `cameraOpen` stays true and the camera can never reopen.
- **The guide frame was a small square.** Fixed insets (132/188/26pt) picked
  against one screen, inside an already-shortened preview. It told the owner
  the receipt had to fit in a quarter of the frame — the opposite of what is
  wanted, since resolution is the one thing OCR cannot recover. Now
  proportional (`guideRect`): ~92% of the width, ~65% of the height, with
  floors so the chrome never overlaps it.

The guide never controlled what was captured — `takePictureAsync` has always
returned the **whole sensor frame** — but a small frame implied otherwise.
Cropping happens afterwards, on the review screen, where it can be seen and
undone.

### The Scan button stopped navigating (8 August 2026)

Device testing produced a run of faults that all turned out to be one mistake.
The Scan button worked by **navigating** —
`navigate("Records", { screen: "ScanReceipt", params: { autoLaunch: true } })`
— so pressing it pushed a screen onto *another tab's stack* purely to get a
camera up. From that, in order of discovery:

1. The **Records** tab lit up instead of Scan, because the scanner was a
   Records screen.
2. Pressing **Records did nothing at all**, so the records list could not be
   reached. `@react-navigation/bottom-tabs` runs its handler under
   `if (!focused …)`, and Records *was* the focused tab.
3. The nested-navigation directive **stuck to the Records tab route**, and the
   same handler replays stored params — so returning to Records from another
   tab reopened the scanner and re-fired `autoLaunch`, pointing a camera at
   someone who asked for their records.
4. Backing out of the camera **stranded the owner** on a screen they never
   asked for, whose only content was a button saying "Open the camera".

Each was patched in turn; the patches were treating symptoms. **The camera is
now a modal owned by the tab bar** (`MainTabs`), not a screen:

- Pressing Scan changes **no navigation state**. The camera opens over
  whatever the owner was looking at, and cancelling returns them there.
- Only **finishing** a capture navigates, and it navigates to `ScanReceipt`
  because there is now a receipt to read. Sections travel through
  `lib/receiptHandoff.ts` — a module-level handoff in the manner of
  `flash.ts` — rather than as route params, because params persist and get
  replayed, which is fault (3) exactly.
- `ScanReceipt` is an ordinary Records screen again: it reviews a scan.
  Records lighting up there is correct, so the highlight special-casing is
  gone. The Scan button lights from plain local state.
- Arriving with a handed-over session **starts the read immediately** — the
  owner already approved those photographs on the capture preview.
- `recordsTabPressAction` is kept for defects (2) and (3), which are general
  to any tab whose stack is navigated into from elsewhere.
- The camera's X **asks before discarding** a session with sections in it.

Entering from "Scan receipt" on the records list still opens the camera
straight away, since nothing has been captured and that screen's purpose is to
capture something.

The **gallery path is unchanged and deliberately kept**. It is the fallback for
a phone whose owner will not grant camera access, for e-receipt screenshots,
and for anything about the new camera that turns out to be wrong on a device.

**The upload contract did not change.** `POST /records/receipts` still receives
the same `files` array in the same order. Crop corners and edge confidence stop
at the phone — see `pagesFromSections` in `RecordsScreens.tsx`.

---

## 2. What it does not do — for the manuscript

These are the claims that would be **false**, each with the reason:

| Do not claim | Reality |
|---|---|
| Real-time OCR | Nothing is recognised from live frames. OCR is server-side Tesseract, after upload. |
| Real-time edge detection | Detection runs **after** the shutter, on the server. There is no live outline and no automatic shutter. |
| Fully automatic cropping | Detection *proposes* corners above a confidence floor. The owner confirms or drags them. Below the floor it proposes nothing and the editor opens on defaults. |
| Perspective correction | The crop applied is the **axis-aligned bounding box** of the four corners. `expo-image-manipulator` cannot resample through a homography and Expo Go has no native module that can. The editor shades what will be discarded, so this is shown rather than hidden. |
| Google ML Kit | Not integrated. Ruled out because it needs a development build — the same reason on-device OCR was ruled out. |
| Offline OCR | Processing is backend-based. |
| On-device edge detection | Runs on the server, via `sharp`. Same development-build constraint. |

### Wording that is accurate

> FinSight provides a custom mobile receipt-capture interface built on Expo
> Camera. Users can capture a complete receipt or record a long receipt as
> several ordered, overlapping sections. After each capture the image is
> assessed for readability and a server-side detector proposes the receipt's
> corners; the owner reviews, adjusts the crop by hand where necessary, and
> approves each section before anything is uploaded. Sections are then
> processed as one receipt by backend OCR. All extracted information remains
> editable and requires the owner's confirmation before it is saved.

---

## 3. Overlap, and why nothing is deleted on a guess

The camera asks for 15–25% overlap between sections so the owner can see where
to continue. Those lines are therefore read twice, and pages are OCR'd
separately and concatenated in order (`multi-page-receipts-plan.md` §7 rejected
image stitching for the same reason).

The first draft of this plan proposed scoring line similarity across the seam
and dropping whatever passed a threshold. **That was rejected**, because it is
a preference-based heuristic deciding which money lines survive, and this
codebase already fixed the opposite rule for exactly this situation at
`receiptScan.service.ts` — a competing reading replaces the deterministic one
*"only on an OBJECTIVE test, never a preference."*

What shipped instead:

1. `seamOverlapLength` finds the longest run where one section's **tail** is the
   next section's **head**. Anchored, not a search for shared lines anywhere —
   a restock receipt legitimately repeats an item on pages 1 and 3, and an
   unanchored search would delete a real purchase.
2. The pipeline builds **both** readings: the plain concatenation and the
   de-overlapped one.
3. The de-overlapped reading is used **only** when the plain one fails to
   account for the receipt's printed total and the de-overlapped one does.
   That is arithmetic agreeing with the paper, not a judgement.
4. Where both fail, the **full reading stands** and the gap surfaces on the
   confirm screen, exactly as it always has.
5. `rawText` always stores the **full, unedited** concatenation. The audit
   trail never loses a line this chose not to count.

`overlappingPages` is returned as an advisory so the confirm screen can explain
repeated lines. It is worded as the feature working, not as a fault — unlike
`duplicatePages`, which is the same page photographed twice by mistake.

---

## 4. Edge detection

`backend/src/lib/edgeDetection.ts`. Blur → Otsu threshold → largest
4-connected component (**both polarities**) → four extreme points →
confidence.

Server-side because every on-device option (a document-scanner library, a
custom native module, OpenCV) needs a development build. The phone is already
posting the same image to `/quality-check` on the same shutter press, and
`sharp` is already loaded in that process.

Confidence is returned as a **number**, not a boolean, so the cut-off lives in
the client (`EDGE_CONFIDENCE_FLOOR`, 0.55) where the consequences are visible.
The same floor gates both the outline drawn on the capture preview and the
one-tap "Crop to the receipt" — below it, neither appears.

### Three things measurement changed

The first working version was wrong in ways only fixtures exposed:

1. **Blur sigma 1.5 → 3.** A receipt is fine dark text on white. Thresholded
   with too little blur, every line of print became a gap and the sheet
   shattered into stripes — it filled only 78% of its own bounding quad, and
   the *background* outscored it. At 2.5 the print merged completely and the
   sheet came back whole at fill 1.0.
2. **`fill` is squared.** The strongest competing reading of any photograph is
   its background — a ring with the receipt punched out, whose extreme points
   are the frame's own corners. It scored **0.55–0.57**, just over the
   preselect floor, so the crop editor would have opened with handles around
   the whole photograph. A solid sheet fills its bounding quad (1.0); a ring
   fills ~0.58. Squaring leaves the receipt untouched and collapses the ring
   to 0.33.
3. **Both polarities are scored.** "Paper is the bright class" holds on a
   counter and fails on a pale table, where a single-polarity detector
   confidently proposed corners around the *table*. Both readings are scored
   and the better wins; scoring the second costs one pass over a 320px image.

**Known limits, stated rather than discovered later:**

- A blob covering >92% of the frame is **rejected**, not scored low — that is
  a flooded mask (white receipt on a white table), and returning corners
  around the whole photograph dresses "I could not tell" up as an answer.
- Corners come back as **fractions** of the image, because detection runs on a
  320px downscale whose dimensions the phone never learns.
- It is **uncalibrated against real receipts.** The unit tests use generated
  images and assert relationships, not accuracy rates. There is no corpus of
  photographs with hand-marked corners to measure against, and none is
  claimed. The three fixes above were found against fixtures, which means
  fixtures are also the limit of what is known to work.

---

## 5. Verification status — read this before writing results

### Automated

| Suite | Covers |
|---|---|
| `backend/tests/unit/pageSeams.test.ts` | seam finding, de-overlapping, and the arithmetic that decides whether to use it (13 tests) |
| `backend/tests/unit/edgeDetection.test.ts` | detection on a dark ground, a *printed* sheet, a dark receipt on a pale table, the background-ring regression, fractional output, the white-on-white failure, small specks, undecodable bytes (9) |
| `backend/tests/unit/imageQuality.test.ts` | the dimension check added for this work (4 new) |
| `backend/tests/integration/multiPageReceipt.test.ts` | overlapping sections end to end, including the case where dropping the overlap is **refused** (5 new) |
| `mobile/tests/receiptCapture.test.ts` | crop geometry, section ceiling, ordering, fraction→pixel conversion, detection fallbacks (24) |

### Not automated, and cannot be here

**Mobile still has no render harness** — 135 tests, none mount a component
(`multi-page-receipts-plan.md` §8). Everything below is verifiable **only by
hand on a physical Android device**, and results must be reported as manual
testing, not as suite coverage:

- camera permission states (granted / denied / permanently denied)
- camera initialisation and preview teardown on leaving the screen
- torch control
- shutter locking under a double tap
- capture preview, zoom, retake
- corner dragging, rotation, reset, apply
- section add / delete / reorder, and the eight-section ceiling
- cancel behaviour, gallery fallback
- failed upload and retry
- app backgrounding mid-session

### Physical-device matrix still to run

Short receipt · long receipt · narrow thermal · crumpled · faded · dark
background · light background · flash on/off · poor lighting · three or more
overlapping sections · network interruption · backgrounding during upload.

`docs/PROGRESS-REPORT.md` §88 already lists physical Android camera capture as
unverified. **That remains true** and this work does not change it.

---

## 6. Deferred, and why

| Deferred | Reason |
|---|---|
| Real-time edge outline | Needs per-frame analysis → native module → development build |
| Automatic shutter | Same |
| True perspective correction | Needs a homography resample; no Expo Go module provides one |
| On-device OCR / ML Kit | Unchanged from the original decision |
| Frame-coverage warning ("receipt too small in frame") | Would need the detector to be trusted enough to gate on, and it is uncalibrated |
| Render harness for mobile | Named here as the prerequisite it is, rather than left to surface at UAT |
