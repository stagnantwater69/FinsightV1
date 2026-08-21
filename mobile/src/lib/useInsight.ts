import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { api, errorMessage } from "./api";

/**
 * Fetches one insight endpoint and refetches it every time the screen regains
 * focus, which is how the insight screens stay current after a record is
 * added or edited elsewhere and the owner comes back.
 */
export function useInsight<T>(path: string, query: Record<string, any>, deps: any[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path, query));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  return { data, loading, error, load };
}
