import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Field, Money, T } from "../../../components/ui";
import { ResultDetails } from "../../../components/ResultDetails";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { useTheme } from "../../../context/ThemeContext";
import { BAND_COPY, confidenceBand, needsAttention } from "../../../lib/confidenceBands";
import { categoryReviewNote } from "../../../lib/categorySuggestion";
import { evidenceSummary } from "../../../lib/receiptWarnings";
import { radius, space, typeScale } from "../../../theme/tokens";
import { CategoryChips } from "./CategoryChips";
import type { ExpenseCategory } from "../../../lib/types";
import type { ScannedItem } from "./types";

/** One extracted receipt line: its figures, its warnings, its category and its edit controls. */
export function ScannedItemRow({
  item,
  categories,
  categoryId,
  editing,
  editingErrors,
  locked,
  saving,
  removing,
  repeatKept,
  suspect,
  suggestedCategory,
  creatingCategory,
  onStartEdit,
  onEditName,
  onEditAmount,
  onSaveEdit,
  onCancelEdit,
  onRemove,
  onKeepRepeat,
  onCategory,
  onAcceptSuggestion,
}: {
  item: ScannedItem;
  categories: ExpenseCategory[];
  categoryId: number | null;
  /** The open correction for this row, if any. */
  editing: { name: string; amount: string } | null;
  editingErrors: { name?: string; amount?: string };
  /** Some row is being edited, saved or removed. */
  locked: boolean;
  saving: boolean;
  removing: boolean;
  repeatKept: boolean;
  suspect: boolean;
  suggestedCategory: string | null;
  creatingCategory: string | null;
  onStartEdit: () => void;
  onEditName: (name: string) => void;
  onEditAmount: (amount: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onRemove: () => void;
  onKeepRepeat: () => void;
  onCategory: (id: number | null) => void;
  onAcceptSuggestion: () => void;
}) {
  const { brand, ink, paper, statusText, statusSurface } = useTheme();
  return (
    <View
      /*
        A rule ABOVE each row and generous padding, rather than
        a box per item. A receipt can carry a dozen lines and
        boxing each one turns the list into a stack of cards
        inside a card; a rule separates them at a fraction of
        the visual weight.
      */
      style={{
        borderTopWidth: 1,
        borderTopColor: paper[200],
        paddingTop: space.md,
        paddingBottom: space.md,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900], lineHeight: 20 }}>
          {item.name}
          {item.quantity != null ? (
            <T variant="caption"> × {item.quantity}</T>
          ) : null}
        </T>
        {/*
          `decimals` is not cosmetic here. Without it
          toLocaleString ROUNDS to whole pesos, so a 123.50
          line printed as "PHP 124" — a figure that appears
          nowhere on the receipt — and a column of them stopped
          adding up to the total shown above. Whole pesos are
          right for a summary; they are wrong for a line the
          owner is checking against paper. Web's own scan
          review passes it on every amount for this reason.
        */}
        <Money value={item.amount} size={14} weight="semibold" decimals />
        <Pressable
          onPress={onStartEdit}
          disabled={locked}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${item.name}`}
          style={{
            width: TAP_FLOOR,
            height: TAP_FLOOR,
            borderRadius: radius.full,
            alignItems: "center",
            justifyContent: "center",
            opacity: locked ? 0.4 : 1,
          }}
        >
          <Ionicons name="pencil-outline" size={18} color={ink[600]} />
        </Pressable>
        {/* Removing a line OCR should never have read. */}
        <Pressable
          onPress={onRemove}
          disabled={locked}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.name} — this was not a purchase`}
          style={{
            width: TAP_FLOOR,
            height: TAP_FLOOR,
            borderRadius: radius.full,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: paper[100],
            opacity: locked ? 0.4 : 1,
          }}
        >
          {/*
            An icon rather than a "×" glyph: the glyph rendered
            at whatever weight the system font gave it, which
            beside a bold amount read as punctuation rather
            than as a control.
          */}
          <Ionicons name="close" size={14} color={ink[500]} />
        </Pressable>
      </View>

      {editing ? (
        <View style={{ marginTop: space.sm }}>
          <Field
            label="Item name"
            accessibilityLabel={`Edit item name for ${item.name}`}
            value={editing.name}
            maxLength={255}
            error={editingErrors.name}
            onChangeText={onEditName}
            returnKeyType="next"
          />
          <Field
            label="Item amount (PHP)"
            accessibilityLabel={`Edit item amount for ${item.name}`}
            value={editing.amount}
            error={editingErrors.amount}
            onChangeText={onEditAmount}
            keyboardType="decimal-pad"
            returnKeyType="done"
            onSubmitEditing={onSaveEdit}
          />
          <Button
            title="Save item changes"
            variant="secondary"
            loading={saving}
            onPress={onSaveEdit}
          />
          <Button
            title="Cancel item edit"
            variant="ghost"
            disabled={saving}
            onPress={onCancelEdit}
          />
        </View>
      ) : null}

      {/*
        A line a model inferred from a photograph must not look
        like one read off text. Marked per row, because the row
        is where the owner actually decides.
      */}
      {item.extractedByVision ? (
        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
          ✦ AI read this from the photo
        </T>
      ) : null}

      {/*
        A line that may be the overlap between two photos read
        twice. FinSight only removes a repeat on its own when
        the receipt's total proves it; anything short of that
        is the owner's call, made here on the row.
      */}
      {item.possibleRepeatOf && !repeatKept ? (
        <View style={{ marginTop: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: statusSurface.warning, gap: space.sm }}>
          <T variant="caption" style={{ color: statusText.warning }}>
            May be counted twice. Your photos overlap, and page {item.possibleRepeatOf.pageNumber} also shows {item.possibleRepeatOf.name} for PHP {item.possibleRepeatOf.amount.toFixed(2)}.
          </T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <Button
              title="Remove repeat"
              accessibilityLabel={`Remove ${item.name}, it repeats page ${item.possibleRepeatOf.pageNumber}`}
              variant="secondary"
              loading={removing}
              disabled={locked}
              onPress={onRemove}
            />
            <Button
              title="Keep both"
              accessibilityLabel={`Keep ${item.name}, it is a separate purchase`}
              variant="ghost"
              disabled={removing}
              onPress={onKeepRepeat}
            />
          </View>
        </View>
      ) : null}

      {/*
        The server names the line it is least sure of when the
        items do not add up. Pointing at one row beats asking the
        owner to re-read all nine.
      */}
      {suspect ? (
        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
          ⚠ Check this one first — the items don't add up to the total
        </T>
      ) : needsAttention({
          confidence: item.amountConfidence,
          visionAssisted: item.extractedByVision,
        }) && typeof item.amountConfidence === "number" ? (
        /*
          The BAND, not "FinSight was 62% sure of this amount".
          A percentage against one line invited the owner to
          grade it, and it used its own 75 cutoff — a third
          opinion about the same number. Same mapping as the
          heading now (lib/confidenceBands.ts).
        */
        <T variant="caption" style={{ marginTop: 2, color: statusText.warning }}>
          {BAND_COPY[confidenceBand({
            confidence: item.amountConfidence,
            visionAssisted: item.extractedByVision,
          })].label} — check this amount against the receipt
        </T>
      ) : null}
      {/* Which printed line this came from, where the server
          could locate it. Never invented. */}
      {evidenceSummary(item.evidence) ? <ResultDetails label={`source for ${item.name}`}><T variant="caption">{evidenceSummary(item.evidence)}</T></ResultDetails> : null}

      <View style={{ marginTop: space.sm }}>
        <CategoryChips
          categories={categories}
          value={categoryId}
          // No haptic here: the chip fires its own, and firing a
          // second would buzz twice for one tap.
          onChange={onCategory}
          label={item.name}
        />
      </View>
      {/*
        Why FinSight is unsure about this line's category, until
        the owner answers it by choosing one themselves.
      */}
      {categoryReviewNote(item, categoryId) ? (
        <T variant="caption" style={{ marginTop: space.xs, color: statusText.warning }}>
          {categoryReviewNote(item, categoryId)}
        </T>
      ) : null}

      {/*
        A category FinSight thinks is missing.

        Phrased as an offer rather than an assignment, because
        nothing is created until the owner says so — inventing
        categories in someone's books is not FinSight's call.
      */}
      {suggestedCategory ? (
        <Pressable
          onPress={onAcceptSuggestion}
          disabled={creatingCategory !== null}
          accessibilityRole="button"
          accessibilityLabel={`Create the category ${item.suggestedCategoryName} and file ${item.name} under it`}
          style={{ marginTop: space.sm, opacity: creatingCategory !== null ? 0.5 : 1 }}
        >
          <T variant="caption" style={{ color: brand[700] }}>
            {creatingCategory === item.suggestedCategoryName
              ? "Creating…"
              : `✦ Nothing fits this. Create "${item.suggestedCategoryName}"?`}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}
