import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
  recentCategoryIds: number[];
  rememberCategory: (id: number) => void;
}

const ExpenseCategoryContext = createContext<ExpenseCategoryContextValue | undefined>(undefined);

export function ExpenseCategoryProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedProfileId, setLoadedProfileId] = useState<number | null>(null);
  const [recentByProfile, setRecentByProfile] = useState<Record<number, number[]>>({});
  const requestVersion = useRef(0);
  const activeProfileId = useRef(selected?.id);
  activeProfileId.current = selected?.id;

  async function refresh() {
    const version = ++requestVersion.current;
    const profileId = selected?.id;
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
      if (version !== requestVersion.current || activeProfileId.current !== profileId) return;
      setCategories(data);
      setLoadedProfileId(profileId!);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh().catch(() => {
      // Keep stale business categories out of the picker when loading fails.
    });
    return () => { requestVersion.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function createCategory(input: { name: string; description?: string; costBehavior?: ExpenseCostBehavior }) {
    if (!selected) throw new Error("No business profile selected");
    const { data } = await api.post<ExpenseCategory>("/records/categories", {
      businessProfileId: selected.id,
      ...input,
    });
    if (activeProfileId.current !== selected.id) throw new Error("Business changed. Choose a category for the current business.");
    if (activeProfileId.current === selected.id) {
      setCategories((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
    }
    return data;
  }

  async function updateCategory(
    id: number,
    input: { name?: string; description?: string | null; costBehavior?: ExpenseCostBehavior },
  ) {
    const { data } = await api.patch<ExpenseCategory>(`/records/categories/${id}`, input);
    if (activeProfileId.current === selected?.id) setCategories((prev) => prev.map((c) => (c.id === id ? data : c)));
    return data;
  }

  return (
    <ExpenseCategoryContext.Provider value={{
      categories: loadedProfileId === selected?.id ? categories : [], loading, createCategory, updateCategory, refresh,
      recentCategoryIds: selected ? recentByProfile[selected.id] ?? [] : [],
      rememberCategory: (id) => {
        if (!selected || !categories.some((category) => category.id === id)) return;
        setRecentByProfile((previous) => ({ ...previous, [selected.id]: [id, ...(previous[selected.id] ?? []).filter((recent) => recent !== id)].slice(0, 5) }));
      },
    }}>
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
