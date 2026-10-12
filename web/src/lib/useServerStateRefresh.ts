import { useLayoutEffect, useRef } from "react";
import {
  isServerStateAffected,
  subscribeToServerState,
  type ServerStateInvalidation,
  type ServerStateScope,
} from "./serverStateCache";

type Refresh = (signal: AbortSignal, target: ServerStateInvalidation) => void;

/** Revalidate mounted reads after a matching successful mutation evicts them. */
export function useServerStateRefresh(
  scopes: readonly ServerStateScope[],
  refresh: Refresh,
) {
  const scopesRef = useRef(scopes);
  const refreshRef = useRef(refresh);
  scopesRef.current = scopes;
  refreshRef.current = refresh;

  useLayoutEffect(() => {
    let active = true;
    let queued = false;
    let latestTarget: ServerStateInvalidation | null = null;
    let controller: AbortController | null = null;

    const unsubscribe = subscribeToServerState((event) => {
      if (
        event.type !== "invalidate" ||
        !scopesRef.current.some((scope) => isServerStateAffected(scope, event.target))
      ) {
        return;
      }

      latestTarget = event.target;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!active || !latestTarget) return;
        const target = latestTarget;
        latestTarget = null;
        controller?.abort();
        controller = new AbortController();
        refreshRef.current(controller.signal, target);
      });
    });

    return () => {
      active = false;
      controller?.abort();
      unsubscribe();
    };
  }, []);
}
