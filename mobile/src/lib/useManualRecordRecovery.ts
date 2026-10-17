import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  PendingManualRecordError,
  clearManualRecordIntent,
  discardManualRecordRecovery,
  prepareManualRecordIntent,
  readManualRecordIntent,
  type ManualRecordDraft,
  type ManualRecordIntent,
  type ManualRecordKind,
  type ManualRecordPayload,
  type ManualRecordScope,
} from "./manualRecordRecovery";

interface RecoveryState {
  identity: string;
  ready: boolean;
  loading: boolean;
  intent: ManualRecordIntent | null;
  confirmedRecordId: number | null;
  error: string | null;
}

export function useManualRecordRecovery(ownerId: number | undefined, businessProfileId: number | undefined, kind: ManualRecordKind, restoreDraft: (draft: ManualRecordDraft) => void, currentDraft?: ManualRecordDraft) {
  const identity = `${ownerId}:${businessProfileId}:${kind}`;
  const scope: ManualRecordScope | null = ownerId && businessProfileId ? { ownerId, businessProfileId, kind } : null;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const restore = useRef(restoreDraft);
  restore.current = restoreDraft;
  const liveDraft = useRef(currentDraft);
  liveDraft.current = currentDraft;
  const heldDraft = useRef<{ identity: string; draft: ManualRecordDraft } | null>(null);
  const [heldIdentity, setHeldIdentity] = useState<string | null>(null);
  const request = useRef(0);
  const focused = useRef(false);
  const [state, setState] = useState<RecoveryState>({ identity, ready: false, loading: true, intent: null, confirmedRecordId: null, error: null });
  const latestState = useRef(state);
  latestState.current = state;
  const current = useCallback((intent: ManualRecordIntent) => focused.current && latestIdentity.current === `${intent.scope.ownerId}:${intent.scope.businessProfileId}:${intent.scope.kind}`, []);

  const load = useCallback(async () => {
    if (!ownerId || !businessProfileId) return;
    const version = ++request.current;
    setState((previous) => previous.identity === identity ? { ...previous, loading: true } : { identity, ready: false, loading: true, intent: null, confirmedRecordId: null, error: null });
    try {
      const intent = await readManualRecordIntent({ ownerId, businessProfileId, kind });
      if (!focused.current || latestIdentity.current !== identity || version !== request.current) return;
      const previous = latestState.current;
      if (intent && (previous.identity !== identity || !previous.ready || previous.intent?.key !== intent.key)) {
        if (previous.identity === identity && previous.ready && !previous.intent && liveDraft.current && JSON.stringify(liveDraft.current) !== JSON.stringify(intent.draft)) {
          heldDraft.current = { identity, draft: { ...liveDraft.current } };
          setHeldIdentity(identity);
        }
        restore.current(intent.draft);
      }
      setState((previous) => {
        // Cleanup may have removed the pointer before failing on old chunks.
        if (!intent && previous.identity === identity && previous.intent && previous.confirmedRecordId !== null) return { ...previous, ready: true, loading: false };
        return { identity, ready: true, loading: false, intent, confirmedRecordId: previous.identity === identity && previous.intent?.key === intent?.key ? previous.confirmedRecordId : null, error: null };
      });
    } catch (error) {
      if (focused.current && latestIdentity.current === identity && version === request.current) {
        setState((previous) => ({ identity, ready: true, loading: false, intent: previous.identity === identity ? previous.intent : null, confirmedRecordId: previous.identity === identity ? previous.confirmedRecordId : null, error: error instanceof Error ? error.message : "Saved recovery could not be read. Check your records before saving again." }));
      }
    }
  }, [ownerId, businessProfileId, kind, identity]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    return () => { focused.current = false; request.current += 1; };
  }, [load]));

  function adopt(intent: ManualRecordIntent) {
    if (!current(intent)) return;
    setState({ identity, ready: true, loading: false, intent, confirmedRecordId: null, error: null });
  }

  async function prepare(payload: ManualRecordPayload, draft: ManualRecordDraft): Promise<ManualRecordIntent> {
    if (!scope || !focused.current || latestIdentity.current !== identity) throw new Error("Choose the current account and business before saving.");
    try {
      const intent = await prepareManualRecordIntent(scope, payload, draft);
      if (!current(intent)) throw new Error("The account or business changed before this request was sent. Its recovery remains saved for the original owner.");
      adopt(intent);
      return intent;
    } catch (error) {
      if (error instanceof PendingManualRecordError && current(error.intent)) {
        if (liveDraft.current && JSON.stringify(liveDraft.current) !== JSON.stringify(error.intent.draft)) { heldDraft.current = { identity, draft: { ...liveDraft.current } }; setHeldIdentity(identity); }
        restore.current(error.intent.draft);
        adopt(error.intent);
      }
      else if (latestIdentity.current === identity && focused.current) setState((previous) => ({ ...previous, error: "Device recovery could not be saved and verified. Nothing was sent. Try loading recovery again or check your records." }));
      throw error;
    }
  }

  async function retry(intent: ManualRecordIntent): Promise<ManualRecordIntent> {
    if (!current(intent)) throw new Error("The account or business changed before this request was sent.");
    try {
      const saved = await readManualRecordIntent(intent.scope);
      if (!saved || saved.key !== intent.key || JSON.stringify(saved.payload) !== JSON.stringify(intent.payload)) throw new Error("The previous request changed or is no longer available. Reload recovery and check your records before continuing.");
      if (!current(intent)) throw new Error("The account or business changed before this request was sent.");
      return saved;
    } catch (error) {
      if (current(intent)) setState((previous) => ({ ...previous, error: "The previous request could not be verified in storage. Nothing was sent. Try loading recovery again or check your records." }));
      throw error;
    }
  }

  async function clear(intent: ManualRecordIntent, preserveConfirmation = false): Promise<void> {
    await clearManualRecordIntent(intent.scope, intent.key);
    if (current(intent)) setState((previous) => previous.intent?.key === intent.key ? (preserveConfirmation ? { ...previous, error: null } : { ...previous, intent: null, confirmedRecordId: null, error: null }) : previous);
  }

  async function confirm(intent: ManualRecordIntent, recordId: number): Promise<boolean> {
    if (!current(intent)) return false;
    setState((previous) => ({ ...previous, confirmedRecordId: recordId }));
    const preserveEdits = heldDraft.current?.identity === identity;
    try { await clear(intent, preserveEdits); return current(intent) && !preserveEdits; }
    catch {
      if (current(intent)) setState((previous) => ({ ...previous, error: "The save is confirmed. This device could not clear its previous request. Try clearing it again or check your records." }));
      return false;
    }
  }

  async function discard(expectedKey: string | null): Promise<void> {
    if (!scope || latestIdentity.current !== identity || !focused.current) return;
    const latest = latestState.current;
    const resolvingUnreadable = expectedKey === null && !!latest.error && latest.confirmedRecordId === null;
    if (!resolvingUnreadable && (latest.intent?.key ?? null) !== expectedKey) throw new Error("The previous request changed. Reload recovery before clearing it.");
    await discardManualRecordRecovery(scope, expectedKey);
    if (latestIdentity.current === identity && focused.current) {
      if (heldDraft.current?.identity === identity) restore.current(heldDraft.current.draft);
      heldDraft.current = null;
      setHeldIdentity(null);
      setState({ identity, ready: true, loading: false, intent: null, confirmedRecordId: null, error: null });
    }
  }

  const visible = state.identity === identity ? state : { identity, ready: false, loading: true, intent: null, confirmedRecordId: null, error: null };
  return { intent: visible.intent, loading: visible.loading || !visible.ready, error: visible.error, confirmedRecordId: visible.confirmedRecordId, hasHeldDraft: heldIdentity === identity, frozen: visible.loading || !visible.ready || !!visible.intent || !!visible.error, current, load, prepare, retry, clear, confirm, discard };
}

export type ManualRecordRecoveryState = ReturnType<typeof useManualRecordRecovery>;
