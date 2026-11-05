/**
 * The three-step business setup a new owner lands in after their first login.
 *
 * WHY A WIZARD RATHER THAN THE FORM THAT ALREADY EXISTED. The single screen
 * asked six questions at once, four of them financial, before showing anything
 * of value. That is a wall, and it arrives at the exact moment someone is least
 * invested. Split three ways, each screen asks two or three related things and
 * says what they are for.
 *
 * WHAT COUNTS AS "NOT SET UP" is deliberately not a new flag: it is having no
 * business profiles. See lib/onboardingDraft.ts for why that derivation is the
 * whole mechanism, and why existing owners can never be dragged back in here.
 *
 * THE PROFILE IS CREATED AT THE END OF STEP 2, not at the end of step 3. Step 3
 * imports records, and records need a business to belong to. It also means an
 * owner who closes the tab on step 3 keeps everything they entered: they have
 * a working business profile and simply skipped an optional import.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { FormError } from "../components/Field";
import { Wordmark } from "../components/Wordmark";
import { formatMoney } from "../components/Money";
import { BusinessBasicsFields, BusinessNumbersFields } from "../components/BusinessFields";
import { getErrorMessage } from "../lib/errors";
import {
  EMPTY_DRAFT,
  applyFieldUpdate,
  hasErrors,
  toBusinessProfileInput,
  validateBasics,
  validateNumbers,
  type BusinessFieldErrors,
  type BusinessProfileDraft,
  type BusinessTextField,
} from "../lib/businessProfileDraft";
import {
  clearOnboarding,
  dismissOnboarding,
  readOnboarding,
  saveOnboardingDraft,
} from "../lib/onboardingDraft";

const STEPS = [
  { title: "Your business", detail: "Name and type" },
  { title: "Starting figures", detail: "Balance and monthly costs" },
  { title: "Past records", detail: "Optional CSV import" },
] as const;
const TOTAL_STEPS = STEPS.length;

/**
 * The step list on the left of the card (lg and up).
 *
 * Not clickable: jumping to step 2 before step 1 is valid would produce a
 * profile that cannot be created, and a control that sometimes refuses is
 * worse than no control. The connector below a step fills once it is done.
 */
function StepList({ step }: { step: number }) {
  return (
    <ol>
      {STEPS.map((s, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        return (
          <li key={s.title} className="relative flex gap-3.5 pb-7 last:pb-0" aria-current={current ? "step" : undefined}>
            {n < TOTAL_STEPS ? (
              <span aria-hidden className="absolute bottom-1 left-[15px] top-10 w-0.5 overflow-hidden rounded-full bg-paper-200">
                <span
                  className={`block h-full w-full origin-top bg-brand-500 transition-transform duration-500 ease-shell ${
                    done ? "scale-y-100" : "scale-y-0"
                  }`}
                />
              </span>
            ) : null}
            <span
              aria-hidden
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors duration-300 ${
                done
                  ? "bg-brand-600 text-white"
                  : current
                    ? "bg-paper text-tone-brand ring-2 ring-brand-500"
                    : "bg-paper text-ink-600 ring-1 ring-paper-300"
              }`}
            >
              {done ? <Check className="h-4 w-4 animate-badge-in" strokeWidth={3} /> : n}
            </span>
            <span className="min-w-0 pt-1">
              <span className={`block text-sm font-semibold ${current || done ? "text-ink-900" : "text-ink-600"}`}>
                {s.title}
                <span className="sr-only">{done ? " (done)" : current ? " (current step)" : ""}</span>
              </span>
              <span className="block text-xs text-ink-600">{s.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Below lg the step list is hidden, so a count and a filling bar stand in for it. */
function CompactProgress({ step }: { step: number }) {
  return (
    <div className="mb-6 lg:hidden">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <p className="eyebrow">
          Step {step} of {TOTAL_STEPS}
        </p>
        <p className="truncate text-ink-600">{STEPS[step - 1].title}</p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-200" role="presentation">
        <div
          className="h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-shell"
          style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * What the owner has entered so far, filled in as they type. It answers the
 * question every setup screen raises ("what is this for?") with their own
 * numbers: the daily target is the first thing FinSight works out for them.
 */
function DraftSummary({ draft }: { draft: BusinessProfileDraft }) {
  const funds = Number(draft.availableFunds);
  const expenses = Number(draft.expectedMonthlyExpenses);
  const days = Number(draft.operatingDays);
  const rows: { label: string; value: string | null; figure?: boolean }[] = [
    { label: "Business", value: draft.name.trim() || null },
    { label: "Type", value: draft.type.trim() || null },
    {
      label: "Opening balance",
      value: draft.availableFunds !== "" && Number.isFinite(funds) ? formatMoney(funds) : null,
      figure: true,
    },
    {
      label: "Daily sales target",
      value: expenses > 0 && Number.isInteger(days) && days > 0 ? formatMoney(expenses / days) : null,
      figure: true,
    },
  ];
  return (
    <div className="rounded-xl border border-paper-200 bg-paper p-4 shadow-sm">
      <p className="text-xs font-semibold text-ink-700">Your business so far</p>
      <dl className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="shrink-0 text-ink-600">{r.label}</dt>
            <dd
              className={`min-w-0 truncate text-right ${r.value ? `font-semibold text-ink-900 ${r.figure ? "figure" : ""}` : "text-ink-600"}`}
              title={r.value ?? undefined}
            >
              {r.value ?? (
                <>
                  <span aria-hidden className="inline-block h-2 w-14 rounded-full bg-paper-200 align-middle" />
                  <span className="sr-only">Not set</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Onboarding() {
  const { profile: user } = useAuth();
  const { profiles, createProfile, loading } = useBusinessProfiles();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const userId = user?.id ?? 0;
  const stored = useMemo(() => (userId ? readOnboarding(userId) : {}), [userId]);

  const [step, setStepState] = useState(1);
  // Which way the step changed, so the new screen slides in from the side the owner is heading.
  const [direction, setDirection] = useState<"next" | "back">("next");
  const [draft, setDraft] = useState<BusinessProfileDraft>(() => ({
    ...EMPTY_DRAFT,
    ...(stored.draft ?? {}),
  }));
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The business created at the end of step 2. Step 3 imports into it. */
  const [createdProfileId, setCreatedProfileId] = useState<number | null>(null);

  function goTo(next: number) {
    setDirection(next > step ? "next" : "back");
    setStepState(next);
  }

  /*
   * Someone who already has a business does not belong here. This catches the
   * back button and a hand-typed /onboarding as well as the ordinary case, and
   * it deliberately does not fire while `createdProfileId` is set: finishing
   * step 2 makes `profiles` non-empty, and without that guard the wizard would
   * eject the owner the instant it created their business, skipping step 3.
   */
  useEffect(() => {
    if (loading || createdProfileId !== null) return;
    if (profiles.length > 0) navigate("/dashboard", { replace: true });
  }, [loading, profiles.length, createdProfileId, navigate]);

  // Persisted on every change rather than on step transitions: the interruption
  // this protects against is a closed tab, which gives no chance to save.
  useEffect(() => {
    if (userId && createdProfileId === null) saveOnboardingDraft(userId, draft);
  }, [userId, draft, createdProfileId]);

  useEffect(() => {
    document.title = `Set up FinSight · Step ${step} of ${TOTAL_STEPS}`;
  }, [step]);

  function update(key: BusinessTextField, value: string) {
    setDraft((d) => applyFieldUpdate(d, key, value));
    setFieldErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }

  async function handleSkip() {
    /*
     * Only steps 1 and 2 warrant a confirmation. By step 3 the business exists
     * and skipping costs nothing but an optional import.
     */
    const ok = await confirm({
      title: "Skip setup for now?",
      body: (
        <>
          Without your business details FinSight can't work out your sales target or flag large
          expenses. Anything you've typed is kept, and you can pick up where you left off from your
          dashboard.
        </>
      ),
      confirmLabel: "Skip for now",
      cancelLabel: "Keep setting up",
      tone: "brand",
    });
    if (!ok) return;
    if (userId) dismissOnboarding(userId);
    navigate("/dashboard", { replace: true });
  }

  function handleContinueFromBasics() {
    const errors = validateBasics(draft);
    if (hasErrors(errors)) {
      setFieldErrors(errors);
      return;
    }
    goTo(2);
  }

  async function handleCreate() {
    const errors = validateNumbers(draft);
    if (hasErrors(errors)) {
      setFieldErrors(errors);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const created = await createProfile(toBusinessProfileInput(draft));
      if (userId) clearOnboarding(userId);
      setCreatedProfileId(created.id);
      goTo(3);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const businessName = draft.name.trim();
  const heading =
    step === 1
      ? { title: "Tell us about your business", subtitle: "Name it and pick the closest fit." }
      : step === 2
        ? {
            title: "Your starting figures",
            subtitle: "Rough numbers are fine. You can change them later.",
          }
        : {
            title: businessName ? `${businessName} is set up` : "Your business is set up",
            subtitle: "Your dashboard is ready.",
          };

  return (
    <div className="app-canvas min-h-dvh px-4 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-5 flex items-center justify-between gap-3 sm:mb-7">
          <div className="flex min-w-0 items-center gap-2.5">
            <img src="/newmascotlogo.png" alt="" aria-hidden className="h-9 w-9 shrink-0 rounded-lg object-contain" />
            <Wordmark className="text-lg text-tone-brand" />
          </div>
          {/*
            A GHOST button on purpose. Skip has to be findable (someone who
            cannot leave a setup screen is trapped), but the quieter of the two
            actions should be the one that abandons the task.
          */}
          {step < 3 ? (
            <Button type="button" variant="ghost" size="sm" onClick={handleSkip} className="shrink-0">
              Skip for now
            </Button>
          ) : null}
        </header>

        <main
          id="main-content"
          className="animate-rise overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-lg lg:grid lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]"
        >
          <aside className="hidden flex-col gap-7 border-r border-paper-200 bg-paper-100/60 p-7 lg:flex">
            <div>
              <p className="eyebrow">Set up FinSight</p>
              <p className="mt-1 text-sm text-ink-600">About two minutes.</p>
            </div>
            <StepList step={step} />
            <div className="mt-auto space-y-4">
              <DraftSummary draft={draft} />
              <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-600">
                <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-tone-brand" />
                Private to you. No bank connection.
              </p>
            </div>
          </aside>

          <div className="min-w-0 px-5 py-7 sm:px-9 sm:py-9">
            <CompactProgress step={step} />

            {/*
              Keyed by step so React remounts on transition rather than reusing
              the previous step's DOM. That lets autoFocus land on the first
              field of each step, and the slide follows the button pressed.
            */}
            <div key={step} className={direction === "next" ? "animate-step-next" : "animate-step-back"}>
              {step === 3 ? (
                <div className="mb-6 flex items-center gap-4">
                  <span className="relative flex h-14 w-14 shrink-0 animate-pop-in items-center justify-center rounded-full bg-tint-brand text-tone-brand">
                    <span aria-hidden className="absolute inset-0 animate-soft-pulse rounded-full ring-4 ring-edge-brand" />
                    <Check aria-hidden className="h-7 w-7" strokeWidth={2.75} />
                  </span>
                  <div className="min-w-0">
                    <h1 className="font-display text-xl font-bold text-ink-900 [overflow-wrap:anywhere] sm:text-2xl">
                      {heading.title}
                    </h1>
                    <p className="mt-1 text-sm text-ink-600">{heading.subtitle}</p>
                  </div>
                </div>
              ) : (
                <div className="mb-6">
                  <h1 className="font-display text-xl font-bold text-ink-900 sm:text-2xl">{heading.title}</h1>
                  <p className="mt-1 max-w-[62ch] text-sm text-ink-600">{heading.subtitle}</p>
                </div>
              )}

              {step === 1 ? (
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleContinueFromBasics();
                  }}
                >
                  <BusinessBasicsFields draft={draft} errors={fieldErrors} update={update} brief />
                  <div className="flex justify-end border-t border-paper-200 pt-5">
                    <Button type="submit" variant="primary">
                      Continue
                    </Button>
                  </div>
                </form>
              ) : null}

              {step === 2 ? (
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleCreate();
                  }}
                >
                  <BusinessNumbersFields draft={draft} errors={fieldErrors} update={update} brief />

                  {error ? <FormError>{error}</FormError> : null}

                  <div className="flex items-center justify-between gap-3 border-t border-paper-200 pt-5">
                    <Button type="button" variant="secondary" onClick={() => goTo(1)} disabled={submitting}>
                      Back
                    </Button>
                    <Button type="submit" variant="primary" disabled={submitting}>
                      {submitting ? "Saving…" : "Create my business"}
                    </Button>
                  </div>
                </form>
              ) : null}

              {step === 3 ? (
                <div className="space-y-5">
                  {/* The profile already exists here (see the file header), so this
                      is the completion moment even though one optional step remains. */}
                  <div className="flex flex-col items-center gap-5 rounded-2xl border border-paper-200 bg-tint-brand p-5 sm:flex-row sm:items-start">
                    <img
                      src="/mascot/01-onboarding/onboardingcomplete.webp"
                      alt=""
                      aria-hidden
                      width={96}
                      height={96}
                      className="h-24 w-24 shrink-0 animate-bob select-none"
                      draggable={false}
                    />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                        <FileSpreadsheet aria-hidden className="h-4 w-4 shrink-0 text-tone-brand" />
                        Have past records?
                      </p>
                      <p className="mt-1.5 text-sm text-ink-700">
                        Import a CSV so your insights start with real history. You check a preview
                        before anything is saved.
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 border-t border-paper-200 pt-5 sm:flex-row-reverse sm:items-center sm:justify-start">
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() =>
                        // The existing importer, flagged to finish at the dashboard
                        // so the wizard ends where it promised to.
                        navigate("/records/csv-imports/new", { state: { fromOnboarding: true } })
                      }
                    >
                      Import CSV
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => navigate("/dashboard", { replace: true })}>
                      Go to my dashboard
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
