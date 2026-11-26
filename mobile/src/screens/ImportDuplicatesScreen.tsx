import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, Disclosure, Screen, T } from "../components/ui";
import { ContentScrollView } from "../components/ContentScrollView";
import { FAB_CLEARANCE } from "../components/AskFinSightFab";
import { ImportDuplicateCards } from "../components/ImportDuplicateCards";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { formatDueDate } from "../lib/recurringAgenda";
import type { InsightsScreenProps } from "../navigation/types";
import { font, space, typeScale } from "../theme/tokens";

/**
 * One CSV import whose rows were flagged as duplicates, opened from its row on
 * the Review tab. The page is about that import: what it is, why its rows were
 * flagged, and the one decision for the whole file. Its rows stay folded away
 * until asked for.
 */
export function ImportDuplicatesScreen({ navigation, route }: InsightsScreenProps<"ImportDuplicates">) {
  const { records, hasMore } = route.params;
  const t = useTheme();
  const { selected, categories } = useBusinessProfiles();
  if (!selected) return null;

  const dates = records.map((r) => r.date.slice(0, 10)).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const span = first && last ? (first === last ? formatDueDate(first) : `${formatDueDate(first)} – ${formatDueDate(last)}`) : "";
  const categoryNames = [...new Set(records.map((r) => r.type === "sales" ? "Sales" : categories.find((c) => c.id === r.categoryId)?.name ?? "Uncategorized"))];
  const originals = records.filter((r) => r.duplicateOfRecordId !== null).length;
  const line = { fontSize: typeScale.bodySm, color: t.textSecondary };
  const fact = (label: string, value: string) => (
    <View key={label} style={{ flexDirection: "row", gap: space.md }}>
      <T style={{ ...line, width: 96 }}>{label}</T>
      <T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textPrimary }}>{value}</T>
    </View>
  );

  return (
    <Screen>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}>
        <ImportDuplicateCards records={records} hasMore={hasMore} businessProfileId={selected.id} onChanged={() => navigation.goBack()} />

        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="help-circle-outline" size={20} color={t.textMuted} />
            <T accessibilityRole="header" style={{ flex: 1, fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>Why these were flagged</T>
          </View>
          <T style={line}>
            {`${originals === records.length ? "Every row in this file has" : `${originals} of the ${records.length} rows in this file ${originals === 1 ? "has" : "have"}`} the same date and amount as a record you already had, with a matching description. That usually means the file, or part of it, was imported twice.`}
          </T>
          <View style={{ gap: space.sm }}>
            {fact("Dates", span)}
            {fact("Categories", categoryNames.join(", "))}
            {fact("Total", formatMoney(records.reduce((sum, r) => sum + r.amount, 0)))}
          </View>
        </Card>

        <Card style={{ gap: space.sm }}>
          <T accessibilityRole="header" style={{ fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>What each choice does</T>
          <T style={line}>Keep all: they are real, separate records. They stay and stop being flagged.</T>
          <T style={line}>Discard all: they are copies. They are deleted; the records they copy are not touched.</T>
        </Card>

        <Disclosure title={`The ${records.length} flagged rows`}>
          <View style={{ gap: space.sm }}>
            {records.map((r) => (
              <View key={`${r.type}-${r.id}`} style={{ gap: 2 }}>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: t.textPrimary }}>{r.description.split(";")[0].trim() || r.description}</T>
                  <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoSemibold, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(r.amount)}</T>
                </View>
                <T variant="caption">{`${formatDueDate(r.date) || r.date.slice(0, 10)}${r.duplicateOfRecordId ? ` · same as record #${r.duplicateOfRecordId}` : ""}`}</T>
              </View>
            ))}
          </View>
        </Disclosure>
      </ContentScrollView>
    </Screen>
  );
}
