# Mascot asset manifest

Drop generated mascot illustrations here, one file per pose, using the filenames below.
The same structure (folders + filenames) is mirrored in `mobile/assets/mascot/` so both
platforms stay in sync and it's obvious at a glance which states are covered where.

Recommended format: PNG or WebP, transparent background, ~1024x1024 source (web can use
full-res; export a smaller/compressed copy for the mobile folder).

> **The art in this folder does not meet that spec.** What is actually here, and
> what still needs doing, is recorded in "What is actually in this folder" below.
> Read that before wiring a new pose or assuming a file is cut out.

## What is actually in this folder

### The background is not transparent, and could not be made so here

Every pose is **opaque RGB on a near-white plate** (corners measured at 249–255
on all three channels), not the transparent art this manifest asks for. On a
Dark-mode screen each one is a bright rectangle. `src/components/MascotState.tsx`
mitigates that by framing the art on a rounded plate of the same measured colour
(`mascotPlate`, `#fdfdfd`), with a `plate={false}` escape hatch for whenever real
cut-out art arrives.

Removing the background here was **attempted and rejected**, not skipped. A
corner-seeded flood fill (tolerance: min channel ≥ 235, so the owl's own white
feathers, eye whites and pale props are not keyed out) was run on
`01-onboarding/emptydashboard.png` and `04-empty-states/nosalesrecords.png` and
the results inspected. It fails in three ways that no threshold fixes:

1. **A white halo.** The art is antialiased against white, so the blend pixels
   along every outline sit between the stroke colour and the background. A hard
   key leaves them opaque and they read as a light rim on a dark screen — 80.5%
   of the cut-out boundary on `emptydashboard`, 32.1% on `nosalesrecords`.
2. **Baked-in drop shadows.** Each owl sits on a soft grey contact shadow that
   is part of the raster. It survives the key and becomes a floating smudge.
3. **Background art that is itself pale.** `emptydashboard`'s ghosted receipt is
   a near-white fill inside a grey outline; the fill keys out and the outline is
   left hanging. Several poses also use black line-art (`nosalesrecords`' chart
   axes) that has no contrast on a dark surface even when the key is perfect.

**The real fix is a re-export from source** by whoever produced the art: a true
alpha channel, no baked contact shadow, and no black-on-white line work that
depends on the plate for contrast. Nothing in the app can recover that from a
flattened raster. When it lands, pass `plate={false}` and update this note.

Two poses have a further export defect worth fixing in the same pass:

- `02-authentication/forgotpassword.png` — the plate is a pale **green**
  (`#e1e8d1` at the corners), not near-white, and it has a visible border band
  plus a dark mark clipped at the bottom edge. Framed on the fixed `#fdfdfd`
  plate it shows a seam.
- `02-authentication/passwordresetsuccesss.png`, `session expired.png` and
  `03-loading-processing/longrunningprocess.png` are warm off-white (down to
  `#f9f6f3`) rather than matching the others.

### The referenced poses have been downscaled

The poses shipped at ~1254x1254 and 1.0–1.9 MB each while rendering at 64–104pt.
File size was the smaller half of it: a 1254x1254 PNG decodes to a ~6.3 MB
ARGB_8888 bitmap, which is a real out-of-memory risk on low-end Android.

The **25 poses actually referenced** by `src/components/MascotState.tsx` and
`src/components/tour/TourMascot.tsx` were resampled to a longest edge of **512px**
(Lanczos, aspect ratio preserved, never stretched, re-encoded as optimised
opaque RGB — the one file carrying a fully-opaque alpha channel lost it). 512
covers the largest placement (104pt) at a 4x device pixel ratio with headroom;
the 3x worst case needs 312px. **32.06 MB → 5.86 MB**, and ~6.3 MB → ~1.0 MB per
decoded bitmap.

`tests/mascotAssetBudget.test.ts` pins that: longest edge ≤ 512px, ≤ 400 KB per
file, and it fails if a pose gains an alpha channel — because that means the
re-export above has arrived and `plate={false}` should be adopted.

Not touched, each for a reason:

- **`finsightlogo.png`** (1024x1024, transparent) is the `brandMark` pose *and*
  the single source every launch icon, adaptive foreground and splash image is
  derived from — see `assets/README.md`. Shrinking it would degrade all of them.
  It is exempted by name in the budget test. Giving the mapper its own 512 copy
  is a sensible follow-up and a change to `MascotState.tsx`.
- **The eight unreferenced poses** — `02-authentication/successfullogin.png`,
  `failedlogin.png`, `session expired.png`, `Accountlocked,too many attempts.png`,
  `03-loading-processing/datasyncing.png`, `aigeneratinginsights.png`,
  `longrunningprocess.png`, `06-warnings/datamismatchfound.png` — are left at
  full resolution. Metro bundles by `require`, so they cost nothing at runtime,
  and they are the highest-fidelity copies left in the repo of art that may yet
  be wired in. Downscale each one when, and only when, it is referenced.

Folder total: **43.75 MB → 17.55 MB**; bundled art: **~6.4 MB**.

### Provenance

These are generated illustrations, flattened onto a white plate by the
generator. The pre-downscale originals are recoverable from git history
(`git show HEAD:mobile/assets/mascot/…`); there is no other master in the repo
and none in `web/` — `web/public/mascot/` holds only the logo and three small
WebP crops. If a full-resolution master matters, get it from whoever ran the
generator and store it outside the app bundle.

## 01-onboarding
- welcome-splash-screen
- sign-up-start
- business-profile-setup
- currency-region-selection
- permissions-request
- tutorial-feature-walkthrough
- onboarding-complete
- empty-dashboard-new-account

## 02-authentication
- login-screen-idle
- successful-login
- failed-login
- forgot-password
- password-reset-success
- 2fa-otp-prompt
- biometric-prompt
- account-locked-too-many-attempts
- session-expired
- logout-confirmation

## 03-loading-processing
- generic-loading-short
- long-running-process-report-build
- data-syncing
- uploading-file
- ocr-receipt-scanning-in-progress
- ai-analyzing-data
- ai-generating-insights
- page-app-first-load-splash

## 04-empty-states
- no-transactions-yet
- no-expense-records
- no-sales-records
- no-notifications
- no-search-results
- no-internet-connection

## 05-success
- transaction-added-successfully
- receipt-scanned-successfully
- import-completed
- report-generated
- goal-achieved
- budget-on-track
- data-backed-up
- settings-saved

## 06-warnings
- unusual-expense-detected
- possible-duplicate-found
- budget-almost-exceeded
- low-available-funds
- data-mismatch-found
- import-errors-found
- low-storage-space

## 07-errors
- something-went-wrong
- network-error
- file-upload-failed
- ocr-failed-to-read-receipt
- cannot-delete-record-in-use
- ai-service-unavailable
- permission-denied
- server-error-500

## 08-data-review-actions
- reviewing-record
- editing-record
- mark-as-duplicate
- mark-as-not-duplicate
- delete-record
- restore-record
- exporting-data
- sharing-report

## 09-navigation-discovery
- exploring-analytics
- discovering-insights
- using-search
- filtering-data
- sorting-data
- switching-business-profile
- opening-menu
- going-back

## 10-celebration-engagement
- streak-consistency-milestone
- level-up-badge-earned
- monthly-summary-ready
- thank-you-user-appreciation
- referral-success
- feedback-submitted
- anniversary-with-finsight
- seasonal-festive-general

## 11-help-support
- help-center
- contact-support
- chat-with-support
- faq-common-questions
- step-by-step-guide
- video-tutorial
- release-notes-whats-new
- feature-request
