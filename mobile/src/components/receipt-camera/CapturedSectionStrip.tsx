import { Image, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { T } from "../ui";
import { font, radius, space, statusText, typeScale } from "../../theme/tokens";
import { sectionOrdinal, type ReceiptSection } from "../../lib/receiptCapture";

/**
 * The sections captured so far, in the order they will be read.
 *
 * WHY IT IS ON THE CAMERA SCREEN AT ALL, rather than only on the review
 * screen behind it: the single most damaging outcome of this feature is a
 * long receipt entered as several separate purchases, and the moment that
 * mistake is cheapest to notice is while the camera is still open and the
 * paper is still in the owner's hand. A strip that says "1  2  3" under the
 * viewfinder is the difference between three sections of one receipt and
 * three receipts, stated continuously rather than asked about at the end.
 *
 * Reordering lives here too. Page order is the client's assertion and the
 * server trusts it wholesale (docs/multi-page-receipts-plan.md §4), so a
 * receipt photographed bottom-up has to be fixable here or it is not fixable
 * anywhere.
 */
export function CapturedSectionStrip({
  sections,
  onRemove,
  onMove,
  onPreview,
}: {
  sections: ReceiptSection[];
  onRemove: (localId: string) => void;
  onMove: (localId: string, delta: number) => void;
  onPreview: (localId: string) => void;
}) {
  if (sections.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: space.md, gap: space.sm }}
      style={{ flexGrow: 0 }}
    >
      {sections.map((section, index) => (
        <View key={section.localId} style={{ width: 52 }}>
          <Pressable
            onPress={() => onPreview(section.localId)}
            accessibilityRole="button"
            accessibilityLabel={`Preview ${sectionOrdinal(index, sections.length)}`}
            style={({ pressed }) => ({
              width: 52,
              height: 66,
              borderRadius: radius.sm,
              overflow: "hidden",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.18)",
              backgroundColor: "rgba(26,32,34,0.6)",
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Image
              source={{ uri: section.processedUri }}
              style={{ width: "100%", height: "100%" }}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
            {/*
              The number is the section's position in the READ order, which is
              why it re-renders from the array index rather than from anything
              stored on the section: after a reorder the label has to be the
              new position, not the one it was shot in.
            */}
            <View
              style={{
                position: "absolute",
                bottom: 2,
                left: 2,
                backgroundColor: "rgba(0,0,0,0.55)",
                borderRadius: 4,
                paddingHorizontal: 4,
                paddingVertical: 1,
              }}
            >
              <T style={{ fontFamily: font.monoMedium, fontSize: 9, color: "#ffffff" }}>{index + 1}</T>
            </View>
          </Pressable>

          <Pressable
            onPress={() => onRemove(section.localId)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${sectionOrdinal(index, sections.length)}`}
            hitSlop={10}
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              width: 20,
              height: 20,
              borderRadius: radius.full,
              // status.critical, the same red the app already uses for
              // destructive actions — not a new red chosen for this screen.
              backgroundColor: "#d03b3b",
              borderWidth: 1.5,
              borderColor: "#1a2022",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={11} color="#ffffff" />
          </Pressable>

          {/*
            Arrows rather than drag-to-reorder. A drag gesture inside a
            horizontal ScrollView that itself sits over a camera preview has
            two other gestures to disambiguate against, and getting that wrong
            means a section the owner cannot move at all. Two taps always work.
          */}
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, marginTop: 2 }}>
            <Pressable
              onPress={() => onMove(section.localId, -1)}
              disabled={index === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move section ${index + 1} earlier`}
              accessibilityState={{ disabled: index === 0 }}
              hitSlop={8}
              style={{ padding: 3, opacity: index === 0 ? 0.25 : 1 }}
            >
              <Ionicons name="chevron-back" size={14} color="rgba(255,255,255,0.85)" />
            </Pressable>
            <Pressable
              onPress={() => onMove(section.localId, 1)}
              disabled={index === sections.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move section ${index + 1} later`}
              accessibilityState={{ disabled: index === sections.length - 1 }}
              hitSlop={8}
              style={{ padding: 3, opacity: index === sections.length - 1 ? 0.25 : 1 }}
            >
              <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.85)" />
            </Pressable>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * The blur warning, shown against a section whose readability came back poor.
 *
 * Advisory and dismissible by ignoring it: the check runs against the same
 * measure the confirm screen uses, and that measure is explicitly documented
 * as a hint rather than a gate (backend/src/lib/imageQuality.ts). A crumpled
 * thermal receipt is sometimes simply the best photograph that exists of that
 * purchase.
 */
export function SectionQualityWarning({ text }: { text: string }) {
  return (
    <T style={{ fontSize: typeScale.axis, color: statusText.warning, marginTop: 2, textAlign: "center" }}>{text}</T>
  );
}
