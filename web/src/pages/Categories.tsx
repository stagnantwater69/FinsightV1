import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { getErrorMessage } from "../lib/errors";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Card, PageHead } from "../components/ui";
import { Field, FormError, SelectInput, TextInput } from "../components/Field";
import { IconArrowRight, IconSearch } from "../components/icons";
import type { ExpenseCategory, ExpenseCostBehavior } from "../lib/types";
import { FIELD_LIMITS } from "../lib/fieldLimits";

/**
 * Cost-behavior classification — plan §5.2/§15 Phase 5. Owner-controlled,
 * optional, never guessed from the category name. `UNCLASSIFIED` is the
 * column default and reads as "not set" here rather than as a fourth
 * meaningful choice — see the blank option in `COST_BEHAVIOR_OPTIONS`.
 */
const COST_BEHAVIOR_OPTIONS: { value: ExpenseCostBehavior; label: string }[] = [
  { value: "UNCLASSIFIED", label: "Not set" },
  { value: "FIXED", label: "Fixed" },
  { value: "VARIABLE", label: "Variable" },
  { value: "MIXED", label: "Mixed" },
];

const COST_BEHAVIOR_LABEL: Record<ExpenseCostBehavior, string> = {
  FIXED: "Fixed",
  VARIABLE: "Variable",
  MIXED: "Mixed",
  UNCLASSIFIED: "Not set",
};

/**
 * One row's inline cost-behavior selector — used in both the table column
 * and the mobile row. Its own component so the "saving…" state (a few
 * hundred ms of a disabled select) is scoped to the row that changed rather
 * than the whole table re-rendering.
 */
function CostBehaviorSelect({ category }: { category: ExpenseCategory }) {
  const { updateCategory } = useExpenseCategories();
  const [saving, setSaving] = useState(false);

  return (
    <SelectInput
      aria-label={`Cost behavior for ${category.name}`}
      value={category.costBehavior ?? "UNCLASSIFIED"}
      disabled={saving}
      onChange={async (e) => {
        const value = e.target.value as ExpenseCostBehavior;
        setSaving(true);
        try {
          await updateCategory(category.id, { costBehavior: value });
        } catch {
          // Left as a no-op error: the select just reverts to the category's
          // last-known value on the next render, which is enough feedback for
          // a low-stakes, easily-retried classification field — the same
          // reasoning a required-field save would not get away with.
        } finally {
          setSaving(false);
        }
      }}
      className="min-h-0 py-1.5 text-xs"
    >
      {COST_BEHAVIOR_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </SelectInput>
  );
}

/**
 * Expense categories.
 *
 * Categories existed before this page did, but only as a dropdown inside the
 * add-expense form — there was nowhere to see the full set, and no way to
 * create one except while recording a spend. That made "what are my
 * categories, actually?" an unanswerable question, which matters because
 * every insight in the app is grouped by them.
 *
 * Renders through the shared <DataTable>, same as Records: same header, same
 * row height, same sort affordance, same pagination. That is the point of
 * having one table.
 */
export function Categories() {
  const { selected } = useBusinessProfiles();
  const { categories, loading, createCategory } = useExpenseCategories();

  const [keyword, setKeyword] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [costBehavior, setCostBehavior] = useState<ExpenseCostBehavior>("UNCLASSIFIED");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q),
    );
  }, [categories, keyword]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);
    try {
      await createCategory({
        name: trimmed,
        description: description.trim() || undefined,
        // Omitted rather than sent as "UNCLASSIFIED": the column default
        // already covers that case, and the omission form matches the other
        // optional field (`description`) above.
        costBehavior: costBehavior === "UNCLASSIFIED" ? undefined : costBehavior,
      });
      setName("");
      setDescription("");
      setCostBehavior("UNCLASSIFIED");
      setAdding(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!selected) return null;

  const columns: Column<ExpenseCategory>[] = [
    {
      key: "name",
      header: "Category",
      width: "grow",
      sortValue: (c) => c.name,
      cell: (c) => <span className="font-medium text-ink-900">{c.name}</span>,
    },
    {
      key: "description",
      header: "Description",
      width: "grow",
      sortValue: (c) => c.description,
      cell: (c) =>
        c.description ? (
          <span className="text-ink-600">{c.description}</span>
        ) : (
          <span className="text-ink-400">—</span>
        ),
    },
    {
      key: "costBehavior",
      header: "Cost behavior",
      width: "content",
      sortValue: (c) => COST_BEHAVIOR_LABEL[c.costBehavior ?? "UNCLASSIFIED"],
      cell: (c) => <CostBehaviorSelect category={c} />,
    },
    {
      key: "created",
      header: "Created",
      width: "content",
      sortValue: (c) => c.createdAt,
      cell: (c) => <span className="text-ink-500">{c.createdAt.slice(0, 10)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      headerSrOnly: true,
      width: "content",
      align: "right",
      cell: (c) => (
        <Link
          to={`/records?type=expense&categoryId=${c.id}`}
          className="tap-inline inline-flex items-center gap-1 font-medium text-brand-700 transition hover:text-brand-800"
        >
          View records
          <IconArrowRight aria-hidden className="h-3.5 w-3.5" />
        </Link>
      ),
    },
  ];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <label htmlFor="cat-search" className="sr-only">
          Search categories
        </label>
        <IconSearch
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        />
        <TextInput
          id="cat-search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Search categories…"
          className="pl-9 pr-3"
        />
      </div>
      <p className="text-sm text-ink-500">
        {categories.length} categor{categories.length === 1 ? "y" : "ies"}
      </p>
    </div>
  );

  return (
    <div>
      <PageHead
        eyebrow="Management"
        title="Expense categories"
        subtitle="How your spending is grouped. Every insight in FinSight is built on these."
        actions={
          !adding ? (
            <Button variant="brand" size="sm" onClick={() => setAdding(true)}>
              + New category
            </Button>
          ) : null
        }
      />

      {adding ? (
        <Card as="form" onSubmit={handleCreate} className="mb-4 animate-slide-up p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="cat-name" required>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={FIELD_LIMITS.categoryName}
                autoFocus
                placeholder="e.g. Rent, Supplies, Utilities"
              />
            </Field>
            <Field label="Description" htmlFor="cat-desc" optional>
              <TextInput
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={FIELD_LIMITS.categoryDescription}
                placeholder="What belongs in here"
              />
            </Field>
            <Field
              label="Cost behavior"
              htmlFor="cat-cost-behavior"
              optional
              hint="How this category tends to move — fixed costs stay roughly flat, variable costs scale with activity, mixed costs have both. Leave it not set if you're unsure; it doesn't block anything."
              className="sm:col-span-2"
            >
              <SelectInput
                id="cat-cost-behavior"
                value={costBehavior}
                onChange={(e) => setCostBehavior(e.target.value as ExpenseCostBehavior)}
              >
                {COST_BEHAVIOR_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          {error ? (
            <div className="mt-3">
              <FormError>{error}</FormError>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save category"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      <DataTable
        rows={filtered}
        columns={columns}
        getRowKey={(c) => String(c.id)}
        loading={loading}
        caption={`Expense categories for ${selected.name}`}
        itemNoun="categories"
        storageKey="categories"
        initialSort={{ key: "name", direction: "asc" }}
        toolbar={toolbar}
        empty={
          keyword ? (
            <EmptyState compact title="No categories match that search" icon="⌕">
              Try a shorter word, or clear the search box.
            </EmptyState>
          ) : (
            <EmptyState
              compact
              title="No categories yet"
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Create your first category
                </Button>
              }
            >
              Categories are how FinSight groups your spending — without them every expense looks the
              same. Start with the three or four you spend on most.
            </EmptyState>
          )
        }
        mobileRow={(c) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-ink-900">{c.name}</p>
              {c.description ? (
                <p className="mt-0.5 text-sm text-ink-500">{c.description}</p>
              ) : null}
              <p className="mt-1 text-xs text-ink-400">Created {c.createdAt.slice(0, 10)}</p>
              <div className="mt-2 max-w-[10rem]">
                <CostBehaviorSelect category={c} />
              </div>
            </div>
            <Link
              to={`/records?type=expense&categoryId=${c.id}`}
              className="tap shrink-0 rounded-lg px-3 text-sm font-medium text-tone-brand transition hover:bg-tint-brand"
            >
              Records
            </Link>
          </div>
        )}
      />
    </div>
  );
}
