/**
 * Fin's greeting wave, as a frame sequence.
 *
 * WHY FRAMES INSTEAD OF A VIDEO: assets/animatedgreeting.mp4 (kept in the
 * repo as the source) has no transparency, and none of the video codecs that
 * DO support alpha are usable here — WebM+VP9 alpha is not reliable across
 * Expo's video player, and HEVC-with-alpha is iOS-only. A transparent H.264
 * MP4 does not exist; the format has no alpha channel to give it. The only
 * way to get Fin floating over the greeting card with no background, on both
 * platforms, is to stop asking a video player to do it and play a sequence
 * of already-transparent images instead — the same technique animated GIFs
 * and old-school sprite animation both rest on.
 *
 * The close-up opening frames are intentionally omitted. The sequence starts
 * at source frame 34, once Fin fits cleanly inside the mascot box, and then
 * includes the rest of the wave, blink, and settling action. It plays on
 * repeat. The sequence does NOT wrap on its own — it opens closer to camera
 * than it closes — so the seam is crossfaded rather than cut; see
 * GREETING_WRAP_CROSSFADE_MS in greetingPlayback.ts, which owns the timings
 * and the frame arithmetic.
 *
 * HOW THESE WERE MADE: every 2nd source frame (24fps -> 12fps — halved
 * rather than thinned further, since a wave gesture reads as choppy at a
 * lower rate), each cropped to a centred 720x720 square matching what a
 * `cover` fit was already showing, downscaled to 320x320, and
 * background-removed with the same flood-fill-from-the-border technique used
 * for FAB.png (see that asset's history) — connected near-white pixels go
 * transparent, enclosed whites (the face, the belly badge) are left alone,
 * and the boundary is feathered so there is no hard white ring. Then
 * palette-quantized to 64 colours: this is flat cartoon art, which
 * compresses far better as an indexed PNG than as truecolour+alpha, with no
 * visible banding at this size (32 colours showed dithering noise in the
 * flat badge fill; 128 was not visibly better than 64).
 *
 * The background-removal and quantization stage is reproducible through
 * scripts/extract-greeting-frames.py after FFmpeg performs the crop and scale.
 */

export const GREETING_FRAMES = [
  require("../../assets/greeting-frames/greeting_017.png"),
  require("../../assets/greeting-frames/greeting_018.png"),
  require("../../assets/greeting-frames/greeting_019.png"),
  require("../../assets/greeting-frames/greeting_020.png"),
  require("../../assets/greeting-frames/greeting_021.png"),
  require("../../assets/greeting-frames/greeting_022.png"),
  require("../../assets/greeting-frames/greeting_023.png"),
  require("../../assets/greeting-frames/greeting_024.png"),
  require("../../assets/greeting-frames/greeting_025.png"),
  require("../../assets/greeting-frames/greeting_026.png"),
  require("../../assets/greeting-frames/greeting_027.png"),
  require("../../assets/greeting-frames/greeting_028.png"),
  require("../../assets/greeting-frames/greeting_029.png"),
  require("../../assets/greeting-frames/greeting_030.png"),
  require("../../assets/greeting-frames/greeting_031.png"),
  require("../../assets/greeting-frames/greeting_032.png"),
  require("../../assets/greeting-frames/greeting_033.png"),
  require("../../assets/greeting-frames/greeting_034.png"),
  require("../../assets/greeting-frames/greeting_035.png"),
  require("../../assets/greeting-frames/greeting_036.png"),
  require("../../assets/greeting-frames/greeting_037.png"),
  require("../../assets/greeting-frames/greeting_038.png"),
  require("../../assets/greeting-frames/greeting_039.png"),
  require("../../assets/greeting-frames/greeting_040.png"),
  require("../../assets/greeting-frames/greeting_041.png"),
  require("../../assets/greeting-frames/greeting_042.png"),
  require("../../assets/greeting-frames/greeting_043.png"),
  require("../../assets/greeting-frames/greeting_044.png"),
  require("../../assets/greeting-frames/greeting_045.png"),
  require("../../assets/greeting-frames/greeting_046.png"),
  require("../../assets/greeting-frames/greeting_047.png"),
  require("../../assets/greeting-frames/greeting_048.png"),
  require("../../assets/greeting-frames/greeting_049.png"),
  require("../../assets/greeting-frames/greeting_050.png"),
  require("../../assets/greeting-frames/greeting_051.png"),
  require("../../assets/greeting-frames/greeting_052.png"),
  require("../../assets/greeting-frames/greeting_053.png"),
  require("../../assets/greeting-frames/greeting_054.png"),
  require("../../assets/greeting-frames/greeting_055.png"),
  require("../../assets/greeting-frames/greeting_056.png"),
  require("../../assets/greeting-frames/greeting_057.png"),
  require("../../assets/greeting-frames/greeting_058.png"),
  require("../../assets/greeting-frames/greeting_059.png"),
  require("../../assets/greeting-frames/greeting_060.png"),
  require("../../assets/greeting-frames/greeting_061.png"),
  require("../../assets/greeting-frames/greeting_062.png"),
  require("../../assets/greeting-frames/greeting_063.png"),
  require("../../assets/greeting-frames/greeting_064.png"),
  require("../../assets/greeting-frames/greeting_065.png"),
  require("../../assets/greeting-frames/greeting_066.png"),
  require("../../assets/greeting-frames/greeting_067.png"),
  require("../../assets/greeting-frames/greeting_068.png"),
  require("../../assets/greeting-frames/greeting_069.png"),
  require("../../assets/greeting-frames/greeting_070.png"),
  require("../../assets/greeting-frames/greeting_071.png"),
  require("../../assets/greeting-frames/greeting_072.png"),
  require("../../assets/greeting-frames/greeting_073.png"),
  require("../../assets/greeting-frames/greeting_074.png"),
  require("../../assets/greeting-frames/greeting_075.png"),
  require("../../assets/greeting-frames/greeting_076.png"),
  require("../../assets/greeting-frames/greeting_077.png"),
  require("../../assets/greeting-frames/greeting_078.png"),
  require("../../assets/greeting-frames/greeting_079.png"),
  require("../../assets/greeting-frames/greeting_080.png"),
  require("../../assets/greeting-frames/greeting_081.png"),
  require("../../assets/greeting-frames/greeting_082.png"),
  require("../../assets/greeting-frames/greeting_083.png"),
  require("../../assets/greeting-frames/greeting_084.png"),
  require("../../assets/greeting-frames/greeting_085.png"),
  require("../../assets/greeting-frames/greeting_086.png"),
  require("../../assets/greeting-frames/greeting_087.png"),
  require("../../assets/greeting-frames/greeting_088.png"),
  require("../../assets/greeting-frames/greeting_089.png"),
  require("../../assets/greeting-frames/greeting_090.png"),
  require("../../assets/greeting-frames/greeting_091.png"),
  require("../../assets/greeting-frames/greeting_092.png"),
  require("../../assets/greeting-frames/greeting_093.png"),
  require("../../assets/greeting-frames/greeting_094.png"),
  require("../../assets/greeting-frames/greeting_095.png"),
  require("../../assets/greeting-frames/greeting_096.png"),
  require("../../assets/greeting-frames/greeting_097.png"),
  require("../../assets/greeting-frames/greeting_098.png"),
  require("../../assets/greeting-frames/greeting_099.png"),
  require("../../assets/greeting-frames/greeting_100.png"),
  require("../../assets/greeting-frames/greeting_101.png"),
  require("../../assets/greeting-frames/greeting_102.png"),
  require("../../assets/greeting-frames/greeting_103.png"),
  require("../../assets/greeting-frames/greeting_104.png"),
  require("../../assets/greeting-frames/greeting_105.png"),
  require("../../assets/greeting-frames/greeting_106.png"),
  require("../../assets/greeting-frames/greeting_107.png"),
  require("../../assets/greeting-frames/greeting_108.png"),
  require("../../assets/greeting-frames/greeting_109.png"),
  require("../../assets/greeting-frames/greeting_110.png"),
  require("../../assets/greeting-frames/greeting_111.png"),
  require("../../assets/greeting-frames/greeting_112.png"),
  require("../../assets/greeting-frames/greeting_113.png"),
  require("../../assets/greeting-frames/greeting_114.png"),
  require("../../assets/greeting-frames/greeting_115.png"),
  require("../../assets/greeting-frames/greeting_116.png"),
  require("../../assets/greeting-frames/greeting_117.png"),
  require("../../assets/greeting-frames/greeting_118.png"),
  require("../../assets/greeting-frames/greeting_119.png"),
];
