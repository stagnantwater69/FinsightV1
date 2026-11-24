import { useState } from "react";
import { IconTile } from "../../components/IconTile";
import { Modal } from "../../components/Modal";
import { Flag } from "lucide-react";
import { formatCalendarDate } from "../../lib/dates";
import { DataTable, type Column } from "../../components/DataTable";
import { Button } from "../../components/Button";
import { STATUS_TEXT_COLORS } from "../../lib/chartPalette";
import type { RecoveryCheckpoint, RecoveryCheckpointStatus } from "../../lib/types";
import { Panel, Pill, type PillTone } from "../../components/ui";
import { Money, formatMoney } from "../../components/Money";

// Weekly checkpoints — plan §10.4. Same tone/colour convention as the daily
// coverage table's own STATUS_TONE above: "behind" reads like "below",
// "on_pace" reads like "at" (informational, not a warning — matching pace is
// good news), "ahead" reads like "above", and "pending" (a checkpoint whose
// endDate hasn't arrived yet) is neutral, the same way a closed day is.
const CHECKPOINT_STATUS_TONE: Record<RecoveryCheckpointStatus, PillTone> = {
  behind: "danger",
  on_pace: "info",
  ahead: "ok",
  pending: "neutral",
};

function checkpointStatusColor(status: RecoveryCheckpointStatus): string {
  return status === "behind"
    ? STATUS_TEXT_COLORS.critical
    : status === "on_pace"
      ? STATUS_TEXT_COLORS.warning
      : status === "ahead"
        ? STATUS_TEXT_COLORS.good
        : "";
}

/** `finished` is a checkpoint whose week is over, so "pace" no longer applies. */
function checkpointStatusLabel(status: RecoveryCheckpointStatus, finished = false): string {
  switch (status) {
    case "behind":
      return finished ? "Missed target" : "Behind";
    case "on_pace":
      return finished ? "Met target" : "On pace";
    case "ahead":
      return finished ? "Beat target" : "Ahead";
    case "pending":
      return "Pending";
  }
}

/** Surface treatment per checkpoint status, from the themed status tokens. */
const CHECKPOINT_LOOK: Record<
  RecoveryCheckpointStatus,
  { track: string; fill: string }
> = {
  behind: {
    track: "bg-edge-danger",
    fill: "bg-tone-danger",
  },
  on_pace: {
    track: "bg-edge-info",
    fill: "bg-tone-info",
  },
  ahead: {
    track: "bg-edge-brand",
    fill: "bg-tone-brand",
  },
  pending: {
    track: "bg-paper-200",
    fill: "bg-tone-neutral",
  },
};

/**
 * One checkpoint, shown prominently — plan §10.4: "Show at most the current
 * and next checkpoint prominently." A `pending` checkpoint (its `endDate` is
 * still in the future) has no `recordedAmount`/`variance` yet, so those cells
 * read "Not yet reached"/"—" instead of a null or a false zero.
 */
function CheckpointCard({
  label,
  checkpoint,
  finished,
}: {
  label: string;
  checkpoint: RecoveryCheckpoint;
  finished: boolean;
}) {
  const isPending = checkpoint.status === "pending";
  const look = CHECKPOINT_LOOK[checkpoint.status];
  const reached =
    !isPending && checkpoint.recordedAmount !== null && checkpoint.cumulativeTarget > 0
      ? (checkpoint.recordedAmount / checkpoint.cumulativeTarget) * 100
      : null;
  return (
    <div
      data-alert={checkpoint.status === "behind" || undefined}
      className="stat-tile h-full !shadow-none"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Flag} />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.04em] text-ink-600">
              {label}
            </p>
            <p className="text-sm font-semibold text-ink-900">
              {formatCalendarDate(checkpoint.endDate)}
            </p>
          </div>
        </div>
        <Pill tone={CHECKPOINT_STATUS_TONE[checkpoint.status]}>
          {checkpointStatusLabel(checkpoint.status, finished)}
        </Pill>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-600">Goal so far</dt>
          <dd className="figure font-semibold text-ink-900">
            {formatMoney(checkpoint.cumulativeTarget)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-600">Recorded amount</dt>
          <dd className="figure font-semibold text-ink-900">
            {isPending || checkpoint.recordedAmount === null ? (
              <span className="text-ink-600">Not yet reached</span>
            ) : (
              formatMoney(checkpoint.recordedAmount)
            )}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-600">Variance</dt>
          <dd
            className="figure font-semibold"
            style={{
              color: checkpointStatusColor(checkpoint.status) || undefined,
            }}
          >
            {isPending || checkpoint.variance === null ? (
              <span className="text-ink-600">—</span>
            ) : (
              formatMoney(checkpoint.variance, { signed: true })
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-auto pt-3">
        <div aria-hidden className={`h-1.5 w-full overflow-hidden rounded-full ${look.track}`}>
          {reached !== null ? (
            <div
              className={`h-full rounded-full ${look.fill}`}
              style={{ width: `${Math.min(Math.max(reached, reached > 0 ? 3 : 0), 100)}%` }}
            />
          ) : null}
        </div>
        <p className="mt-1.5 text-xs text-ink-500">
          {reached !== null
            ? `${Math.round(reached)}% of this checkpoint's target recorded`
            : "Counts once this date arrives"}
        </p>
      </div>
    </div>
  );
}

// Secondary, full list — plan §10.4: "keep the full list secondary". Reuses
// the DataTable convention every other tabular surface on this page already
// uses, rather than hand-rolling a second table shape.
const checkpointColumns = (isFinished: (c: RecoveryCheckpoint) => boolean): Column<RecoveryCheckpoint>[] => [
  {
    key: "endDate",
    header: "End date",
    width: "content",
    sortValue: (c) => c.endDate,
    cell: (c) => (
      <span className="whitespace-nowrap font-medium text-ink-700">
        {formatCalendarDate(c.endDate)}
      </span>
    ),
  },
  {
    key: "cumulativeTarget",
    header: "Goal so far",
    width: "content",
    align: "right",
    sortValue: (c) => c.cumulativeTarget,
    cell: (c) => (
      <span className="text-ink-600">
        <Money value={c.cumulativeTarget} />
      </span>
    ),
  },
  {
    key: "recordedAmount",
    header: "Recorded amount",
    width: "content",
    align: "right",
    sortValue: (c) => c.recordedAmount ?? -1,
    cell: (c) =>
      c.recordedAmount === null ? (
        <span className="text-ink-500">Not yet reached</span>
      ) : (
        <span className="text-ink-600">
          <Money value={c.recordedAmount} />
        </span>
      ),
  },
  {
    key: "variance",
    header: "Variance",
    width: "content",
    align: "right",
    sortValue: (c) => c.variance ?? 0,
    cell: (c) =>
      c.variance === null ? (
        <span className="text-ink-500">—</span>
      ) : (
        <span
          className="font-medium"
          style={{ color: checkpointStatusColor(c.status) || undefined }}
        >
          <Money value={c.variance} signed />
        </span>
      ),
  },
  {
    key: "status",
    header: "Status",
    width: "content",
    sortValue: (c) => c.status,
    cell: (c) => (
      <Pill tone={CHECKPOINT_STATUS_TONE[c.status]}>
        {checkpointStatusLabel(c.status, isFinished(c))}
      </Pill>
    ),
  },
];

/**
 * "Current" is the most recent checkpoint whose `endDate` has already
 * arrived, or the first checkpoint if none have — plan §10.4. Checkpoints
 * arrive from the server sorted ascending by `endDate`, so a single forward
 * scan keeping the last one at-or-before `todayKey` is enough.
 */
function findCurrentAndNextCheckpoints(
  checkpoints: RecoveryCheckpoint[],
  todayKey: string,
): { current: RecoveryCheckpoint | null; next: RecoveryCheckpoint | null } {
  let current: RecoveryCheckpoint | null = null;
  let next: RecoveryCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (checkpoint.endDate <= todayKey) {
      current = checkpoint;
    } else if (!next) {
      next = checkpoint;
    }
  }
  if (!current) current = checkpoints[0] ?? null;
  // The rare early-month case where the very first checkpoint hasn't
  // happened yet: it is both the "current" fallback and the "next"
  // checkpoint, so it is shown once rather than twice — mirrors mobile's
  // RecoveryCheckpointsCard, which carries the same guard.
  if (next && current && next.endDate === current.endDate) next = null;
  return { current, next };
}

/**
 * Weekly checkpoints — plan §10.4. The current and next checkpoint are shown
 * prominently; the full month's list opens in a popup so the card keeps its
 * height.
 */
export function RecoveryCheckpoints({
  checkpoints,
  todayKey,
  periodName,
  periodComplete,
}: {
  checkpoints: RecoveryCheckpoint[];
  todayKey: string;
  periodName: string;
  periodComplete: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  if (checkpoints.length === 0) return null;
  const isFinished = (c: RecoveryCheckpoint) => periodComplete || c.endDate < todayKey;

  const { current, next } = findCurrentAndNextCheckpoints(
    checkpoints,
    todayKey,
  );

  return (
    <Panel
      title="Weekly checkpoints"
      eyebrow={`Cumulative open-day targets for ${periodName}`}
      action={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-haspopup="dialog"
          onClick={() => setShowAll(true)}
        >
          Show all checkpoints
        </Button>
      }
    >
      <div className={`grid gap-4 ${current && next ? "sm:grid-cols-2" : ""}`}>
        {current ? (
          <CheckpointCard label="Current checkpoint" checkpoint={current} finished={isFinished(current)} />
        ) : null}
        {next ? (
          <CheckpointCard label="Next checkpoint" checkpoint={next} finished={isFinished(next)} />
        ) : null}
      </div>

      <Modal
        open={showAll}
        onClose={() => setShowAll(false)}
        title={`Weekly checkpoints for ${periodName}`}
        size="wide"
      >
      {showAll ? (
          <DataTable
            rows={checkpoints}
            columns={checkpointColumns(isFinished)}
            getRowKey={(c) => c.endDate}
            caption={`All weekly checkpoints for ${periodName}.`}
            itemNoun="checkpoints"
            initialSort={{ key: "endDate", direction: "asc" }}
            empty={
              <p className="p-4 text-sm text-ink-500">
                No checkpoints for {periodName}.
              </p>
            }
            mobileRow={(c) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">
                    {formatCalendarDate(c.endDate)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {c.recordedAmount === null ? (
                      "Not yet reached"
                    ) : (
                      <>
                        <Money value={c.recordedAmount} bare /> of{" "}
                        <Money value={c.cumulativeTarget} bare /> target
                      </>
                    )}
                  </p>
                </div>
                <Pill tone={CHECKPOINT_STATUS_TONE[c.status]}>
                  {checkpointStatusLabel(c.status, isFinished(c))}
                </Pill>
              </div>
            )}
          />
      ) : null}
      </Modal>
    </Panel>
  );
}
