import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api, errorMessage } from "./api";
import {
  SERVER_STATE_CACHE_MS,
  SERVER_STATE_STALE_MS,
  createServerStateIdentity,
  fetchServerState,
  isServerStateAffected,
  peekServerState,
  subscribeToServerState,
  type ServerStateQuery,
} from "./serverStateCache";

export interface ServerStateOptions {
  enabled?: boolean;
  staleTimeMs?: number;
  cacheTimeMs?: number;
}

interface QueryState<T> {
  identity: string;
  data: T | null;
  updatedAt: number | null;
  fetching: boolean;
  error: unknown | null;
  settled: boolean;
}

export function useServerStateQuery<T>(
  path: string,
  query: Record<string, any>,
  deps: any[],
  options: ServerStateOptions = {},
) {
  const enabled = options.enabled ?? true;
  const staleTimeMs = options.staleTimeMs ?? SERVER_STATE_STALE_MS;
  const cacheTimeMs = options.cacheTimeMs ?? SERVER_STATE_CACHE_MS;
  const identity = createServerStateIdentity(path, query);
  const dependencyToken = JSON.stringify(deps);
  const initial = enabled ? peekServerState<T>(path, query) : null;
  const [state, setState] = useState<QueryState<T>>(() => ({
    identity,
    data: initial?.data ?? null,
    updatedAt: initial?.updatedAt ?? null,
    fetching: false,
    error: null,
    settled: initial !== null,
  }));
  const requestVersion = useRef(0);
  const focused = useRef(false);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  const run = useCallback(
    async (force: boolean): Promise<T | null> => {
      if (!enabled) return null;

      const requestedIdentity = identity;
      const cached = peekServerState<T>(path, query);
      if (!force && cached && !cached.stale) {
        setState({
          identity: requestedIdentity,
          data: cached.data,
          updatedAt: cached.updatedAt,
          fetching: false,
          error: null,
          settled: true,
        });
        return cached.data;
      }

      const version = ++requestVersion.current;
      setState((previous) => {
        const sameRequest = previous.identity === requestedIdentity;
        return {
          identity: requestedIdentity,
          data: cached?.data ?? (sameRequest ? previous.data : null),
          updatedAt: cached?.updatedAt ?? (sameRequest ? previous.updatedAt : null),
          fetching: true,
          error: sameRequest ? previous.error : null,
          settled: cached !== null || (sameRequest && previous.settled),
        };
      });

      try {
        const snapshot = await fetchServerState<T>({
          path,
          query,
          fetcher: () => api.get<T>(path, query),
          force,
          staleTimeMs,
          cacheTimeMs,
        });
        if (requestVersion.current !== version || currentIdentity.current !== requestedIdentity) {
          return snapshot.data;
        }
        setState({
          identity: requestedIdentity,
          data: snapshot.data,
          updatedAt: snapshot.updatedAt,
          fetching: false,
          error: null,
          settled: true,
        });
        return snapshot.data;
      } catch (err) {
        if (requestVersion.current === version && currentIdentity.current === requestedIdentity) {
          setState((previous) => ({
            identity: requestedIdentity,
            data: previous.identity === requestedIdentity ? previous.data : cached?.data ?? null,
            updatedAt:
              previous.identity === requestedIdentity ? previous.updatedAt : cached?.updatedAt ?? null,
            fetching: false,
            error: err,
            settled: true,
          }));
        }
        return null;
      }
    },
    // The canonical identity contains every response-affecting query value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, identity, dependencyToken, path, staleTimeMs, cacheTimeMs],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void run(false);
      return () => {
        focused.current = false;
        requestVersion.current += 1;
      };
    }, [run]),
  );

  useEffect(() => {
    let previous: AppStateStatus | null = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      const returning = (previous === "background" || previous === "inactive") && next === "active";
      previous = next;
      if (!returning || !focused.current || !enabled) return;
      const cached = peekServerState<T>(path, query);
      if (!cached || cached.stale) void run(false);
    });
    return () => subscription.remove();
    // The identity changes whenever the query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, identity, run]);

  useEffect(
    () =>
      subscribeToServerState((event) => {
        if (event.type === "clear") {
          requestVersion.current += 1;
          setState({
            identity,
            data: null,
            updatedAt: null,
            fetching: false,
            error: null,
            settled: false,
          });
          return;
        }
        if (
          focused.current &&
          enabled &&
          isServerStateAffected(path, query as ServerStateQuery, event)
        ) {
          void run(false);
        }
      }),
    // The identity changes whenever the query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, identity, run],
  );

  const fallback = state.identity === identity || !enabled ? null : peekServerState<T>(path, query);
  const current: QueryState<T> =
    state.identity === identity
      ? state
      : {
          identity,
          data: fallback?.data ?? null,
          updatedAt: fallback?.updatedAt ?? null,
          fetching: false,
          error: null,
          settled: fallback !== null,
        };
  const data = enabled ? current.data : null;
  const error = enabled && current.error ? errorMessage(current.error) : null;
  const load = useCallback(async () => {
    await run(true);
  }, [run]);

  return {
    data,
    loading: enabled && data === null && error === null,
    refreshing: enabled && data !== null && current.fetching,
    error,
    rawError: enabled ? current.error : null,
    lastUpdatedAt: enabled ? current.updatedAt : null,
    isStale:
      enabled &&
      data !== null &&
      current.updatedAt !== null &&
      Date.now() - current.updatedAt >= staleTimeMs,
    load,
  };
}

export function useInsight<T>(
  path: string,
  query: Record<string, any>,
  deps: any[],
  options?: ServerStateOptions,
) {
  return useServerStateQuery<T>(path, query, deps, options);
}
