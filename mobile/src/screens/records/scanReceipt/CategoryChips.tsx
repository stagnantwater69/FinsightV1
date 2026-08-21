import { CategorySelect } from "../../../components/ui";
import type { ExpenseCategory } from "../../../lib/types";

/**
 * The category for one line of a receipt, as a dropdown.
 *
 * It was a row of chips, and chips were the wrong control here. Every
 * category the business has rendered as a chip, wrapping over three or four
 * lines — and then again for the next item, and the next. A nine-line receipt
 * against a dozen categories put over a hundred chips on one screen, all of
 * them looking alike, which is a large part of why that screen was
 * unreadable.
 *
 * A dropdown costs one tap and gives back a constant-height row that states
 * the current answer. No create field, deliberately: CategoryPicker carries
 * one, which is right when it appears once on a form and wrong when it
 * appears on every row of an itemised receipt.
 */
export function CategoryChips({
  categories,
  value,
  onChange,
  label,
}: {
  categories: ExpenseCategory[];
  value: number | null;
  onChange: (id: number) => void;
  label: string;
}) {
  return (
    <CategorySelect
      options={categories}
      value={value}
      onChange={onChange}
      // These rows repeat down an itemised receipt, so "Food" on its own
      // tells a screen reader nothing about WHICH line it would file.
      accessibilityContext={label}
      sheetTitle={label ? `Category for ${label}` : "Choose a category"}
    />
  );
}
