import { useMemo, useRef, useState } from "react";
import { Image, PanResponder, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, T } from "../ui";
import { brand, ink, radius, space } from "../../theme/tokens";
import { CORNER_ORDER, DetectedOutline } from "./DetectedOutline";
import {
  clampToImage,
  cornersToCropRect,
  fitImageInBox,
  fullFrameCorners,
  initialCorners,
  type Corners,
  type Point,
} from "../../lib/receiptCapture";

/**
 * Four draggable corners over a captured section.
 *
 * BUILT BEFORE AUTOMATIC EDGE DETECTION, ON PURPOSE. Detection is an
 * enhancement that either works or does not; this is the thing underneath it
 * that always works. A detector that finds nothing on a crumpled thermal
 * receipt against a dark counter — which is most of what this app is for —
 * lands the owner here with sensible default handles rather than in a failure
 * state, and a detector that finds the WRONG quadrilateral lands them here
 * with handles to drag. Neither outcome can lose them the photograph.
 *
 * WHAT IT DOES NOT DO. The crop applied is the axis-aligned bounding box of
 * the four corners, not the quadrilateral itself — cutting along an arbitrary
 * quad is perspective correction, which needs a homography resample that
 * expo-image-manipulator cannot perform and that Expo Go has no native module
 * to provide. Rather than pretend, the editor SHOWS the bounding box: the lit
 * region is exactly what will be kept, and the polygon drawn over it is there
 * to help place the corners against a receipt that sits askew. Four handles
 * still beat two for that, because a tilted receipt puts its corners at four
 * different offsets and a two-handle rectangle can only guess at them.
 *
 * Rotation is handled by re-rendering the file rather than by transforming
 * coordinates. It is a rare action, a round trip through the manipulator
 * costs a moment, and the alternative — keeping corner geometry correct
 * across a 90° turn — is exactly the kind of arithmetic that goes quietly
 * wrong and crops a receipt through its own total.
 */
export function CropEditor({
  uri,
  imageWidth,
  imageHeight,
  detectedCorners,
  edgeConfidence,
  onCancel,
  onRotate,
  onApply,
  busy,
}: {
  uri: string;
  imageWidth: number;
  imageHeight: number;
  /** From the edge detector, or null when it did not run or found nothing. */
  detectedCorners: Corners | null;
  edgeConfidence: number | null;
  onCancel: () => void;
  /** Rotates the underlying file 90° clockwise and hands back new dimensions. */
  onRotate: () => void;
  onApply: (corners: Corners) => void;
  busy: boolean;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const [corners, setCorners] = useState<Corners>(() =>
    initialCorners(imageWidth, imageHeight, detectedCorners, edgeConfidence),
  );

  /*
   * The image is drawn `contain`-fitted inside this box, so the mapping
   * between a handle's position on glass and its position in the FILE is a
   * single scale plus a centring offset. Everything stored in state is in
   * image pixels — screen coordinates belong to the phone the crop was drawn
   * on, and the crop has to survive being applied to the original file.
   */
  const boxWidth = screenWidth;
  const boxHeight = screenHeight - 250;
  const { scale, offsetX, offsetY } = useMemo(
    () => fitImageInBox(imageWidth, imageHeight, boxWidth, boxHeight),
    [boxWidth, boxHeight, imageWidth, imageHeight],
  );

  const toScreen = (p: Point) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY });

  const rect = cornersToCropRect(corners, imageWidth, imageHeight);
  const preselected = detectedCorners !== null && corners !== undefined && edgeConfidence !== null;

  return (
    <View style={{ flex: 1, backgroundColor: ink[900] }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
        <T variant="title" style={{ color: "#ffffff" }}>
          Crop the receipt
        </T>
        <T style={{ color: "rgba(255,255,255,0.66)", fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>
          Drag the corners onto the receipt's edges. The lit area is what will be kept.
        </T>
      </View>

      <View style={{ width: boxWidth, height: boxHeight }}>
        <Image
          source={{ uri }}
          style={{
            position: "absolute",
            left: offsetX,
            top: offsetY,
            width: imageWidth * scale,
            height: imageHeight * scale,
          }}
          resizeMode="contain"
          accessibilityRole="image"
          accessibilityLabel="The section being cropped"
          accessibilityIgnoresInvertColors
        />

        {/*
          The scrim. Four panels around the bounding box rather than one view
          with a hole, because the hole must stay genuinely transparent — a
          translucent overlay would darken the print the owner is judging.
        */}
        {rect ? <CropScrim rect={rect} scale={scale} offsetX={offsetX} offsetY={offsetY} box={{ boxWidth, boxHeight }} /> : null}

        <DetectedOutline corners={corners} toScreen={toScreen} thickness={1.5} />

        {CORNER_ORDER.map((key) => (
          <CornerHandle
            key={key}
            position={toScreen(corners[key])}
            label={CORNER_LABELS[key]}
            onDrag={(dx, dy, start) => {
              setCorners((prev) => ({
                ...prev,
                // The gesture's delta is in screen points; dividing by the
                // same scale used to draw is what keeps a drag tracking the
                // finger exactly on a phone of any density.
                [key]: clampToImage(
                  { x: start.x + dx / scale, y: start.y + dy / scale },
                  imageWidth,
                  imageHeight,
                ),
              }));
            }}
            startValue={corners[key]}
          />
        ))}
      </View>

      <View style={{ padding: space.lg, gap: space.sm }}>
        {preselected ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center" }}>
            <Ionicons name="scan-outline" size={14} color={brand[400]} />
            <T style={{ color: "rgba(255,255,255,0.6)", fontSize: 11.5 }}>
              FinSight guessed these edges — move them if they are wrong.
            </T>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Reset"
              variant="secondary"
              onPress={() => setCorners(fullFrameCorners(imageWidth, imageHeight))}
              disabled={busy}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Rotate" variant="secondary" onPress={onRotate} disabled={busy} />
          </View>
        </View>

        <Button title="Apply crop" variant="primary" onPress={() => onApply(corners)} loading={busy} />
        <Button title="Cancel" variant="ghost" onPress={onCancel} disabled={busy} />
      </View>
    </View>
  );
}

const CORNER_LABELS: Record<(typeof CORNER_ORDER)[number], string> = {
  topLeft: "Top left corner",
  topRight: "Top right corner",
  bottomRight: "Bottom right corner",
  bottomLeft: "Bottom left corner",
};

/**
 * One handle.
 *
 * PanResponder rather than react-native-gesture-handler: this is four
 * independent single-touch drags with no competing gesture to disambiguate
 * against, which is precisely what PanResponder is for, and it ships with
 * React Native rather than depending on a second library's version and its
 * optional Reanimated pairing behaving as expected on the device.
 *
 * The handle's value at gesture START is captured in a ref rather than read
 * from state on each move. `onPanResponderMove` reports a CUMULATIVE
 * translation, so adding it to a value that is itself being updated on every
 * frame would compound the movement and send the corner shooting off under
 * the finger.
 */
function CornerHandle({
  position,
  label,
  startValue,
  onDrag,
}: {
  position: Point;
  label: string;
  startValue: Point;
  onDrag: (dx: number, dy: number, start: Point) => void;
}) {
  const start = useRef<Point>(startValue);
  const latest = useRef<Point>(startValue);
  latest.current = startValue;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = latest.current;
      },
      onPanResponderMove: (_event, gesture) => {
        onDrag(gesture.dx, gesture.dy, start.current);
      },
    }),
  ).current;

  const size = 28;
  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      // Hit area is 28pt but the visible dot is 16pt: a corner sitting on the
      // edge of a receipt needs to be grabbable without covering the print
      // the owner is aligning it to.
      style={{
        position: "absolute",
        left: position.x - size / 2,
        top: position.y - size / 2,
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: radius.full,
          backgroundColor: brand[400],
          borderWidth: 2.5,
          borderColor: "#ffffff",
        }}
      />
    </View>
  );
}

/** Darkens everything the crop will discard. */
function CropScrim({
  rect,
  scale,
  offsetX,
  offsetY,
  box,
}: {
  rect: { originX: number; originY: number; width: number; height: number };
  scale: number;
  offsetX: number;
  offsetY: number;
  box: { boxWidth: number; boxHeight: number };
}) {
  const left = rect.originX * scale + offsetX;
  const top = rect.originY * scale + offsetY;
  const right = left + rect.width * scale;
  const bottom = top + rect.height * scale;
  const shade = "rgba(26,32,34,0.62)";

  return (
    <>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, height: top, backgroundColor: shade }} />
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: bottom, right: 0, height: box.boxHeight - bottom, backgroundColor: shade }} />
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top, width: left, height: bottom - top, backgroundColor: shade }} />
      <View pointerEvents="none" style={{ position: "absolute", left: right, top, width: box.boxWidth - right, height: bottom - top, backgroundColor: shade }} />
    </>
  );
}
