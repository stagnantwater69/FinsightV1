import { useState } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { RecordItem } from "../lib/types";
import { useConfirm } from "./ConfirmDialog";
import { useToast } from "./Toast";

const pathFor = (r: RecordItem) => (r.type === "expense" ? `/records/expenses/${r.id}` : `/records/sales/${r.id}`);

/**
 * Keep both, or delete this copy: the two answers to a Repeat?, shared by the
 * compare window and the edit page so both settle a duplicate the same way.
 */
export function useResolveDuplicate(onDone: (outcome: "kept" | "deleted") => void) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function keep(record: RecordItem) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(pathFor(record), { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" });
      toast(`Kept "${record.description}"`);
      onDone("kept");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function discard(record: RecordItem, otherExists: boolean) {
    const ok = await confirm({
      title: `Delete this copy of "${record.description}"?`,
      body: `This copy is deleted and leaves every figure.${otherExists ? " The earlier record stays." : ""}`,
      confirmLabel: "Delete copy",
      tone: "danger",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      await api.delete(pathFor(record), { serverStateScope: { businessProfileId: record.businessProfileId } });
      toast(`Deleted the copy of "${record.description}"`);
      onDone("deleted");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, keep, discard };
}
