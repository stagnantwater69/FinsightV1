import { useEffect, useId, useRef, useState } from "react";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { SelectInput, TextInput } from "./Field";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { FIELD_LIMITS } from "../lib/fieldLimits";

interface Props {
  value: number | "";
  onChange: (categoryId: number) => void;
  /**
   * The id the <select> carries, so an enclosing <Field>'s label resolves to
   * it. Without this the Category field was the one unlabelled control in the
   * app: the label had no htmlFor and this component rendered no matching id.
   */
  id?: string;
  /** Lets an enclosing form show its own validation once the field is left. */
  onBlur?: () => void;
}

export function CategorySelect({ value, onChange, id, onBlur }: Props) {
  const { categories, createCategory, loading, recentCategoryIds = [], rememberCategory } = useExpenseCategories();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const createPending = useRef(false);
  const visible = categories.filter((category) => category.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const recent = recentCategoryIds.map((recentId) => visible.find((category) => category.id === recentId)).filter((category) => category !== undefined);

  function choose(categoryId: number) {
    rememberCategory?.(categoryId);
    onChange(categoryId);
    setQuery("");
    setSearching(false);
  }

  /**
   * Focus has to be put back deliberately on the way out of create mode.
   *
   * Entering swaps the <select> for an inline form and the name input takes
   * focus, which is right. Leaving used to swap the form back and drop focus on
   * <body>, so the next Tab restarted from the top of the document — the same
   * failure useDismiss exists to prevent for popovers. `returnFocus` runs after
   * the select is back in the DOM.
   */
  const selectRef = useRef<HTMLSelectElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!creating && returnFocus.current) {
      returnFocus.current = false;
      selectRef.current?.focus();
    }
  }, [creating]);

  function leaveCreateMode() {
    returnFocus.current = true;
    setCreating(false);
    setError(null);
  }

  async function handleCreate() {
    if (!newName.trim() || createPending.current) return;
    createPending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const category = await createCategory({ name: newName.trim() });
      choose(category.id);
      // Announce it: the select re-renders with the new value already chosen,
      // which is easy to miss and impossible to perceive without sight.
      toast(`Category "${category.name}" created`);
      leaveCreateMode();
      setNewName("");
    } catch {
      setError("Couldn't create category. Try again.");
    } finally {
      createPending.current = false;
      setSubmitting(false);
    }
  }

  if (creating) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <TextInput
            id={id}
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New category name"
            aria-label="New category name"
            maxLength={FIELD_LIMITS.categoryName}
            disabled={submitting}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void handleCreate(); }
              if (event.key === "Escape" && !submitting) { event.preventDefault(); leaveCreateMode(); }
            }}
            className="min-w-0 flex-1"
          />
          <Button type="button" onClick={handleCreate} disabled={submitting || !newName.trim()}>
            Add
          </Button>
          <Button type="button" variant="secondary" onClick={leaveCreateMode} disabled={submitting}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-tone-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0">
    {searching ? (
      <TextInput
        id={searchId}
        type="search"
        aria-label="Search categories"
        placeholder="Search categories"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setSearching(false); setQuery(""); selectRef.current?.focus(); }
          if (event.key === "Enter") { event.preventDefault(); selectRef.current?.focus(); }
        }}
        className="mb-2"
      />
    ) : null}
    <SelectInput
      ref={selectRef}
      id={id}
      required
      value={value}
      onBlur={onBlur}
      onChange={(e) => {
        if (e.target.value === "__new__") {
          setCreating(true);
          return;
        }
        choose(Number(e.target.value));
      }}
      disabled={loading}
    >
      <option value="" disabled>
        {loading ? "Loading categories…" : "Select a category"}
      </option>
      {recent.length > 0 ? (
        <optgroup label="Recently used">
          {recent.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </optgroup>
      ) : null}
      {value !== "" && categories.some((category) => category.id === value) && !visible.some((category) => category.id === value) ? (
        <option value={value}>{categories.find((category) => category.id === value)!.name} (selected)</option>
      ) : null}
      {visible.filter((category) => !recentCategoryIds.includes(category.id)).map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      {/*
        A placeholder for a value this list doesn't contain.

        Without it, a <select> whose value matches no option silently falls
        back to displaying the FIRST option — so a stale category list made
        every receipt item appear to be in the business's first category
        while the database held something else entirely. A select must never
        show a category its value does not refer to; if the name can't be
        resolved, it has to say so rather than name a different one.
      */}
      {value !== "" && !loading && !categories.some((c) => c.id === value) ? (
        <option value={value}>Category unavailable — please choose</option>
      ) : null}
      <option value="__new__">+ New category…</option>
    </SelectInput>
    {categories.length > 0 ? (
      <button
        type="button"
        className="inline-flex min-h-tap items-center text-xs font-medium text-tone-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
        aria-expanded={searching}
        aria-controls={searching ? searchId : undefined}
        disabled={loading}
        onClick={() => { setSearching((previous) => !previous); setQuery(""); }}
      >
        {searching ? "Close category search" : "Search categories"}
      </button>
    ) : null}
    {searching && visible.length === 0 ? <p role="status" className="text-xs text-ink-500">No matching categories. Try another name or create a category.</p> : null}
    </div>
  );
}
