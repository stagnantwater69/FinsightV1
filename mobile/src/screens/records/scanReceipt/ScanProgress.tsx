import { View } from "react-native";
import { Button, Money, T } from "../../../components/ui";
import { SkeletonBox } from "../../../components/Skeleton";
import { useTheme } from "../../../context/ThemeContext";
import { space, typeScale } from "../../../theme/tokens";
import { ScanningThumbnail } from "./ScanningThumbnail";
import { cancelsAnUpload } from "./scanSession";
import type { ReceiptLocalPreview } from "./types";

/**
 * The upload and read wait: what is happening, the photo being read, and a way to stop.
 *
 * Once the photo itself has been read, its headline fields replace the
 * placeholder bars while the second check runs. They are marked as
 * provisional and carry no actions: nothing can be saved until the read ends.
 */
export function ScanProgress({
  phase,
  thumbnailUri,
  earlyReading = null,
  onStop,
}: {
  phase: string;
  thumbnailUri?: string;
  earlyReading?: ReceiptLocalPreview | null;
  onStop: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: space.sm, paddingVertical: space.md }}>
      <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.xs }}>{phase}</T>
      {thumbnailUri !== undefined ? <ScanningThumbnail uri={thumbnailUri} /> : null}
      {earlyReading ? (
        <View style={{ gap: space.xs }}>
          <T variant="label" accessibilityRole="header" style={{ color: t.textPrimary }}>Read from your photo so far</T>
          <EarlyField label="Store" value={earlyReading.vendor} />
          <EarlyField label="Date" value={earlyReading.date} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
            <T variant="caption">Total</T>
            {earlyReading.amount !== null
              ? <Money value={earlyReading.amount} decimals size={typeScale.bodySm} />
              : <T variant="caption">Not read yet</T>}
          </View>
          <T variant="caption" style={{ marginTop: space.xs }}>Still being checked. These can change before you review them.</T>
        </View>
      ) : (
        <>
          <SkeletonBox width="40%" height={14} />
          <SkeletonBox height={14} />
          <SkeletonBox width="70%" height={14} />
          <SkeletonBox width="55%" height={14} />
        </>
      )}
      <Button title={cancelsAnUpload(phase) ? "Cancel upload" : "Stop waiting"} variant="ghost" onPress={onStop} />
    </View>
  );
}

function EarlyField({ label, value }: { label: string; value: string | null }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
      <T variant="caption">{label}</T>
      <T numberOfLines={1} style={{ flexShrink: 1, textAlign: "right", color: t.textPrimary, fontSize: typeScale.bodySm }}>
        {value ?? "Not read yet"}
      </T>
    </View>
  );
}
