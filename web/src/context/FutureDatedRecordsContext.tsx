import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { FutureDatedRecords } from "../lib/types";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { useToast } from "../components/Toast";

/**
 * Whether the selected business has records dated after its today.
 *
 * New writes cannot carry a future date (the server refuses them), but older
 * records can. While any exist, the transaction and insight pages show the
 * correction screen instead (FutureDateGate), and Quick add is hidden.
 *
 * Checked when the business changes and, while blocked, on every navigation:
 * saving an edit sends the owner back through a gated page, which is the
 * recheck after each correction. Once clear it stays clear, because nothing
 * can write a future date any more.
 *
 * A failed check does not block. The server already leaves future-dated
 * records out of every figure, so failing open shows correct numbers; failing
 * closed would lock an owner out over a dropped request.
 */

interface FutureDatedRecordsValue {
  /** The last successful check found records to fix. */
  blocked: boolean;
  /** The first check for this business has not answered yet. */
  checking: boolean;
  data: FutureDatedRecords | null;
  /** The last check failed; `data` is whatever the one before it returned. */
  error: string | null;
  refresh: () => Promise<void>;
}

const FutureDatedRecordsContext = createContext<FutureDatedRecordsValue | undefined>(undefined);

const OUTSIDE_PROVIDER: FutureDatedRecordsValue = {
  blocked: false,
  checking: false,
  data: null,
  error: null,
  refresh: async () => undefined,
};

export function FutureDatedRecordsProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const { pathname } = useLocation();
  const toast = useToast();
  const businessId = selected?.id ?? null;
  const [data, setData] = useState<FutureDatedRecords | null>(null);
  const [checkedFor, setCheckedFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const blocked = data !== null && data.total > 0;
  const wasBlocked = useRef(false);

  const refresh = useCallback(async () => {
    if (businessId === null) return;
    const id = ++request.current;
    try {
      const { data: result } = await api.get<FutureDatedRecords>("/records/future-dated", {
        params: { businessProfileId: businessId },
      });
      if (id !== request.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (id !== request.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (id === request.current) setCheckedFor(businessId);
    }
  }, [businessId]);

  // A different business (or a changed timezone) is a different answer.
  useEffect(() => {
    setData(null);
    setError(null);
    setCheckedFor(null);
    void refresh();
  }, [refresh, selected?.timezone]);

  // While blocked, every navigation is a recheck: an edit page returns here
  // after saving, so the list is current the moment the owner sees it again.
  useEffect(() => {
    if (wasBlocked.current) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (wasBlocked.current && data?.total === 0) toast("All dates are fixed. Everything is unlocked.");
    wasBlocked.current = blocked;
  }, [blocked, data, toast]);

  const value: FutureDatedRecordsValue = {
    blocked,
    checking: businessId !== null && checkedFor !== businessId,
    data,
    error,
    refresh,
  };
  return <FutureDatedRecordsContext.Provider value={value}>{children}</FutureDatedRecordsContext.Provider>;
}

/** Outside the provider (a page rendered on its own in a test) nothing is blocked. */
export function useFutureDatedRecords(): FutureDatedRecordsValue {
  return useContext(FutureDatedRecordsContext) ?? OUTSIDE_PROVIDER;
}
