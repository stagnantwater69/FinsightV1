import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { FormError } from "../../components/Field";
import { Callout, FormPage } from "../../components/ui";
import { ScanProgress } from "./ScanProgress";
import type { ReceiptHistoryItem, ReceiptScanResult, ScanStage } from "./types";

export function FailedReceiptScan({
  scan,
  receiptPreview,
  scanError,
  scanning,
  scanStage,
  retryProcessing,
  handleStopWaiting,
  handleRescan,
  deleteUnconfirmedScan,
  deletingScanId,
}: {
  scan: ReceiptScanResult;
  receiptPreview: ReactNode;
  scanError: string | null;
  scanning: boolean;
  scanStage: ScanStage;
  retryProcessing: () => Promise<void>;
  handleStopWaiting: () => void;
  handleRescan: () => Promise<void>;
  deleteUnconfirmedScan: (target: Pick<ReceiptHistoryItem, "id" | "extractedVendor" | "extractedDescription">) => Promise<void>;
  deletingScanId: number | null;
}) {
  return (
    <FormPage eyebrow="Records" title="Receipt needs another try">
      <div className="space-y-4">
        <Callout tone="warn">
          <p className="font-semibold">FinSight could not finish reading this receipt.</p>
          <p className="mt-1 text-sm">
            {scan.processingError ?? "The saved images are still available for another processing attempt."}
          </p>
        </Callout>
        {receiptPreview}
        {scanError ? <FormError>{scanError}</FormError> : null}
        {scanning ? <ScanProgress stage={scanStage} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={retryProcessing} disabled={scanning}>
            {scanning ? "Retrying…" : "Retry processing"}
          </Button>
          {scanning ? (
            <Button type="button" variant="secondary" onClick={handleStopWaiting}>
              Stop waiting
            </Button>
          ) : null}
          <Link to="/records/expenses/new" className="tap-inline inline-flex items-center link">
            Enter manually
          </Link>
          <Button type="button" variant="secondary" onClick={handleRescan} disabled={scanning}>
            Choose another image
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void deleteUnconfirmedScan(scan)}
            disabled={scanning || deletingScanId !== null}
          >
            {deletingScanId === scan.id ? "Deleting…" : "Delete scan"}
          </Button>
        </div>
      </div>
    </FormPage>
  );
}
