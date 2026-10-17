import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { getErrorMessage } from "./errors";
import { captureServerStateAccount } from "./serverStateCache";
import {
  clearPendingManualCreate, manualCreateScopeKey, performManualRecordCreate, readPendingManualCreate,
  ManualCreateCorruptError, repairCorruptManualCreate,
  type ManualCreatePayload, type ManualRecordKind, type PendingManualCreate,
} from "./manualRecordCreate";
import type { RecordItem } from "./types";

export function useManualRecordCreate(businessProfileId: number | undefined, kind: ManualRecordKind, active = true) {
  const { profile } = useAuth();
  const scope = profile && businessProfileId ? { ownerId: profile.id, businessProfileId, kind } : null;
  const scopeKey = scope && active ? manualCreateScopeKey(scope) : null;
  const [pending, setPending] = useState<PendingManualCreate | null>(null);
  const [snapshotScopeKey, setSnapshotScopeKey] = useState(scopeKey);
  const [loading, setLoading] = useState(Boolean(scopeKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [checkedRecords, setCheckedRecords] = useState(false);
  const [deferredDraft, setDeferredDraft] = useState<ManualCreatePayload | null>(null);
  const [corruptFingerprint, setCorruptFingerprint] = useState<string | null>(null);
  const operation = useRef<{ controller: AbortController; scopeKey: string } | null>(null);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const pendingRef = useRef<PendingManualCreate | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.controller.abort(); };
  }, []);

  useEffect(() => {
    let current = true;
    operation.current?.controller.abort();
    operation.current = null;
    pendingRef.current = null;
    setPending(null); setError(null); setBusy(false); setCheckedRecords(false); setStorageReady(false);
    setDeferredDraft(null);
    setCorruptFingerprint(null);
    setSnapshotScopeKey(scopeKey);
    if (!scopeKey || !scope) { setLoading(false); return; }
    setLoading(true);
    readPendingManualCreate(scope).then((stored) => {
      if (!current || currentScope.current !== scopeKey) return;
      pendingRef.current = stored; setPending(stored); setStorageReady(true);
    }).catch((errorValue: unknown) => {
      if (current && currentScope.current === scopeKey) {
        setError(getErrorMessage(errorValue));
        if (errorValue instanceof ManualCreateCorruptError) setCorruptFingerprint(errorValue.fingerprint);
      }
    }).finally(() => {
      if (current && currentScope.current === scopeKey) setLoading(false);
    });
    return () => { current = false; operation.current?.controller.abort(); };
    // The string contains every scope field; an object dependency would reload on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  async function save(payload: ManualCreatePayload): Promise<RecordItem | null> {
    if (!scope || !scopeKey || operation.current) return null;
    const controller = new AbortController();
    const task = { controller, scopeKey };
    operation.current = task;
    const isCurrent = () => mounted.current && currentScope.current === scopeKey && operation.current === task;
    setBusy(true); setError(null);
    let adopted = false;
    const previous = pendingRef.current;
    try {
      if (previous?.confirmedRecord) {
        await clearPendingManualCreate(scope, previous.body.idempotencyKey);
        if (!isCurrent()) return null;
        pendingRef.current = null; setPending(null);
        return previous.confirmedRecord;
      }
      const result = await performManualRecordCreate(scope, payload, {
        signal: controller.signal, isCurrent,
        account: captureServerStateAccount(),
        expectedKey: previous?.body.idempotencyKey,
        requireFresh: !previous,
        onPending: (intent) => {
          adopted = true;
          if (!isCurrent()) return;
          pendingRef.current = intent; setPending(intent);
        },
      });
      if (!isCurrent()) return null;
      pendingRef.current = result.cleanupPending ? result.pending : null;
      setPending(pendingRef.current);
      setStorageReady(true);
      if (result.cleanupPending) {
        setError("Your record is saved. Its recovery details could not be cleared. Finish recovery before adding another record.");
        return null;
      }
      return result.record;
    } catch (errorValue) {
      if (!isCurrent()) return null;
      if (pendingRef.current?.confirmedRecord) {
        setError("Your record is saved. Recovery cleanup could not finish. Try Finish recovery again.");
        return null;
      }
      try {
        const stored = await readPendingManualCreate(scope);
        if (!isCurrent()) return null;
        pendingRef.current = stored; setPending(stored); setStorageReady(true);
        if (!previous && !adopted && stored) setDeferredDraft(payload);
      } catch { setStorageReady(false); }
      setError(getErrorMessage(errorValue));
      if (errorValue instanceof ManualCreateCorruptError) setCorruptFingerprint(errorValue.fingerprint);
      throw errorValue;
    } finally {
      if (operation.current === task) { operation.current = null; if (mounted.current) setBusy(false); }
    }
  }

  async function resolveAfterChecking(): Promise<boolean> {
    if (!scope || !scopeKey || !checkedRecords || operation.current || (!pendingRef.current && corruptFingerprint === null) || pendingRef.current?.confirmedRecord) return false;
    const key = pendingRef.current?.body.idempotencyKey;
    const task = { controller: new AbortController(), scopeKey };
    operation.current = task;
    setBusy(true);
    try {
      if (corruptFingerprint !== null) await repairCorruptManualCreate(scope, corruptFingerprint);
      else if (key) await clearPendingManualCreate(scope, key);
      if (!mounted.current || currentScope.current !== scopeKey) return false;
      pendingRef.current = null; setPending(null); setCheckedRecords(false); setError(null);
      setCorruptFingerprint(null); setStorageReady(true);
      return true;
    } catch (errorValue) { if (currentScope.current === scopeKey) setError(getErrorMessage(errorValue)); return false; }
    finally {
      if (operation.current === task) {
        operation.current = null;
        if (mounted.current && currentScope.current === scopeKey) setBusy(false);
      }
    }
  }

  const currentSnapshot = snapshotScopeKey === scopeKey;
  const visiblePending = currentSnapshot ? pending : null;
  const corrupt = currentSnapshot && corruptFingerprint !== null;
  return { pending: visiblePending, loading: !currentSnapshot || loading, busy: currentSnapshot && busy,
    error: currentSnapshot ? error : null, storageReady: currentSnapshot && storageReady,
    checkedRecords: currentSnapshot && checkedRecords, setCheckedRecords, save, resolveAfterChecking,
    frozen: Boolean(visiblePending) || corrupt, ownerId: profile?.id,
    deferredDraft: currentSnapshot ? deferredDraft : null, corrupt,
  };
}
