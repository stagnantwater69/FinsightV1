import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { apiPage } from "./apiPage";
import { getErrorMessage } from "./errors";
import { useDebounced } from "./hooks";
import type { ImportBatchPage, ImportBatchSummary } from "./types";

export function useImportBatchPages(businessProfileId: number | undefined, enabled: boolean) {
  const [items, setItems] = useState<ImportBatchSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 220);
  const controllerRef = useRef<AbortController | null>(null);
  const scopeRef = useRef("");
  const seenCursorsRef = useRef(new Set<string>());
  const scope = `${businessProfileId ?? "none"}\u0000${enabled}\u0000${query}`;
  scopeRef.current = scope;

  const load = useCallback(async (cursor: string | null = null) => {
    if (!enabled || businessProfileId === undefined) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && scopeRef.current === scope;
    if (cursor) setLoadingMore(true);
    else { setLoading(true); setItems([]); setNextCursor(null); }
    setError(null);
    try {
      const { data } = await api.get<ImportBatchPage | ImportBatchSummary[]>("/records/csv-imports/batches", {
        params: { businessProfileId, pageSize: 50, ...(query ? { search: query } : {}), ...(cursor ? { cursor } : {}) },
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const page = apiPage(data);
      if (cursor !== null && page.nextCursor !== null && (page.nextCursor === cursor || seenCursorsRef.current.has(page.nextCursor))) {
        throw new Error("FinSight couldn't load more imports because the next page repeated. Your loaded imports are kept; try again.");
      }
      if (cursor === null) seenCursorsRef.current.clear();
      if (page.nextCursor !== null) seenCursorsRef.current.add(page.nextCursor);
      setItems((current) => cursor ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))] : page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (isCurrent()) setError(getErrorMessage(err));
    } finally {
      if (isCurrent()) { setLoading(false); setLoadingMore(false); }
    }
  }, [businessProfileId, enabled, query, scope]);

  useEffect(() => {
    if (!enabled || businessProfileId === undefined) {
      setItems([]); setNextCursor(null); setError(null); setLoading(false); setLoadingMore(false);
    } else void load();
    return () => controllerRef.current?.abort();
  }, [businessProfileId, enabled, load]);

  return { items, nextCursor, loading, loadingMore, error, search, setSearch,
    reload: () => void load(), loadMore: () => { if (nextCursor && !loadingMore && !loading) void load(nextCursor); } };
}
