import { View } from "react-native";
import { Card, T } from "../../../components/ui";
import { BAND_COPY, type scanConfidenceBand } from "../../../lib/confidenceBands";
import { font, space, typeScale } from "../../../theme/tokens";
import { useTheme } from "../../../context/ThemeContext";

/**
 * How much of this reading the owner should distrust, said in words.
 *
 * WHAT IT REPLACES: "Reading confidence 87%", which is not a sentence anyone
 * can act on — 87 of what, out of what, and is that good? It was tesseract's
 * mean per-word certainty for the page, a property of the ENGINE rather than a
 * probability that the total is right, and owners read it as the latter. The
 * band says what to DO instead; the number survives only where it is evidence
 * (an item's own reading), never as the headline.
 *
 * The mapping is lib/confidenceBands.ts, shared with the website and pinned
 * against it by tests/webParity.test.ts — the same receipt must not be called
 * clear on a laptop and suspect on a phone.
 */
export function ScanBand({ band, fields }: { band: ReturnType<typeof scanConfidenceBand>; fields: string[] }) {
  const t = useTheme();
  const copy = BAND_COPY[band];
  const tint = t.statusText[copy.tone];
  return (
    <Card style={{ borderColor: t.status[copy.tone] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {/* A glyph and words as well as the tint — never colour alone. */}
        <T style={{ fontSize: typeScale.label, color: tint, fontFamily: font.sansSemibold }}>
          {band === "clear" ? "✓" : "⚠"}
        </T>
        <T
          accessibilityRole="header"
          style={{ flex: 1, fontSize: typeScale.bodyLg, color: tint, fontFamily: font.sansSemibold }}
        >
          {copy.label}
        </T>
      </View>
      <T style={{ fontSize: typeScale.label, lineHeight: 19, color: t.textSecondary, marginTop: 4 }}>{copy.detail}</T>
      {fields.length > 0 ? (
        <T variant="caption" style={{ marginTop: space.sm, color: tint }}>
          Worth checking first: {fields.join(", ")}.
        </T>
      ) : null}
    </Card>
  );
}
