import { View } from "react-native";
import { brand } from "../../theme/tokens";
import type { Corners, Point } from "../../lib/receiptCapture";

/**
 * The quadrilateral drawn around a detected receipt.
 *
 * WHY IT IS DRAWN AT ALL. Detection that only moves some handles on a screen
 * the owner may never open is detection nobody can see working — and when it
 * gets a receipt wrong, silently starting the crop somewhere odd is worse
 * than saying nothing. Drawing the outline over the photograph the instant it
 * is taken turns it into a claim the owner can check at a glance: that is the
 * receipt, or it plainly is not.
 *
 * Four rotated bars rather than an SVG path. react-native-svg is in the app,
 * but a drawing surface layered over the image is another view competing for
 * the same touches in the crop editor, and four absolutely-positioned lines
 * have no such problem. `transformOrigin` is what makes each bar run from one
 * corner to the next instead of pivoting about its own middle.
 */
export function DetectedOutline({
  corners,
  toScreen,
  thickness = 2,
  color = brand[400],
}: {
  corners: Corners;
  /** Maps a point in IMAGE pixels to a point in the drawing box. */
  toScreen: (p: Point) => Point;
  thickness?: number;
  color?: string;
}) {
  const points = CORNER_ORDER.map((key) => toScreen(corners[key]));

  return (
    <>
      {points.map((from, i) => {
        const to = points[(i + 1) % points.length]!;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        // A zero-length edge happens while two handles sit on top of each
        // other mid-drag; rotating a zero-width bar is harmless but Math.atan2
        // of (0,0) is 0, which would draw a stray horizontal tick.
        if (length < 0.5) return null;
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

        return (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: from.x,
              top: from.y,
              width: length,
              height: thickness,
              backgroundColor: color,
              transform: [{ translateY: -thickness / 2 }, { rotateZ: `${angle}deg` }],
              transformOrigin: "left center",
            }}
          />
        );
      })}
    </>
  );
}

export const CORNER_ORDER = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
