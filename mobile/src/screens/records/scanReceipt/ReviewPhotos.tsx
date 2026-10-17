import { Image, Pressable, ScrollView, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { font, radius, space, typeScale } from "../../../theme/tokens";
import type { CapturedPage } from "./types";

/** The review's opening card: every page that was read, each opening the evidence viewer. */
export function ReviewPhotos({ pages, onInspect }: { pages: CapturedPage[]; onInspect: (pageIndex: number) => void }) {
  const { ink, paper } = useTheme();
  return (
    pages.length > 0 ? (
      <Card>
        <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
        <T variant="caption" style={{ marginBottom: space.md }}>
          Receipt scanned. Open each page to check the source image and any edited version before saving.
        </T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {pages.map((p, i) => (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityLabel={pages.length === 1 ? "Inspect receipt image" : `Inspect receipt page ${i + 1} of ${pages.length}`}
                onPress={() => onInspect(i)}
                style={{
                  width: 96,
                  height: 128,
                  borderRadius: radius.sm,
                  overflow: "hidden",
                  backgroundColor: paper[100],
                  borderWidth: 1,
                  borderColor: ink[200],
                }}
              >
                {p.uri ? (
                  <Image
                    source={{ uri: p.uri }}
                    style={{ width: "100%", height: "100%" }}
                    resizeMode="cover"
                    accessible={false}
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.xs }}>
                    <Ionicons name="receipt-outline" size={24} color={ink[500]} />
                    <T variant="caption" style={{ color: ink[600], textAlign: "center" }}>Open stored image</T>
                  </View>
                )}
                {pages.length > 1 ? (
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
                    <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink[700] }}>{i + 1}</T>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </Card>
    ) : (
      <Card>
        <T variant="title" style={{ marginBottom: 2 }}>Check the details</T>
        <T variant="caption">
          Receipt scanned. Review the details before saving.
        </T>
      </Card>
    )
  );
}
