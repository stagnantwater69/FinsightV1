import { View } from "react-native";
import { Card, T } from "../../../components/ui";
import { brand, font, ink, paper, space, status, statusText, typeScale } from "../../../theme/tokens";
import type { ReviewNotice } from "./types";

/**
 * Everything worth checking, gathered into one place.
 *
 * WHY THEY ARE NO LONGER SIX SEPARATE CALLOUTS. A blurry photo, a blurry
 * PAGE, a duplicated page, an overlapping section, two receipts in one shot
 * and an AI-assisted read are all possible at once, and on a bad scan several
 * fire together. Stacked, each in its own tinted panel with its own border
 * and its own icon, they filled the screen before a single figure was
 * visible — and a wall of warnings is read as one undifferentiated blob or
 * skipped entirely, which is the failure mode a warning can least afford.
 *
 * The wording of each is unchanged: they were written to say what to DO, and
 * shortening them to fit a tidier layout would trade the useful half for the
 * decorative one. What changes is that they share one panel, are counted, and
 * sit under a heading that says what they are.
 */
export function ReviewNotices({ notices }: { notices: ReviewNotice[] }) {
  if (notices.length === 0) return null;

  const worst = notices.some((n) => n.tone === "warn") ? "warn" : "info";
  const tint = worst === "warn" ? statusText.warning : brand[700];

  return (
    <Card style={{ borderColor: worst === "warn" ? status.warning : brand[200] }}>
      <T variant="heading" accessibilityRole="header" style={{ color: tint, marginBottom: space.sm }}>
        {notices.length === 1 ? "Worth checking" : `Worth checking (${notices.length})`}
      </T>
      <View style={{ gap: space.sm }}>
        {notices.map((notice, i) => (
          <View
            key={i}
            style={{
              flexDirection: "row",
              gap: space.sm,
              // A rule between entries rather than a box around each: they are
              // a list of related remarks, not six unrelated alerts.
              paddingTop: i === 0 ? 0 : space.sm,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: paper[200],
            }}
          >
            <T
              style={{
                fontSize: typeScale.label,
                fontFamily: font.sansSemibold,
                color: notice.tone === "warn" ? statusText.warning : brand[700],
              }}
            >
              {notice.tone === "warn" ? "⚠" : "ⓘ"}
            </T>
            <T style={{ flex: 1, fontSize: typeScale.label, lineHeight: 19, color: ink[700] }}>{notice.text}</T>
          </View>
        ))}
      </View>
    </Card>
  );
}
