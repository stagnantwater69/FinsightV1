import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  clearReceiptReviewDraft,
  readReceiptReviewDraft,
  saveReceiptReviewDraft,
  type ReceiptReviewDraftScope,
  type ReceiptReviewEdits,
} from "../../../lib/receiptReviewDraft";
import { hasUnsavedReviewEdits, restorableReviewEdits } from "./reviewDraft";
import type { ReceiptScanResult } from "./types";
import type { NavigationAction } from "@react-navigation/native";

interface RemovalEvent { preventDefault: () => void; data: { action: NavigationAction } }
interface GuardedNavigation {
  addListener?: (event: "beforeRemove", listener: (event: RemovalEvent) => void) => () => void;
  dispatch?: (action: NavigationAction) => void;
}

/**
 * Keeps the owner's review corrections across navigation and app restarts.
 *
 * `begin` runs whenever a reading is shown: it records what the form was
 * seeded with, then restores a stored draft for that exact account, business
 * and scan unless the owner has already started typing. From then on every
 * change is written through a single coalescing queue, so a burst of
 * keystrokes costs one write in flight plus one pending. A failed write leaves
 * the form untouched and only sets `saveFailed`.
 */
export function useReceiptReviewDraft({
  ownerId,
  businessProfileId,
  scan,
  edits,
  apply,
  navigation,
}: {
  ownerId: number | undefined;
  businessProfileId: number | undefined;
  scan: ReceiptScanResult | null;
  edits: ReceiptReviewEdits;
  apply: (edits: ReceiptReviewEdits) => void;
  navigation: GuardedNavigation;
}) {
  const [baseline, setBaseline] = useState<{ scanId: number; edits: ReceiptReviewEdits } | null>(null);
  const [readyFor, setReadyFor] = useState<number | null>(null);
  const [restored, setRestored] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const token = useRef(0);
  const stored = useRef(false);
  const leaving = useRef(false);
  const queued = useRef<{ run: () => Promise<void>; save: boolean } | null>(null);
  const running = useRef(false);

  const scope: ReceiptReviewDraftScope | null = scan && ownerId && businessProfileId === scan.businessProfileId
    ? { ownerId, businessProfileId, scanId: scan.id }
    : null;
  const dirty = Boolean(scan && baseline && baseline.scanId === scan.id && hasUnsavedReviewEdits(edits, baseline.edits, scan.items));

  const latest = useRef({ ownerId, businessProfileId, scan, edits, scope, dirty, apply });
  latest.current = { ownerId, businessProfileId, scan, edits, scope, dirty, apply };

  const schedule = useCallback((run: () => Promise<void>, save: boolean) => {
    queued.current = { run, save };
    if (running.current) return;
    running.current = true;
    void (async () => {
      while (queued.current) {
        const next = queued.current;
        queued.current = null;
        try {
          await next.run();
          if (next.save) setSaveFailed(false);
        } catch {
          if (next.save) setSaveFailed(true);
        }
      }
      running.current = false;
    })();
  }, []);

  const begin = useCallback((result: ReceiptScanResult, seeded: ReceiptReviewEdits) => {
    const current = ++token.current;
    const { ownerId: owner, businessProfileId: business } = latest.current;
    leaving.current = false;
    stored.current = false;
    // The caller has just applied `seeded`; the next render would say so too late.
    latest.current.edits = seeded;
    setBaseline({ scanId: result.id, edits: seeded });
    setReadyFor(null);
    setRestored(false);
    setSaveFailed(false);
    if (!owner || business !== result.businessProfileId) return;
    const finish = () => { if (token.current === current) setReadyFor(result.id); };
    // Settles before the render that shows `result`, so the token is the only guard.
    readReceiptReviewDraft({ ownerId: owner, businessProfileId: business, scanId: result.id }).then((draft) => {
      if (token.current !== current) return;
      if (draft) {
        stored.current = true;
        if (!hasUnsavedReviewEdits(latest.current.edits, seeded, result.items)) {
          const next = restorableReviewEdits(draft, seeded, result.items);
          if (hasUnsavedReviewEdits(next, seeded, result.items)) {
            latest.current.apply(next);
            setRestored(true);
          }
        }
      }
      finish();
    }, finish);
  }, []);

  /** Stops tracking without touching storage: business switch or starting over. */
  const reset = useCallback(() => {
    token.current += 1;
    stored.current = false;
    setBaseline(null);
    setReadyFor(null);
    setRestored(false);
    setSaveFailed(false);
  }, []);

  const clearStored = useCallback((target: ReceiptReviewDraftScope | null) => {
    stored.current = false;
    if (target) schedule(() => clearReceiptReviewDraft(target), false);
  }, [schedule]);

  /** The owner chose to throw their changes away. */
  const discard = useCallback(() => {
    setRestored(false);
    clearStored(latest.current.scope);
  }, [clearStored]);

  /** Back to the scanned values, for the restored-changes notice. */
  const discardRestored = useCallback(() => {
    const current = latest.current;
    discard();
    if (baseline && current.scan && baseline.scanId === current.scan.id) current.apply(baseline.edits);
  }, [baseline, discard]);

  /** This scan is finished (confirmed or deleted); leaving needs no prompt. */
  const close = useCallback((scanId: number) => {
    const target = latest.current.scope;
    leaving.current = true;
    reset();
    clearStored(target?.scanId === scanId ? target : null);
  }, [reset, clearStored]);

  /** Runs `onDiscard` at once when nothing is unsaved, otherwise asks first. */
  const confirmDiscard = useCallback((onDiscard: () => void) => {
    if (!latest.current.dirty) { onDiscard(); return; }
    Alert.alert("Discard your receipt changes?", "Your changes to this receipt haven't been saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard changes", style: "destructive", onPress: () => { discard(); onDiscard(); } },
    ]);
  }, [discard]);

  const serialized = JSON.stringify(edits);
  useEffect(() => {
    const { scope: target, dirty: unsaved, edits: values } = latest.current;
    if (!target || readyFor !== target.scanId || leaving.current) return;
    if (unsaved) {
      stored.current = true;
      schedule(() => saveReceiptReviewDraft(target, values), true);
    } else if (stored.current) {
      stored.current = false;
      schedule(() => clearReceiptReviewDraft(target), false);
    }
  }, [serialized, readyFor, dirty, scope?.ownerId, scope?.businessProfileId, scope?.scanId, schedule]);

  useEffect(() => navigation.addListener?.("beforeRemove", (event) => {
    if (!latest.current.dirty || leaving.current) return;
    event.preventDefault();
    Alert.alert("Discard your receipt changes?", "Your changes to this receipt haven't been saved.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          discard();
          leaving.current = true;
          navigation.dispatch?.(event.data.action);
        },
      },
    ]);
  }), [navigation, discard]);

  return {
    dirty,
    restored: restored && Boolean(scan),
    saveFailed: saveFailed && dirty,
    begin,
    reset,
    discardRestored,
    close,
    confirmDiscard,
  };
}
