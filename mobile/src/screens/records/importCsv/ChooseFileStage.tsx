import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { CONTENT_WIDTH, ContentScrollView } from "../../../components/ContentScrollView";
import { Button, ErrorNote, T } from "../../../components/ui";
import { ResultDetails } from "../../../components/ResultDetails";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { useTheme } from "../../../context/ThemeContext";
import { radius, space } from "../../../theme/tokens";
import { ImportSteps } from "./ImportSteps";

const REQUIREMENTS = [
  ["Column names in the first row", "Use a header row so FinSight can read your file."],
  ["Date, description and amount", "One transaction per row. Amounts should be in Philippine pesos."],
  ["Save your spreadsheet as CSV", "Export a CSV file from Excel, Google Sheets or your sales app."],
] as const;

export function ChooseFileStage({ businessName, bottomInset, busy, error, onChoose }: {
  businessName: string;
  bottomInset: number;
  busy: boolean;
  error: string | null;
  onChoose: () => void;
}) {
  const t = useTheme();
  return (
    <>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <T variant="caption">{businessName}</T>
        <ImportSteps current={0} />
        <View style={{ gap: space.sm }}>
          <T variant="title" accessibilityRole="header">Bring in your records</T>
          <T>Import sales, expenses or both from a CSV file.</T>
        </View>
        <Pressable onPress={onChoose} disabled={busy} accessibilityRole="button" accessibilityLabel="Choose a CSV file from your phone or cloud storage" accessibilityState={{ disabled: busy }} style={{ minHeight: TAP_FLOOR, alignItems: "center", gap: space.sm, paddingVertical: space.xxl, paddingHorizontal: space.lg, borderWidth: 1, borderStyle: "dashed", borderColor: t.borderStrong, borderRadius: radius.lg, backgroundColor: t.brandSurface }}>
          <Ionicons name="document-text-outline" size={42} color={t.brandText} accessible={false} />
          <T variant="heading">Choose a CSV file</T>
          <T variant="caption" style={{ textAlign: "center" }}>From your phone or cloud storage</T>
          <T variant="caption">CSV · Up to 5 MB</T>
        </Pressable>
        <View style={{ gap: space.md }}>
          <T variant="heading" accessibilityRole="header">Before you import</T>
          {REQUIREMENTS.map(([title, help]) => (
            <View key={title} style={{ flexDirection: "row", gap: space.md }}>
              <Ionicons name="checkmark-circle" size={22} color={t.brandText} accessible={false} />
              <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                <T variant="label">{title}</T>
                <T variant="caption">{help}</T>
              </View>
            </View>
          ))}
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.sm }}>
          <ResultDetails label="CSV example" title="View a CSV example">
            <T variant="caption">Vendor and category are optional. Use dates like 2026-09-01 where possible. For mixed files, add a type column with sale or expense.</T>
            <T variant="caption" selectable>{"date,description,amount,category,vendor\n2026-09-01,Coffee beans,450,Inventory,Local supplier"}</T>
            <T variant="caption">Use UTF-8 when saving your file. Extra columns, including tax and currency, are not imported.</T>
          </ResultDetails>
        </View>
      </ContentScrollView>
      <View style={{ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, padding: space.md, paddingBottom: Math.max(bottomInset, space.md), gap: space.sm }}>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button title="Choose a CSV file" variant="primary" onPress={onChoose} loading={busy} />
        <T variant="caption" style={{ textAlign: "center" }}>Nothing is added until you confirm.</T>
      </View>
    </>
  );
}
