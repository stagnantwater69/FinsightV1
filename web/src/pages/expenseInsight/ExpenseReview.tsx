import { Fragment, type ReactNode } from "react";
import { IconTile } from "../../components/IconTile";
import { Link } from "react-router-dom";
import { Flag } from "lucide-react";
import { formatMoney } from "../../components/Money";
import { Panel, Pill } from "../../components/ui";
import { SeeAllFooter } from "../../components/SeeAllFooter";
import type { ExpenseBehavior as ExpenseInsightData, RecordItem } from "../../lib/types";
import { UnusualExpenseRow } from "./ExpenseVisuals";
import {
  ListDisclosureControl,
  useListDisclosure,
} from "../../components/ListDisclosure";
import type { SupplementState } from "./supplement";

/**
 * Why a record showed up on the Large Expense Flags panel.
 *
 * Grounded in the exact rule the backend applies (expenseRecord.service.ts:
 * `amount >= expectedMonthlyExpenses * (largeExpenseThresholdPercent / 100)`),
 * so the reason line names a real, checkable threshold rather than a vague
 * "this seemed big". A record can carry a large-expense flag, a duplicate
 * flag, or both — the sentence says whichever actually applied.
 */
function flagReasons(
  record: RecordItem,
  profile: {
    expectedMonthlyExpenses: number;
    largeExpenseThresholdPercent: number;
  },
): ReactNode[] {
  const reasons: ReactNode[] = [];
  if (record.largeExpenseFlag) {
    const thresholdAmount =
      profile.expectedMonthlyExpenses *
      (profile.largeExpenseThresholdPercent / 100);
    reasons.push(
      <>
        above your large-expense threshold (
        {profile.largeExpenseThresholdPercent}% of your starting monthly estimate ={" "}
        <span className="figure">{formatMoney(thresholdAmount)}</span>)
      </>,
    );
  }
  if (record.duplicateStatus === "Flagged") {
    // The other record's database id means nothing to an owner; Needs review shows the pair side by side.
    reasons.push("a possible duplicate of another record");
  }
  return reasons.length > 0 ? reasons : ["flagged for a second look"];
}

/** Renders `flagReasons` joined with " · ", the same separator the plain-string version used. */
function FlagReason({
  record,
  profile,
}: {
  record: RecordItem;
  profile: {
    expectedMonthlyExpenses: number;
    largeExpenseThresholdPercent: number;
  };
}) {
  const reasons = flagReasons(record, profile);
  return (
    <>
      {reasons.map((reason, i) => (
        <Fragment key={i}>
          {i > 0 ? " · " : null}
          {reason}
        </Fragment>
      ))}
    </>
  );
}

// Three, not five: each unusual row carries a bar, so five ran well past the
// large-expense flags beside it.
const UNUSUAL_PREVIEW_COUNT = 3;

export function FlaggedExpensesPanel({
  flaggedState,
  flaggedTotal,
  flaggedExpenses,
  disclosure,
  categoryName,
  profile,
  hasFlaggedRecordLink,
}: {
  flaggedState: SupplementState;
  flaggedTotal: number;
  flaggedExpenses: RecordItem[];
  disclosure: ReturnType<typeof useListDisclosure>;
  categoryName: (categoryId?: number) => string;
  profile: { expectedMonthlyExpenses: number; largeExpenseThresholdPercent: number };
  hasFlaggedRecordLink: boolean;
}) {
  return (
    <Panel
      title="Large expense flags"
      className="h-full min-w-0"
      action={
        flaggedState === "stale" ? (
          <Pill>Saved data</Pill>
        ) : flaggedState === "unavailable" ? (
          <Pill>Unavailable</Pill>
        ) : flaggedState === "ready" && flaggedTotal > 0 ? (
          <Pill tone="danger">{flaggedTotal} flagged</Pill>
        ) : null
      }
    >
      <SupplementNotice
        state={flaggedState}
        label="flagged record details"
      />
      {flaggedState === "loading" ? (
        <p
          aria-live="polite"
          className="py-6 text-center text-sm text-ink-500"
        >
          Loading flagged records…
        </p>
      ) : flaggedState === "unavailable" ||
        (flaggedState === "stale" && flaggedTotal === 0) ||
        flaggedTotal === 0 ? null : (
        <>
          <ul id={disclosure.contentId} className="space-y-2">
            {flaggedExpenses
              .slice(0, disclosure.visibleCount)
              .map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-3 rounded-xl border border-paper-200 bg-paper-50 px-3.5 py-3"
                >
                  <IconTile icon={Flag} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 text-sm font-semibold text-ink-900">
                        {r.description}
                      </p>
                      <p className="figure shrink-0 text-sm font-bold text-tone-danger">
                        {formatMoney(r.amount)}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {categoryName(r.categoryId)} ·{" "}
                      {r.date.slice(0, 10)} ·{" "}
                      <FlagReason record={r} profile={profile} />
                    </p>
                  </div>
                </li>
              ))}
          </ul>
          <ListDisclosureControl
            disclosure={disclosure}
            total={flaggedExpenses.length}
            itemLabel={flaggedTotal > flaggedExpenses.length ? "loaded flags" : "flags"}
            className="mt-3"
          />
          {hasFlaggedRecordLink ? (
            <Link
              to="/records/flagged"
              className="tap-inline mt-3 block text-sm link-action"
            >
              Review all {flaggedTotal} flagged
            </Link>
          ) : null}
        </>
      )}
    </Panel>
  );
}

export function UnusualExpensesPanel({
  data,
  isRefreshing,
  refreshError,
}: {
  data: ExpenseInsightData;
  isRefreshing: boolean;
  refreshError: string | null;
}) {
  return (
    <Panel
      title="Unusual expenses"
      className="h-full min-w-0"
      action={
        data.unusualExpenses.length > 0 ? (
          <span className="text-xs text-ink-500">
            {data.unusualExpenses.length} flagged
          </span>
        ) : null
      }
    >
    {isRefreshing && data.unusualExpenses.length === 0 ? (
      <p aria-live="polite" className="py-6 text-center text-sm text-ink-500">
        Refreshing unusual expenses…
      </p>
    ) : refreshError && data.unusualExpenses.length === 0 ? (
      <p role="status" className="text-sm text-tone-accent">
        Showing recently loaded unusual-expense results; the latest
        refresh failed.
      </p>
    ) : (
      <>
        <ul className="space-y-2">
          {data.unusualExpenses.slice(0, UNUSUAL_PREVIEW_COUNT).map((u) => (
            <UnusualExpenseRow key={u.id} expense={u} />
          ))}
        </ul>
        {/* The full list opens on its own page rather than growing
            this panel past the flags panel beside it. */}
        {data.unusualExpenses.length > UNUSUAL_PREVIEW_COUNT ? (
          <SeeAllFooter
            shown={UNUSUAL_PREVIEW_COUNT}
            total={data.unusualExpenses.length}
            noun="unusual expenses"
            to="/insights/expense-behavior/unusual"
          />
        ) : null}
      </>
    )}

    {data.insufficientHistoryCategories.length > 0 ? (
      <p className="mt-3 text-xs text-ink-500">
        Not enough history to check:{" "}
        {data.insufficientHistoryCategories
          .map((c) => c.categoryName)
          .join(", ")}
      </p>
    ) : null}
    </Panel>
  );
}

export function SupplementNotice({ state, label }: { state: SupplementState; label: string }) {
  if (state === "ready" || state === "loading") return null;
  return (
    <p role="status" className="mb-3 text-xs text-tone-accent">
      {state === "stale"
        ? `Showing recently loaded ${label}; the latest refresh failed.`
        : `${label[0]!.toUpperCase()}${label.slice(1)} are temporarily unavailable.`}
    </p>
  );
}
