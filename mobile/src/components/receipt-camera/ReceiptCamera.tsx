import { useCallback, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraBottomBar, CameraTopBar, GuideToggle, SectionLimitNotice } from "./CameraControls";
import { CameraPermissionState } from "./CameraPermissionState";
import { CapturePreview } from "./CapturePreview";
import { CapturedSectionStrip } from "./CapturedSectionStrip";
import { CropEditor } from "./CropEditor";
import { GuideInstruction, ReceiptGuide } from "./ReceiptGuide";
import { api } from "../../lib/api";
import * as haptics from "../../lib/haptics";
import { ink, space } from "../../theme/tokens";
import {
  CAPTURE_QUALITY,
  canAddSection,
  captureInstruction,
  cornersFromFractions,
  cornersToCropRect,
  cropChangesAnything,
  moveSection,
  newSectionId,
  sectionLabel,
  type Corners,
  type ReceiptSection,
  type SectionQuality,
} from "../../lib/receiptCapture";

/**
 * FinSight's own camera for photographing a receipt.
 *
 * WHY NOT THE SYSTEM CAMERA. `ImagePicker.launchCameraAsync` — what this
 * replaces — hands the owner to a camera app that knows nothing about
 * receipts: no frame to line the paper up in, no way to say "this is section
 * two of the same receipt", no chance to reject a bad photograph before it
 * costs an OCR pass, and a jarring hand-off out of FinSight and back. Every
 * one of those is a property of the capture, and capture is the only stage of
 * this pipeline where quality can still be improved. Nothing downstream
 * recovers detail the photograph did not record — that is measured, and it is
 * why backend/src/lib/imageQuality.ts exists at all.
 *
 * THE ONE RULE THIS SCREEN ENFORCES: nothing is uploaded until the owner says
 * so. The shutter produces a file on the phone and a preview; the section
 * list is local; the scan happens once, for all sections together, after
 * "Finish". A blurry thumb-over-the-lens shot costs one tap to discard here,
 * against an OCR pass, a possible vision call and a wrong set of figures if
 * it were sent the moment it was taken.
 *
 * WHAT IS DELIBERATELY ABSENT: real-time edge detection and an automatic
 * shutter. Both need per-frame analysis, which in Expo Go has no native
 * module to do it — and adding one means a development-build migration, the
 * same cost that ruled out on-device OCR (see ScanReceiptScreen's header).
 * Detection here runs AFTER the shutter, server-side, and only ever proposes
 * corners the owner can drag.
 */
export function ReceiptCamera({
  initialSections = [],
  onCancel,
  onDone,
}: {
  /**
   * Sections already photographed in this receipt's session.
   *
   * The camera owns the WHOLE ordered session while it is open — that is what
   * lets it number "Section 3 of 3", ghost the previous section for
   * alignment, and enforce one ceiling across the lot. Reopening it to add a
   * third page therefore has to hand back the first two, or finishing would
   * replace them with the one just taken.
   */
  initialSections?: ReceiptSection[];
  onCancel: () => void;
  /** Handed the finished session, in reading order. Never called empty. */
  onDone: (sections: ReceiptSection[]) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [sections, setSections] = useState<ReceiptSection[]>(initialSections);
  const [pending, setPending] = useState<PendingCapture | null>(null);
  const [mode, setMode] = useState<"camera" | "preview" | "crop">("camera");

  const [torch, setTorch] = useState(false);
  const [showOverlapGuide, setShowOverlapGuide] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * The shutter lock.
   *
   * A ref as well as state, because the two are needed for different things
   * and only one of them works. `capturing` state disables the button and
   * shows the spinner — but state updates are asynchronous, so two taps
   * landing in the same frame both read the old `false` and both fire
   * `takePictureAsync`. The ref is written synchronously and is what actually
   * makes a double-press impossible.
   */
  const captureLock = useRef(false);
  const [capturing, setCapturing] = useState(false);

  /**
   * Closing the camera, with the one question worth asking first.
   *
   * The X discards the whole session, and a session is real work — someone
   * photographing a long receipt may be four sections in. It matters more now
   * than it used to: cancelling with nothing captured leaves the scan screen
   * altogether, so a mis-tap that also threw away four photographs would be
   * two losses from one wrong touch, with nothing on screen afterwards to
   * suggest anything had been lost.
   *
   * Nothing is asked when there is nothing to lose. A confirmation on an
   * empty session is a dialog between the owner and their own intention.
   */
  const requestClose = useCallback(() => {
    if (sections.length === 0) return onCancel();

    Alert.alert(
      "Discard this receipt?",
      `${sections.length} photographed section${sections.length === 1 ? "" : "s"} will be lost.`,
      [
        { text: "Keep photographing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: onCancel },
      ],
    );
  }, [sections.length, onCancel]);

  const capture = useCallback(async () => {
    if (captureLock.current || !cameraRef.current || !cameraReady) return;
    if (!canAddSection(sections.length)) return;

    captureLock.current = true;
    setCapturing(true);
    haptics.committed();

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: CAPTURE_QUALITY,
        // EXIF is not read anywhere downstream and carries location data the
        // owner never agreed to attach to their bookkeeping.
        exif: false,
        // Left off so the file arrives already rotated the way it was shot.
        // `skipProcessing` is faster but returns orientation-uncertain images,
        // and an upside-down receipt is a wrong crop and a failed read.
        skipProcessing: false,
      });
      if (!photo) return;

      setPending({
        originalUri: photo.uri,
        uri: photo.uri,
        width: photo.width,
        height: photo.height,
        quality: null,
        checkingQuality: true,
        detectedCorners: null,
        edgeConfidence: null,
      });
      setMode("preview");
      void inspect(photo.uri, photo.width, photo.height);
    } catch {
      haptics.failed();
    } finally {
      captureLock.current = false;
      setCapturing(false);
    }
  }, [cameraReady, sections.length]);

  /**
   * Asks the server what it makes of a photograph, without scanning it.
   *
   * Two cheap, side-effect-free endpoints: one measures readability, the
   * other proposes receipt corners. Neither runs OCR, writes a row or stores
   * a file, which is what makes it reasonable to call them on every shutter
   * press rather than once at the end.
   *
   * BOTH FAIL SILENTLY, and that is the design rather than an oversight. A
   * blur warning that could not be fetched is a missing nicety; a corner
   * proposal that could not be fetched leaves the crop editor on its default
   * handles, which is where it starts anyway. Neither is a reason to stop
   * someone photographing the receipt in front of them — an owner on a bad
   * connection in a sari-sari store still has to be able to scan.
   */
  async function inspect(uri: string, width: number, height: number) {
    const form = new FormData();
    // React Native's FormData takes this {uri,name,type} shape rather than a
    // Blob — the browser's File API does not exist here.
    form.append("file", { uri, name: `section-${Date.now()}.jpg`, type: "image/jpeg" } as any);

    const [quality, edges] = await Promise.all([
      api
        .upload<PendingCapture["quality"]>("/records/receipts/quality-check", form)
        .catch(() => null),
      api
        .upload<{ corners: Corners | null; confidence: number }>("/records/receipts/detect-edges", form)
        .catch(() => null),
    ]);

    setPending((prev) => {
      // The owner may have retaken or discarded while this was in flight. The
      // uri identifies which photograph the answer belongs to; anything else
      // would staple one section's blur warning onto another's preview.
      if (!prev || prev.originalUri !== uri) return prev;
      return {
        ...prev,
        quality: quality ?? null,
        checkingQuality: false,
        // The server answers in fractions of the image, because it detects on
        // a downscaled copy whose size the phone never sees. Scaling to this
        // photograph's real pixels happens here, once.
        detectedCorners: cornersFromFractions(edges?.corners ?? null, width, height),
        edgeConfidence: edges?.confidence ?? null,
      };
    });
  }

  async function pickFromGallery() {
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: CAPTURE_QUALITY,
      mediaTypes: ["images"],
    });
    const asset = res.canceled ? null : res.assets[0];
    if (!asset) return;

    setPending({
      originalUri: asset.uri,
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      quality: null,
      checkingQuality: true,
      detectedCorners: null,
      edgeConfidence: null,
    });
    setMode("preview");
    void inspect(asset.uri, asset.width, asset.height);
  }

  /** Turns the approved pending capture into a section and returns the list. */
  function commitPending(): ReceiptSection[] {
    if (!pending) return sections;
    const section: ReceiptSection = {
      localId: newSectionId(),
      originalUri: pending.originalUri,
      processedUri: pending.uri,
      width: pending.width,
      height: pending.height,
      // Only meaningful for an UNCROPPED section: once a crop is applied the
      // measurement describes a file that no longer exists. Cropping usually
      // improves readability anyway (less background, more receipt), so
      // carrying the old number forward would understate it.
      quality: pending.appliedCorners ? null : pending.quality,
      ...(pending.appliedCorners ? { cropCorners: pending.appliedCorners } : {}),
      ...(pending.edgeConfidence != null ? { edgeConfidence: pending.edgeConfidence } : {}),
    };
    const next = [...sections, section];
    setSections(next);
    setPending(null);
    return next;
  }

  async function applyCrop(corners: Corners) {
    if (!pending) return;
    const rect = cornersToCropRect(corners, pending.width, pending.height);

    // A crop that changes nothing is not worth a re-encode: every pass
    // through the manipulator re-compresses the JPEG, and this is the same
    // file OCR will have to read faint thermal print off.
    if (!rect || !cropChangesAnything(rect, pending.width, pending.height)) {
      setMode("preview");
      return;
    }

    setBusy(true);
    try {
      const image = await ImageManipulator.manipulate(pending.uri).crop(rect).renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: CAPTURE_QUALITY });
      setPending({
        ...pending,
        uri: saved.uri,
        width: saved.width,
        height: saved.height,
        appliedCorners: corners,
      });
      haptics.succeeded();
      setMode("preview");
    } catch {
      haptics.failed();
      // Staying in the editor with the original file intact is the right
      // failure: the owner can try a different crop or simply use the photo.
      setMode("preview");
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!pending) return;
    setBusy(true);
    try {
      const image = await ImageManipulator.manipulate(pending.uri).rotate(90).renderAsync();
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: CAPTURE_QUALITY });
      setPending({
        ...pending,
        uri: saved.uri,
        width: saved.width,
        height: saved.height,
        // The corners described the old orientation and mean nothing now.
        // Dropping them re-opens the editor on defaults, which is honest;
        // rotating the geometry to match is the kind of arithmetic that goes
        // quietly wrong and crops a receipt through its own total.
        detectedCorners: null,
        edgeConfidence: null,
        appliedCorners: undefined,
      });
    } catch {
      haptics.failed();
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- render

  if (!permission) {
    return <CameraPermissionState status="pending" onRequest={() => void requestPermission()} onPickFromGallery={pickFromGallery} onClose={onCancel} />;
  }
  if (!permission.granted) {
    return (
      <CameraPermissionState
        status={permission.canAskAgain ? "denied" : "blocked"}
        onRequest={() => void requestPermission()}
        onPickFromGallery={pickFromGallery}
        onClose={onCancel}
      />
    );
  }

  if (mode === "crop" && pending) {
    return (
      <CropEditor
        // Keyed on the file, so a rotate re-mounts the editor with handles
        // that match the new dimensions instead of the old ones.
        key={pending.uri}
        uri={pending.uri}
        imageWidth={pending.width}
        imageHeight={pending.height}
        detectedCorners={pending.detectedCorners}
        edgeConfidence={pending.edgeConfidence}
        onCancel={() => setMode("preview")}
        onRotate={() => void rotate()}
        onApply={(corners) => void applyCrop(corners)}
        busy={busy}
      />
    );
  }

  if (mode === "preview" && pending) {
    return (
      <CapturePreview
        uri={pending.uri}
        imageWidth={pending.width}
        imageHeight={pending.height}
        detectedCorners={pending.detectedCorners}
        edgeConfidence={pending.edgeConfidence}
        quality={pending.quality}
        checkingQuality={pending.checkingQuality}
        capturedCount={sections.length}
        busy={busy}
        onRetake={() => {
          setPending(null);
          setMode("camera");
        }}
        onCrop={() => setMode("crop")}
        onCropToDetected={(corners) => void applyCrop(corners)}
        onUse={() => {
          commitPending();
          setMode("camera");
        }}
        onUseAndFinish={() => {
          const finished = commitPending();
          if (finished.length > 0) onDone(finished);
        }}
      />
    );
  }

  const atLimit = !canAddSection(sections.length);

  return (
    <View style={{ flex: 1, backgroundColor: ink[900] }}>
      {/*
        The preview is mounted only in camera mode. Leaving a CameraView alive
        behind the crop editor keeps the sensor and the torch running for a
        screen that shows a still image, which on a phone is battery and heat
        for nothing.
      */}
      <CameraView
        ref={cameraRef}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
        facing="back"
        enableTorch={torch}
        onCameraReady={() => setCameraReady(true)}
      />

      <ReceiptGuide
        capturedCount={sections.length}
        previousUri={sections.length > 0 ? sections[sections.length - 1]!.processedUri : null}
        showOverlapGuide={showOverlapGuide}
      />

      <SafeAreaView style={{ flex: 1, justifyContent: "space-between" }} edges={["top", "bottom"]}>
        <View style={{ gap: space.sm, paddingTop: space.sm }}>
          <CameraTopBar
            onClose={requestClose}
            sectionLabel={sectionLabel(sections.length)}
            torchOn={torch}
            onToggleTorch={() => setTorch((t) => !t)}
          />
          <View style={{ gap: 2, paddingHorizontal: space.lg }}>
            {atLimit ? (
              <SectionLimitNotice />
            ) : (
              <GuideInstruction text={captureInstruction(sections.length)} />
            )}
            {sections.length > 0 && !atLimit ? (
              <GuideToggle hidden={!showOverlapGuide} onToggle={() => setShowOverlapGuide((s) => !s)} />
            ) : null}
          </View>
        </View>

        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <CapturedSectionStrip
            sections={sections}
            onRemove={(id) => setSections((prev) => prev.filter((s) => s.localId !== id))}
            onMove={(id, delta) =>
              setSections((prev) => moveSection(prev, prev.findIndex((s) => s.localId === id), delta))
            }
            onPreview={(id) => {
              const section = sections.find((s) => s.localId === id);
              if (!section) return;
              // Re-opening a captured section pulls it back OUT of the list
              // and into the pending slot, so "Retake" genuinely replaces it
              // rather than adding a ninth photograph of the same page.
              setSections((prev) => prev.filter((s) => s.localId !== id));
              setPending({
                originalUri: section.originalUri,
                uri: section.processedUri,
                width: section.width,
                height: section.height,
                quality: section.quality,
                checkingQuality: false,
                detectedCorners: null,
                edgeConfidence: section.edgeConfidence ?? null,
              });
              setMode("preview");
            }}
          />
          <CameraBottomBar
            onCapture={() => void capture()}
            onPickFromGallery={() => void pickFromGallery()}
            onFinish={() => sections.length > 0 && onDone(sections)}
            capturing={capturing}
            capturedCount={sections.length}
            canCapture={!atLimit && cameraReady}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * A photograph taken but not yet approved.
 *
 * `originalUri` is kept separately from `uri` throughout: every crop and
 * rotation writes a NEW file and moves `uri` to it, so the photograph as
 * captured survives until the section is committed. That is what makes the
 * crop editor safe to experiment in.
 */
interface PendingCapture {
  originalUri: string;
  uri: string;
  width: number;
  height: number;
  quality: SectionQuality | null;
  checkingQuality: boolean;
  detectedCorners: Corners | null;
  edgeConfidence: number | null;
  /** Set once a crop has actually been applied, for the record. */
  appliedCorners?: Corners;
}
