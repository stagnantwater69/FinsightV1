# Receipt scan/capture screen redesign

Date: 2026-08-31
Status: approved, ready for implementation
Scope: `mobile/` only (`ScanReceiptScreen.tsx` and its `scanReceipt/` helpers). No backend, web, or ML Kit/native changes.

## Problem

Inspired by a look at Veryfi's own capture-demo app (a receipt-OCR API being evaluated purely as a reference, see `backend/tests/ocr-accuracy/veryfi-spike.ts`), the owner asked for FinSight's receipt capture flow to be redesigned with the same polish: a gallery option sitting right beside the capture action, and real animation during the wait states — not a static screen.

Two things constrain this from being a literal copy of Veryfi's screens:

1. **FinSight's capture engine is Google ML Kit Document Scanner, a native Android system screen FinSight does not render and cannot restyle.** There is no live viewfinder FinSight draws itself to put a gallery icon or zoom control "beside" — that decision (removing FinSight's own camera in favour of ML Kit) is deliberate and documented in `docs/receipt-camera.md` and the header comments of `ReceiptCamera.tsx`/`nativeReceiptScanner.ts`. This redesign does not reopen that decision.
2. **ML Kit already perspective-corrects and crops each page before handing it back.** Veryfi's screenshots show a manual crop/rotate/annotate toolbar; FinSight has no such feature today, and adding one would be new functionality, not a re-skin. Explicitly out of scope.

What's actually being redesigned is the two screens FinSight fully owns: the **pre-capture card** shown before/after the ML Kit modal, and the **OCR-wait state** during the server-side read.

## Decisions taken before design

1. **No manual crop/rotate/annotate.** ML Kit's own auto-correction stays the only correction step.
2. **The zero-pages "Add another section" state is untouched.** Only the very first landing card (reached with `pages.length === 0`) is redesigned.
3. **Landing behaviour changes: the card is shown first, not auto-launched past.** Today, arriving at `ScanReceiptScreen` auto-opens ML Kit immediately (`cameraOpen` starts `true`); cancelling or a scanner failure is the only way to ever see the pre-capture card. This flips: the card is now the actual mount-time state (`cameraOpen` starts `false`), so the gallery option is visible on arrival rather than one cancel away. One extra tap before the common case (camera) starts.
4. **Animation is scoped to one moment: the OCR "Reading the receipt…" wait**, not the ML Kit launch spinner and not general screen-transition motion — both were considered and explicitly deprioritised in favour of this one, highest-payoff spot (the app's slowest step, and the one closest to what Veryfi's own scan-line animation is covering).
5. **No new animation library.** The app has no Reanimated/Moti/Lottie dependency; every existing animation (`Skeleton.tsx`, `QuickActionMenu.tsx`, `GreetingHero.tsx`, etc.) uses the plain `Animated` API from `react-native`, gated by the shared `useReducedMotion()` hook (`mobile/src/lib/useReducedMotion.ts`). This redesign follows that exact pattern — no dependency added.

## Design

### 1. Pre-capture card

Replaces the current stacked pair (`ScanReceiptScreen.tsx:995-999`, "Open the camera" primary / "Choose from gallery" secondary, each full-width) with a horizontal row inside the existing `Card`:

- A large primary button, "Scan receipt" (`capturePage`), taking most of the row's width — same action as today's "Open the camera".
- A compact square icon-button immediately beside it — `image-outline` (Ionicons), calling the existing `pickPage()` — same gallery flow that exists today, just relocated and restyled from a full-width secondary `Button` to an icon button.
- Visual model for the icon button: same circular/square Pressable-with-Ionicons pattern already used for the filmstrip's remove-page control (`ScanReceiptScreen.tsx` ~927-949), sized to the app's `TAP` (44px) minimum touch target, themed via `t.surface`/`t.border` rather than the white-on-photo overlay styling that control uses (this one sits on a plain card, not over an image).
- Heading/helper copy above the row is unchanged.

`cameraOpen`'s initial state changes from `true` to `false` (was flipped to `true` unconditionally in the prior session's fix — see recent history in `ScanReceiptScreen.tsx`). Everything downstream — `onDone`, and `onCancel` revealing this same card — is already correct and untouched; only the mount-time default changes.

### 2. OCR "reading" animation

Today (`ScanReceiptScreen.tsx` ~878-888), the busy state during the server OCR read is:

```
Reading the receipt…
[skeleton bar 40%]
[skeleton bar 100%]
[skeleton bar 70%]
[skeleton bar 55%]
```

— generic bars with no visual connection to the actual receipt. New version:

- Show the first captured page's thumbnail (same `pages[0].uri` already used in the filmstrip) at a larger size than the filmstrip's 84×112 chip — large enough to read as "the document being processed", not a repeat of the small thumbnail strip below it.
- Overlay a thin horizontal line (2-3px, brand-colored, soft glow/shadow) that sweeps top-to-bottom on a loop via `Animated.loop`/`Animated.sequence` animating `translateY`, mirroring `Skeleton.tsx`'s existing loop structure (`useNativeDriver: true`).
- Gate with `useReducedMotion()`: when Reduce Motion is on, the line rests at a fixed position (roughly center) instead of sweeping — same fallback shape `SkeletonBox` already uses, not a new pattern.
- Keep the existing skeleton bars underneath the image, since they still communicate "these fields are about to fill in" — the image+scan-line is additive, not a replacement for that context.
- No new component library; this lives as a small addition inside `ScanReceiptScreen.tsx` or, if it grows past a few dozen lines, as a sibling to the existing `scanReceipt/` helper components (`ScanBand.tsx`, `ReviewSection.tsx`, etc.) — matching how that directory is already organised by concern.

## Out of scope

- Any change to `ReceiptCamera.tsx`, `nativeReceiptScanner.ts`, `receiptScannerLaunch.ts`, or the ML Kit integration itself.
- Manual crop, rotate, or annotate tooling.
- The "Add another section" (`pages.length > 0`) card state.
- Animation on the ML Kit launch spinner (`ScannerLaunchingState`) or general card/screen transition motion.
- Any web or backend change.

## Testing

- `mobile` unit tests already cover `launchReceiptScanner`/`receiptScannerLaunch.ts` state-machine logic and are unaffected (no change to that file).
- New coverage needed: a test (or update to existing `ScanReceiptScreen` tests, if any exist) asserting the screen mounts with the camera closed and the pre-capture card visible, rather than the camera modal open.
- Animation correctness (the sweep, the reduced-motion fallback) is not meaningfully unit-testable — verify visually per `CLAUDE.md`'s standing rule that mobile camera/UI behaviour needs physical-device (or emulator) verification, not a claimed test pass.
