/**
 * The three-step business setup a new owner lands in after their first login.
 *
 * WHY A WIZARD RATHER THAN THE FORM THAT ALREADY EXISTED. The single screen
 * asked six questions at once, four of them financial, before showing anything
 * of value — and on a phone that is six fields fighting a keyboard that covers
 * half of them. Split three ways, each screen asks two or three related things
 * and says what they are for.
 *
 * WHAT COUNTS AS "NOT SET UP" is not a new flag: it is having no business
 * profiles. See lib/onboardingDraft.ts.
 *
 * THE PROFILE IS CREATED AT THE END OF STEP 2, not step 3, because step 3
 * imports records and records need a business to belong to.
 *
 * Mirrors web/src/pages/Onboarding.tsx question for question — same fields,
 * same order, same words — while keeping the platform's own shapes: chips
 * rather than a dropdown, a bottom sheet rather than a dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, BackHandler, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Callout,
  Card,
  ConfirmSheet,
  ErrorNote,
  Field,
  Screen,
  ScreenHeader,
  SelectChip,
  T,
} from "../components/ui";
import { Mascot } from "../components/MascotState";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { formatMoney } from "../lib/money";
import { radius, space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import {
  BUSINESS_TYPES,
  EMPTY_DRAFT,
  applyFieldUpdate,
  hasErrors,
  matchBusinessType,
  thresholdDisplayValue,
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

/**
 * The steps, named.
 *
 * A bare "Step 2 of 3" says how far along but not what is coming, which is the
 * question an owner deciding whether to carry on is actually asking. The names
 * are also what the rail announces to a screen reader, where a row of bars is
 * nothing at all.
 */
const STEP_NAMES = ["Your business", "Your numbers", "You're ready"] as const;
const TOTAL_STEPS = STEP_NAMES.length;

/** Where the owner can go straight from the end of setup. */
export type OnboardingNext = "sale" | "expense" | "scan" | "import";

/**
 * The progress rail: a count to decide by, bars to make finishing feel near.
 * Not tappable — jumping to step 2 before step 1 is valid would build a profile
 * that cannot be created, and a control that sometimes refuses is worse than
 * no control.
 *
 * ONE ACCESSIBLE ELEMENT, not five. The label, the counter and the three bars
 * are one fact; read out separately they are "Step 2 of 3", "2/3", and three
 * unnamed views. `accessibilityRole="progressbar"` with the sentence as its
 * label is what a screen reader can actually use.
 */
function StepRail({ step }: { step: number }) {
  const t = useTheme();
  const { brand, ink } = t;
  return (
    <View
      style={{ marginBottom: space.lg }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step} of ${TOTAL_STEPS}: ${STEP_NAMES[step - 1]}`}
      accessibilityValue={{ min: 1, max: TOTAL_STEPS, now: step }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6, gap: space.sm }}>
        <T variant="label" style={{ color: ink[500], flexShrink: 1 }} numberOfLines={1}>
          Step {step} of {TOTAL_STEPS} · {STEP_NAMES[step - 1]}
        </T>
        <T variant="label" style={{ color: brand[700] }}>
          {step}/{TOTAL_STEPS}
        </T>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 6,
              borderRadius: radius.full,
              backgroundColor: i < step ? brand[500] : brand[200],
            }}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * WHY a question is being asked, said before it is asked.
 *
 * The figures on step 2 are the ones an owner is most likely to refuse — they
 * are money, and nothing so far has explained what the app does with them.
 * These captions used to sit UNDER their field, which is where an explanation
 * arrives too late to help someone decide whether to answer.
 */
function WhyWeAsk({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <T variant="caption" style={{ marginBottom: space.sm, color: t.textMuted }}>
      {children}
    </T>
  );
}

/** One line of the readiness summary: what was saved, in the owner's own figures. */
function ReadyLine({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <Ionicons
        name="checkmark-circle"
        size={18}
        color={t.statusText.good}
        // Decorative: every line here is a completed one, and the heading above
        // already says so. Announcing "checkmark" four times says nothing.
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <T variant="caption" style={{ flex: 1, color: t.textSecondary }}>
        <T variant="caption" style={{ color: t.textPrimary }}>
          {label}:{" "}
        </T>
        {value}
      </T>
    </View>
  );
}

/** A number the owner typed, as pesos — or a dash where they left it blank. */
function pesos(raw: string): string {
  const value = Number(raw);
  return raw.trim() === "" || Number.isNaN(value) ? "not set" : formatMoney(value);
}

/**
 * The same wizard reached deliberately, from the dashboard's "Continue setup"
 * prompt, rather than automatically on launch.
 *
 * It exists so that resuming works the same way it does on the web, where
 * /onboarding is a route anyone can navigate to regardless of whether they
 * dismissed it. Without it, an owner who skipped would have no way back in
 * short of reinstalling.
 */
/**
 * Where each end-of-setup action lands. One table, used by both entry points,
 * so the resumed wizard and the first-run wizard cannot disagree about what
 * "Scan a receipt" means.
 *
 * Every one of these is a screen in the Records stack — see App.tsx's
 * `<Stack.Screen name=…>` list, which tests/navigationTargets.test.ts pins.
 */
export const ONBOARDING_NEXT_SCREENS: Record<OnboardingNext, string> = {
  sale: "AddSales",
  expense: "AddExpense",
  scan: "ScanReceipt",
  import: "ImportCsv",
};

export function OnboardingResumeScreen({ navigation }: any) {
  return (
    <OnboardingScreen
      onDone={(next) => {
        navigation.goBack();
        // Resolved up the tree to the Records tab — all four destinations are
        // siblings of this stack, not children of it.
        if (next) navigation.navigate("Records", { screen: ONBOARDING_NEXT_SCREENS[next] });
      }}
    />
  );
}

export function OnboardingScreen({
  onDone,
}: {
  /**
   * Leaves the wizard for the main app. A `next` also opens the screen the
   * owner picked on the readiness step — see ONBOARDING_NEXT_SCREENS.
   */
  onDone: (next?: OnboardingNext) => void;
}) {
  const t = useTheme();
  const { ink } = t;
  const { profile: user } = useAuth();
  const { createProfile } = useBusinessProfiles();

  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<BusinessProfileDraft>(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<BusinessFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  /** Set once step 2 succeeds, so step 3 knows the business exists. */
  const [created, setCreated] = useState(false);
  const [customType, setCustomType] = useState(false);

  const userId = user?.id ?? 0;

  // Restoring is async here (SecureStore), unlike the web's synchronous
  // localStorage — so the fields fill in a moment after mount rather than on
  // first paint. Guarded against a resolve that lands after the owner has
  // already started typing, which would otherwise overwrite them.
  const touched = useRef(false);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void readOnboarding(userId).then((stored) => {
      if (!active || touched.current || !stored.draft) return;
      setDraft((d) => ({ ...d, ...stored.draft }));
      const type = stored.draft.type;
      // Case-insensitively: a stored "Food Business" is the list's "Food
      // business", not a type the chips have no word for. See matchBusinessType.
      if (type && matchBusinessType(type) === null) setCustomType(true);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    if (userId && touched.current && !created) void saveOnboardingDraft(userId, draft);
  }, [userId, draft, created]);

  /*
   * A FLUSH ON THE WAY TO THE BACKGROUND.
   *
   * The effect above already writes on every change, so in the normal case
   * the keystore is current. What it does not cover is the write that was
   * in flight — SecureStore is async — when Android decided to reclaim the
   * process behind a phone call or a camera app. Writing once more as the app
   * leaves the foreground costs nothing and closes that window; the write is
   * idempotent, so a duplicate is harmless.
   *
   * A REF, not the state, is read here: this subscription is set up once, and
   * capturing `draft` in the closure would freeze it at whatever was typed
   * before the listener was attached.
   */
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") return;
      if (userId && touched.current && !created) void saveOnboardingDraft(userId, latestDraft.current);
    });
    return () => subscription.remove();
  }, [userId, created]);

  const fundsRef = useRef<TextInput>(null);
  const monthlyRef = useRef<TextInput>(null);
  const daysRef = useRef<TextInput>(null);
  const thresholdRef = useRef<TextInput>(null);

  function update(key: BusinessTextField, value: string) {
    touched.current = true;
    setDraft((d) => applyFieldUpdate(d, key, value));
    // Cleared on edit rather than revalidated per keystroke: an error that
    // disappears as you start fixing it encourages, one that rewrites itself
    // mid-word is noise.
    setFieldErrors((e) => (key in e ? { ...e, [key]: undefined } : e));
  }

  function continueFromBasics() {
    const errors = validateBasics(draft);
    if (hasErrors(errors)) return setFieldErrors(errors);
    setStep(2);
  }

  async function create() {
    const errors = validateNumbers(draft);
    if (hasErrors(errors)) return setFieldErrors(errors);

    setError(null);
    setBusy(true);
    try {
      await createProfile(toBusinessProfileInput(draft));
      if (userId) await clearOnboarding(userId);
      setCreated(true);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setConfirmingSkip(false);
    if (userId) await dismissOnboarding(userId);
    onDone();
  }

  /**
   * What the Android back gesture does inside the wizard.
   *
   * WHY IT NEEDS HANDLING AT ALL. This screen renders three different steps in
   * one component, so as far as the navigator is concerned there is nothing to
   * go back to: on the first-run path the wizard is not even in a stack. Back
   * from step 2 therefore did what back always does at the root — it dropped
   * the app to the home screen, mid-setup, with the owner's answers still on
   * screen. They survive (the draft is in the keystore), but nothing said so,
   * and "I pressed back and lost it" is not a thing anyone tries twice.
   *
   * Now: back walks the wizard BACKWARDS a step, and only asks to leave from
   * step 1 — through the same confirmation the Skip button uses, so there is
   * one wording and one consequence. Step 3 does not intercept: the business
   * exists by then and the step is optional, so back may leave.
   */
  const onBack = useCallback(() => {
    if (confirmingSkip) {
      setConfirmingSkip(false);
      return true;
    }
    if (step === 2) {
      setStep(1);
      return true;
    }
    if (step === 1) {
      setConfirmingSkip(true);
      return true;
    }
    return false;
  }, [confirmingSkip, step]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => subscription.remove();
  }, [onBack]);

  const heading =
    step === 1
      ? { title: "Tell us about your business", subtitle: "Two quick questions to get started." }
      : step === 2
        ? {
            title: "Your numbers",
            subtitle: "These let FinSight work out your targets. Rough figures are fine.",
          }
        : {
            title: "You're ready",
            subtitle: "Your business is saved. Pick one thing to do first.",
          };

  return (
    <Screen safeTop>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenHeader
            eyebrow="Set up FinSight"
            title={heading.title}
            subtitle={heading.subtitle}
            /*
              Top-right as asked, and a ghost button on purpose. Skip has to be
              findable — someone who cannot leave a setup screen is trapped —
              but it competes with Continue for the same glance, and the quieter
              of the two should be the one that abandons the task.
            */
            action={
              step < 3 ? (
                <Button title="Skip for now" variant="ghost" onPress={() => setConfirmingSkip(true)} />
              ) : undefined
            }
          />

          <Card>
            <StepRail step={step} />

            {step === 1 ? (
              <>
                {/*
                  The approved business-setup pose, and the only mascot on the
                  first two steps. Fin's notepad is literally "tell us about
                  your business", which is the one place in this wizard where
                  the art means the same thing the heading does.

                  Step 2 is deliberately mascot-free: it is four money fields,
                  and a character watching someone type their cash position adds
                  nothing to it. Step 3 has the completion pose. One focal point
                  per screen, as the plan requires.
                */}
                <View style={{ alignItems: "center", marginBottom: space.md }}>
                  <Mascot state="businessSetup" size={72} />
                </View>
                <Field
                  label="Business name"
                  value={draft.name}
                  onChangeText={(v) => update("name", v)}
                  error={fieldErrors.name}
                  maxLength={FIELD_LIMITS.businessName}
                  placeholder="e.g. Aling Nena's Store"
                  autoFocus
                  returnKeyType="done"
                />

                <T variant="label" style={{ marginBottom: 4, color: ink[700] }}>
                  Business type
                </T>
                <T variant="caption" style={{ marginBottom: space.sm }}>
                  Helps FinSight compare you against the right kind of business.
                </T>
                {/*
                  Chips rather than the web's dropdown. A picker wheel on a phone
                  hides every option but one behind a tap, and with six choices
                  showing them all costs less space than the control that would
                  conceal them.
                */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm }}>
                  {BUSINESS_TYPES.map((t) => (
                    <SelectChip
                      key={t}
                      label={t}
                      // Compared through the same case-insensitive match the
                      // restore above uses, so a chip is lit for a stored
                      // "Food Business" rather than none of them being.
                      selected={!customType && matchBusinessType(draft.type) === t}
                      onPress={() => {
                        setCustomType(false);
                        update("type", t);
                      }}
                    />
                  ))}
                  <SelectChip
                    label="Other…"
                    selected={customType}
                    onPress={() => {
                      setCustomType(true);
                      // Cleared rather than kept: the box below is empty, and
                      // leaving the old value in state would save a type the
                      // owner can no longer see.
                      update("type", "");
                    }}
                  />
                </View>

                {customType ? (
                  <Field
                    label="Tell us what kind"
                    value={draft.type}
                    onChangeText={(v) => update("type", v)}
                    maxLength={FIELD_LIMITS.businessType}
                    placeholder="e.g. Tire shop, laundry, printing"
                    autoFocus
                    returnKeyType="done"
                  />
                ) : null}

                {fieldErrors.type ? <ErrorNote>{fieldErrors.type}</ErrorNote> : null}

                <Button
                  title="Continue"
                  variant="primary"
                  onPress={continueFromBasics}
                  style={{ marginTop: space.md }}
                />
              </>
            ) : null}

            {step === 2 ? (
              <>
                {/*
                  WHAT THE WHOLE STEP IS FOR, before the first money question.

                  These three figures are the ones an owner is most likely to
                  balk at, and the app had been asking for them cold. Naming the
                  two things they produce — a daily sales target and a large-
                  expense flag — is the difference between a form and a reason.
                */}
                <Callout tone="info">
                  These three figures are what FinSight works your daily sales target from, and what tells it which
                  expenses are big enough to set aside for review. Rough figures are fine — you can change any of them
                  later from your business profile.
                </Callout>
                <View style={{ height: space.md }} />

                <WhyWeAsk>
                  The cash the business has to work with right now. It is the starting point for &ldquo;can I afford
                  this?&rdquo; — FinSight never reads your bank.
                </WhyWeAsk>
                <Field
                  ref={fundsRef}
                  label="Available business funds (PHP)"
                  value={draft.availableFunds}
                  onChangeText={(v) => update("availableFunds", v)}
                  error={fieldErrors.availableFunds}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  autoFocus
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => monthlyRef.current?.focus()}
                />

                <WhyWeAsk>
                  What a normal month costs you — rent, stock, wages, utilities. Divided by your operating days below,
                  this becomes the daily sales target on your Home screen.
                </WhyWeAsk>
                <Field
                  ref={monthlyRef}
                  label="Expected monthly expenses (PHP)"
                  value={draft.expectedMonthlyExpenses}
                  onChangeText={(v) => update("expectedMonthlyExpenses", v)}
                  error={fieldErrors.expectedMonthlyExpenses}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => daysRef.current?.focus()}
                />

                <WhyWeAsk>
                  How many days a month you are actually open. A stall that closes on Sundays needs a higher daily
                  target than one that does not, for the same monthly costs.
                </WhyWeAsk>
                <Field
                  ref={daysRef}
                  label="Operating days per month"
                  value={draft.operatingDays}
                  onChangeText={(v) => update("operatingDays", v)}
                  error={fieldErrors.operatingDays}
                  keyboardType="number-pad"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => thresholdRef.current?.focus()}
                />
                <View style={{ height: space.md }} />

                {/*
                  ASKED IN PESOS, STORED AS A PERCENT — see lib/largeExpenseThreshold.ts.
                  Labelled optional because it is the one field here that is not
                  a fact about the business: it is a setting with a sensible
                  default, and an owner who does not know what to put should be
                  able to move past it rather than stall on it.
                */}
                <Field
                  ref={thresholdRef}
                  label="Flag single expenses over (PHP) — optional"
                  value={thresholdDisplayValue(draft)}
                  onChangeText={(v) => update("largeExpenseThresholdPesos", v)}
                  error={fieldErrors.largeExpenseThresholdPesos}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  returnKeyType="done"
                  // Mirrors the button's own `loading` guard: a second submit
                  // while the first is in flight would create two businesses.
                  onSubmitEditing={() => {
                    if (!busy) void create();
                  }}
                />
                <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
                  Expenses this big get set aside for you to review. Suggested from your monthly
                  expenses — change it anytime.
                </T>

                {error ? <ErrorNote>{error}</ErrorNote> : null}


                <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                  <Button
                    title="Back"
                    variant="secondary"
                    onPress={() => setStep(1)}
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title="Continue"
                    variant="primary"
                    onPress={() => void create()}
                    loading={busy}
                    style={{ flex: 1 }}
                  />
                </View>
              </>
            ) : null}

            {step === 3 ? (
              <>
                {/*
                  THE READINESS SUMMARY.

                  This step used to be "Import your past records" — one
                  optional task, presented as the third of three, which read as
                  a chore standing between the owner and the app. It is now
                  what the end of setup should be: a receipt for what was
                  actually saved, then ONE obvious thing to do next.

                  THE FIGURES ARE ECHOED BACK, not recomputed. Every line below
                  is a value the owner typed on step 2, formatted; nothing here
                  works out a target or a threshold, because both of those are
                  the backend's to derive and a second implementation on this
                  screen is exactly the drift the working agreement forbids.

                  THE ONE MASCOT ON THIS SCREEN. The approved completion pose,
                  shown once, after the profile is genuinely created — `created`
                  is only true past a successful POST. It is static: the plan
                  allows a one-shot for a milestone, and a one-shot that must
                  also be suppressed under Reduce Motion is more machinery than
                  a small celebration is worth.
                */}
                <View style={{ alignItems: "center", marginBottom: space.md }}>
                  <Mascot state="onboardingComplete" size={104} />
                </View>

                <T accessibilityRole="header" variant="title" style={{ textAlign: "center" }}>
                  {draft.name.trim() || "Your business"} is set up
                </T>
                <T variant="caption" style={{ textAlign: "center", marginTop: 4, marginBottom: space.lg }}>
                  Here is what FinSight has. All of it is editable later from your business profile.
                </T>

                <View style={{ gap: space.sm, marginBottom: space.lg }}>
                  <ReadyLine label="Business" value={draft.type.trim() || "Type not set"} />
                  <ReadyLine label="Available funds" value={pesos(draft.availableFunds)} />
                  <ReadyLine
                    label="Monthly expenses"
                    value={`${pesos(draft.expectedMonthlyExpenses)} over ${draft.operatingDays || "—"} operating days`}
                  />
                  <ReadyLine label="Large expenses flagged over" value={pesos(thresholdDisplayValue(draft))} />
                </View>

                {/*
                  ONE PRIMARY ACTION, and it is recording a sale.

                  Of the four honest first moves, this is the one an owner does
                  several times a day and the one that makes the dashboard show
                  something real fastest. The other three are present and equal
                  in weight to each other, but quieter than this — a screen with
                  four primary buttons has no primary action at all.
                */}
                <Button title="Add your first sale" variant="primary" onPress={() => onDone("sale")} />
                <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
                  <Button
                    title="Add an expense"
                    variant="secondary"
                    onPress={() => onDone("expense")}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title="Scan a receipt"
                    variant="secondary"
                    onPress={() => onDone("scan")}
                    style={{ flex: 1 }}
                  />
                </View>
                {/*
                  The CSV importer keeps its place, one level quieter. It is
                  still the best first move for an owner who arrives with a
                  spreadsheet, and it handles preview, column mapping, per-row
                  correction and the failure report — none of which is worth
                  reimplementing inside onboarding.
                */}
                <Button
                  title="Import records from a CSV"
                  variant="ghost"
                  onPress={() => onDone("import")}
                  style={{ marginTop: space.sm }}
                />
                <Button title="Not now — take me to Home" variant="ghost" onPress={() => onDone()} />
              </>
            ) : null}
          </Card>

          {step === 3 ? (
            <T variant="caption" style={{ textAlign: "center", marginTop: space.md }}>
              Nothing here is required. Everything above is already saved.
            </T>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {/*
        Only steps 1 and 2 confirm. By step 3 the business exists and skipping
        costs nothing but an optional import, so a dialog there would protect
        nobody — and one people learn to dismiss is one they will also dismiss
        when it matters.
      */}
      <ConfirmSheet
        visible={confirmingSkip}
        title="Skip setup for now?"
        body="Without your business details FinSight can't work out your sales target or flag large expenses. Anything you've typed is kept, and you can pick up where you left off from your dashboard."
        confirmLabel="Skip for now"
        cancelLabel="Keep setting up"
        onConfirm={() => void skip()}
        onCancel={() => setConfirmingSkip(false)}
      />
    </Screen>
  );
}
