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
there. The short version: the contextual poses are **not** transparent despite
what that manifest asks for, background removal was tried on a representative
pose and rejected (halo, baked contact shadow, pale background art), and the 25
contextual poses the app references were downscaled to a 512px longest edge.
The folder is now 18.25 MB after adding the transparent cross-platform mark.
`mascot/newmascotlogo.png` is the in-app mark and Expo web favicon source;
`mascot/finsightlogo.png` remains the source for native launch art.

## Launch art

`icon.png`, `android-icon-foreground.png`, `android-icon-background.png`,
`splash-icon.png` and `favicon.png` are **derived**, not hand-drawn. The native
set remains legacy: the icon, adaptive foreground and splash use
`mascot/finsightlogo.png`, while the adaptive background remains the fixed brand
plate. `favicon.png` was regenerated from the transparent
`mascot/newmascotlogo.png` used inside the web and mobile apps. Each illustrated
derivative uses its source's alpha bounding box, resized with Lanczos and centred
on a square canvas:

| File | Canvas | Mark width | Source / plate |
|---|---|---|---|
| `icon.png` | 1024 | 78% | legacy mark on `#052624`, opaque (iOS rejects alpha in an app icon) |
| `android-icon-foreground.png` | 1024 | 62% (inside the 66% adaptive safe zone) | legacy mark, transparent |
| `android-icon-background.png` | 1024 | — | `#052624` |
| `splash-icon.png` | 1024 | 86% | legacy mark, transparent |
| `favicon.png` | 64 | 91% | current mark, transparent |

`#052624` is `brand[950]`. Why the same plate on the icon and the splash, and
why it is fixed rather than themed, is argued in `app.config.ts`.

The four native resources are not part of the JS bundle and are never decoded
by a screen; they are kept at full quality rather than quantised, because
banding in an app icon is exactly the defect the branding pass existed to
remove. The favicon is an Expo web asset.

**Missing art, stated rather than faked:** there is no Android 13 *themed*
(monochrome) icon. It needs a flat single-colour silhouette that reads at
launcher size, and the owl badge does not reduce to one — its meaning is
carried by the glasses, the beak and the trend arrow, all of which disappear in
a silhouette. The Expo template's `android-icon-monochrome.png` was removed
rather than left in place pretending to be FinSight's. Until a silhouette mark
is drawn, Android 13+ falls back to the full-colour adaptive icon, which is the
correct behaviour, not a bug.
