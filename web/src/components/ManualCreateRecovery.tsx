import { Link } from "react-router-dom";
import { Button } from "./Button";
import { FormError } from "./Field";
import { Callout } from "./ui";
import type { useManualRecordCreate } from "../lib/useManualRecordCreate";

export function ManualCreateRecovery({ recovery }: { recovery: ReturnType<typeof useManualRecordCreate> }) {
  if (!recovery.pending && !recovery.corrupt) return recovery.error ? <FormError>{recovery.error}</FormError> : null;
  const confirmed = Boolean(recovery.pending?.confirmedRecord);
  return (
    <Callout tone={confirmed ? "brand" : "warn"}>
      <p role="status">{confirmed
        ? "Your record is saved. Finish recovery below; this will not send another save."
        : recovery.corrupt ? "This business has unreadable save recovery. Check its records before resolving it below. Other businesses' recovery will stay stored."
          : "This save has not been confirmed. The original details are kept below. Retrying uses the same save request."}</p>
      {recovery.deferredDraft ? <p className="mt-2">Your separate draft will return when you resolve this earlier save.</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link to="/records" target="_blank" rel="noopener noreferrer" className="tap-inline link-action">Check records in a new tab</Link>
      </div>
      {!confirmed ? (
        <>
          <label className="tap mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={recovery.checkedRecords} onChange={(event) => recovery.setCheckedRecords(event.target.checked)} disabled={recovery.busy} />
            I checked the records and want to resolve this save before making a separate entry.
          </label>
          <Button type="button" variant="secondary" disabled={!recovery.checkedRecords || recovery.busy} onClick={() => void recovery.resolveAfterChecking()}>Resolve this save and enable editing</Button>
        </>
      ) : null}
      {recovery.error ? <p role="alert" className="mt-2 text-sm">{recovery.error}</p> : null}
    </Callout>
  );
}
