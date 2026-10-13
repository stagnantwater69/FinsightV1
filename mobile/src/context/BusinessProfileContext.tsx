import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "./AuthContext";
import type { BusinessProfile, BusinessProfileInput, ExpenseCategory, ExpenseCostBehavior } from "../lib/types";

/**
 * Active business + its categories.
 *
 * Same soft-delete model as web: archive/restore only, no hard delete anywhere.
 * `listArchived` fetches on demand rather than keeping archived profiles in
 * `profiles`, so the switcher never accidentally offers one.
 */
interface Value {
  profiles: BusinessProfile[];
  selected: BusinessProfile | null;
  categories: ExpenseCategory[];
  /** Scoped to the selected business; cached rows remain visible on refresh. */
  categoriesLoading: boolean;
  /** A selected-business fetch failure, separate from a successful empty list. */
  categoriesError: string | null;
  loading: boolean;
  /**
   * Why the list is empty, when it is empty because the request failed rather
   * than because the owner has no businesses.
   *
   * Those two states used to be indistinguishable: a failed fetch left
   * `profiles` at [] and the Dashboard told an owner with three businesses to
   * "set up a business first", which invites them to create a fourth.
   */
  error: string | null;
  selectProfile: (id: number) => void;
  refresh: () => Promise<void>;
  refreshCategories: () => Promise<void>;
  /**
   * Creates a category and puts it straight into `categories`.
   *
   * Three screens create categories — the picker on the add-expense form, the
   * "accept this suggestion" button on the receipt review, and the categories
   * screen itself — and each does something different afterwards, which is why
   * the FOLLOW-UP stays at the call site while the write lives here. Before
   * this, all three posted the request themselves and each was independently
   * responsible for remembering to refresh the shared list.
   *
   * Appends rather than refetching: the created row is what the server just
   * returned. A category fetch that was already in flight merges creations
   * made after it started, so its older snapshot cannot erase the new row.
   */
  createCategory: (input: {
    name: string;
    description?: string;
    /** Optional, owner-controlled — Expense Reduction Opportunities plan §5.2/§15 Phase 5. Omitted means UNCLASSIFIED. */
    costBehavior?: ExpenseCostBehavior;
  }) => Promise<ExpenseCategory>;
  createProfile: (input: BusinessProfileInput) => Promise<BusinessProfile>;
  updateProfile: (id: number, input: Partial<BusinessProfileInput>) => Promise<BusinessProfile>;
  archiveProfile: (id: number) => Promise<void>;
  restoreProfile: (id: number) => Promise<void>;
  listArchived: () => Promise<BusinessProfile[]>;
}

const Ctx = createContext<Value | undefined>(undefined);

interface CategoryState {
  rows: ExpenseCategory[];
  loading: boolean;
  error: string | null;
}

export function BusinessProfileProvider({ children }: { children: ReactNode }) {
  const { profile: user, takeBootstrapProfiles } = useAuth();
  const [profiles, setProfiles] = useState<BusinessProfile[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [categoryStates, setCategoryStates] = useState<Record<string, CategoryState>>({});
  const categoryScope = user && selectedId ? `${user.id}:${selectedId}` : null;
  const latestCategoryScope = useRef(categoryScope);
  latestCategoryScope.current = categoryScope;
  const categoryRequest = useRef(0);
  const categoryMutationVersion = useRef(0);
  const createdCategoryVersions = useRef(new Map<string, Map<number, number>>());
  const currentCategoryState = categoryScope ? categoryStates[categoryScope] : undefined;
  const categories = currentCategoryState?.rows ?? [];
  const categoriesLoading = categoryScope ? (currentCategoryState?.loading ?? true) : false;
  const categoriesError = currentCategoryState?.error ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * `pending` is a /business-profiles request the auth bootstrap already put
   * on the wire — see `takeBootstrapProfiles` in AuthContext. Adopting it
   * rather than issuing a second one is the entire saving: on a cold start
   * this list is fetched next to /auth/me instead of after it.
   *
   * A failing `pending` rejects out of here exactly as a fresh `api.get`
   * would, so the failure path is unchanged either way.
   */
  const load = useCallback(async (pending?: Promise<BusinessProfile[]> | null) => {
    setLoading(true);
    try {
      const data = await (pending ?? api.get<BusinessProfile[]>("/business-profiles"));
      setProfiles(data);
      setSelectedId((current) => (current && data.some((p) => p.id === current) ? current : data[0]?.id ?? null));
      setError(null);
    } catch (err) {
      // Recorded for the screens AND rethrown: `archiveProfile` and
      // `restoreProfile` await `refresh()` and surface their own failure, so
      // swallowing here would leave them reporting success on a failed reload.
      setError(errorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // The public refresh always goes to the network — a caller asking to
  // refresh wants current data, never a promise made at startup.
  const refresh = useCallback(() => load(), [load]);

  useEffect(() => {
    if (!user) {
      setProfiles([]);
      setSelectedId(null);
      categoryRequest.current += 1;
      categoryMutationVersion.current += 1;
      createdCategoryVersions.current.clear();
      setCategoryStates({});
      setError(null);
      setLoading(false);
      return;
    }
    // The reason is already in `error` by the time this settles; the catch is
    // here so a failed load is a message on screen rather than an unhandled
    // rejection in the console.
    load(takeBootstrapProfiles()).catch(() => undefined);
  }, [user, load, takeBootstrapProfiles]);

  const refreshCategories = useCallback(async () => {
    if (!selectedId || !categoryScope) return;

    const request = ++categoryRequest.current;
    const requestedScope = categoryScope;
    const mutationsAtStart = categoryMutationVersion.current;
    setCategoryStates((previous) => ({
      ...previous,
      [requestedScope]: {
        rows: previous[requestedScope]?.rows ?? [],
        loading: true,
        error: null,
      },
    }));

    try {
      const rows = await api.get<ExpenseCategory[]>("/records/categories", { businessProfileId: selectedId });
      if (latestCategoryScope.current !== requestedScope || categoryRequest.current !== request) return;
      const returnedIds = new Set(rows.map((row) => row.id));
      const createdVersions = createdCategoryVersions.current.get(requestedScope);
      for (const id of returnedIds) createdVersions?.delete(id);
      if (createdVersions?.size === 0) createdCategoryVersions.current.delete(requestedScope);
      setCategoryStates((previous) => ({
        ...previous,
        [requestedScope]: {
          rows: [
            ...rows,
            ...(previous[requestedScope]?.rows ?? []).filter((row) =>
              !returnedIds.has(row.id) && (createdVersions?.get(row.id) ?? 0) > mutationsAtStart,
            ),
          ],
          loading: false,
          error: null,
        },
      }));
    } catch (err) {
      if (latestCategoryScope.current === requestedScope && categoryRequest.current === request) {
        setCategoryStates((previous) => ({
          ...previous,
          [requestedScope]: {
            rows: previous[requestedScope]?.rows ?? [],
            loading: false,
            error: errorMessage(err),
          },
        }));
      }
      throw err;
    }
  }, [selectedId, categoryScope]);

  useEffect(() => {
    // The scoped failure is already recorded; consume the effect's rejection.
    refreshCategories().catch(() => undefined);
  }, [refreshCategories]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  return (
    <Ctx.Provider
      value={{
        profiles,
        selected,
        categories,
        categoriesLoading,
        categoriesError,
        loading,
        error,
        selectProfile: setSelectedId,
        refresh,
        refreshCategories,
        createCategory: async (input) => {
          if (!selectedId) {
            // Not reachable from the UI — every screen that can create a
            // category is behind a selected business — but the alternative is
            // posting `businessProfileId: null` and letting the server answer
            // with a validation error that names a field the owner never saw.
            throw new Error("Choose a business before adding a category.");
          }
          const created = await api.post<ExpenseCategory>("/records/categories", {
            businessProfileId: selectedId,
            name: input.name,
            ...(input.description ? { description: input.description } : {}),
            ...(input.costBehavior ? { costBehavior: input.costBehavior } : {}),
          });
          if (latestCategoryScope.current !== categoryScope || !categoryScope) {
            throw new Error("Business changed. Choose a category for the current business.");
          }
          const mutationVersion = ++categoryMutationVersion.current;
          const createdForScope = createdCategoryVersions.current.get(categoryScope) ?? new Map<number, number>();
          createdForScope.set(created.id, mutationVersion);
          createdCategoryVersions.current.set(categoryScope, createdForScope);
          setCategoryStates((previous) => {
            const current = previous[categoryScope];
            return {
              ...previous,
              [categoryScope]: {
                rows: [...(current?.rows.filter((row) => row.id !== created.id) ?? []), created],
                loading: false,
                error: null,
              },
            };
          });
          return created;
        },
        createProfile: async (input) => {
          const created = await api.post<BusinessProfile>("/business-profiles", input);
          setProfiles((prev) => [...prev, created]);
          setSelectedId(created.id);
          return created;
        },
        updateProfile: async (id, input) => {
          const updated = await api.patch<BusinessProfile>(`/business-profiles/${id}`, input);
          setProfiles((prev) => prev.map((p) => (p.id === id ? updated : p)));
          return updated;
        },
        // Archiving can remove the active business, so the list is reloaded and
        // the selection allowed to fall back to whatever remains.
        archiveProfile: async (id) => {
          await api.post(`/business-profiles/${id}/archive`);
          await refresh();
        },
        restoreProfile: async (id) => {
          await api.post(`/business-profiles/${id}/restore`);
          await refresh();
        },
        listArchived: async () => {
          const all = await api.get<BusinessProfile[]>("/business-profiles", { includeArchived: true });
          return all.filter((p) => p.isArchived);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useBusinessProfiles() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBusinessProfiles must be used within BusinessProfileProvider");
  return ctx;
}
