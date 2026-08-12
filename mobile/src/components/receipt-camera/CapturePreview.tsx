import { useState } from "react";
import { Image, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, T } from "../ui";
import { ACCENT, brand, font, ink, radius, space, typeScale } from "../../theme/tokens";
import { DetectedOutline } from "./DetectedOutline";
import {
  canAddSection,
  fitImageInBox,
  MAX_SECTIONS,
  shouldPreselectCorners,
  type Corners,
  type Point,
  type SectionQuality,
} from "../../lib/receiptCapture";

/**
 * The photograph, before it becomes a section.
 *
 * THE POINT OF THIS SCREEN IS THAT IT UPLOADS NOTHING. The old flow sent the
 * image the instant the system camera returned it, which meant a thumb over
 * the lens cost a full OCR pass, possibly a vision call, and a set of wrong
 * figures the owner then had to notice and undo. Here a bad photograph is
 * discarded with one tap and never reaches the server at all.
 *
 * The readability check is the one thing that DOES talk to the server before
 * approval, and deliberately: it is a separate endpoint that runs no OCR,
 * writes no row and stores no file (see the controller's own note on
 * /records/receipts/quality-check). Paying for that here is what lets the
 * warning below appear while the receipt is still in the owner's hand.
 */
export function CapturePreview({
  uri,
  imageWidth,
  imageHeight,
  detectedCorners,
  edgeConfidence,
  quality,
  checkingQuality,
  capturedCount,
  onRetake,
  onCrop,
  onCropToDetected,
  onUse,
  onUseAndFinish,
  busy,
}: {
  uri: string;
  imageWidth: number;
  imageHeight: number;
  /** Where the server thinks the receipt is, in image pixels. Null if unknown. */
  detectedCorners: Corners | null;
  edgeConfidence: number | null;
  quality: SectionQuality | null;
  checkingQuality: boolean;
  /** Sections already approved, not counting this one. */
  capturedCount: number;
  onRetake: () => void;
  onCrop: () => void;
  /** Applies the detected outline as-is, without opening the editor. */
  onCropToDetected: (corners: Corners) => void;
  onUse: () => void;
  onUseAndFinish: () => void;
  busy: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const [zoomed, setZoomed] = useState(false);

  /*
   * Zoom via a ScrollView sized larger than its viewport, rather than a pinch
   * gesture. `maximumZoomScale` is iOS-only and the presentation device is
   * Android, and a real pinch handler here would be a third gesture competing
   * with the two scroll axes for the same touches. Tapping to double the
   * image and panning it with the scroll view is less clever and works
   * identically on both platforms — which is what matters for a control whose
   * whole job is letting someone check whether print is legible.
   */
  const canvasWidth = zoomed ? width * 2 : width;
  const canvasHeight = zoomed ? (height - 220) * 2 : height - 220;

  // The same fit the crop editor uses, so the outline drawn here and the crop
  // cut there describe the same rectangle. See fitImageInBox.
  const fit = fitImageInBox(imageWidth, imageHeight, canvasWidth, canvasHeight);
  const toScreen = (p: Point) => ({ x: p.x * fit.scale + fit.offsetX, y: p.y * fit.scale + fit.offsetY });

  /*
   * Whether to offer the one-tap crop.
   *
   * The same floor the crop editor uses to decide whether to PRESELECT the
   * detected corners — one rule, one constant. Below it the outline is not
   * drawn and the button is not offered, because an outline around the wrong
   * thing invites a tap that crops away the receipt.
   */
  const detectionTrusted = detectedCorners !== null && shouldPreselectCorners(edgeConfidence);

  return (
    <View style={{ flex: 1, backgroundColor: ink[900] }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: space.sm,
        }}
      >
        <T variant="title" style={{ color: "#ffffff" }}>
          {capturedCount === 0 ? "Check this photo" : `Section ${capturedCount + 1}`}
        </T>
        <Pressable
          onPress={() => setZoomed((z) => !z)}
          accessibilityRole="button"
          accessibilityLabel={zoomed ? "Fit the whole photo on screen" : "Zoom in to check the print"}
          hitSlop={10}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          <Ionicons name={zoomed ? "contract-outline" : "expand-outline"} size={16} color={brand[400]} />
          <T style={{ color: brand[400], fontSize: typeScale.caption, fontFamily: font.sansSemibold }}>
            {zoomed ? "Fit" : "Zoom"}
          </T>
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ width: canvasWidth, height: canvasHeight }}
        maximumZoomScale={3}
        minimumZoomScale={1}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        horizontal={false}
        bouncesZoom
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ width: canvasWidth }}>
          <View style={{ width: canvasWidth, height: canvasHeight }}>
            <Image
              source={{ uri }}
              style={{ width: canvasWidth, height: canvasHeight }}
              // `contain` while fitted so nothing is cropped out of the check
              // itself; `cover` once zoomed, because at 2x the owner is looking
              // at a region rather than the whole page.
              resizeMode={zoomed ? "cover" : "contain"}
              accessibilityRole="image"
              accessibilityLabel="The section you just photographed"
              accessibilityIgnoresInvertColors
            />

            {/*
              The detected receipt, drawn over the photograph.

              Only while FITTED. Once zoomed the image is `cover`-cropped and
              the fit arithmetic below no longer describes where the pixels
              landed — an outline drawn from it would sit convincingly in the
              wrong place, which is worse than no outline. Zooming is for
              reading print anyway, not for judging edges.
            */}
            {detectionTrusted && !zoomed ? (
              <DetectedOutline corners={detectedCorners!} toScreen={toScreen} thickness={2.5} />
            ) : null}
          </View>
        </ScrollView>
      </ScrollView>

      <View style={{ padding: space.lg, gap: space.sm }}>
        {/*
          Warnings sit above the buttons, not inside them: the owner should
          read the reason before the action, and a button whose label changes
          because of a measurement is a button whose meaning is unstable.
        */}
        {/*
          One warning at a time, blur first. Both can be true of the same
          photograph, and stacking two cautions above the buttons turns a
          useful nudge into a wall of text that gets scrolled past — which is
          how a warning stops working. Blur leads because it is the one a
          retake reliably fixes.
        */}
        {checkingQuality ? (
          <Notice tone="neutral" icon="hourglass-outline" text="Checking how readable this is…" />
        ) : quality?.tooBlurredToTrust ? (
          <Notice
            tone="warning"
            icon="alert-circle-outline"
            text="This photo may be blurry. Retake it for a better reading, or continue anyway."
          />
        ) : quality?.tooSmallToRead ? (
          <Notice
            tone="warning"
            icon="alert-circle-outline"
            text="This image is small, so fine print may not come through. Photograph the receipt directly if you can."
          />
        ) : null}

        {!canAddSection(capturedCount + 1) ? (
          <Notice
            tone="neutral"
            icon="information-circle-outline"
            text={`This is section ${MAX_SECTIONS} of ${MAX_SECTIONS}, the most one receipt can hold.`}
          />
        ) : null}

        {/*
          The detection result, offered rather than applied.

          A found receipt is the common case and cropping to it is nearly
          always what the owner wants, so it gets one tap — but they have
          already SEEN the outline over the photograph above, which is what
          makes a one-tap crop safe rather than a surprise. "Adjust" opens the
          editor on the same corners for the times it is close but not right.
        */}
        {detectionTrusted ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              alignSelf: "center",
              paddingBottom: space.xs,
            }}
          >
            <Ionicons name="scan-outline" size={14} color={brand[400]} />
            <T style={{ color: "rgba(255,255,255,0.7)", fontSize: 11.5 }}>
              FinSight found the receipt inside the outline.
            </T>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Retake" variant="secondary" onPress={onRetake} disabled={busy} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={detectionTrusted ? "Adjust crop" : "Crop"}
              variant="secondary"
              onPress={onCrop}
              disabled={busy}
            />
          </View>
        </View>

        {detectionTrusted ? (
          <Button
            title="Crop to the receipt"
            variant="brand"
            onPress={() => onCropToDetected(detectedCorners!)}
            disabled={busy}
          />
        ) : null}

        {/*
          Two ways forward, because a receipt that fitted in one photograph is
          the common case and must not be made to walk through a
          multi-section interface to get scanned. "Use and finish" is the
          one-photo path in a single tap; "Add another section" is the long
          receipt.
        */}
        <Button
          title={capturedCount === 0 ? "Use this photo and scan" : `Scan all ${capturedCount + 1} sections`}
          variant="primary"
          onPress={onUseAndFinish}
          loading={busy}
        />
        {canAddSection(capturedCount + 1) ? (
          <Button title="Add another section" variant="brand" onPress={onUse} disabled={busy} />
        ) : null}
      </View>
    </View>
  );
}

function Notice({
  tone,
  icon,
  text,
}: {
  tone: "warning" | "neutral";
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}) {
  const color = tone === "warning" ? ACCENT.fill : "rgba(255,255,255,0.7)";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        backgroundColor: tone === "warning" ? "rgba(245,165,36,0.12)" : "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderColor: tone === "warning" ? "rgba(245,165,36,0.35)" : "rgba(255,255,255,0.12)",
        borderRadius: radius.md,
        padding: space.md,
      }}
    >
      <Ionicons name={icon} size={16} color={color} style={{ marginTop: 1 }} />
      <T style={{ flex: 1, fontSize: 12.5, lineHeight: 18, color: tone === "warning" ? "#ffe6b8" : "rgba(255,255,255,0.75)" }}>
        {text}
      </T>
    </View>
  );
}
