import { ResultDetails } from "../../components/ResultDetails";
import { Callout } from "../../components/ui";
import { warningHeadline, warningPageSuffix, type ReceiptWarning } from "../../lib/receiptWarnings";

// These warnings change how the user must review the receipt. Their instructions
// stay visible; optional extraction commentary and evidence can be expanded.
const ACTION_WARNINGS = new Set(["DUPLICATE_PAGE", "MULTI_RECEIPT", "UNEXPLAINED_GAP", "AMBIGUOUS_DATE", "UNREADABLE_FIELD"]);

export function ReceiptResultNotes({ warnings }: { warnings: ReceiptWarning[] }) {
  const unique = warnings.filter((warning, index) => warnings.findIndex((other) =>
    other.code === warning.code && other.field === warning.field && other.pageNumber === warning.pageNumber && other.detail === warning.detail,
  ) === index);
  const actions = unique.filter((warning) => ACTION_WARNINGS.has(warning.code));
  const optional = unique.filter((warning) => !ACTION_WARNINGS.has(warning.code));
  const evidence = actions.filter((warning) => warning.detail);
  if (!unique.length) return null;

  return (
    <Callout tone={actions.length ? "warn" : "info"}>
      {actions.length ? (
        <ul className="space-y-2">
          {actions.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <p className="font-semibold">{warningHeadline(warning.code)}{warningPageSuffix(warning)}.</p>
              {warning.guidance ? <p>{warning.guidance}</p> : null}
            </li>
          ))}
        </ul>
      ) : <p className="font-semibold">Some details need your review.</p>}
      {optional.length || evidence.length ? (
        <ResultDetails label="Receipt scan details">
          <ul className="space-y-3">
            {optional.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>
                <p className="font-semibold">{warningHeadline(warning.code)}{warningPageSuffix(warning)}.</p>
                {warning.guidance ? <p>{warning.guidance}</p> : null}
                {warning.detail ? <p className="mt-1 text-xs">{warning.detail}</p> : null}
              </li>
            ))}
            {evidence.map((warning, index) => (
              <li key={`evidence-${index}`}>
                <p className="font-semibold">{warningHeadline(warning.code)}{warningPageSuffix(warning)}.</p>
                <p>{warning.detail}</p>
              </li>
            ))}
          </ul>
        </ResultDetails>
      ) : null}
    </Callout>
  );
}
