import { View } from "react-native";
import { T } from "../../../components/ui";
import { brand, radius, space } from "../../../theme/tokens";

/**
 * Where the owner is in the three steps.
 *
 * Bars rather than filled circles, matching SetupProgress — a fully-rounded
 * brand-filled shape is this app's SELECTION CHIP, and borrowing its look for
 * something that cannot be tapped is exactly the drift chipConsistency exists
 * to stop.
 */
export function ImportSteps({ current }: { current: 0 | 1 | 2 }) {
  const labels = ["Choose file", "Map columns", "Review rows"];
  return (
    <View style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {labels.map((label, i) => (
          <View
            key={label}
            style={{ flex: 1, height: 6, borderRadius: radius.sm, backgroundColor: i <= current ? brand[500] : brand[200] }}
          />
        ))}
      </View>
      <T variant="caption" style={{ marginTop: 6 }}>
        Step {current + 1} of 3 · {labels[current]}
      </T>
    </View>
  );
}
