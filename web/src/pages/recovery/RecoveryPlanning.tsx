import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconTile } from "../../components/IconTile";
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  Info,
  Minus,
} from "lucide-react";
import { api } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { Button } from "../../components/Button";
import { Field, FormError, MoneyInput } from "../../components/Field";
import type { RecoveryPlan, RecoveryScenario } from "../../lib/types";
import { Panel } from "../../components/ui";
import { formatMoney } from "../../components/Money";
import { TextInput } from "../../components/Field";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { monthLabel } from "../../lib/reportingPeriod";

/**
 * "Saved plan" in `RecoverySectionNav` needs to open the (collapsed-by-
 * default) "Try a scenario" panel when there's no plan yet to jump to — a
 * DOM event rather than lifted state, since `RecoveryScenarioPanel` owns its
 * own `expanded` flag and nothing else on the page otherwise needs to know
 * about it.
 */
export const EXPAND_SCENARIO_EVENT = "finsight:recovery-expand-scenario";

/**
 * "What if?" — a hypothetical Recovery Target scenario, plan §13.2/§15
 * Phase 5.
 *
 * THE ONLY VALID HYPOTHETICAL, per the plan: an explicit, owner-typed change
 * to `expectedMonthlyExpenses`, never one derived from a reduction-opportunity
 * simulation or any other guess. `POST /insights/recovery-scenario` is
 * read-only — see insights.service.ts `simulateRecoveryScenario` — and this
 * component has no path to the real "edit business profile" flow at all: no
 * button here writes `assumedExpectedMonthlyExpenses` anywhere. An owner who
 * wants to make a hypothetical real has to go and edit the business profile
 * deliberately, elsewhere.
 *
 * Visually distinct from the real target on purpose (plan §13.1/§13.2's own
 * requirement): the real figures above use the ordinary `Panel`
 * surface, so the result here renders inside a dashed, differently-toned box
 * with its own "hypothetical, not saved" label repeated beside every figure
 * it produces — not just once at the top, where it would be easy to scroll
 * past and then read the numbers below as real.
 */
/**
 * One current-vs-hypothetical comparison line inside the scenario result —
 * plan §10.7: "Absolute and percentage deltas." Guards the percentage against
 * a near-zero denominator: when `current` is within a peso of 0 (including
 * exactly 0), only the peso delta is shown, not a divide-by-zero
 * "Infinity%"/"NaN%" — or, just as bad, a technically-finite but meaningless
 * figure like "+99999900%" from dividing a normal-sized delta by a tiny
 * fraction of a peso near month-end. Mirrors mobile's `ScenarioRow` floor —
 * keep the literal `1` (one peso) in sync with that file.
 */
function ScenarioCompareCard({
  label,
  current,
  hypothetical,
  emphasis = false,
}: {
  label: string;
  current: number;
  hypothetical: number;
  /** The figure that answers "what would I need per day?" gets the frame. */
  emphasis?: boolean;
}) {
  const delta = hypothetical - current;
  const percent = Math.abs(current) >= 1 ? (delta / current) * 100 : null;
  const unchanged = Math.abs(delta) < 0.5;
  // Every figure here is a target, so a lower one is the easier outcome.
  const Arrow = unchanged ? Minus : delta < 0 ? ArrowDown : ArrowUp;
  const chipTone = unchanged
    ? "bg-tint-neutral text-tone-neutral"
    : delta < 0
      ? "bg-tint-brand text-tone-brand"
      : "bg-tint-danger text-tone-danger";
  return (
    <div
      className={`min-w-0 rounded-xl bg-paper p-3.5 shadow-sm ring-1 ${
        emphasis ? "ring-2 ring-edge-accent" : "ring-paper-200"
      }`}
    >
      <p className="text-xs font-semibold text-ink-600">{label}</p>
      <p className="figure mt-1.5 break-words text-xl font-semibold leading-tight text-ink-900">
        {formatMoney(hypothetical)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="figure text-ink-500">Now {formatMoney(current)}</span>
        <span
          className={`figure inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${chipTone}`}
        >
          <Arrow aria-hidden className="size-3" />
          {unchanged
            ? "No change"
            : `${formatMoney(delta, { signed: true })}${
                percent !== null
                  ? ` (${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%)`
                  : ""
              }`}
        </span>
      </div>
    </div>
  );
}

/**
 * A small, optional form for the fields a `RecoveryPlan` can hold — plan
 * §7.5/§10.7. Shared between "Save this as a plan" (seeded from the
 * scenario's assumed value) and editing an already-saved plan, so the two
 * flows can't drift in what fields they expose or how they validate.
 */
function RecoveryPlanFields({
  ownerTargetAmount,
  deadline,
  bufferPercent,
  onOwnerTargetAmountChange,
  onDeadlineChange,
  onBufferPercentChange,
}: {
  ownerTargetAmount: string;
  deadline: string;
  bufferPercent: string;
  onOwnerTargetAmountChange: (value: string) => void;
  onDeadlineChange: (value: string) => void;
  onBufferPercentChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Target amount" htmlFor="plan-owner-target-amount" optional>
        <MoneyInput
          id="plan-owner-target-amount"
          value={ownerTargetAmount}
          min={0}
          onChange={(e) => onOwnerTargetAmountChange(e.target.value)}
        />
      </Field>
      <Field label="Deadline" htmlFor="plan-deadline" optional>
        <TextInput
          id="plan-deadline"
          type="date"
          value={deadline}
          onChange={(e) => onDeadlineChange(e.target.value)}
        />
      </Field>
      <Field
        label="Buffer"
        htmlFor="plan-buffer-percent"
        optional
        hint="A percentage, for your own reference."
      >
        <div className="relative">
          <TextInput
            id="plan-buffer-percent"
            type="number"
            min={0}
            step={1}
            value={bufferPercent}
            onChange={(e) => onBufferPercentChange(e.target.value)}
            className="pr-8"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-500">
            %
          </span>
        </div>
      </Field>
    </div>
  );
}

/**
 * "This month's saved plan" — plan §7.5/§10.7. A purely owner-visible
 * planning artifact rendered separately from every real Recovery Target
 * figure above it; edit/delete are the only actions here, both explicit.
 * Renders nothing when there's no saved plan for the current month, per the
 * task: this is a secondary surface, not a prompt to create one.
 */
export function SavedRecoveryPlanPanel({
  businessProfileId,
  monthKey,
  plan,
  onPlanChange,
}: {
  businessProfileId: number;
  monthKey: string;
  plan: RecoveryPlan;
  onPlanChange: (plan: RecoveryPlan | null) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [ownerTargetAmount, setOwnerTargetAmount] = useState(
    plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "",
  );
  const [deadline, setDeadline] = useState(plan.deadline ?? "");
  const [bufferPercent, setBufferPercent] = useState(
    plan.bufferPercent !== null ? String(plan.bufferPercent) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put<RecoveryPlan>(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
        {
          ownerTargetAmount:
            ownerTargetAmount.trim() === "" ? null : Number(ownerTargetAmount),
          deadline: deadline.trim() === "" ? null : deadline,
          bufferPercent:
            bufferPercent.trim() === "" ? null : Number(bufferPercent),
        },
      );
      onPlanChange(data);
      setEditing(false);
      toast(
        "Saved for reference — this doesn't change your business profile or recorded sales.",
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Remove your saved plan for ${monthLabel(monthKey)}?`,
      body: "This only removes your reference notes — it never affected your actual Recovery Target.",
      confirmLabel: "Remove plan",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.delete(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
      );
      onPlanChange(null);
      toast("Saved plan removed.");
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <Panel
      eyebrow="For your reference only"
      title={`This month's saved plan — ${monthLabel(monthKey)}`}
      action={
        !editing ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
            >
              Delete
            </Button>
          </div>
        ) : null
      }
    >
      <p className="mb-3 text-xs text-ink-500">
        Your note. It doesn’t change your target, profile or sales.
      </p>
      {editing ? (
        <form onSubmit={handleSave} className="space-y-3">
          <RecoveryPlanFields
            ownerTargetAmount={ownerTargetAmount}
            deadline={deadline}
            bufferPercent={bufferPercent}
            onOwnerTargetAmountChange={setOwnerTargetAmount}
            onDeadlineChange={setDeadline}
            onBufferPercentChange={setBufferPercent}
          />
          {error ? <FormError>{error}</FormError> : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-500">Target amount</dt>
            <dd className="figure font-semibold text-ink-900">
              {plan.ownerTargetAmount === null ? (
                <span className="text-ink-500">—</span>
              ) : (
                formatMoney(plan.ownerTargetAmount)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Deadline</dt>
            <dd className="font-semibold text-ink-900">
              {plan.deadline ? (
                new Date(plan.deadline).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })
              ) : (
                <span className="text-ink-500">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Buffer</dt>
            <dd className="figure font-semibold text-ink-900">
              {plan.bufferPercent === null ? (
                <span className="text-ink-500">—</span>
              ) : (
                `${plan.bufferPercent}%`
              )}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

export function RecoveryScenarioPanel({
  businessProfileId,
  currentExpectedMonthlyExpenses,
  monthKey,
  hasSavedPlan,
  onPlanSaved,
}: {
  businessProfileId: number;
  currentExpectedMonthlyExpenses: number;
  monthKey: string;
  hasSavedPlan: boolean;
  onPlanSaved: (plan: RecoveryPlan) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [rawValue, setRawValue] = useState(
    String(currentExpectedMonthlyExpenses),
  );
  // Once the owner types into the field, a background refresh that changes
  // the real expected-monthly-expenses must not silently overwrite what
  // they're mid-way through entering.
  const touchedRef = useRef(false);
  useEffect(() => {
    if (touchedRef.current) return;
    setRawValue(String(currentExpectedMonthlyExpenses));
  }, [currentExpectedMonthlyExpenses]);
  // Lets `RecoverySectionNav`'s "Save a plan" jump-link open this
  // collapsed-by-default panel from outside, without lifting `expanded`
  // state up through the page just for that one cross-component nudge.
  useEffect(() => {
    function onExpand() {
      setExpanded(true);
    }
    window.addEventListener(EXPAND_SCENARIO_EVENT, onExpand);
    return () => window.removeEventListener(EXPAND_SCENARIO_EVENT, onExpand);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<RecoveryScenario | null>(null);
  // Guards against out-of-order responses: native form submission via Enter
  // in the money input isn't blocked by the submit button's `disabled`, so
  // two rapid submits with different assumed values can race — without this,
  // an earlier (e.g. smaller) request resolving AFTER a later (e.g. larger)
  // one would leave the displayed result mismatched with what was most
  // recently typed. Same pattern as `RecoveryInsightPage`'s own `requestId`
  // ref above, and as mobile's `RecoveryScenarioSheet`'s `seq` ref.
  const submitSeq = useRef(0);

  async function runScenario(value: number) {
    if (submitting) return;
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a number greater than or equal to 0.");
      return;
    }
    const thisSubmitSeq = ++submitSeq.current;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<RecoveryScenario>(
        "/insights/recovery-scenario",
        {
          businessProfileId,
          assumedExpectedMonthlyExpenses: value,
        },
      );
      if (thisSubmitSeq !== submitSeq.current) return;
      setScenario(res.data);
    } catch (err) {
      if (thisSubmitSeq !== submitSeq.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (thisSubmitSeq === submitSeq.current) setSubmitting(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runScenario(Number(rawValue));
  }

  // One-tap starting points relative to the real basis. They fill the field
  // and run the scenario, so the owner sees the result without typing.
  const presets = [
    { label: "−10%", factor: 0.9 },
    { label: "−20%", factor: 0.8 },
    { label: "+10%", factor: 1.1 },
  ];
  function applyPreset(factor: number) {
    const value = Math.round(currentExpectedMonthlyExpenses * factor);
    touchedRef.current = true;
    setRawValue(String(value));
    void runScenario(value);
  }

  const [showSavePlanForm, setShowSavePlanForm] = useState(false);
  const [planDeadline, setPlanDeadline] = useState("");
  const [planBufferPercent, setPlanBufferPercent] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [planSaveError, setPlanSaveError] = useState<string | null>(null);
  const [planSaveConfirmation, setPlanSaveConfirmation] = useState(false);

  async function handleSavePlan(e: FormEvent) {
    e.preventDefault();
    if (!scenario) return;
    setSavingPlan(true);
    setPlanSaveError(null);
    setPlanSaveConfirmation(false);
    try {
      const { data } = await api.put<RecoveryPlan>(
        `/business-profiles/${businessProfileId}/recovery-plans/${monthKey}`,
        {
          ownerTargetAmount: scenario.assumedExpectedMonthlyExpenses,
          deadline: planDeadline.trim() === "" ? null : planDeadline,
          bufferPercent:
            planBufferPercent.trim() === "" ? null : Number(planBufferPercent),
        },
      );
      onPlanSaved(data);
      setShowSavePlanForm(false);
      setPlanSaveConfirmation(true);
    } catch (err) {
      setPlanSaveError(getErrorMessage(err));
    } finally {
      setSavingPlan(false);
    }
  }

  return (
    <Panel
      eyebrow="Optional"
      title="What if my monthly costs changed?"
      action={
        expanded ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded
            aria-controls="recovery-scenario-body"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp aria-hidden className="size-4" />
            Hide
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={false}
            aria-controls="recovery-scenario-body"
            onClick={() => setExpanded(true)}
          >
            <ChevronDown aria-hidden className="size-4" />
            {scenario ? "Show scenario" : "Try a scenario"}
          </Button>
        )
      }
    >
      {!expanded ? (
        scenario ? (
          <p className="text-sm text-ink-600">
            Last result: at{" "}
            <span className="figure font-semibold text-ink-900">
              {formatMoney(scenario.assumedExpectedMonthlyExpenses)}
            </span>{" "}
            a month you would need{" "}
            <span className="figure font-semibold text-ink-900">
              {formatMoney(scenario.hypothetical.adjustedDailyTarget)}
            </span>{" "}
            a day. Not saved.
          </p>
        ) : (
          <p className="text-sm text-ink-500">
            Test a different monthly expense amount. Nothing is saved.
          </p>
        )
      ) : (
        <div id="recovery-scenario-body" className="space-y-4">
          {/* noValidate: the JS check in runScenario (finite, >= 0) is the
              single source of the error message shown, same as
              ReductionSimulationModal's own form — native HTML5 constraint
              validation on a min-0 number input would otherwise silently
              swallow the submit instead of surfacing that message. */}
          <form
            onSubmit={handleSubmit}
            className="flex flex-wrap items-end gap-3"
            noValidate
          >
            <Field
              label="Assumed monthly costs"
              htmlFor="recovery-scenario-value"
              hint="Your saved figure is unaffected."
              className="min-w-[14rem] flex-1"
            >
              <MoneyInput
                id="recovery-scenario-value"
                value={rawValue}
                min={0}
                onChange={(e) => {
                  touchedRef.current = true;
                  setRawValue(e.target.value);
                }}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Calculating…" : "See hypothetical target"}
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-500">Quick try:</span>
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={submitting}
                onClick={() => applyPreset(preset.factor)}
                className="tap-inline figure rounded-full bg-paper-100 px-3 py-1 text-xs font-semibold text-ink-700 ring-1 ring-paper-200 transition hover:bg-tint-brand hover:text-tone-brand hover:ring-edge-brand disabled:opacity-50"
              >
                {preset.label}
              </button>
            ))}
            <span className="text-xs text-ink-500">of your current basis</span>
          </div>

          {error ? <FormError>{error}</FormError> : null}

          {scenario ? (
            // The distinct surface itself: a dashed amber frame unlike every
            // other panel on this page, so it cannot be mistaken for another
            // read of the real target above (plan §13.1/§13.2).
            <div className="rounded-2xl border-2 border-dashed border-edge-accent bg-tint-accent/60 p-4 motion-safe:animate-fade-up sm:p-5">
              <div className="flex items-start gap-3">
                <IconTile icon={FlaskConical} />
                <p className="text-sm leading-relaxed text-ink-700">
                  <b className="font-semibold text-tone-accent">Hypothetical. Not saved.</b>{" "}
                  This does not change your records, starting estimate, or
                  active monthly costs. Assumed value used:{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.assumedExpectedMonthlyExpenses)}
                  </span>
                  .
                </p>
              </div>

              {/* Side-by-side current/hypothetical with deltas — plan §10.7. */}
              <div className="mt-4">
                <p className="text-xs font-semibold text-ink-700">
                  Current vs. hypothetical
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <ScenarioCompareCard
                    label="Monthly costs"
                    current={scenario.current.expectedMonthlyExpenses}
                    hypothetical={scenario.hypothetical.expectedMonthlyExpenses}
                  />
                  <ScenarioCompareCard
                    label="Remaining target"
                    current={scenario.current.remainingTarget}
                    hypothetical={scenario.hypothetical.remainingTarget}
                  />
                  <ScenarioCompareCard
                    label="New daily goal"
                    current={scenario.current.adjustedDailyTarget}
                    hypothetical={scenario.hypothetical.adjustedDailyTarget}
                    emphasis
                  />
                </div>
              </div>

              <div className="mt-4 space-y-2 border-t border-edge-accent/50 pt-3 text-xs leading-relaxed text-ink-600">
                <p>
                  Sell this much each day in this scenario:{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.hypothetical.dailyNeededTarget)}
                  </span>
                  . For comparison, your current (real, saved) amount
                  to sell each day is{" "}
                  <span className="figure font-semibold text-ink-900">
                    {formatMoney(scenario.current.dailyNeededTarget)}
                  </span>{" "}
                  and remains unchanged in this scenario.
                </p>
                {/* §9.9: always null right now — say so plainly rather than
                    silently omitting a figure the plan otherwise promises. */}
                <p className="flex items-start gap-1.5">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-500" />
                  <span>
                    <b className="font-semibold text-ink-700">
                      Estimated transactions per day:
                    </b>{" "}
                    Not available. FinSight can't yet tell whether your sales
                    records represent individual transactions or daily totals,
                    so it won't guess a transaction count.
                  </span>
                </p>
              </div>

              {/* Secondary — plan §10.7: "clearly optional/secondary".
                  Persists the assumed value above as a separate, owner-visible
                  RecoveryPlan; never touches the real business profile. */}
              <div className="mt-4 border-t border-edge-accent/50 pt-4">
                {!showSavePlanForm ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowSavePlanForm(true)}
                  >
                    <BookmarkPlus aria-hidden className="size-4" />
                    Save this as a plan
                    {hasSavedPlan
                      ? " (replaces your current one for this month)"
                      : ""}
                  </Button>
                ) : (
                  <form onSubmit={handleSavePlan} className="space-y-3">
                    <p className="text-xs text-ink-600">
                      Saves the assumed monthly costs above (
                      {formatMoney(scenario.assumedExpectedMonthlyExpenses)}) as
                      this month's target amount for your own reference.
                      Optionally add a deadline and a buffer percentage. This
                      never changes your business profile or recorded sales.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Deadline"
                        htmlFor="scenario-plan-deadline"
                        optional
                      >
                        <TextInput
                          id="scenario-plan-deadline"
                          type="date"
                          value={planDeadline}
                          onChange={(e) => setPlanDeadline(e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Buffer"
                        htmlFor="scenario-plan-buffer"
                        optional
                        hint="A percentage, for your own reference."
                      >
                        <div className="relative">
                          <TextInput
                            id="scenario-plan-buffer"
                            type="number"
                            min={0}
                            step={1}
                            value={planBufferPercent}
                            onChange={(e) =>
                              setPlanBufferPercent(e.target.value)
                            }
                            className="pr-8"
                          />
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-600">
                            %
                          </span>
                        </div>
                      </Field>
                    </div>
                    {planSaveError ? (
                      <FormError>{planSaveError}</FormError>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowSavePlanForm(false)}
                        disabled={savingPlan}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        variant="secondary"
                        size="sm"
                        disabled={savingPlan}
                      >
                        {savingPlan ? "Saving…" : "Save plan"}
                      </Button>
                    </div>
                  </form>
                )}
                {planSaveConfirmation ? (
                  <p className="mt-2 text-xs font-medium text-tone-brand">
                    Saved. Your profile and sales are unchanged.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
