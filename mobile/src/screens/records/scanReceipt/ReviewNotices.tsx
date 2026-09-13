import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, T } from "../../../components/ui";
import { ResultDetails } from "../../../components/ResultDetails";
import { space, typeScale } from "../../../theme/tokens";
import { useTheme } from "../../../context/ThemeContext";
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
 * Required warnings stay visible. Optional evidence and informational notes
 * are available on demand without obscuring the receipt fields.
 */
export function ReviewNotices({ notices }: { notices: ReviewNotice[] }) {
  const t = useTheme();
  const { brand, ink, paper, statusText, status } = t;
  const unique = notices.filter((notice, index) => notices.findIndex((other) => other.text === notice.text) === index);
  const warnings = unique.filter((notice) => notice.tone === "warn");
  const details = unique.filter((notice) => notice.tone === "info" || notice.detail);
  if (notices.length === 0) return null;

  const worst = notices.some((n) => n.tone === "warn") ? "warn" : "info";
  const tint = worst === "warn" ? statusText.warning : brand[700];

  return (
    <Card style={{ borderColor: worst === "warn" ? status.warning : brand[200] }}>
      <T variant="heading" accessibilityRole="header" style={{ color: tint, marginBottom: space.sm }}>
        {warnings.length ? "Check before saving" : "Scan notes"}
      </T>
      <View style={{ gap: space.sm }}>
        {warnings.map((notice, i) => (
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
            <Ionicons name="alert-circle-outline" size={18} color={statusText.warning} />
            <T style={{ flex: 1, fontSize: typeScale.label, lineHeight: 19, color: ink[700] }}>{notice.text}</T>
          </View>
        ))}
        {details.length ? (
          <ResultDetails label="scan notes">
            {details.map((notice) => (
              <T key={notice.text} variant="caption">
                {notice.tone === "info" ? notice.text : ""}
                {notice.detail ? `${notice.tone === "info" ? " " : ""}${notice.detail}` : ""}
              </T>
            ))}
          </ResultDetails>
        ) : null}
      </View>
    </Card>
  );
}
