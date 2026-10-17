import { Money } from "../../components/Money";
import { Pill } from "../../components/ui";
import { IconRecords } from "../../components/icons";
import { BAND_COPY, type ConfidenceBand } from "../../lib/confidenceBands";
import type { ReceiptField, ReceiptWarning } from "../../lib/receiptWarnings";

export function CompactReceiptSummary({
  vendor,
  description,
  receiptBand,
  date,
  amount,
  compactItemCount,
  compactCategoryLabel,
  attentionFields,
  allWarnings,
}: {
  vendor: string;
  description: string;
  receiptBand: ConfidenceBand;
  date: string;
  amount: number | "";
  compactItemCount: number;
  compactCategoryLabel: string;
  attentionFields: ReceiptField[];
  allWarnings: ReceiptWarning[];
}) {
  return (
    <section aria-labelledby="compact-receipt-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-paper-200 pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
            <IconRecords className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="compact-receipt-title" className="truncate font-display text-lg font-semibold text-ink-900">
              {vendor.trim() || description.trim() || "Receipt details need review"}
            </h2>
            <p className="mt-1 break-words text-sm text-ink-500">{description.trim() || "Add a description before saving."}</p>
          </div>
        </div>
        <Pill tone={BAND_COPY[receiptBand].tone === "ok" ? "ok" : BAND_COPY[receiptBand].tone === "warn" ? "warn" : "danger"}>
          {BAND_COPY[receiptBand].label}
        </Pill>
      </div>

      <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-5 py-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Date</dt>
          <dd className="mt-1 text-sm font-semibold text-ink-900">
            {date ? <time dateTime={date}>{date}</time> : "Date needed"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Vendor</dt>
          <dd className="mt-1 break-words text-sm font-semibold text-ink-900">{vendor.trim() || "Not provided"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Total amount</dt>
          <dd className="figure mt-1 text-sm font-semibold text-ink-900">
            {amount === "" ? "Amount needed" : <Money value={Number(amount)} decimals />}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Items</dt>
          <dd className="mt-1 text-sm font-semibold text-ink-900">
            {compactItemCount} item{compactItemCount === 1 ? "" : "s"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Category</dt>
          <dd className="mt-1 break-words text-sm font-semibold text-ink-900">{compactCategoryLabel}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold text-ink-500">Review status</dt>
          <dd className="mt-1 text-sm font-semibold text-ink-900">
            {attentionFields.length > 0
              ? `${attentionFields.length} field${attentionFields.length === 1 ? "" : "s"} flagged`
              : allWarnings.length > 0
                ? `${allWarnings.length} scan note${allWarnings.length === 1 ? "" : "s"}`
                : "No fields flagged"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
