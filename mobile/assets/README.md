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
