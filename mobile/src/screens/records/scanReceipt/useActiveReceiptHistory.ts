import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "../../../lib/api";
import { describeActionFailure, toLoadFailure } from "../../../lib/connectionState";
import type { ReceiptHistoryItem, ReceiptHistoryPage } from "./types";

export function useActiveReceiptHistory(businessProfileId?: number) {
  const [items, setItems] = useState<ReceiptHistoryItem[]>([]);
  const [nextCursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const activeBusiness = useRef(businessProfileId);
  const dataScope = useRef(businessProfileId);
  if (activeBusiness.current !== businessProfileId) dataScope.current = undefined;
  activeBusiness.current = businessProfileId;
  const seen = useRef(new Set<string>());

  useEffect(() => {
    dataScope.current = businessProfileId;
    setItems([]); setCursor(null); setLoading(Boolean(businessProfileId)); setLoadingMore(false); setError(null); seen.current.clear();
  }, [businessProfileId]);

  const load = useCallback(async (cursor?: string) => {
    if (!businessProfileId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && activeBusiness.current === businessProfileId && request.current === controller;
    if (cursor) setLoadingMore(true); else { setLoading(true); setError(null); }
    try {
      const result = await api.get<ReceiptHistoryPage>("/records/receipts", { businessProfileId, status: "active", take: 50, cursor }, controller.signal);
      if (!current()) return;
      if (!result || !Array.isArray(result.items) || result.items.some((item) => item.businessProfileId !== businessProfileId)) throw new Error("FinSight returned a receipt list that could not be verified for this business.");
      if (cursor && result.nextCursor !== null && (result.nextCursor === cursor || seen.current.has(result.nextCursor))) throw new Error("The receipt page did not advance. Check the receipt list again before continuing.");
      if (cursor) seen.current.add(cursor); else seen.current.clear();
      setItems((previous) => [...new Map([...(cursor ? previous : []), ...result.items].map((item) => [item.id, item])).values()]);
      setCursor(result.nextCursor ?? null);
      setError(null);
    } catch (err) {
      if (current()) setError(describeActionFailure(toLoadFailure(err), "You can still capture a new receipt.", "read"));
    } finally {
      if (current()) { setLoading(false); setLoadingMore(false); }
    }
  }, [businessProfileId]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { request.current?.abort(); };
  }, [load]));

  const scoped = dataScope.current === businessProfileId;
  return { items: scoped ? items : [], setItems, nextCursor: scoped ? nextCursor : null, loading: scoped ? loading : Boolean(businessProfileId), loadingMore: scoped && loadingMore, error: scoped ? error : null, setError, load };
}
