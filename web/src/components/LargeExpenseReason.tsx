import { Link } from "react-router-dom";
import type { BusinessProfile, RecordItem } from "../lib/types";
import { Money } from "./Money";

/**
 * Why a record was flagged, stated in the owner's own numbers.
 *
 * THIS IS THE QUALITY BAR for every reason in the queue, which is why it
 * survived the rebuild unchanged. It names the threshold, says where that
 * number came from (a percentage the owner chose themselves, of a figure they
 * entered themselves), and links to the screen that changes it — so it reads
 * as a setting rather than an accusation. UAT items 30 and 33 are both about
 * this: "Possible duplicate of record #412" told the owner nothing they could
 * act on.
 *
 * Both operands are on the BusinessProfile already in context, so this needs
 * no API call: amount >= expectedMonthlyExpenses × (threshold% / 100), the
 * same arithmetic largeExpenseThresholdFor() does on the server.
 */
/** Why a record is marked Check or Repeat?, in one sentence the owner can act on. */
export function ReviewReason({ record, profile }: { record: RecordItem; profile: BusinessProfile | null }) {
  if (record.duplicateStatus === "Flagged") {
    return (
      <>
        FinSight&rsquo;s duplicate check found another record with the same date and amount, and the same
        vendor or description.{" "}
        <Link to="/records/flagged" className="tap-inline link-action">Compare them in Needs review</Link>.
      </>
    );
  }
  if (record.largeExpenseFlag && profile) return <LargeExpenseReason record={record} profile={profile} />;
  if (record.source === "RECEIPT_SCAN") {
    return <>This came from a scanned receipt and hasn&rsquo;t been confirmed yet.</>;
  }
  return <>This record is waiting on your confirmation before FinSight counts it as settled.</>;
}

export function LargeExpenseReason({ record, profile }: { record: RecordItem; profile: BusinessProfile }) {
  const threshold =
    Number(profile.expectedMonthlyExpenses) * (Number(profile.largeExpenseThresholdPercent) / 100);

  if (!Number.isFinite(threshold) || threshold <= 0) {
    return (
      <>
        Large compared with your usual spending. Set a starting monthly estimate to see the exact threshold.
      </>
    );
  }

  return (
    <>
      <Money value={record.amount} /> is at or above your large-expense threshold of{" "}
      <Money value={threshold} />. That is {profile.largeExpenseThresholdPercent}% of your{" "}
      <Money value={profile.expectedMonthlyExpenses} /> starting monthly estimate.{" "}
      <Link to="/business-profiles" className="tap-inline link-action">
        Change the threshold
      </Link>{" "}
      if this is normal for your business.
    </>
  );
}
