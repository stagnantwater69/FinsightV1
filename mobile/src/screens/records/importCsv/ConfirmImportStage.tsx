import { useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { CONTENT_WIDTH, ContentScrollView } from "../../../components/ContentScrollView";
import { Button, Callout, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { font, radius, space, typeScale } from "../../../theme/tokens";
import { ImportSteps } from "./ImportSteps";

export function ConfirmImportStage({ businessName, title, fileName, ready, skipped, excluded, duplicates, newCategories, bottomInset, busy, onImport, onBack }: {
  businessName: string;
  title: string;
  fileName: string;
  ready: number;
  skipped: number;
  excluded: number;
  duplicates: number;
  newCategories: string[];
  bottomInset: number;
  busy: boolean;
  onImport: () => void;
  onBack: () => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackedSummary = width < 360 || fontScale > 1.2;
  return (
    <>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <ImportSteps current={2} />
        <View style={{ gap: space.sm }}>
          <T variant="title" accessibilityRole="header">Import these records?</T>
          <T>They will be added to {businessName}.</T>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1, borderColor: t.border, borderRadius: radius.md, padding: space.md }}>
          <Ionicons name="document-text-outline" size={28} color={t.brandText} accessible={false} />
          <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
            <T variant="label">{title}</T>
            <T variant="caption">{fileName}</T>
          </View>
        </View>
        <View style={{ gap: space.md }}>
          {([[ready, "Ready to import", t.brandText], [skipped, "Will be skipped", t.statusText.warning]] as const).map(([count, label, color]) => (
            <View key={label} accessible accessibilityLabel={`${label}: ${count.toLocaleString()}`} style={{ flexDirection: stackedSummary ? "column" : "row", alignItems: stackedSummary ? "flex-start" : "baseline", justifyContent: "space-between", gap: stackedSummary ? space.xs : space.md, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <T>{label}</T>
              <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.title, color }}>{count.toLocaleString()}</T>
            </View>
          ))}
        </View>
        {excluded > 0 ? <T variant="caption" accessibilityLabel={`Left out by you: ${excluded.toLocaleString()}, included in will be skipped`}>Includes {excluded.toLocaleString()} left out by you.</T> : null}
        {skipped > 0 ? <T variant="caption">Skipped records will not be added. Go back to review if you want to fix them.</T> : null}
        {duplicates > 0 ? <Callout tone="warn">{duplicates.toLocaleString()} possible duplicate{duplicates === 1 ? "" : "s"} will be flagged if imported. They are included in the ready count.</Callout> : null}
        {newCategories.length > 0 ? <Callout tone="info">New categories: {newCategories.join(", ")}. Created when you import.</Callout> : null}
        <T variant="caption">Your original file stays the same. Only the ready records will be added.</T>
      </ContentScrollView>
      <View style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, padding: space.md, paddingBottom: Math.max(bottomInset, space.md), gap: space.sm }}>
        <Button title={`Import ${ready.toLocaleString()} record${ready === 1 ? "" : "s"}`} variant="primary" onPress={onImport} loading={busy} disabled={ready === 0} />
        <Button title="Back to review" variant="secondary" onPress={onBack} disabled={busy} />
      </View>
    </>
  );
}
