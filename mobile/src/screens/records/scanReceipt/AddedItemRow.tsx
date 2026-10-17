import { useRef } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Field, T } from "../../../components/ui";
import { TAP_FLOOR } from "../../../components/touchTarget";
import { useTheme } from "../../../context/ThemeContext";
import type { ReceiptReviewAddedItem } from "../../../lib/receiptReviewDraft";
import type { ExpenseCategory } from "../../../lib/types";
import { space, typeScale } from "../../../theme/tokens";
import { CategoryChips } from "./CategoryChips";

/**
 * A line the owner is adding because OCR missed it.
 *
 * Each row holds its own amount ref, so the name field hands off to the
 * amount on the SAME row rather than to whichever row rendered last.
 */
export function AddedItemRow({
  added,
  index,
  categories,
  onChange,
  onRemove,
}: {
  added: ReceiptReviewAddedItem;
  index: number;
  categories: ExpenseCategory[];
  onChange: (patch: Partial<Omit<ReceiptReviewAddedItem, "key">>) => void;
  onRemove: () => void;
}) {
  const { ink, paper } = useTheme();
  const amountRef = useRef<TextInput>(null);
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: paper[100],
        backgroundColor: paper[50],
        paddingVertical: space.sm,
        paddingHorizontal: space.sm,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T variant="caption">You're adding this line</T>
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove added item ${index + 1}`}
          /*
           * Was 32 x 28 with no hitSlop at all — the smallest
           * target left in the app, on a destructive control.
           * Laid out to the floor rather than slopped: it is
           * the right-hand end of a two-item `space-between`
           * row whose other item is a caption, so nothing
           * tappable is anywhere near it, and the block below
           * it is a form field rather than more chrome.
           */
          style={{
            minWidth: TAP_FLOOR,
            minHeight: TAP_FLOOR,
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <T style={{ fontSize: typeScale.bodyLg, color: ink[400] }}>×</T>
        </Pressable>
      </View>
      <Field
        label="Item name"
        value={added.name}
        onChangeText={(name: string) => onChange({ name })}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => amountRef.current?.focus()}
      />
      <Field
        ref={amountRef}
        label="Amount (PHP)"
        value={added.amount}
        keyboardType="decimal-pad"
        // The row ends at its category chips, which are pressables
        // and cannot be focused from a keyboard — so this closes
        // the keyboard and leaves the chips visible underneath.
        returnKeyType="done"
        onChangeText={(amount: string) => onChange({ amount })}
      />
      <CategoryChips
        categories={categories}
        value={added.categoryId}
        onChange={(categoryId) => onChange({ categoryId })}
        label={added.name || `added item ${index + 1}`}
      />
    </View>
  );
}
