import { useEffect, useMemo, useRef } from "react";

/** Serializes picker/upload/save operations and rejects results from another business. */
export function useImportOperation(businessId: number | undefined) {
  const scope = useRef(businessId);
  scope.current = businessId;
  const active = useRef<{ controller: AbortController; businessId: number | undefined } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, [businessId]);
  return useMemo(() => ({
    begin() {
      if (active.current || !mounted.current) return null;
      const operation = { controller: new AbortController(), businessId };
      active.current = operation;
      return operation;
    },
    current(operation: { controller: AbortController; businessId: number | undefined }) {
      return mounted.current && active.current === operation && !operation.controller.signal.aborted && scope.current === operation.businessId;
    },
    finish(operation: { controller: AbortController }) {
      if (active.current === operation) active.current = null;
    },
    cancel() {
      active.current?.controller.abort();
      active.current = null;
    },
  }), [businessId]);
}
