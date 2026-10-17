import { View } from "react-native";
import { Button, T } from "../../../components/ui";
import { SkeletonBox } from "../../../components/Skeleton";
import { space } from "../../../theme/tokens";
import { ScanningThumbnail } from "./ScanningThumbnail";
import { cancelsAnUpload } from "./scanSession";

/** The upload and read wait: what is happening, the photo being read, and a way to stop. */
export function ScanProgress({ phase, thumbnailUri, onStop }: { phase: string; thumbnailUri?: string; onStop: () => void }) {
  return (
    <View style={{ gap: space.sm, paddingVertical: space.md }}>
      <T variant="caption" accessibilityLiveRegion="polite" style={{ marginBottom: space.xs }}>{phase}</T>
      {thumbnailUri !== undefined ? <ScanningThumbnail uri={thumbnailUri} /> : null}
      <SkeletonBox width="40%" height={14} />
      <SkeletonBox height={14} />
      <SkeletonBox width="70%" height={14} />
      <SkeletonBox width="55%" height={14} />
      <Button title={cancelsAnUpload(phase) ? "Cancel upload" : "Stop waiting"} variant="ghost" onPress={onStop} />
    </View>
  );
}
