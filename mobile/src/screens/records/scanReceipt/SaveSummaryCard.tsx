import { View } from "react-native";
import { Card, Money, T } from "../../../components/ui";
import { useTheme } from "../../../context/ThemeContext";
import { BAND_COPY, type ConfidenceBand } from "../../../lib/confidenceBands";
import * as haptics from "../../../lib/haptics";
import type { ReconciliationPlan } from "../../../lib/receiptConfirm";
import type { ExpenseCategory } from "../../../lib/types";
import { radius, space, typeScale } from "../../../theme/tokens";
import { CategoryChips } from "./CategoryChips";
import { GapOption } from "./GapOption";

/** The records an itemised receipt will become, and how any gap to the total is settled. */
export function SaveSummaryCard({
  band,
  gap,
  itemGroups,
  itemsTotal,
  categories,
  everyItemHasCategory,
  planResolved,
  canFileGapOnItsOwn,
  plan,
  onPlan,
  gapCategoryId,
  onGapCategory,
  stackedFigures,
}: {
  band: ConfidenceBand;
  /** Total minus items, in centavos. */
  gap: number;
  itemGroups: [number | null, { total: number; count: number }][];
  itemsTotal: number;
  categories: ExpenseCategory[];
  everyItemHasCategory: boolean;
  planResolved: boolean;
  canFileGapOnItsOwn: boolean;
  plan: ReconciliationPlan;
  onPlan: (plan: ReconciliationPlan) => void;
  gapCategoryId: number | null;
  onGapCategory: (id: number | null) => void;
  stackedFigures: boolean;
}) {
  const { brand, ink, statusText, statusSurface } = useTheme();
  return (
    <Card emphasis>
      <View>
        <View
          style={{
            flexDirection: stackedFigures ? "column" : "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
            marginBottom: space.sm,
          }}
        >
          <View style={{ flex: 1 }}>
            <T variant="heading" accessibilityRole="header" style={{ color: brand[900] }}>
              What gets saved
            </T>
            {/* The band, not the percentage — the number is at the
                top of the screen in words already, and repeating
                it here as "87%" would put the two cues back into
                competition. */}
            <T variant="caption">{BAND_COPY[band].label}</T>
          </View>
          {/*
            Whether the receipt balances, stated as a badge rather
            than left for the owner to work out by comparing two
            numbers in different places. Colour is never the only
            signal — the badge carries a glyph and words.
          */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: space.sm,
              paddingVertical: 3,
              borderRadius: radius.full,
              // The wash under the balance badge, paired with the
              // `statusText` step written on it. Both halves have
              // to come from the same family or the pair stops
              // clearing contrast the moment the page goes dark —
              // these were Light's literal surfaces, which left a
              // near-white pill behind light green text in Dark.
              backgroundColor: gap === 0 ? statusSurface.good : statusSurface.warning,
            }}
          >
            <T
              style={{
                fontSize: typeScale.micro,
                color: gap === 0 ? statusText.good : statusText.warning,
              }}
            >
              {gap === 0
                ? "✓ Balances"
                : `⚠ ${gap > 0 ? "Short" : "Over"} PHP ${(Math.abs(gap) / 100).toFixed(2)}`}
            </T>
          </View>
        </View>
        {itemGroups.map(([catId, g]) => (
          <View
            key={String(catId)}
            style={{ flexDirection: stackedFigures ? "column" : "row", justifyContent: "space-between", gap: space.sm, marginTop: space.sm }}
          >
            <T style={{ flex: 1, fontSize: typeScale.label, color: catId == null ? statusText.warning : ink[700] }}>
              {catId == null
                ? "Not categorised yet"
                : (categories.find((c) => c.id === catId)?.name ?? "Category")}
              <T variant="caption"> ({g.count} item{g.count === 1 ? "" : "s"})</T>
            </T>
            <Money value={g.total} size={13} decimals />
          </View>
        ))}
        <T
          variant="caption"
          style={{ marginTop: space.sm, color: everyItemHasCategory && planResolved ? statusText.good : statusText.warning }}
        >
          {!everyItemHasCategory
            ? "⚠ Every item needs a category before this can be saved."
            : gap === 0
              ? `✓ ${itemGroups.length} record${itemGroups.length === 1 ? "" : "s"} will be saved, adding up to the receipt total.`
              : plan === "shrink"
                ? `✓ The receipt will be saved as PHP ${itemsTotal.toFixed(2)} — the items' own total.`
                : planResolved
                  ? "✓ Ready to save."
                  : gap > 0
                    ? `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(gap / 100).toFixed(2)} less than the total above.`
                    : `⚠ The items come to PHP ${itemsTotal.toFixed(2)}, which is PHP ${(-gap / 100).toFixed(2)} more than the total above.`}
        </T>
      </View>

      {/*
        Accounting for the difference.

        A gap is normal rather than a mistake: a VAT-exclusive
        register adds tax on top of the printed lines, a discount
        takes money off, and OCR sometimes just misses a line. So the
        screen asks what the difference IS instead of blocking until
        the arithmetic works — which, on a VAT-exclusive receipt, it
        never would. The total never changes on its own; only the
        last option touches it, and only to figures read off the
        receipt.
      */}
      {everyItemHasCategory && gap !== 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="label" style={{ color: ink[700], marginBottom: 4 }}>
            {gap > 0
              ? `What is the missing PHP ${(gap / 100).toFixed(2)}?`
              : `What is the extra PHP ${(-gap / 100).toFixed(2)}?`}
          </T>
          <T variant="caption" style={{ marginBottom: space.sm }}>
            {gap > 0
              ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
              : "A discount or a voided line usually explains this."}
          </T>

          <GapOption
            selected={plan === "proportional"}
            onPress={() => {
              haptics.tapped();
              onPlan("proportional");
            }}
            title={gap > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
            detail="Split across the categories above, in proportion to what each came to. Keeps every category's spending accurate."
          />
          {canFileGapOnItsOwn ? (
            <GapOption
              selected={plan === "category"}
              onPress={() => {
                haptics.tapped();
                onPlan("category");
              }}
              title="A separate charge to track on its own"
              detail="Saved as its own expense record under one category."
            >
              {plan === "category" ? (
                <View style={{ marginTop: space.sm }}>
                  <CategoryChips
                    categories={categories}
                    value={gapCategoryId}
                    onChange={onGapCategory}
                    label="the remaining amount"
                  />
                </View>
              ) : null}
            </GapOption>
          ) : null}
          <GapOption
            selected={plan === "shrink"}
            onPress={() => {
              haptics.tapped();
              onPlan("shrink");
            }}
            title="FinSight misread the receipt total"
            detail={`Save PHP ${itemsTotal.toFixed(2)} — the items' own total — instead of the amount above.`}
          />
        </View>
      ) : null}
    </Card>
  );
}
