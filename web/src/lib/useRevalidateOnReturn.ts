import { useEffect, useRef } from "react";

type Revalidate = (signal: AbortSignal) => void;

/**
 * Ask a mounted read to revalidate when the owner comes back to the tab.
 *
 * A record added on the phone never reached a web dashboard left open in a
 * background tab: nothing on this side changed, so nothing invalidated it.
 * Returning is the moment the owner looks again. The callback decides whether
 * to fetch, so a read still inside its cache window costs nothing.
 *
 * Switching tabs fires `visibilitychange` and `focus` together; they collapse
 * into one call, and a newer return aborts the call before it.
 */
export function useRevalidateOnReturn(revalidate: Revalidate) {
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  useEffect(() => {
    let queued = false;
    let controller: AbortController | null = null;

    const onReturn = () => {
      if (document.visibilityState !== "visible" || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        controller?.abort();
        controller = new AbortController();
        revalidateRef.current(controller.signal);
      });
    };

    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      controller?.abort();
    };
  }, []);
}
