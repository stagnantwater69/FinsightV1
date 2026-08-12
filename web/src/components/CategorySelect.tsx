import { useEffect, useRef, useState } from "react";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { SelectInput, TextInput } from "./Field";
import { Button } from "./Button";
import { useToast } from "./Toast";

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
  const { categories, createCategory, loading } = useExpenseCategories();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    if (!newName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const category = await createCategory({ name: newName.trim() });
      onChange(category.id);
      // Announce it: the select re-renders with the new value already chosen,
      // which is easy to miss and impossible to perceive without sight.
      toast(`Category "${category.name}" created`);
      leaveCreateMode();
      setNewName("");
    } catch {
      setError("Couldn't create category. Try again.");
    } finally {
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
            className="min-w-0 flex-1"
          />
          <Button type="button" onClick={handleCreate} disabled={submitting || !newName.trim()}>
            Add
          </Button>
          <Button type="button" variant="secondary" onClick={leaveCreateMode}>
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
        onChange(Number(e.target.value));
      }}
      disabled={loading}
    >
      <option value="" disabled>
        {loading ? "Loading categories…" : "Select a category"}
      </option>
      {categories.map((c) => (
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
  );
}
