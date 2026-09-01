import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { errorMessage } from "../lib/api";
import { Button, Card, EmptyState, ErrorNote, Field, Screen, ScreenHeader, SelectChip, T } from "../components/ui";
import { TAP, font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { ExpenseCategory, ExpenseCostBehavior } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";

/**
 * Cost-behavior classification — Expense Reduction Opportunities plan
 * §5.2/§15 Phase 5. Owner-controlled, optional, and never guessed from the
 * category name (see the plan's explicit warning against name heuristics).
 * `null` is a real, distinct choice here — it means "leave unclassified",
 * which is also what omitting the field from the create request does.
 */
const COST_BEHAVIOR_OPTIONS: { value: ExpenseCostBehavior; label: string }[] = [
  { value: "FIXED", label: "Fixed" },
  { value: "VARIABLE", label: "Variable" },
  { value: "MIXED", label: "Mixed" },
];

/**
 * Expense categories, on a phone.
 *
 * WHY THIS SCREEN EXISTS: categories could already be CREATED on mobile, but
 * only sideways — inside the add-expense picker, or by accepting a suggestion
 * while reviewing a receipt. There was nowhere to see the whole set. That made
 * "what are my categories, actually?" unanswerable on a phone, which matters
 * because every insight in the app is grouped by them, and the panel's finding
 * was that most owners have no computer to go and look on instead.
 *
 * Deliberately NOT a port of web's <DataTable>. That table earns its sorting,
 * pagination and column headers on a wide screen; at 360dp the same
 * information is a list, and reimplementing the table's machinery to render
 * one column of cards would be carrying the cost without the benefit. What is
 * kept identical is the SUBSTANCE — the same search over name and description,
 * the same count, the same two empty states, and the same route into the
 * records a category holds.
 */
export function CategoriesScreen({ navigation }: { navigation: { navigate: (screen: string, params?: object) => void } }) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const { selected, categories, createCategory } = useBusinessProfiles();

  const [keyword, setKeyword] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [costBehavior, setCostBehavior] = useState<ExpenseCostBehavior | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same predicate as web: name OR description, case-insensitive.
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q),
    );
  }, [categories, keyword]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => a.name.localeCompare(b.name)),
    [filtered],
  );

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);
    try {
      await createCategory({
        name: trimmed,
        description: description.trim() || undefined,
        costBehavior: costBehavior ?? undefined,
      });
      setName("");
      setDescription("");
      setCostBehavior(null);
      setAdding(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!selected) return null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
        <ScreenHeader
          eyebrow="Management"
          title="Expense categories"
          subtitle="How your spending is grouped. Every insight in FinSight is built on these."
        />

        {!adding ? (
          <Button
            title="+ New category"
            variant="primary"
            onPress={() => {
              setAdding(true);
              setError(null);
            }}
          />
        ) : (
          <Card>
            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              maxLength={FIELD_LIMITS.categoryName}
              autoFocus
              placeholder="e.g. Rent, Supplies, Utilities"
            />
            <Field
              label="Description (optional)"
              value={description}
              onChangeText={setDescription}
              maxLength={FIELD_LIMITS.categoryDescription}
              placeholder="What belongs in here"
            />

            {/*
              Low-friction and skippable — the plan is explicit that this
              stays optional and never guessed from the name. Tapping the
              already-selected chip clears it back to "leave unclassified",
              same toggle-to-clear behavior the filter chips elsewhere use.
            */}
            <View style={{ marginBottom: space.md }}>
              <T variant="label" style={{ marginBottom: 6, color: t.textSecondary }}>
                How this cost behaves (optional)
              </T>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                {COST_BEHAVIOR_OPTIONS.map((option) => (
                  <SelectChip
                    key={option.value}
                    label={option.label}
                    selected={costBehavior === option.value}
                    onPress={() => setCostBehavior((v) => (v === option.value ? null : option.value))}
                    accessibilityLabel={`${option.label} cost`}
                  />
                ))}
              </View>
              <T variant="caption" style={{ marginTop: 4 }}>
                Helps FinSight tailor its review checks — rent or a lease is usually fixed, ingredients or supplies
                usually vary. Leave this unset if you're not sure.
              </T>
            </View>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button
                  title={saving ? "Saving…" : "Save category"}
                  variant="primary"
                  disabled={saving || !name.trim()}
                  onPress={handleCreate}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Cancel"
                  variant="ghost"
                  disabled={saving}
                  onPress={() => {
                    setAdding(false);
                    setName("");
                    setDescription("");
                    setCostBehavior(null);
                    setError(null);
                  }}
                />
              </View>
            </View>
          </Card>
        )}

        {/*
          The search box is hidden below a handful of categories. A filter over
          four items costs a tap and a keyboard to save nothing, and on a phone
          the space it takes is space the list itself wanted.
        */}
        {categories.length > 5 ? (
          <View style={{ marginTop: space.lg }}>
            <TextInput
              value={keyword}
              onChangeText={setKeyword}
              placeholder="Search categories…"
              placeholderTextColor={ink[400]}
              accessibilityLabel="Search categories"
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              style={{
                minHeight: TAP,
                borderWidth: 1,
                borderColor: searchFocused ? brand[600] : ink[200],
                borderRadius: radius.md,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                fontSize: typeScale.body,
                color: ink[900],
                backgroundColor: paper.DEFAULT,
              }}
            />
          </View>
        ) : null}

        <T variant="caption" style={{ marginTop: space.md, marginBottom: space.sm }}>
          {keyword.trim()
            ? `${sorted.length} of ${categories.length} shown`
            : `${categories.length} categor${categories.length === 1 ? "y" : "ies"}`}
        </T>

        {sorted.length === 0 ? (
          keyword.trim() ? (
            <EmptyState
              icon="⌕"
              title="No categories match that search"
              body="Try a shorter word, or clear the search box."
              action={<Button title="Clear search" variant="ghost" onPress={() => setKeyword("")} />}
            />
          ) : (
            <EmptyState
              title="No categories yet"
              body="Categories are how FinSight groups your spending — without them every expense looks the same. Start with the three or four you spend on most."
              action={
                <Button title="Create your first category" variant="primary" onPress={() => setAdding(true)} />
              }
            />
          )
        ) : (
          sorted.map((c) => (
            <CategoryRow
              key={c.id}
              category={c}
              onOpenRecords={() =>
                // Same destination as web's "View records": the records list,
                // already filtered to this category's expenses.
                navigation.navigate("RecordsList", { type: "expense", categoryId: c.id })
              }
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

function CategoryRow({
  category,
  onOpenRecords,
}: {
  category: ExpenseCategory;
  onOpenRecords: () => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  return (
    <Pressable
      onPress={onOpenRecords}
      accessibilityRole="button"
      // The visible label is the category name; the action is opening its
      // records, and a reader that only hears "Rent" would not know that.
      accessibilityLabel={`${category.name}, view records`}
      accessibilityHint="Opens the records filed under this category"
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: TAP,
        borderWidth: 1,
        borderColor: ink[200],
        borderRadius: radius.md,
        backgroundColor: pressed ? brand[50] : paper.DEFAULT,
        padding: space.md,
        marginBottom: space.sm,
      })}
    >
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: typeScale.body, color: ink[900], fontFamily: font.sansMedium }}>{category.name}</T>
        {category.description ? (
          <T variant="caption" style={{ marginTop: 2 }}>
            {category.description}
          </T>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={ink[400]} />
    </Pressable>
  );
}
