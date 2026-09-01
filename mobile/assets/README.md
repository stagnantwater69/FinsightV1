# Mobile asset provenance

The Home greeting uses the transparent PNG sequence in `greeting-frames/` at
runtime. The frames are explicitly imported by `src/lib/greetingFrames.ts` and
were produced with `scripts/extract-greeting-frames.py` after video cropping
and scaling.

The following source/reference exports are intentionally retained even though
Expo does not import them at runtime:

- `animatedgreeting.mp4` and `greetinganimation.mp4` preserve the two greeting
  animation exports used while selecting and regenerating the frame sequence;
- `greeting.png` preserves the static greeting artwork and its measured crop;
- `FAB.png` is the runtime Ask FinSight floating-action artwork.

Do not replace or remove a source export without regenerating the frame
sequence and running the mobile typecheck and tests. Real customer images and
receipt photographs must never be stored in this directory.

## Mascot poses

`mascot/` has its own note — read `mascot/README.md` before touching anything in
there. The short version: the poses are **not** transparent despite what that
manifest asks for, background removal was tried on a representative pose and
rejected (halo, baked contact shadow, pale background art), and the 25 poses the
app actually references were downscaled to a 512px longest edge, taking the
folder from 43.75 MB to 17.55 MB. `mascot/finsightlogo.png` is deliberately
excluded from that downscale because the launch art below is derived from it.

## Launch art

`icon.png`, `android-icon-foreground.png`, `android-icon-background.png`,
`splash-icon.png` and `favicon.png` are **derived**, not hand-drawn. The single
source is `mascot/finsightlogo.png` — the same owl badge the web app uses — and
each derivative is the badge's alpha bounding box, resized with Lanczos and
centred on a square canvas:

| File | Canvas | Badge width | Plate |
|---|---|---|---|
| `icon.png` | 1024 | 78% | `#052624`, opaque (iOS rejects alpha in an app icon) |
| `android-icon-foreground.png` | 1024 | 62% (inside the 66% adaptive safe zone) | transparent |
| `android-icon-background.png` | 1024 | — | `#052624` |
| `splash-icon.png` | 1024 | 86% | transparent |
| `favicon.png` | 64 | 94% | transparent |

`#052624` is `brand[950]`. Why the same plate on the icon and the splash, and
why it is fixed rather than themed, is argued in `app.config.ts`.

These are native resources, so they are not part of the JS bundle and are never
decoded by a screen; they are kept at full quality rather than quantised,
because banding in an app icon is exactly the defect the branding pass existed
to remove.

**Missing art, stated rather than faked:** there is no Android 13 *themed*
(monochrome) icon. It needs a flat single-colour silhouette that reads at
launcher size, and the owl badge does not reduce to one — its meaning is
carried by the glasses, the beak and the trend arrow, all of which disappear in
a silhouette. The Expo template's `android-icon-monochrome.png` was removed
rather than left in place pretending to be FinSight's. Until a silhouette mark
is drawn, Android 13+ falls back to the full-colour adaptive icon, which is the
correct behaviour, not a bug.
