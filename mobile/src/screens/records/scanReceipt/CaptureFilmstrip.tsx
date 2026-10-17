import { ActivityIndicator, Image, Pressable, ScrollView, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { canMoveWithinReceipt } from "../../../lib/receiptGrouping";
import { font, radius, space, typeScale } from "../../../theme/tokens";
import { StoredPagePlaceholder } from "./StoredPagePlaceholder";
import type { CapturedPage } from "./types";

/** The captured pages before upload, each removable and movable within its receipt. */
export function CaptureFilmstrip({
  pages,
  receiptCount,
  positions,
  scanStarted,
  uploadIssuePageKeys,
  onRemove,
  onMove,
}: {
  pages: CapturedPage[];
  receiptCount: number;
  positions: Map<string, { receipt: number; page: number; pages: number }>;
  scanStarted: boolean;
  uploadIssuePageKeys: Record<string, true>;
  onRemove: (key: string) => void;
  /** -1 moves a page earlier, +1 later. */
  onMove: (key: string, delta: number) => void;
}) {
  const { brand, ink, paper, statusText } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {pages.map((p, i) => (
          <View key={p.key} style={{ width: 84 }}>
            <View
              style={{
                width: 84,
                height: 112,
                borderRadius: radius.sm,
                overflow: "hidden",
                backgroundColor: paper[100],
                borderWidth: 1,
                borderColor: ink[200],
              }}
            >
              {p.uri ? (
                <Image source={{ uri: p.uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
              ) : (
                <StoredPagePlaceholder label="Stored" compact />
              )}
              <View
                style={{
                  position: "absolute",
                  top: 4,
                  left: 4,
                  backgroundColor: "rgba(255,255,255,0.9)",
                  borderRadius: radius.full,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink[700] }}>
                  {receiptCount > 1
                    ? `R${positions.get(p.key)?.receipt} · P${positions.get(p.key)?.page}`
                    : pages.length > 1 ? `Part ${i + 1}` : i + 1}
                </T>
              </View>
              <Pressable
                onPress={() => onRemove(p.key)}
                disabled={scanStarted}
                accessibilityRole="button"
                accessibilityLabel={pages.length > 1 && receiptCount === 1 ? `Remove part ${i + 1}` : `Remove page ${i + 1}`}
                // The visible chip stays 22px so it doesn't
                // swallow the thumbnail, but hitSlop brings
                // the actual tap target up to TAP (44px) —
                // 8px was 6px short even with hitSlop.
                hitSlop={11}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  width: 22,
                  height: 22,
                  borderRadius: radius.full,
                  backgroundColor: "rgba(255,255,255,0.9)",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: scanStarted ? 0.35 : 1,
                }}
              >
                <Ionicons name="close" size={14} color={ink[700]} />
              </Pressable>
              {p.checkingQuality ? (
                <View style={{ position: "absolute", bottom: 4, right: 4 }}>
                  <ActivityIndicator size="small" color={brand[600]} />
                </View>
              ) : null}
            </View>
            {/*
              Caught at capture, not after the whole session
              uploads — see addPage's own comment for why that
              order matters.
            */}
            {p.quality?.tooBlurredToTrust ? (
              <T style={{ fontSize: typeScale.axis, color: statusText.warning, marginTop: 2, textAlign: "center" }}>
                ⚠ blurry
              </T>
            ) : null}
            {uploadIssuePageKeys[p.key] ? (
              <T style={{ fontSize: typeScale.axis, color: statusText.critical, marginTop: 2, textAlign: "center" }}>
                ⚠ Can't upload yet
              </T>
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, marginTop: 2 }}>
              <Pressable
                onPress={() => onMove(p.key, -1)}
                disabled={scanStarted || !canMoveWithinReceipt(pages, i, -1)}
                accessibilityRole="button"
                accessibilityLabel={pages.length > 1 && receiptCount === 1 ? `Move part ${i + 1} up` : `Move page ${i + 1} earlier`}
                hitSlop={8}
                style={{ padding: 4, opacity: scanStarted || !canMoveWithinReceipt(pages, i, -1) ? 0.3 : 1 }}
              >
                <Ionicons name="chevron-up" size={16} color={ink[600]} />
              </Pressable>
              <Pressable
                onPress={() => onMove(p.key, 1)}
                disabled={scanStarted || !canMoveWithinReceipt(pages, i, 1)}
                accessibilityRole="button"
                accessibilityLabel={pages.length > 1 && receiptCount === 1 ? `Move part ${i + 1} down` : `Move page ${i + 1} later`}
                hitSlop={8}
                style={{ padding: 4, opacity: scanStarted || !canMoveWithinReceipt(pages, i, 1) ? 0.3 : 1 }}
              >
                <Ionicons name="chevron-down" size={16} color={ink[600]} />
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
