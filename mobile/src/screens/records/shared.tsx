import { useState } from "react";
import { TextInput, View } from "react-native";
import { AlertBadge, Button, CategorySelect, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { TAP, radius, space, typeScale } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import type { ExpenseCategory, RecordItem } from "../../lib/types";

/**
 * Pieces shared across more than one records screen — the list, Edit and
 * Flagged all render the same status badges, and Add/Edit/Scan all offer the
 * same category picker. Kept in one place so the three do not drift into
 * three slightly different versions of the same control.
 */

export const todayISO = () => new Date().toISOString().slice(0, 10);

/** A past CSV import, used only to name a group of duplicates. */
export interface ImportBatchSummary {
  id: number;
  title: string;
  uploadDate: string;
  status: string;
}

/** Status badges, shared by the list, Edit and the review queue. */
export function badges(r: RecordItem) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: space.sm }}>
      {r.duplicateStatus === "Flagged" ? <AlertBadge kind="duplicate" /> : null}
      {r.reviewStatus === "Needs Review" ? <AlertBadge kind="needs-review" /> : null}
      {r.largeExpenseFlag ? <AlertBadge kind="large-expense" /> : null}
    </View>
  );
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  onCreated,
}: {
  categories: ExpenseCategory[];
  value: number | null;
  onChange: (id: number) => void;
  onCreated: () => void;
}) {
  const t = useTheme();
  const { brand, ink } = t;
  // The business is read from context rather than passed in: the write itself
  // moved to createCategory, which is already scoped to the selected business,
  // so a prop naming it here would be a second source for the same fact.
  const { createCategory } = useBusinessProfiles();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  /** Raw TextInput, so the focus border `Field` gives every other input is
   *  wired here by hand rather than inherited. */
  const [nameFocused, setNameFocused] = useState(false);

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const c = await createCategory({ name: newName.trim() });
      setNewName("");
      onCreated();
      onChange(c.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ marginBottom: space.md }}>
      <T variant="label" style={{ marginBottom: 4, color: ink[700] }}>Category</T>
      {categories.length > 0 ? (
        /*
          A dropdown rather than a row of chips, matching the per-item control
          on an itemised receipt. Two ways of choosing the same thing on one
          screen is the kind of difference that reads as a bug.
        */
        <View style={{ marginBottom: space.sm }}>
          <CategorySelect options={categories} value={value} onChange={onChange} />
        </View>
      ) : (
        // Create-on-the-fly when the list is empty, same as web — a brand-new
        // business would otherwise hit a dead end on its very first expense.
        <T variant="caption" style={{ marginBottom: space.sm }}>
          No categories yet. Add your first one below (e.g. Inventory, Utilities, Rent).
        </T>
      )}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="New category name"
          placeholderTextColor={ink[400]}
          // Deliberately NOT part of the surrounding form's next-field chain.
          // This box belongs to a side errand — naming a category — and its
          // return key does what the "Add" button beside it does. Handing the
          // keyboard on to Description instead would abandon a half-typed
          // category name. The guard mirrors the button's own
          // `loading` / `disabled` so return cannot post a second time.
          returnKeyType="done"
          onSubmitEditing={() => {
            if (!busy && newName.trim()) create();
          }}
          onFocus={() => setNameFocused(true)}
          onBlur={() => setNameFocused(false)}
          style={{
            flex: 1,
            minHeight: TAP,
            borderWidth: 1,
            borderColor: nameFocused ? brand[600] : ink[200],
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            fontSize: typeScale.body,
            color: ink[900],
          }}
        />
        <Button title="Add" variant="secondary" onPress={create} loading={busy} disabled={!newName.trim()} />
      </View>
    </View>
  );
}
