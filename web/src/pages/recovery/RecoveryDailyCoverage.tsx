import type { ReactNode } from "react";
import { IconTile } from "../../components/IconTile";
import {
  ArrowDown,
  ArrowUp,
  CalendarCheck,
  CalendarOff,
  Check,
  Minus,
  TrendingUp,
} from "lucide-react";
import { DataTable, type Column } from "../../components/DataTable";
import {
  ListDisclosureControl,
  useListDisclosure,
} from "../../components/ListDisclosure";
import { DailySalesChart } from "./RecoveryCharts";
import { shortDay } from "./recoverySeries";
import type {
  DailyCoverageRow,
  DailyCoverageStatus,
  RecoveryReportingPeriod,
} from "../../lib/types";
import { Panel, Pill, type PillTone } from "../../components/ui";
import { Money, formatMoney } from "../../components/Money";
import {
  statusColor,
  dailyRowStatusLabel,
  recoveryPeriodLabel,
  recoveryPeriodPhrase,
} from "./recoveryLabels";

// The Status column as a themed Pill rather than a hand-rolled chip painted
// with an inline background colour — see the note on PILL_TONES in ui.tsx.
// "at" reads as informational rather than a warning: reaching the target
// exactly is a good outcome, not a caution. "closed" is neutral — a
// configured non-operating day is neither good nor bad news, so it must not
// borrow the danger/info/ok tones the other three statuses use.
const STATUS_TONE: Record<DailyCoverageStatus, PillTone> = {
  below: "danger",
  at: "info",
  above: "ok",
  closed: "neutral",
};

function DailyStatusIcon({ status }: { status: DailyCoverageStatus }) {
  const Icon =
    status === "below"
      ? ArrowDown
      : status === "at"
        ? Minus
        : status === "closed"
          ? CalendarOff
          : ArrowUp;
  return <Icon aria-hidden className="size-3.5" />;
}

// Column defs live at module scope, same as every other DataTable call site —
// they don't close over component state, so there's no reason to recreate
// them on every render.
const DAILY_COVERAGE_COLUMNS: Column<DailyCoverageRow>[] = [
  {
    key: "date",
    header: "Day",
    width: "content",
    sortValue: (d) => d.date,
    cell: (d) => (
      <span className="whitespace-nowrap font-medium text-ink-700">
        {d.date}
      </span>
    ),
  },
  {
    key: "neededTarget",
    header: "Allocated target",
    width: "content",
    align: "right",
    // Sorts closed days (null) to the low end rather than throwing on the
    // comparison — DataTable's sort just needs any stable, finite ordering.
    sortValue: (d) => d.neededTarget ?? -1,
    cell: (d) =>
      d.neededTarget === null ? (
        <span className="text-ink-500">—</span>
      ) : (
        <span className="text-ink-600">
          <Money value={d.neededTarget} />
        </span>
      ),
  },
  {
    key: "sales",
    header: "Sales recorded",
    width: "content",
    align: "right",
    sortValue: (d) => d.sales,
    cell: (d) => (
      <span className="text-ink-600">
        <Money value={d.sales} />
      </span>
    ),
  },
  {
    key: "gap",
    header: "Gap",
    width: "content",
    align: "right",
    sortValue: (d) => d.gap ?? 0,
    cell: (d) =>
      d.gap === null || d.status === "closed" ? (
        <span className="text-ink-500">—</span>
      ) : (
        <span className="font-medium" style={{ color: statusColor(d.status) }}>
          {d.status === "at" ? (
            <Money value={0} />
          ) : (
            <>
              <Money value={Math.abs(d.gap)} /> {d.status}
            </>
          )}
        </span>
      ),
  },
  {
    key: "status",
    header: "Status",
    width: "content",
    sortValue: (d) => d.status,
    cell: (d) => (
      <Pill tone={STATUS_TONE[d.status]}>
        <DailyStatusIcon status={d.status} />
        {dailyRowStatusLabel(d.status)}
      </Pill>
    ),
  },
];

/**
 * Plain facts read straight off the daily rows and checkpoints. Nothing is
 * inferred or predicted here, so nothing needs an AI disclaimer.
 */
function RecoveryHighlights({ rows }: { rows: DailyCoverageRow[] }) {
  const openRows = rows.filter((r) => r.status !== "closed");
  const hitRows = openRows.filter((r) => r.status === "at" || r.status === "above");
  const best = rows.reduce<DailyCoverageRow | null>(
    (top, r) => (r.sales > 0 && (!top || r.sales > top.sales) ? r : top),
    null,
  );
  const closedCount = rows.length - openRows.length;

  const items: { icon: typeof Check; title: string; body: ReactNode }[] = [];
  if (openRows.length > 0) {
    items.push({
      icon: CalendarCheck,
      title: "Open days on target",
      body: `${hitRows.length} of ${openRows.length} open ${openRows.length === 1 ? "day" : "days"} so far reached the allocated target.`,
    });
  }
  if (best) {
    items.push({
      icon: TrendingUp,
      title: "Highest sales day",
      body: (
        <>
          {shortDay(best.date)}, with{" "}
          <span className="figure font-semibold text-ink-700">{formatMoney(best.sales)}</span>{" "}
          recorded.
        </>
      ),
    });
  }
  if (closedCount > 0) {
    items.push({
      icon: CalendarOff,
      title: "Closed days",
      body: `${closedCount} ${closedCount === 1 ? "day was" : "days were"} closed on your schedule and carry no target.`,
    });
  }

  return (
    <Panel title="Highlights" eyebrow="From your daily records" className="h-full">
      {items.length === 0 ? (
        <p className="text-sm text-ink-500">
          Highlights appear once this period has recorded days.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {items.map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="flex items-start gap-3 rounded-xl border border-paper-200 bg-paper-50 p-3"
            >
              <IconTile icon={Icon} size="sm" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-900">{title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The daily history section: the chart, the highlights and the day-by-day table. */
export function RecoveryDailyCoverage({
  rows,
  visibleRows,
  totalRows,
  disclosure,
  reportingPeriod,
  businessName,
  scopeKey,
}: {
  rows: DailyCoverageRow[];
  visibleRows: DailyCoverageRow[];
  totalRows: number;
  disclosure: ReturnType<typeof useListDisclosure>;
  reportingPeriod: RecoveryReportingPeriod;
  businessName: string;
  scopeKey: string;
}) {
  return (
    <div className="scroll-mt-6">
      <div className="mb-3 flex items-center justify-between">
        {/* `id` moved here (from the old wrapping `<div>`) so the
            "Review month summary" anchor scrolls to, and `focusSection`
            focuses, the heading itself rather than an unlabelled div.
            `tabIndex={-1}`: script-focusable only, not in tab order —
            WCAG 2.4.3. */}
        <h2
          id="daily-coverage"
          tabIndex={-1}
          className="scroll-mt-6 text-lg font-semibold text-ink-900 focus:outline-none"
        >
          Each day's sales
        </h2>
        <span className="text-xs text-ink-500">
          {recoveryPeriodLabel(reportingPeriod)}
        </span>
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel
          title="Sales by day"
          headingLevel={3}
          className="min-w-0 lg:col-span-2"
        >
          <DailySalesChart rows={rows} />
        </Panel>
        <div className="min-w-0">
          <RecoveryHighlights rows={rows} />
        </div>
      </div>
      <div id={disclosure.contentId}>
        <DataTable
          key={`${scopeKey}:${disclosure.expanded}`}
          rows={visibleRows}
          columns={DAILY_COVERAGE_COLUMNS}
          getRowKey={(d) => d.date}
          caption={`Daily sales recorded against target for ${businessName}, ${recoveryPeriodPhrase(reportingPeriod)}.`}
          itemNoun="days"
          storageKey="recovery-daily-coverage"
          initialSort={{ key: "date", direction: "desc" }}
          empty={
            <p className="p-4 text-sm text-ink-500">
              No days recorded {recoveryPeriodPhrase(reportingPeriod)}.
            </p>
          }
          mobileRow={(d) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{d.date}</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {d.neededTarget === null ? (
                    <>
                      <Money value={d.sales} bare /> — closed day
                    </>
                  ) : (
                    <>
                      <Money value={d.sales} bare /> of{" "}
                      <Money value={d.neededTarget} bare /> allocated
                    </>
                  )}
                </p>
              </div>
              <Pill tone={STATUS_TONE[d.status]}>
                <DailyStatusIcon status={d.status} />
                {dailyRowStatusLabel(d.status)}
              </Pill>
            </div>
          )}
        />
      </div>
      <ListDisclosureControl
        disclosure={disclosure}
        total={totalRows}
        itemLabel="days"
        className="mt-3"
      />
    </div>
  );
}
