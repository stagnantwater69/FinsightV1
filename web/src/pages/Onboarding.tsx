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
 * owner who closes the tab on step 3 keeps everything they entered — they have
 * a working business profile and simply skipped an optional import.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useConfirm } from "../components/ConfirmDialog";
import { Button } from "../components/Button";
import { FormError } from "../components/Field";
import { Card } from "../components/ui";
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

const TOTAL_STEPS = 3;

/**
 * The progress rail.
 *
 * Both a count and a set of bars: the count is what someone reads to decide
 * whether to start now or later, the bars are what makes finishing feel near.
 * The steps are not clickable — jumping to step 2 before step 1 is valid would
 * produce a profile that cannot be created, and a control that sometimes
 * refuses is worse than no control.
 */
function StepRail({ step }: { step: number }) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <p className="eyebrow">
          Step {step} of {TOTAL_STEPS}
        </p>
        <p className="figure text-xs text-brand-700">
          {step}/{TOTAL_STEPS}
        </p>
      </div>
      <div className="flex gap-1.5" role="presentation">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i < step ? "bg-brand-500" : "bg-brand-200"
            }`}
          />
        ))}
      </div>
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

  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<BusinessProfileDraft>(() => ({
    ...EMPTY_DRAFT,
    ...(stored.draft ?? {}),
  }));
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** The business created at the end of step 2 — step 3 imports into it. */
  const [createdProfileId, setCreatedProfileId] = useState<number | null>(null);

  /*
   * Someone who already has a business does not belong here. This catches the
   * back button and a hand-typed /onboarding as well as the ordinary case, and
   * it deliberately does not fire while `createdProfileId` is set — finishing
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

  function update(key: BusinessTextField, value: string) {
    setDraft((d) => applyFieldUpdate(d, key, value));
    setFieldErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }

  async function handleSkip() {
    /*
     * Only steps 1 and 2 warrant a confirmation. By step 3 the business exists
     * and skipping costs nothing but an optional import, so asking "are you
     * sure?" there would be a dialog that protects nobody — and a dialog people
     * learn to dismiss is one they will also dismiss when it matters.
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
    setStep(2);
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
      setStep(3);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const heading =
    step === 1
      ? { title: "Tell us about your business", subtitle: "Two quick questions to get started." }
      : step === 2
        ? {
            title: "Your numbers",
            subtitle: "These let FinSight work out your targets. Rough figures are fine — you can change them anytime.",
          }
        : {
            title: "Import your past records",
            subtitle: "Already keeping records? Bring them in so your insights start with real history.",
          };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow">Set up FinSight</div>
          <h1 className="text-xl font-bold text-ink-900 sm:text-2xl">{heading.title}</h1>
          <p className="mt-1 text-sm text-ink-500">{heading.subtitle}</p>
        </div>
        {/*
          Top-right as asked, and a GHOST button on purpose. Skip has to be
          findable — someone who cannot leave a setup screen is trapped — but it
          competes with Continue for the same glance, and the quieter of the two
          should be the one that abandons the task.
        */}
        {step < 3 ? (
          <Button type="button" variant="ghost" size="sm" onClick={handleSkip} className="shrink-0">
            Skip for now
          </Button>
        ) : null}
      </div>

      <Card className="p-6 sm:p-7">
        <StepRail step={step} />

        {/*
          Keyed by step so React remounts on transition rather than reusing the
          previous step's DOM — that is what lets autoFocus land on the first
          field of each step, and what makes the fade read as a change of screen.
        */}
        <div key={step} className="animate-fade-up space-y-4">
          {step === 1 ? (
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                handleContinueFromBasics();
              }}
            >
              <BusinessBasicsFields draft={draft} errors={fieldErrors} update={update} />
              <div className="flex justify-end pt-2">
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
              {/* The worked example lives inside BusinessNumbersFields now, and
                  is computed from what the owner has actually typed — see
                  DailyTargetNote. It used to be repeated here as fixed figures. */}
              <BusinessNumbersFields draft={draft} errors={fieldErrors} update={update} />

              {error ? <FormError>{error}</FormError> : null}

              <div className="flex items-center justify-between gap-3 pt-2">
                <Button type="button" variant="secondary" onClick={() => setStep(1)} disabled={submitting}>
                  Back
                </Button>
                <Button type="submit" variant="primary" disabled={submitting}>
                  {submitting ? "Saving…" : "Continue"}
                </Button>
              </div>
            </form>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-paper-200 bg-tint-brand p-4">
                <p className="text-sm font-semibold text-ink-900">Already have sales or expense records?</p>
                <p className="mt-1 text-sm text-ink-600">
                  Upload your CSV report to bring your historical data into FinSight. You'll see a
                  preview and confirm before anything is saved.
                </p>
              </div>

              <p className="text-sm text-ink-500">
                No file handy? Skip this — you can import records at any time from the Records
                screen, or add them one at a time.
              </p>

              <div className="flex flex-col gap-3 pt-2 sm:flex-row-reverse sm:items-center sm:justify-start">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() =>
                    /*
                     * Straight into the importer that already exists rather
                     * than a second copy of it — it handles preview, column
                     * mapping, per-row correction and the failure report, none
                     * of which is worth reimplementing for onboarding. The flag
                     * tells it to finish at the dashboard instead of the
                     * records list, so the wizard ends where it promised to.
                     */
                    navigate("/records/csv-imports/new", { state: { fromOnboarding: true } })
                  }
                >
                  Import CSV
                </Button>
                <Button type="button" variant="secondary" onClick={() => navigate("/dashboard", { replace: true })}>
                  Skip for now
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {step === 3 ? (
        <p className="mt-4 text-center text-sm text-ink-500">
          Your business profile is saved. This last step is optional.
        </p>
      ) : null}
    </div>
  );
}
