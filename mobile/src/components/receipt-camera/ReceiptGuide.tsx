import { Image, useWindowDimensions, View } from "react-native";
import { T } from "../ui";
import { font, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { guideRect, overlapGuideHeight } from "../../lib/receiptCapture";

/**
 * The receipt-shaped frame drawn over the live preview, and — from the second
 * section onwards — the ghost of where the previous one ended.
 *
 * SIZED FROM THE SCREEN, not from constants. The first version used fixed
 * insets picked against one phone, inside a preview that still had a
 * navigation header and a tab bar taking bites out of it. What that produced
 * on a real device was a small square box floating in a tall viewfinder,
 * which told the owner the receipt had to fit in a quarter of the screen. It
 * does not, and a frame that makes someone step back to fit the paper inside
 * it throws away the resolution OCR needs. See `guideRect`.
 *
 * PURELY ADVISORY, all of it. Nothing here measures what is in the frame or
 * refuses a capture that ignores it, and — the part that matters most — the
 * photograph taken is the WHOLE sensor frame, never just the framed area.
 * The frame is somewhere to put the paper so it lands square and fills the
 * picture; the cropping happens afterwards, on the review screen, where it
 * can be seen and undone. The receipts this app is for are frequently
 * crumpled, faded, or narrower than any frame you would draw, and a guide
 * that gated capture would gate exactly the receipts that most need
 * photographing.
 *
 * The frame is drawn as four scrim panels around a hole rather than as a
 * bordered box, because the hole has to stay genuinely transparent — a `View`
 * with a translucent background would tint the preview underneath.
 */
export function ReceiptGuide({
  /** Sections already captured. 0 means this is the first. */
  capturedCount,
  /** The previous section's image, ghosted at the top as an alignment cue. */
  previousUri,
  /** False once the owner taps "Hide guide" — see ReceiptCamera. */
  showOverlapGuide,
}: {
  capturedCount: number;
  previousUri: string | null;
  showOverlapGuide: boolean;
}) {
  const t = useTheme();
  const { brand } = t;
  const { width, height } = useWindowDimensions();
  const rect = guideRect(width, height);

  const isContinuation = capturedCount > 0;
  const showGhost = isContinuation && showOverlapGuide && previousUri !== null;

  return (
    <View style={ABSOLUTE_FILL} pointerEvents="none">
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width: rect.side, backgroundColor: SCRIM }} />

        <View style={{ flex: 1 }}>
          {/* Headroom: status bar, close button, and the instruction. */}
          <View style={{ height: rect.top, backgroundColor: SCRIM }} />

          {/*
            The frame itself. `overflow: "hidden"` keeps the ghost's rounded
            top from bleeding past the dashed border.
          */}
          <View
            style={{
              flex: 1,
              borderWidth: 2,
              borderStyle: "dashed",
              borderColor: brand[400],
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            {showGhost ? (
              <View style={{ height: `${overlapGuideHeight() * 100}%` }}>
                {/*
                  The previous section's own photograph, faded — not a generic
                  band. An abstract stripe would tell the owner that something
                  goes here; their own last few lines of print tell them WHICH
                  lines to line up, which is the only question this answers.
                */}
                <Image
                  source={{ uri: previousUri! }}
                  style={{ width: "100%", height: "100%", opacity: 0.42 }}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    borderBottomWidth: 1,
                    borderStyle: "dashed",
                    borderColor: "rgba(255,255,255,0.65)",
                  }}
                />
              </View>
            ) : null}
          </View>

          {/* Footroom: the section strip and the shutter. */}
          <View style={{ height: rect.bottom, backgroundColor: SCRIM }} />
        </View>

        <View style={{ width: rect.side, backgroundColor: SCRIM }} />
      </View>

      {/* Brackets, drawn over the dashed frame's own corners. */}
      <Corner corner="tl" top={rect.top} left={rect.side} />
      <Corner corner="tr" top={rect.top} right={rect.side} />
      <Corner corner="bl" bottom={rect.bottom} left={rect.side} />
      <Corner corner="br" bottom={rect.bottom} right={rect.side} />
    </View>
  );
}

/**
 * Sits above the frame rather than inside it, so the words never cover the
 * paper the owner is trying to line up.
 */
export function GuideInstruction({ text }: { text: string }) {
  return (
    <T
      style={{
        color: "rgba(255,255,255,0.94)",
        fontSize: typeScale.label,
        lineHeight: 19,
        fontFamily: font.sansMedium,
        textAlign: "center",
        maxWidth: 280,
        alignSelf: "center",
        // A shadow rather than a plate behind the text: the scrim is already
        // dark, and a second panel on top of it reads as a dialog the owner
        // has to dismiss.
        textShadowColor: "rgba(0,0,0,0.6)",
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
      }}
    >
      {text}
    </T>
  );
}

const SCRIM = "rgba(26,32,34,0.5)";

const ABSOLUTE_FILL = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

/**
 * One bracket. Brighter and thicker than the dashed frame it sits on, because
 * the corners are what the eye actually uses to judge whether the paper is
 * square in the frame.
 */
function Corner({
  corner,
  top,
  bottom,
  left,
  right,
}: {
  corner: "tl" | "tr" | "bl" | "br";
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}) {
  const t = useTheme();
  const { brand } = t;
  const size = 26;
  const thickness = 3;
  const isTop = corner === "tl" || corner === "tr";
  const isLeft = corner === "tl" || corner === "bl";

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top,
        bottom,
        left,
        right,
        width: size,
        height: size,
        borderColor: brand[400],
        borderTopWidth: isTop ? thickness : 0,
        borderBottomWidth: isTop ? 0 : thickness,
        borderLeftWidth: isLeft ? thickness : 0,
        borderRightWidth: isLeft ? 0 : thickness,
        borderTopLeftRadius: corner === "tl" ? 12 : 0,
        borderTopRightRadius: corner === "tr" ? 12 : 0,
        borderBottomLeftRadius: corner === "bl" ? 12 : 0,
        borderBottomRightRadius: corner === "br" ? 12 : 0,
      }}
    />
  );
}
