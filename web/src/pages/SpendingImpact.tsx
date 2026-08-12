import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, AskFinSightDrawer } from "../components/AskFinSightDrawer";
import { Button } from "../components/Button";
import { StatTile } from "../components/StatTile";
import { OTHER_COLOR, STATUS_COLORS } from "../lib/chartPalette";
import type { CategorySuggestion, ImpactBand, SpendingImpact as SpendingImpactData } from "../lib/types";
import { AiCard, Callout, InfoNote, Kw, PageHead, Panel, Pill, type PillTone } from "../components/ui";
import { Field, MoneyInput, SelectInput, TextInput } from "../components/Field";
import { Money, formatMoney } from "../components/Money";

const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "This week", days: 7 },
  { label: "This month", days: 30 },
];

const BAND_STATUS: Record<ImpactBand, keyof typeof STATUS_COLORS> = {
  "Low Impact": "good",
  "Noticeable Impact": "warning",
  "High Impact": "critical",
};

// The impact band as a themed Pill rather than a white-on-solid chip painted
// with an inline style. The band glyphs stay: severity must survive greyscale
// and colourblindness, so the shape carries it as well as the colour.
const BAND_TONE: Record<ImpactBand, PillTone> = {
  "Low Impact": "ok",
  "Noticeable Impact": "warn",
  "High Impact": "danger",
};

const BAND_GLYPH: Record<ImpactBand, string> = {
  "Low Impact": "✓",
  "Noticeable Impact": "●",
  "High Impact": "▲",
};

function percentText(data: SpendingImpactData): string {
  return data.percentOfFunds >= 999999 ? "more than 100%" : `${data.percentOfFunds.toFixed(1)}%`;
}

// Paired before/after bars. Both bars in a pair share one scale (the larger
// of the two values), so their lengths are directly comparable.
function BeforeAfterBars({
  before,
  after,
  afterColor,
  afterIsNegative,
}: {
  before: number;
  after: number;
  afterColor: string;
  afterIsNegative?: boolean;
}) {
  const scale = Math.max(Math.abs(before), Math.abs(after), 1);
  const rows = [
    // The neutral "before" bar uses the palette's documented neutral rather
    // than an arbitrary hex, so it stays in step with the charts.
    { key: "Before", value: before, color: OTHER_COLOR },
    { key: "After", value: after, color: afterColor },
  ];
  return (
    <div className="mt-3 space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs text-ink-500">{r.key}</span>
          <div className="h-4 flex-1 overflow-hidden rounded-sm bg-paper-100">
            <div
              className="h-full rounded-sm"
              style={{ width: `${(Math.abs(r.value) / scale) * 100}%`, backgroundColor: r.color }}
            />
          </div>
          <Money
            value={r.value}
            className={`w-28 shrink-0 text-right text-xs font-medium ${
              r.key === "After" && afterIsNegative ? "text-tone-danger" : "text-ink-700"
            }`}
          />
        </div>
      ))}
    </div>
  );
}

export function SpendingImpact() {
  const { selected } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const [plannedAmount, setPlannedAmount] = useState<number | "">("");
  const [description, setDescription] = useState("");
  const [periodDays, setPeriodDays] = useState(30);
  const [data, setData] = useState<SpendingImpactData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The category is reference-only — like Description, it is never sent to
  // /insights/spending-impact and never affects the calculation. This is a
  // hypothetical, unsaved expense, not a real record, so there is no actual
  // category assignment for it yet; this is a hint at what it MIGHT be filed
  // under, not a computed input.
  const [categoryId, setCategoryId] = useState<number | "">("");
  // Once the owner picks a category by hand, a later suggestion must not
  // silently overwrite their choice — "editable" has to mean it stays edited.
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set only by the "expand on this" link — the plain header button opens
  // the drawer with this left undefined, same as always.
  const [drawerQuestion, setDrawerQuestion] = useState<string | undefined>(undefined);

  async function fetchImpact(amount: number) {
    if (!selected) return;
    try {
      const { data } = await api.get<SpendingImpactData>("/insights/spending-impact", {
        params: { businessProfileId: selected.id, plannedAmount: amount, periodDays },
      });
      setData(data);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  useEffect(() => {
    if (!selected || plannedAmount === "") {
      setData(null);
      return;
    }
    const timeout = setTimeout(() => fetchImpact(plannedAmount), 200);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, plannedAmount, periodDays]);

  // Suggests a category from the description text, against this business's
  // OWN categories only (see suggestCategoryForDescription on the backend —
  // it never invents a category that isn't already one of the owner's own).
  // Debounced longer than the amount effect above: this is a real AI round
  // trip, not a local calculation, so firing it on every keystroke would be
  // both slow and wasteful.
  useEffect(() => {
    if (!selected || categoryTouched || description.trim().length < 3) return;
    const timeout = setTimeout(async () => {
      setSuggesting(true);
      try {
        const { data } = await api.post<{ suggestion: CategorySuggestion | null }>("/ai/suggest-category", {
          businessProfileId: selected.id,
          description: description.trim(),
        });
        setCategoryId(data.suggestion?.categoryId ?? "");
      } catch {
        // A missing suggestion just means the owner picks one themselves —
        // not worth surfacing as a page-level error for a purely optional hint.
      } finally {
        setSuggesting(false);
      }
    }, 500);
    return () => clearTimeout(timeout);
  }, [selected, description, categoryTouched]);

  if (!selected) return null;

  const bandStatus = data ? BAND_STATUS[data.impactBand] : null;

  // Names the exact scenario the card above just described — the planned
  // amount and its impact band — rather than a generic "tell me more".
  const expandQuestion = data
    ? `Why is spending ${formatMoney(data.plannedAmount)}${description ? ` on ${description}` : ""} a ${data.impactBand.toLowerCase()}?`
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Spending impact"
        subtitle={
          <>
            Spending-Impact Assessment — answers "What may happen if I spend this amount?" This is a
            what-if check; nothing is saved.
          </>
        }
        actions={
          <AskFinSightButton
            onClick={() => {
              setDrawerQuestion(undefined);
              setDrawerOpen(true);
            }}
          />
        }
      />

      <InsightsTabs />

      <div className="mb-4">
        <Callout tone="brand">
          <b className="font-semibold">Two ways to run a scenario.</b> Ask FinSight in plain language (e.g.
          "What if I spend ₱11,000 on a fridge?"), or use the form below. Either way, FinSight's
          calculations are structured — they are not invented by AI.
        </Callout>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel eyebrow="Manual entry" title="Simulate a planned expense">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Planned amount" htmlFor="plannedAmount">
              <MoneyInput
                min={0}
                value={plannedAmount}
                onChange={(e) => setPlannedAmount(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="11000"
              />
            </Field>
            <Field label="Compare against" htmlFor="periodDays">
              <SelectInput value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))}>
                {PERIOD_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>
                    {o.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          <div className="mt-3">
            <Field
              label="Description"
              htmlFor="description"
              optional
              hint="For your own reference — this is not saved."
            >
              <TextInput
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Display fridge for drinks"
              />
            </Field>
          </div>

          <div className="mt-3">
            <Field
              label="Category"
              htmlFor="category"
              optional
              labelAction={
                suggesting ? (
                  <span className="text-xs text-ink-400">Suggesting…</span>
                ) : (
                  <span className="text-xs font-medium text-tone-brand">
                    {categoryId !== "" && !categoryTouched ? "AI-suggested, editable" : "editable"}
                  </span>
                )
              }
            >
              <SelectInput
                value={categoryId}
                onChange={(e) => {
                  setCategoryTouched(true);
                  setCategoryId(e.target.value === "" ? "" : Number(e.target.value));
                }}
              >
                <option value="">— No category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>

          {/* Read-only context, not another field to fill in — the scenario is
              always run against the funds already on this business profile.
              Surfacing the figure here, next to a way to correct it, is
              cheaper than a wrong simulation and a confused owner. */}
          <div className="mt-3 rounded-xl border border-paper-200 bg-paper-100 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium text-ink-500">
                Available business funds <span className="text-ink-400">(read-only, from your business profile)</span>
              </p>
              <Link
                to={`/business-profiles/${selected.id}/edit`}
                className="tap-inline shrink-0 text-xs font-semibold text-brand-700 hover:text-brand-800"
              >
                Update funds →
              </Link>
            </div>
            <p className="figure mt-0.5 text-xl font-semibold text-ink-900">
              {formatMoney(selected.availableFunds)}
            </p>
            <p className="mt-0.5 text-xs text-ink-400">Based on {selected.name}</p>
          </div>

          {/* The debounced effect above already recalculates as you type — this
              button doesn't do anything the typing wouldn't eventually trigger
              on its own. It exists for the person who wants to finish filling
              in the form and press something, rather than trust that a number
              changed quietly while they were still typing. */}
          <div className="mt-4">
            <Button
              type="button"
              variant="brand"
              fullWidth
              disabled={plannedAmount === ""}
              onClick={() => plannedAmount !== "" && fetchImpact(plannedAmount)}
            >
              Analyze Spending
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-tone-danger">
              {error}
            </p>
          ) : null}

          <div className="mt-4">
            <Callout tone="warn">
              This simulation supports spending awareness and does not tell you whether to proceed with the
              purchase.
            </Callout>
          </div>
        </Panel>

        <Panel
          eyebrow="Result"
          title="Estimated impact"
          action={
            data ? (
              <Pill tone={BAND_TONE[data.impactBand]}>
                <span aria-hidden>{BAND_GLYPH[data.impactBand]}</span>
                {data.impactBand}
              </Pill>
            ) : null
          }
        >
          {!data ? (
            <p className="text-sm text-ink-400">Enter a planned amount to see the impact.</p>
          ) : (
            <div className="space-y-5">
              {data.exceedsFunds ? (
                <Callout tone="warn">
                  <b className="font-semibold">This would exceed your available funds.</b>
                </Callout>
              ) : null}

              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Estimated remaining funds" value={formatMoney(data.funds.after)} emphasis />
                <StatTile label="Funds used" value={percentText(data)} />
                <StatTile
                  label="Current period expenses"
                  value={formatMoney(data.periodExpenses.before)}
                />
                <StatTile
                  label="Updated period expenses"
                  value={formatMoney(data.periodExpenses.after)}
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Funds used by this expense
                  </h3>
                  <span className="figure text-xs font-semibold text-ink-700">{percentText(data)}</span>
                </div>
                <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-paper-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, data.percentOfFunds))}%`,
                      backgroundColor: STATUS_COLORS[bandStatus!],
                    }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-ink-400">
                  You treat anything above {data.thresholdPercent}% of available funds (
                  <Money value={data.thresholdAmount} />) as a high-impact expense — you can change that in
                  your business profile.
                </p>
              </div>

              <AiCard
                title="FinSight explanation"
                subtitle="Scoped to Spending Impact — composed from this scenario, not AI-written"
                footer={
                  <button
                    type="button"
                    onClick={() => {
                      setDrawerQuestion(expandQuestion);
                      setDrawerOpen(true);
                    }}
                    className="tap-inline font-semibold text-accent-200 underline-offset-2 hover:underline"
                  >
                    Refine this scenario with Ask FinSight →
                  </button>
                }
              >
                If you spend <Kw>{formatMoney(data.plannedAmount)}</Kw>
                {description ? ` on ${description}` : ""}, your available business funds may{" "}
                {data.funds.after < data.funds.before ? "decrease" : "increase"} from{" "}
                <Kw>{formatMoney(data.funds.before)}</Kw> to <Kw>{formatMoney(data.funds.after)}</Kw>. This
                would use about <Kw>{percentText(data)}</Kw> of your funds — a <Kw>{data.impactBand}</Kw>.{" "}
                {data.periodExpenses.before > 0 ? (
                  <>
                    If included this period, your recorded expenses may change from{" "}
                    <Kw>{formatMoney(data.periodExpenses.before)}</Kw> to{" "}
                    <Kw>{formatMoney(data.periodExpenses.after)}</Kw>.
                  </>
                ) : null}
              </AiCard>
            </div>
          )}
        </Panel>
      </div>

      {data ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Panel eyebrow="Before & after" title="Available business funds">
            {/* Provenance: this figure is the owner's own, not something
                FinSight derived. Same treatment as Dashboard's KPI meta. */}
            <p className="text-xs text-ink-400">Owner-entered reference</p>
            <BeforeAfterBars
              before={data.funds.before}
              after={data.funds.after}
              afterColor={STATUS_COLORS[bandStatus!]}
              afterIsNegative={data.funds.after < 0}
            />
          </Panel>

          <Panel eyebrow="Before & after" title="Period expenses">
            <p className="text-xs text-ink-400">Computed from your records</p>
            {/*
              The one genuinely thin figure on this page.

              The impact band above is arithmetic on funds the owner entered,
              so it holds regardless of how much history exists. This
              comparison is not: with nothing recorded in the period, the
              "before" bar is empty and the "after" bar fills the width, which
              reads as a dramatic increase when it is really a single data
              point against no baseline. Saying so is cheaper than letting the
              owner draw the wrong conclusion — and item 19 is lost precisely
              by claiming confidence that isn't there.
            */}
            {data.periodExpenses.before === 0 ? (
              <div className="mt-2">
                <InfoNote>
                  You have no expenses recorded in the last {data.periodDays} day
                  {data.periodDays === 1 ? "" : "s"}, so there's nothing to compare this against yet. The
                  funds figure above is still accurate — this comparison gets useful once you've recorded a
                  few days.
                </InfoNote>
              </div>
            ) : (
              <BeforeAfterBars
                before={data.periodExpenses.before}
                after={data.periodExpenses.after}
                afterColor={STATUS_COLORS[bandStatus!]}
              />
            )}
          </Panel>
        </div>
      ) : null}

      <AskFinSightDrawer
        businessProfileId={selected.id}
        module="Spending Impact"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        initialQuestion={drawerQuestion}
      />
    </div>
  );
}
