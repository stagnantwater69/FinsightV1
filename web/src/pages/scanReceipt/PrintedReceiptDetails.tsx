import { ResultDetails } from "../../components/ResultDetails";
import type { ReceiptScanResult } from "./types";

export function PrintedReceiptDetails({ details }: { details: ReceiptScanResult["receiptDetails"] }) {
  if (!details) return null;
  const money = (value: number | null) => value === null ? null : `${details.currency ? `${details.currency} ` : ""}${new Intl.NumberFormat("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
  const fields = [
    ["Currency", details.currency], ["Time", details.transactionTime],
    ["Subtotal", money(details.subtotal)], ["Tax", money(details.tax)],
    ["Tip", money(details.tip)], ["Discount", money(details.discount)],
    ["Payment", details.paymentMethod], ["Receipt number", details.receiptNumber],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!fields.length) return null;

  return (
    <div className="border-t border-paper-200 pt-3 text-ink-700">
      <p className="text-sm font-medium">As printed on the receipt</p>
      <ResultDetails label="Printed receipt details">
        <dl className="space-y-2">
          {fields.map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="text-ink-500">{label}</dt>
              <dd className="figure min-w-0 break-words text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-500">Check against the photo. These are printed details, not a currency conversion.</p>
      </ResultDetails>
    </div>
  );
}
