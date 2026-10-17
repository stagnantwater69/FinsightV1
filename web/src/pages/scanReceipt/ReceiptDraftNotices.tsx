import { Button } from "../../components/Button";
import { Callout } from "../../components/ui";
import { recoveryRowTitle } from "./recoveryHistory";
import type { ReceiptHistoryItem } from "./types";

export function KeptDraftNotice({
  draftRow,
  scanning,
  deletingScanId,
  openStoredScan,
  discardStoredDraft,
}: {
  draftRow: ReceiptHistoryItem;
  scanning: boolean;
  deletingScanId: number | null;
  openStoredScan: (summary: ReceiptHistoryItem) => Promise<void>;
  discardStoredDraft: (target: ReceiptHistoryItem) => Promise<void>;
}) {
  return (
    <section aria-label="Unsaved review changes" className="mb-4">
      <Callout tone="brand">
        <p className="font-semibold">You have unsaved changes to {recoveryRowTitle(draftRow)}.</p>
        <p className="mt-0.5">They were kept in this browser tab.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="primary" size="sm" disabled={scanning || deletingScanId !== null}
            onClick={() => void openStoredScan(draftRow)}>
            Continue reviewing
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={scanning}
            onClick={() => void discardStoredDraft(draftRow)}>
            Discard changes
          </Button>
        </div>
      </Callout>
    </section>
  );
}

export function RestoredDraftNotice({
  confirming,
  discardRestoredDraft,
}: {
  confirming: boolean;
  discardRestoredDraft: () => Promise<void>;
}) {
  return (
    <div className="mb-4" role="status">
      <Callout tone="brand">
        <p className="font-semibold">Your unsaved changes to this receipt were restored.</p>
        <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={confirming}
          onClick={() => void discardRestoredDraft()}>
          Discard changes
        </Button>
      </Callout>
    </div>
  );
}
