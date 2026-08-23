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
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
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
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
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

const TOTAL_STEPS = 3;

/**
 * The progress rail: a count to decide by, bars to make finishing feel near.
 * Not tappable — jumping to step 2 before step 1 is valid would build a profile
 * that cannot be created, and a control that sometimes refuses is worse than
 * no control.
 */
function StepRail({ step }: { step: number }) {
  const t = useTheme();
  const { brand, ink } = t;
  return (
    <View style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <T variant="label" style={{ color: ink[500] }}>
          Step {step} of {TOTAL_STEPS}
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
 * The same wizard reached deliberately, from the dashboard's "Continue setup"
 * prompt, rather than automatically on launch.
 *
 * It exists so that resuming works the same way it does on the web, where
 * /onboarding is a route anyone can navigate to regardless of whether they
 * dismissed it. Without it, an owner who skipped would have no way back in
 * short of reinstalling.
 */
export function OnboardingResumeScreen({ navigation }: any) {
  return (
    <OnboardingScreen
      onDone={(next) => {
        navigation.goBack();
        // Resolved up the tree to the Records tab — the importer is a sibling
        // of this stack, not a child of it.
        if (next === "import") navigation.navigate("Records", { screen: "ImportCsv" });
      }}
    />
  );
}

export function OnboardingScreen({
  onDone,
}: {
  /** Leaves the wizard for the main app; "import" also opens the CSV importer. */
  onDone: (next?: "import") => void;
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

  const heading =
    step === 1
      ? { title: "Tell us about your business", subtitle: "Two quick questions to get started." }
      : step === 2
        ? {
            title: "Your numbers",
            subtitle: "These let FinSight work out your targets. Rough figures are fine.",
          }
        : {
            title: "Import your past records",
            subtitle: "Bring in what you already have so your insights start with real history.",
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
                <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
                  The cash the business has to work with right now. FinSight doesn't read your bank.
                </T>

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
                <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
                  What a normal month costs you — rent, stock, wages, utilities. This drives your
                  daily sales target.
                </T>

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
                <T variant="caption" style={{ marginTop: -space.sm, marginBottom: space.md }}>
                  How many days a month you're actually open.
                </T>

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
                <Callout tone="info">
                  Already have sales or expense records? Upload your CSV report to bring your
                  historical data into FinSight. You'll see a preview and confirm before anything is
                  saved.
                </Callout>
                <T variant="caption" style={{ marginVertical: space.md }}>
                  No file handy? Skip this — you can import records anytime from the Records tab, or
                  add them one at a time.
                </T>
                {/*
                  Both paths call onDone, which drops the owner into the main
                  tabs. Import then navigates to the CSV screen that already
                  exists rather than a second copy of it — it handles preview,
                  column mapping, per-row correction and the failure report,
                  none of which is worth reimplementing for onboarding.
                */}
                <Button title="Import CSV" variant="primary" onPress={() => onDone("import")} />
                <Button
                  title="Skip for now"
                  variant="secondary"
                  onPress={() => onDone()}
                  style={{ marginTop: space.sm }}
                />
              </>
            ) : null}
          </Card>

          {step === 3 ? (
            <T variant="caption" style={{ textAlign: "center", marginTop: space.md }}>
              Your business profile is saved. This last step is optional.
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
