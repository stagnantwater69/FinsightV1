import { Button, Card, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { space } from "../../../theme/tokens";

/** Says a stored draft replaced the scanned values, and offers the way back. */
export function RestoredReviewNotice({ onDiscard, disabled }: { onDiscard: () => void; disabled?: boolean }) {
  const { brand } = useTheme();
  return (
    <Card style={{ borderColor: brand[200], gap: space.sm }}>
      <T variant="heading" accessibilityRole="header" accessibilityLiveRegion="polite" style={{ color: brand[700] }}>
        Your unsaved changes were restored
      </T>
      <T variant="caption">
        These are the corrections you made before leaving this receipt. Check them, then save, or go back to the scanned values.
      </T>
      <Button
        title="Discard restored changes"
        accessibilityLabel="Discard restored changes and show the scanned values"
        variant="ghost"
        disabled={disabled}
        onPress={onDiscard}
      />
    </Card>
  );
}
