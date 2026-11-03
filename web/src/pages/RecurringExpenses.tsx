import { useEffect, useRef, useState } from "react";
import { isAxiosError } from "axios";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import type { RecurringPattern, RecurringSchedule } from "../lib/types";
import { Button } from "../components/Button";
import { SkeletonPanel } from "../components/Skeleton";
import { RecurringAgenda } from "../components/RecurringAgenda";
import { ScheduleFormModal } from "./RecurringScheduleForm";
import { Callout, Panel } from "../components/ui";
import { ExpenseSubpageHead } from "./expenseInsight/ExpenseSubpageHead";
import { CandidateRow } from "./expenseInsight/reviewItems";
import {
  dismissRecurringPattern,
  recurringPatternsRequest,
  recurringSchedulesRequest,
  watchRecurringPattern,
} from "./expenseInsight/reviewRequests";

/** A read that failed, kept apart from one the server says is switched off. */
type ReadState = "loading" | "ready" | "failed" | "unavailable";

/**
 * The full recurring view behind Expense insight's two previews: every
 * payment the owner asked FinSight to watch, then every suggestion still
 * waiting for an answer. Same requests and cache scopes as Expense insight.
 */
export function RecurringExpensesPage() {
  const { selected } = useBusinessProfiles();
  const [schedules, setSchedules] = useState<RecurringSchedule[] | null>(null);
  const [schedulesState, setSchedulesState] = useState<ReadState>("loading");
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [patternsState, setPatternsState] = useState<ReadState>("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RecurringSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const requestId = useRef(0);

  async function load(force = false) {
    if (!selected) {
      setSchedules(null);
      setPatterns([]);
      setSchedulesState("ready");
      setPatternsState("ready");
      return;
    }
    const thisRequestId = ++requestId.current;
    const current = () => thisRequestId === requestId.current;
    const schedulesRequest = recurringSchedulesRequest(selected.id);
    const patternsRequest = recurringPatternsRequest(selected.id);
    const cachedSchedules = peekCachedApiData<RecurringSchedule[]>(
      schedulesRequest.url,
      { params: schedulesRequest.params },
      schedulesRequest.scope,
    );
    const cachedPatterns = peekCachedApiData<RecurringPattern[]>(
      patternsRequest.url,
      { params: patternsRequest.params },
      patternsRequest.scope,
    );
    if (cachedSchedules) {
      setSchedules(cachedSchedules.data);
      setSchedulesState("ready");
    }
    if (cachedPatterns) {
      setPatterns(cachedPatterns.data);
      setPatternsState("ready");
    }

    await Promise.all([
      cachedApiGet<RecurringSchedule[]>(
        schedulesRequest.url,
        { params: schedulesRequest.params },
        schedulesRequest.scope,
        { force },
      ).then(
        ({ data }) => {
          if (!current()) return;
          setSchedules(data);
          setSchedulesState("ready");
        },
        (err: unknown) => {
          if (!current()) return;
          // 404 is the server saying schedules are switched off, not a failure.
          if (isAxiosError(err) && err.response?.status === 404) {
            setSchedules(null);
            setSchedulesState("unavailable");
          } else {
            setSchedulesState("failed");
          }
        },
      ),
      cachedApiGet<RecurringPattern[]>(
        patternsRequest.url,
        { params: patternsRequest.params },
        patternsRequest.scope,
        { force },
      ).then(
        ({ data }) => {
          if (!current()) return;
          setPatterns(data);
          setPatternsState("ready");
        },
        () => {
          if (current()) setPatternsState("failed");
        },
      ),
    ]);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function confirmPattern(id: number) {
    if (!selected) return;
    setActionError(null);
    try {
      await watchRecurringPattern(selected.id, id);
      // Refetched, not patched: the new schedule's due state is server-computed.
      await load(true);
    } catch (err) {
      setActionError(getErrorMessage(err));
    }
  }

  async function dismissPattern(id: number) {
    if (!selected) return;
    setActionError(null);
    try {
      await dismissRecurringPattern(selected.id, id);
      setPatterns((current) =>
        current.map((pattern) => (pattern.id === id ? { ...pattern, status: "DISMISSED" } : pattern)),
      );
    } catch (err) {
      setActionError(getErrorMessage(err));
    }
  }

  const candidates = patterns.filter((pattern) => pattern.status === "CANDIDATE");
  const loading =
    (schedulesState === "loading" && schedules === null) ||
    (patternsState === "loading" && patterns.length === 0);

  return (
    <div>
      <ExpenseSubpageHead
        title="Recurring expenses"
        subtitle="Payments you asked FinSight to watch, and the ones it thinks might repeat."
        backTo="/insights/expense-behavior#expense-recurring"
      />

      {actionError ? (
        <div className="mb-4">
          <Callout tone="warn">
            <span role="alert">That didn’t save. {actionError}</span>
          </Callout>
        </div>
      ) : null}

      {schedulesState === "failed" || patternsState === "failed" ? (
        <div className="mb-4">
          <Callout tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span role="status">
                Some recurring expenses couldn’t load
                {schedules !== null || patterns.length > 0 ? "; showing what loaded." : "."}
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void load(true)}>
                Retry
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {loading ? (
        <div aria-busy="true" aria-live="polite" className="grid gap-5 lg:grid-cols-2">
          <span className="sr-only">Loading recurring expenses…</span>
          <SkeletonPanel lines={6} />
          <SkeletonPanel lines={6} />
        </div>
      ) : (
        <div className={`grid items-start gap-5 ${schedules !== null ? "lg:grid-cols-2" : ""}`}>
          {schedules !== null ? (
            <div id="recurring-watched" className="min-w-0 scroll-mt-6">
              {/* Unbounded preview: every row shows, with no per-group "Show all". */}
              <RecurringAgenda
                schedules={schedules}
                resetKey={String(selected?.id ?? "")}
                previewLimit={Number.POSITIVE_INFINITY}
                onEdit={(schedule) => {
                  setEditing(schedule);
                  setFormOpen(true);
                }}
                onAdd={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              />
            </div>
          ) : null}
          <div id="recurring-suggestions" className="min-w-0 scroll-mt-6">
            <Panel
              title="Possible recurring expenses"
              action={
                candidates.length > 0 ? (
                  <span className="text-xs text-ink-500">{candidates.length} to answer</span>
                ) : null
              }
            >
              {candidates.length === 0 ? (
                <p className="text-sm text-ink-500">
                  {patternsState === "failed"
                    ? "Suggestions are temporarily unavailable."
                    : "No suggestions waiting for an answer."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {candidates.map((pattern) => (
                    <CandidateRow
                      key={pattern.id}
                      pattern={pattern}
                      canWatch={schedules !== null}
                      onWatch={(id) => void confirmPattern(id)}
                      onDismiss={(id) => void dismissPattern(id)}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}

      <ScheduleFormModal
        open={formOpen}
        schedule={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void load(true)}
      />
    </div>
  );
}
