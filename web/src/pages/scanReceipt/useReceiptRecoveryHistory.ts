import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { EMPTY_RECOVERY_HISTORY, appendOlderPage, reconcileFirstPage, seedLocalScans, withoutScan } from "./recoveryHistory";
import type { ReceiptHistoryItem, ReceiptHistoryPage } from "./types";

export function useReceiptRecoveryHistory(businessProfileId: number | undefined) {
  const [history, setHistory] = useState(EMPTY_RECOVERY_HISTORY);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<{ message: string; failed: "refresh" | "older" } | null>(null);
  const requests = useRef(new AbortController());
  const purgedIds = useRef(new Set<number>());
  const seenCursors = useRef(new Set<string>());

  useEffect(() => {
    requests.current = new AbortController();
    return () => requests.current.abort();
  }, []);

  const refresh = useCallback(async (requestSignal?: AbortSignal, excludeScanId?: number) => {
    if (businessProfileId === undefined) return;
    const signal = requestSignal ?? requests.current.signal;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<ReceiptHistoryPage>("/records/receipts", {
        params: { businessProfileId, status: "active", take: 20 }, signal,
      });
      signal.throwIfAborted();
      setHistory((current) => {
        const page = {
          ...data, items: data.items.filter((scan) => scan.id !== excludeScanId && !purgedIds.current.has(scan.id)),
        };
        const next = reconcileFirstPage(current, page);
        // A refreshed first page can retain older pages and their cursor chain.
        if (next.scans.length === page.items.length) seenCursors.current.clear();
        if (data.nextCursor !== null) seenCursors.current.add(data.nextCursor);
        if (next.nextCursor !== null) seenCursors.current.add(next.nextCursor);
        return next;
      });
    } catch (err) {
      if (!signal.aborted) setError({ message: getErrorMessage(err), failed: "refresh" });
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [businessProfileId]);

  const loadOlder = useCallback(async () => {
    if (businessProfileId === undefined || history.nextCursor === null || loading || loadingOlder) return;
    const signal = requests.current.signal;
    setLoadingOlder(true);
    setError(null);
    try {
      const { data } = await api.get<ReceiptHistoryPage>("/records/receipts", {
        params: { businessProfileId, status: "active", take: 20, cursor: history.nextCursor }, signal,
      });
      signal.throwIfAborted();
      if (data.nextCursor !== null && (data.nextCursor === history.nextCursor || seenCursors.current.has(data.nextCursor))) {
        throw new Error("FinSight couldn't load older scans because the next page repeated. Your loaded scans are kept; try again.");
      }
      if (data.nextCursor !== null) seenCursors.current.add(data.nextCursor);
      setHistory((current) => appendOlderPage(current, { ...data, items: data.items.filter((scan) => !purgedIds.current.has(scan.id)) }));
    } catch (err) {
      if (!signal.aborted) setError({ message: getErrorMessage(err), failed: "older" });
    } finally {
      if (!signal.aborted) setLoadingOlder(false);
    }
  }, [businessProfileId, history.nextCursor, loading, loadingOlder]);

  useEffect(() => {
    if (businessProfileId === undefined) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [businessProfileId, refresh]);

  const remove = useCallback((id: number) => {
    purgedIds.current.add(id);
    setHistory((current) => withoutScan(current, id));
  }, []);
  const seed = useCallback((scans: ReceiptHistoryItem[]) => setHistory((current) => seedLocalScans(current, scans)), []);
  return { history, loading, loadingOlder, error, refresh, loadOlder, remove, seed };
}
