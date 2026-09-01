import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useBusinessProfiles } from "./BusinessProfileContext";
import type { ExpenseCategory, ExpenseCostBehavior } from "../lib/types";

interface ExpenseCategoryContextValue {
  categories: ExpenseCategory[];
  loading: boolean;
  createCategory: (input: {
    name: string;
    description?: string;
    costBehavior?: ExpenseCostBehavior;
  }) => Promise<ExpenseCategory>;
  /**
   * PATCH `/records/categories/:id` — plan §5.2/§15 Phase 5. Currently only
   * used to change `costBehavior` after creation (name/description edits
   * have no UI yet), but the input shape matches the backend's full
   * `updateSchema` so it isn't reshaped if that changes.
   */
  updateCategory: (
    id: number,
    input: { name?: string; description?: string | null; costBehavior?: ExpenseCostBehavior },
  ) => Promise<ExpenseCategory>;
  refresh: () => Promise<void>;
}

const ExpenseCategoryContext = createContext<ExpenseCategoryContextValue | undefined>(undefined);

export function ExpenseCategoryProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!selected) {
      setCategories([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get<ExpenseCategory[]>("/records/categories", {
        params: { businessProfileId: selected.id },
      });
      setCategories(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function createCategory(input: { name: string; description?: string; costBehavior?: ExpenseCostBehavior }) {
    if (!selected) throw new Error("No business profile selected");
    const { data } = await api.post<ExpenseCategory>("/records/categories", {
      businessProfileId: selected.id,
      ...input,
    });
    setCategories((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    return data;
  }

  async function updateCategory(
    id: number,
    input: { name?: string; description?: string | null; costBehavior?: ExpenseCostBehavior },
  ) {
    const { data } = await api.patch<ExpenseCategory>(`/records/categories/${id}`, input);
    setCategories((prev) => prev.map((c) => (c.id === id ? data : c)));
    return data;
  }

  return (
    <ExpenseCategoryContext.Provider value={{ categories, loading, createCategory, updateCategory, refresh }}>
      {children}
    </ExpenseCategoryContext.Provider>
  );
}

export function useExpenseCategories() {
  const ctx = useContext(ExpenseCategoryContext);
  if (!ctx) {
    throw new Error("useExpenseCategories must be used within an ExpenseCategoryProvider");
  }
  return ctx;
}
