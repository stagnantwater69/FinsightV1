import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, T } from "../../../components/ui";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { useTheme } from "../../../context/ThemeContext";
import { radius, space } from "../../../theme/tokens";
import { api } from "../../../lib/api";
import type { CapturedPage, ReceiptPageEvidence, ReceiptPageImage } from "./types";
import { receiptEvidenceLabels } from "./receiptEvidence";

type Variant = "source" | "processed";

export function ReceiptEvidenceViewer({
  pages,
  scanId,
  pageEvidence,
  initialPage,
  visible,
  onClose,
}: {
  pages: CapturedPage[];
  scanId?: number;
  pageEvidence?: ReceiptPageEvidence[];
  initialPage: number;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [variant, setVariant] = useState<Variant>("source");
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [storedImages, setStoredImages] = useState<Record<string, ReceiptPageImage>>({});
  const [failedStoredImages, setFailedStoredImages] = useState<Record<string, true>>({});
  // Key of the stored-image request in flight. Comparing it with the
  // on-screen key keeps a superseded request from veiling another page.
  const [storedImageLoadingKey, setStoredImageLoadingKey] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPageIndex(Math.min(Math.max(initialPage, 0), Math.max(0, pages.length - 1)));
    setVariant("source");
    setZoom(1);
    setStoredImages({});
    setFailedStoredImages({});
    setImageError(false);
  }, [initialPage, pageEvidence?.length, pages.length, scanId, visible]);

  const page = pages[pageIndex];
  const storedEvidence = pageEvidence?.find((candidate) => candidate.pageNumber === pageIndex + 1);
  const hasDerived = Boolean(storedEvidence?.derived || (page?.originalUri && page.originalUri !== page.uri));
  const fallbackLabels = page ? receiptEvidenceLabels(page) : { source: "Source", processed: "Processed" };
  const labels = {
    source: storedEvidence?.source.label ?? fallbackLabels.source,
    processed: storedEvidence?.derived?.label ?? fallbackLabels.processed,
  };
  const shownVariant: Variant = hasDerived ? variant : "source";
  const requestVariant = shownVariant === "source" ? "source" : "derived";
  const storedKey = `${pageIndex + 1}:${requestVariant}`;
  const localUri = page
    ? shownVariant === "source" ? page.originalUri ?? page.uri : page.uri
    : "";
  const storedImage = storedImages[storedKey];
  const storedImageError = Boolean(failedStoredImages[storedKey]);
  const storedImageLoading = storedImageLoadingKey === storedKey;
  const shownUri = storedImage?.url ?? localUri;
  const shownLabel = shownVariant === "source" ? labels.source : labels.processed;
  const scaledWidth = Math.max(1, viewport.width * zoom);
  const scaledHeight = Math.max(1, viewport.height * zoom);

  useEffect(() => {
    setImageError(false);
    setImageLoading(Boolean(shownUri));
  }, [shownUri]);

  useEffect(() => {
    if (!visible || !scanId || !storedEvidence || storedImage || storedImageError) return;
    let active = true;
    setStoredImageLoadingKey(storedKey);
    void api.get<ReceiptPageImage>(`/records/receipts/${scanId}/pages/${pageIndex + 1}/image/${requestVariant}`)
      .then((result) => {
        if (!active) return;
        if (result.pageNumber !== pageIndex + 1
          || result.variant !== requestVariant
          || typeof result.url !== "string"
          || result.url.length > 4096
          || !/^https?:\/\/[^\s]+$/i.test(result.url)
          || !Number.isInteger(result.expiresInSeconds)
          || result.expiresInSeconds <= 0) {
          throw new Error("Receipt image response did not match the requested page.");
        }
        setStoredImages((current) => ({ ...current, [storedKey]: result }));
      })
      .catch(() => {
        if (!active) return;
        setFailedStoredImages((current) => ({ ...current, [storedKey]: true }));
      })
      .finally(() => {
        if (active) setStoredImageLoadingKey((current) => (current === storedKey ? null : current));
      });
    return () => {
      active = false;
      setStoredImageLoadingKey((current) => (current === storedKey ? null : current));
    };
  }, [pageIndex, requestVariant, scanId, storedEvidence, storedImage, storedImageError, storedKey, visible]);

  if (!page) return null;

  function choosePage(index: number) {
    setPageIndex(index);
    setVariant("source");
    setZoom(1);
  }

  function retryStoredImage() {
    setFailedStoredImages((current) => {
      const next = { ...current };
      delete next[storedKey];
      return next;
    });
    setImageError(false);
  }

  function handleImageError() {
    setImageLoading(false);
    if (!storedImage) {
      setImageError(true);
      return;
    }

    setStoredImages((current) => {
      const next = { ...current };
      delete next[storedKey];
      return next;
    });
    setFailedStoredImages((current) => ({ ...current, [storedKey]: true }));
    setImageError(!localUri);
  }

  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: t.cameraSurface, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close receipt image"
            onPress={onClose}
            style={styles.iconButton}
          >
            <Ionicons name="close-outline" size={26} color={t.onCamera} />
          </Pressable>
          <View style={styles.headerText}>
            <T variant="title" accessibilityRole="header" style={{ color: t.onCamera, textAlign: "center" }}>
              Receipt page {pageIndex + 1} of {pages.length}
            </T>
            <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.onCamera, textAlign: "center" }}>
              {shownLabel}. Zoom in to check every line.
            </T>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        {hasDerived ? (
          <View style={styles.segmented}>
            {(["source", "processed"] as const).map((value) => {
              const label = value === "source" ? labels.source : labels.processed;
              const selected = shownVariant === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected }}
                  onPress={() => { setVariant(value); setZoom(1); }}
                  style={[styles.segment, { backgroundColor: selected ? t.brandFill : t.cameraSurface, borderColor: t.onCamera }]}
                >
                  <T style={{ color: t.onCamera, textAlign: "center" }}>{label}</T>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <T variant="caption" style={{ color: t.onCamera, textAlign: "center", paddingHorizontal: space.lg }}>
            {labels.source}
          </T>
        )}

        <View
          style={styles.viewer}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            if (width > 0 && height > 0) setViewport({ width, height });
          }}
        >
          <ScrollView
            horizontal
            scrollEnabled={zoom > 1}
            showsHorizontalScrollIndicator={zoom > 1}
            contentContainerStyle={{ width: scaledWidth, height: scaledHeight }}
          >
            <ScrollView
              scrollEnabled={zoom > 1}
              showsVerticalScrollIndicator={zoom > 1}
              contentContainerStyle={{ width: scaledWidth, height: scaledHeight }}
            >
              {shownUri ? (
                <Image
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={`Receipt page ${pageIndex + 1}, ${shownLabel}`}
                  accessibilityIgnoresInvertColors
                  source={{ uri: shownUri }}
                  resizeMode="contain"
                  style={{ width: scaledWidth, height: scaledHeight }}
                  onLoadStart={() => { setImageLoading(true); setImageError(false); }}
                  onLoadEnd={() => setImageLoading(false)}
                  onError={handleImageError}
                />
              ) : null}
            </ScrollView>
          </ScrollView>
          {imageLoading || storedImageLoading ? (
            <View pointerEvents="none" style={styles.viewerStatus}>
              <ActivityIndicator color={t.onCamera} />
              <T variant="caption" style={{ color: t.onCamera }}>Opening {shownLabel.toLowerCase()}…</T>
            </View>
          ) : null}
          {imageError ? (
            <View accessibilityLiveRegion="assertive" style={styles.viewerStatus}>
              <T accessibilityRole="alert" style={{ color: t.onCamera, textAlign: "center" }}>
                {storedImageError ? "Neither copy of this receipt image could be opened." : "This receipt image couldn't be opened."}
              </T>
              <T variant="caption" style={{ color: t.onCamera, textAlign: "center" }}>
                {storedImageError ? "Check your connection, then request a fresh stored-image link." : "Close this view and choose another page or image."}
              </T>
              {storedImageError ? <Button title="Try stored image again" variant="secondary" onPress={retryStoredImage} /> : null}
            </View>
          ) : null}
          {storedImageError && !localUri && !imageError ? (
            <View accessibilityLiveRegion="assertive" style={styles.viewerStatus}>
              <T accessibilityRole="alert" style={{ color: t.onCamera, textAlign: "center" }}>The stored receipt image couldn't be opened.</T>
              <T variant="caption" style={{ color: t.onCamera, textAlign: "center" }}>Check your connection, then try opening this page again.</T>
              <Button title="Try stored image again" variant="secondary" onPress={retryStoredImage} />
            </View>
          ) : null}
        </View>

        {storedImageError && Boolean(localUri) && !imageError ? (
          <T accessibilityRole="alert" variant="caption" style={{ color: t.onCamera, textAlign: "center", paddingHorizontal: space.md }}>
            The stored image is temporarily unavailable. This is the copy kept on your device.
          </T>
        ) : null}

        <View style={styles.zoomControls}>
          <Button title="Zoom out" variant="secondary" disabled={zoom <= 1} onPress={() => setZoom((value) => Math.max(1, value - 0.5))} />
          <Button title={zoom === 1 ? "Actual view" : `Reset ${zoom.toFixed(1)}×`} variant="ghost" disabled={zoom === 1} onPress={() => setZoom(1)} />
          <Button title="Zoom in" variant="secondary" disabled={zoom >= 4} onPress={() => setZoom((value) => Math.min(4, value + 0.5))} />
        </View>

        {pages.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pageStrip}>
            {pages.map((candidate, index) => (
              <Pressable
                key={candidate.key}
                accessibilityRole="button"
                accessibilityLabel={`Show receipt page ${index + 1}`}
                accessibilityState={{ selected: index === pageIndex }}
                onPress={() => choosePage(index)}
                style={[styles.thumbnail, { borderColor: index === pageIndex ? t.onCamera : "transparent" }]}
              >
                {candidate.uri ? <Image source={{ uri: candidate.uri }} resizeMode="cover" style={StyleSheet.absoluteFill} /> : null}
                <View style={styles.pageNumber}><T variant="caption" style={{ color: t.onCamera }}>{index + 1}</T></View>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm },
  headerText: { flex: 1, gap: 2 },
  headerSpacer: { width: TAP_FLOOR, height: TAP_FLOOR },
  iconButton: { width: TAP_FLOOR, height: TAP_FLOOR, alignItems: "center", justifyContent: "center" },
  segmented: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm },
  segment: { minWidth: 120, minHeight: TAP_FLOOR, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, alignItems: "center", justifyContent: "center" },
  viewer: { flex: 1, minHeight: 120, overflow: "hidden" },
  viewerStatus: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg, backgroundColor: "rgba(0,0,0,0.72)" },
  zoomControls: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: space.sm, padding: space.sm },
  pageStrip: { gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  thumbnail: { width: 64, height: 80, borderWidth: 2, borderRadius: radius.sm, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.08)" },
  pageNumber: { position: "absolute", left: 0, right: 0, bottom: 0, minHeight: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.72)" },
});
