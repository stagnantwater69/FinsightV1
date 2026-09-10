import { useCallback, useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Callout, Checkbox, ErrorNote, Field, Screen, T } from "../components/ui";
import { Mascot, mascotSource, type MascotState } from "../components/MascotState";
import { useAuth } from "../context/AuthContext";
import * as haptics from "../lib/haptics";
import { api, errorMessage, getFieldErrors } from "../lib/api";
import {
  isValid,
  normaliseRecoveryCode,
  validateLogin,
  validateRecoverPassword,
  validateRecoveryCode,
  validateRegister,
  validateResetPassword,
  MAX_RECOVERY_CODE_LENGTH,
  MIN_PASSWORD_LENGTH,
  type FieldErrors,
  type LoginField,
  type RecoveryCodeField,
  type RegisterField,
  type ResetPasswordField,
} from "../lib/authValidation";
import { createRecoveryClient } from "../lib/supabase";
import type { AuthLinkTokens } from "../lib/authLinkTokens";
import type { Profile } from "../lib/types";
import { isSavingAccount, savedEmail, setSavedAccount } from "../lib/savedAccountStore";
import { font, radius, space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";

/**
 * Auth screens. Every input uses `minHeight: TAP` rather than a fixed height so
 * the field grows when a user scales their system font up.
 */

/**
 * Sends the keyboard to whichever field the owner needs to fix, in form
 * order. A failed submit used to leave focus wherever it last was — often
 * nowhere, since the button itself does not take focus — so a screen reader
 * user landed back on the same screen with no indication which of several
 * fields needed attention. Pairs rather than a Record so the FORM's order
 * decides, not the object's key order.
 */
function focusFirstInvalid<F extends string>(
  invalid: FieldErrors<F>,
  order: readonly (readonly [F, React.RefObject<TextInput | null>])[],
) {
  const first = order.find(([field]) => invalid[field]);
  first?.[1].current?.focus();
}

/**
 * How long "send it again" stays unavailable after a send.
 *
 * The endpoints behind both resends are rate-limited server-side, and a
 * button that can be tapped ten times and answers identically every time
 * teaches an owner that the app is not listening. Sixty seconds is long
 * enough for a mail server to be believed and short enough that a genuinely
 * lost email is not a punishment.
 */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The countdown behind a resend control.
 *
 * A plain 1s timeout chain rather than an interval, so the timer cannot
 * outlive the component or drift into a second scheduled tick — and so
 * nothing keeps running once the count reaches zero. This is a count, not an
 * animation: Reduce Motion has no opinion about it, and the number is text,
 * which is why the label below reads it out rather than only showing a bar.
 */
function useResendCooldown(seconds = RESEND_COOLDOWN_SECONDS) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = setTimeout(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearTimeout(id);
  }, [remaining]);

  return { remaining, start: useCallback(() => setRemaining(seconds), [seconds]) };
}

/** One compact brand anchor and a consistent form layout for every auth state. */
function BrandMoment({ mascot, showMascot = true }: { mascot: MascotState; showMascot?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
      {!showMascot ? null : mascot === "brandMark" ? (
        <Image
          source={mascotSource("brandMark")}
          style={{ width: 48, height: 48 }}
          resizeMode="contain"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : (
        <Mascot state={mascot} size={48} plate />
      )}
      <T variant="title" style={{ flex: 1 }}>FinSight</T>
    </View>
  );
}

function AuthTextLink({ title, onPress }: { title: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: space.xs,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <T style={{ color: t.brandText, fontFamily: font.sansSemibold }}>{title}</T>
    </Pressable>
  );
}

function AuthShell({
  title,
  subtitle,
  mascot = "brandMark",
  showMascot = true,
  switchPrompt,
  switchAction,
  onSwitch,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  mascot?: MascotState;
  showMascot?: boolean;
  switchPrompt?: string;
  switchAction?: string;
  onSwitch?: () => void;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Screen safeTop style={{ backgroundColor: t.brandSurface }}>
      <StatusBar style={t.mode === "light" ? "dark" : "light"} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            padding: space.lg,
            paddingBottom: Math.max(insets.bottom, space.xxl) + space.lg,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={{ width: "100%", maxWidth: 480, alignSelf: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md, marginBottom: space.lg }}>
              {onBack ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to log in"
                  onPress={onBack}
                  style={({ pressed }) => ({
                    minWidth: 48,
                    minHeight: 48,
                    borderRadius: radius.md,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? t.surface : "transparent",
                  })}
                >
                  <Ionicons name="arrow-back" size={24} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
                </Pressable>
              ) : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <BrandMoment mascot={mascot} showMascot={showMascot} />
              </View>
            </View>
            <View style={{ backgroundColor: t.surface, borderRadius: radius.lg, padding: space.xl }}>
              <View style={{ gap: space.sm, marginBottom: space.xxl }}>
                <T accessibilityRole="header" variant="titleLg">{title}</T>
                {subtitle ? <T style={{ color: t.textSecondary }}>{subtitle}</T> : null}
              </View>
              {children}
            </View>
            {switchPrompt && switchAction && onSwitch ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.xs,
                  marginTop: space.md,
                }}
              >
                <T>{switchPrompt}</T>
                <AuthTextLink title={switchAction} onPress={onSwitch} />
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The shape every "we have sent you something / it worked" outcome takes.
 *
 * WHY A COMPONENT AND NOT FOUR TINTED BOXES. Registration, password recovery,
 * the completed reset and the confirmed email each used to end in a
 * brand-tinted paragraph — the same paragraph, four times, in four slightly
 * different words, with no symbol and (for the two that email you) no mention
 * of WHICH address. An owner who mistyped their address got the identical
 * reassuring box as one who did not.
 *
 * AN ICON, NOT A MASCOT, by default. The plan reserves Fin for moments where
 * a pose means something, and "an email is on its way" is a status, not a
 * milestone — a checkmark or an envelope says it faster and at a fraction of
 * the bytes. The two screens that DO have approved art (the completed
 * password reset) pass their pose to `AuthShell` above instead, so there is
 * still only one illustration per screen.
 *
 * ANNOUNCED. `accessibilityLiveRegion="polite"` because this replaces a form
 * in place: nothing navigates, so without it a screen-reader user taps
 * "Create account" and hears nothing at all.
 */
function SuccessPanel({
  icon,
  tone = "good",
  body,
  email,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone?: "good" | "brand";
  body: string;
  /** The address the message went to. Shown so a typo is visible while it can still be fixed. */
  email?: string;
}) {
  const t = useTheme();
  const surface = tone === "good" ? t.statusSurface.good : t.brandSurface;
  const tint = tone === "good" ? t.statusText.good : t.brandText;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: tone === "good" ? t.statusBorder.good : t.brandBorder,
        padding: space.lg,
        alignItems: "flex-start",
        gap: space.sm,
      }}
    >
      {/* Decorative: `body` below states the outcome in words. */}
      <Ionicons name={icon} size={28} color={tint} accessibilityElementsHidden importantForAccessibility="no" />
      <T style={{ color: t.textPrimary }}>{body}</T>
      {email ? (
        <T
          selectable
          style={{ color: t.textPrimary, fontFamily: font.sansSemibold }}
        >
          {email}
        </T>
      ) : null}
    </View>
  );
}

/**
 * The resend control's label, as one function so the three states cannot
 * drift apart between the two screens that use them.
 *
 * The countdown is IN THE LABEL rather than in a caption beside a disabled
 * button, because a disabled control with no stated reason is the version an
 * owner taps repeatedly and then reports as broken.
 */
function resendLabel(remaining: number, sending: boolean, sent: boolean): string {
  if (sending) return "Sending…";
  if (remaining > 0) return `Send again in ${remaining}s`;
  if (sent) return "Send it again";
  return "Didn't arrive? Send it again";
}

export function LoginScreen({ navigation }: any) {
  const { login, sessionEnded } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saveAccount, setSaveAccount] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Per-field messages, from this screen's checks or from the server's.
   *
   * Set on submit only. Checking as someone types marks an email invalid
   * halfway through typing it, which is a form arguing with a person who is
   * doing nothing wrong — so a field's message clears when it changes, and is
   * only ever set when they ask to continue.
   */
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<LoginField>>({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  /** Every field's ref, in the order the form reads — see `focusFirstInvalid`. */
  const fieldOrder = [
    ["email", emailRef],
    ["password", passwordRef],
  ] as const satisfies readonly (readonly [LoginField, React.RefObject<TextInput | null>])[];

  const clearField = (field: LoginField) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  /*
   * Both of these live in the keystore and both reads are async, so the form
   * starts on its defaults and fills in a moment later. That is deliberately
   * not gated behind a loading state: the fields are usable immediately, and
   * someone who starts typing their own address before the stored one arrives
   * would not thank us for overwriting it — which is what the guard below is
   * for.
   */
  useEffect(() => {
    let active = true;
    void (async () => {
      const [saved, choice] = await Promise.all([savedEmail(), isSavingAccount()]);
      if (!active) return;
      setSaveAccount(choice);
      // Only prefill an untouched field.
      if (saved) setEmail((current) => (current === "" ? saved : current));
    })();
    return () => {
      active = false;
    };
  }, []);

  async function submit() {
    setError(null);

    const invalid = validateLogin({ email, password });
    if (!isValid(invalid)) {
      // Not sent. The round trip would bring back the same answer, and on a
      // phone tether it is one the owner pays for.
      setFieldErrors(invalid);
      focusFirstInvalid(invalid, fieldOrder);
      haptics.failed();
      return;
    }
    setFieldErrors({});

    setBusy(true);
    try {
      await login({ email: email.trim(), password });
      // Saved only once the address is known to work. Prefilling a login that
      // fails would hand the owner a form that looks right and is not, which
      // is harder to recover from than an empty one.
      await setSavedAccount(saveAccount, email);
    } catch (err) {
      // Fields the server rejected go under those fields. Everything else —
      // wrong password, no network — has no field to sit under.
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
      focusFirstInvalid(fromServer, fieldOrder);
      setError(Object.keys(fromServer).length > 0 ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Log in"
      subtitle="Welcome back. Log in to see how your business is doing."
      switchPrompt="New to FinSight?"
      switchAction="Create account"
      onSwitch={() => navigation.navigate("Register")}
    >
      {/*
        The return key walks the form: "next" until the last field, then "done",
        which runs the same submit the button does. `submitBehavior="submit"`
        keeps the keyboard up between fields so it does not flicker closed and
        open again on every hop — it replaces `blurOnSubmit`, which React Native
        0.86 marks deprecated in favour of it.
      */}
      {/*
        WHY THE APP IS SHOWING THIS FORM, when the owner did not ask for it.
        Landing on a login screen you did not tap for reads as the app having
        lost your work; saying which of the two things happened is the whole
        difference between that and an instruction.

        The two reasons get different sentences on purpose. "Log in again" is
        the fix for an expired token and is NOT the fix for a suspended
        account — see the ACCOUNT_NOT_ACTIVE note in the backend's requireAuth,
        which is why that case is a 403 rather than a 401 in the first place.
      */}
      {sessionEnded ? (
        <View
          style={{ marginBottom: space.md }}
          // `accessible` for the reason ErrorNote gives: React Native maps it
          // onto isAccessibilityElement, and `alert` on a View without it is an
          // announcement nothing makes. Safe here — the callout is text only,
          // so there is no control for the grouping to swallow.
          accessible
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          <Callout tone="warn">
            {sessionEnded === "account-not-active"
              ? "This account isn't active right now, so FinSight has signed it out. Confirm your email address if you haven't yet, or contact support if you think this is a mistake."
              : "Your session expired — please log in again."}
          </Callout>
        </View>
      ) : null}
      <Field
        ref={emailRef}
        icon="mail-outline"
        label="Email"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          clearField("email");
        }}
        error={fieldErrors.email}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      <Field
        ref={passwordRef}
        icon="lock-closed-outline"
        label="Password"
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          clearField("password");
        }}
        error={fieldErrors.password}
        secureTextEntry
        autoComplete="password"
        returnKeyType="done"
        // Mirrors the button's own `loading` guard: a second submit while the
        // first is still in flight would fire two login requests.
        onSubmitEditing={() => {
          if (!busy) submit();
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <View style={{ flexGrow: 1, flexBasis: 160 }}>
          <Checkbox
            label="Remember me"
            checked={saveAccount}
            onChange={setSaveAccount}
            style={{ marginBottom: 0, minHeight: 48 }}
          />
        </View>
        <AuthTextLink title="Forgot password?" onPress={() => navigation.navigate("RecoverPassword")} />
      </View>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button title="Log in" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
    </AuthShell>
  );
}

export function RegisterScreen({ navigation }: any) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const formWidth = Math.min(width - space.lg * 2, 480) - space.xl * 2;
  const namesSideBySide = formWidth >= 360 && fontScale <= 1.2;
  const { register } = useAuth();
  const [form, setForm] = useState({ firstName: "", lastName: "", middleName: "", email: "", phoneNumber: "", password: "", confirmPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<RegisterField>>({});
  const [busy, setBusy] = useState(false);
  /**
   * What the server said once the request was accepted.
   *
   * Non-null switches this screen to the "check your email" state. Registration
   * no longer returns a session — the account is pending until its address is
   * confirmed — so there is nothing to sign into, and the honest end of this
   * form is an instruction rather than a jump into the app.
   */
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const cooldown = useResendCooldown();
  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Correcting a marked field clears its mark straight away, rather than
    // making the owner submit again to find out whether they fixed it.
    setFieldErrors((prev) => (prev[k as RegisterField] ? { ...prev, [k]: undefined } : prev));
  };
  const firstNameRef = useRef<TextInput>(null);
  const lastNameRef = useRef<TextInput>(null);
  const middleNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const phoneNumberRef = useRef<TextInput>(null);
  const focusEmailOnReturn = useRef(false);
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  useEffect(() => {
    if (acknowledgement === null && focusEmailOnReturn.current) {
      focusEmailOnReturn.current = false;
      emailRef.current?.focus();
    }
  }, [acknowledgement]);
  // Match the visible field order when focusing the first validation error.
  const fieldOrder = [
    ["firstName", firstNameRef],
    ["lastName", lastNameRef],
    ["middleName", middleNameRef],
    ["email", emailRef],
    ["phoneNumber", phoneNumberRef],
    ["password", passwordRef],
    ["confirmPassword", confirmPasswordRef],
  ] as const satisfies readonly (readonly [RegisterField, React.RefObject<TextInput | null>])[];

  async function submit() {
    setError(null);

    const invalid = validateRegister(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
      focusFirstInvalid(invalid, fieldOrder);
      haptics.failed();
      return;
    }
    setFieldErrors({});

    setBusy(true);
    try {
      const { message } = await register({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        middleName: form.middleName.trim() || undefined,
        email: form.email.trim(),
        phoneNumber: form.phoneNumber.trim() || undefined,
        password: form.password,
      });
      setAcknowledgement(message);
      // The first mail has just gone out, so the resend starts on cooldown —
      // otherwise the obvious next tap sends a duplicate of an email that has
      // not had time to arrive.
      cooldown.start();
    } catch (err) {
      // An address already registered, or a rule this screen let through,
      // lands under its own field; anything else stays form-level.
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
      focusFirstInvalid(fromServer, fieldOrder);
      setError(Object.keys(fromServer).length > 0 ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      await api.post("/auth/resend-verification", { email: form.email.trim(), platform: "mobile" });
    } catch {
      // The endpoint answers the same way whatever happened, so there is
      // nothing to show that "check your inbox" does not already say.
    } finally {
      setResent(true);
      setResending(false);
      cooldown.start();
    }
  }

  /*
   * The end of registration, and it is not the app.
   *
   * Signing straight in used to be possible because registration handed back a
   * session — which is precisely how an address nobody owned became a working
   * account. The account now stays pending until the link in that inbox is
   * opened, and this screen says so rather than pretending otherwise.
   */
  if (acknowledgement) {
    return (
      /*
       * NO MASCOT HERE, on purpose. This is a pending state, not a milestone:
       * the account does not exist until the link is opened, and a celebrating
       * Fin beside "nothing is active yet" would be the app congratulating
       * someone on a step they have not taken. The badge mark and an envelope
       * are the honest amount of ceremony.
       */
      <AuthShell title="Check your email" subtitle="One more step.">
        <SuccessPanel icon="mail-unread-outline" tone="brand" body={acknowledgement} email={form.email.trim()} />
        <T style={{ color: t.textSecondary, marginTop: space.md }}>
          Open the link on this phone and it will bring you straight back here. Nothing is active until you do.
        </T>
        {/*
          NO "OPEN MAIL APP" BUTTON, and that is a decision rather than an
          omission. There is no reliable cross-platform way to open an inbox:
          `mailto:` opens a COMPOSE window, not the mail the owner is waiting
          for; `message://` is Apple Mail only and does nothing for the many
          owners on Gmail; and Android has no documented inbox intent that is
          guaranteed to resolve. A primary button that silently does nothing
          on half of the phones this app targets is worse than no button, so
          the instruction above is the whole answer until one of those becomes
          dependable.
        */}
        <Button
          title="Back to log in"
          variant="primary"
          onPress={() => navigation.navigate("Login")}
          style={{ marginTop: space.md }}
        />
        <Button
          title={resent && cooldown.remaining === 0 ? "Sent — check your inbox" : resendLabel(cooldown.remaining, resending, resent)}
          variant="ghost"
          disabled={resending || cooldown.remaining > 0}
          onPress={resend}
        />
        {/*
          THE TYPO ESCAPE HATCH. Every field is still in state, so this puts
          the owner back on their own filled-in form with the cursor in the
          address — not through registration a second time. Without it, a
          mistyped address is a dead end that can only be left by force-quitting
          and starting again.
        */}
        <Button
          title="Use a different email"
          variant="ghost"
          onPress={() => {
            // Focus after the email field has mounted again.
            focusEmailOnReturn.current = true;
            setAcknowledgement(null);
            setResent(false);
          }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Track your business finances with FinSight."
      onBack={() => navigation.navigate("Login")}
      switchPrompt="Already have an account?"
      switchAction="Log in"
      onSwitch={() => navigation.navigate("Login")}
    >
      <T style={{ color: t.textSecondary, marginBottom: space.lg }}>Fields without (optional) are required.</T>
      <View style={{ flexDirection: namesSideBySide ? "row" : "column", gap: namesSideBySide ? space.md : 0 }}>
        <View style={namesSideBySide ? { flex: 1, minWidth: 0 } : undefined}>
          <Field
            ref={firstNameRef}
            icon="person-outline"
            label="First name"
            value={form.firstName}
            onChangeText={set("firstName")}
            error={fieldErrors.firstName}
            autoComplete="given-name"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => lastNameRef.current?.focus()}
          />
        </View>
        <View style={namesSideBySide ? { flex: 1, minWidth: 0 } : undefined}>
          <Field
            ref={lastNameRef}
            icon="person-outline"
            label="Last name"
            value={form.lastName}
            onChangeText={set("lastName")}
            error={fieldErrors.lastName}
            autoComplete="family-name"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => middleNameRef.current?.focus()}
          />
        </View>
      </View>
      <Field
        ref={middleNameRef}
        icon="person-outline"
        label="Middle name (optional)"
        value={form.middleName}
        onChangeText={set("middleName")}
        error={fieldErrors.middleName}
        autoComplete="additional-name"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => emailRef.current?.focus()}
      />
      <Field
        ref={emailRef}
        icon="mail-outline"
        label="Email"
        value={form.email}
        onChangeText={set("email")}
        error={fieldErrors.email}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => phoneNumberRef.current?.focus()}
      />
      <Field
        ref={phoneNumberRef}
        icon="call-outline"
        label="Phone number (optional)"
        value={form.phoneNumber}
        onChangeText={set("phoneNumber")}
        error={fieldErrors.phoneNumber}
        keyboardType="phone-pad"
        autoComplete="tel"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />
      {/*
        "new-password" rather than Login's "password": it tells the password
        manager to offer a generated one instead of autofilling an existing
        one, which is the difference between signing up and signing in.
      */}
      <Field
        ref={passwordRef}
        icon="lock-closed-outline"
        label="Password"
        value={form.password}
        onChangeText={set("password")}
        error={fieldErrors.password}
        secureTextEntry
        accessibilityHint={`At least ${MIN_PASSWORD_LENGTH} characters. A short phrase works well.`}
        autoComplete="new-password"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmPasswordRef.current?.focus()}
      />
      <T style={{ color: t.textSecondary, marginBottom: space.lg }}>
        At least {MIN_PASSWORD_LENGTH} characters. A short phrase works well.
      </T>
      {/*
        A mistyped password here is not a small mistake: the account it creates
        cannot be logged into, and the way out is a reset link sent to an inbox
        that may have been mistyped in the same sitting.
      */}
      <Field
        ref={confirmPasswordRef}
        icon="shield-checkmark-outline"
        label="Confirm password"
        value={form.confirmPassword}
        onChangeText={set("confirmPassword")}
        error={fieldErrors.confirmPassword}
        secureTextEntry
        autoComplete="new-password"
        returnKeyType="done"
        onSubmitEditing={() => {
          if (!busy) submit();
        }}
      />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button title="Create account" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
    </AuthShell>
  );
}

export function RecoverPasswordScreen({ navigation }: any) {
  const t = useTheme();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  /** The address the link actually went to, frozen at send time. */
  const [sentTo, setSentTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const cooldown = useResendCooldown();
  const focusEmailOnReturn = useRef(false);
  useEffect(() => {
    if (!sent && focusEmailOnReturn.current) {
      focusEmailOnReturn.current = false;
      emailRef.current?.focus();
    }
  }, [sent]);

  async function submit() {
    setError(null);

    /*
      Checked here as much for the OWNER as for the server. This endpoint
      answers the same way whether or not the address is registered — that is
      deliberate, so it cannot be used to discover who has an account — which
      means a typo produces the identical "check your inbox" as a real
      address, and the reset that never arrives is unexplainable. Catching a
      malformed address before sending is the only place that typo can still
      be pointed at.
    */
    const invalid = validateRecoverPassword({ email });
    if (!isValid(invalid)) {
      setEmailError(invalid.email ?? null);
      // One field on this form, so "first invalid" is not a search.
      emailRef.current?.focus();
      haptics.failed();
      return;
    }
    setEmailError(null);

    setBusy(true);
    try {
      // `platform` tells the server which app to point the emailed link at; the
      // address itself comes from configuration there, never from here — a
      // client-supplied redirect would be an open redirect carrying a live
      // reset token.
      await api.post("/auth/recover-password", { email: email.trim(), platform: "mobile" });
      setSentTo(email.trim());
      setSent(true);
      cooldown.start();
      /*
       * Straight into the code form, with the address already filled in.
       *
       * The email carries a CODE and nothing else now — the button that used to
       * open `finsight://auth/reset-password` has been taken out of the
       * template, so there is no link left to come back on and "check your
       * inbox" would be the end of the road rather than the middle of it. The
       * `sent` state below is still rendered underneath, so backing out of the
       * code form lands on the resend rather than on an empty form.
       */
      navigation.navigate("ResetPassword", { email: email.trim() });
    } catch (err) {
      const fromServer = getFieldErrors(err);
      setEmailError(fromServer.email ?? null);
      if (fromServer.email) emailRef.current?.focus();
      setError(fromServer.email ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={sent ? "Check your email" : "Reset your password"}
      subtitle={sent ? "The code is on its way." : "We'll email you a code to set a new one."}
      onBack={() => navigation.navigate("Login")}
      showMascot={false}
    >
      {sent ? (
        <>
          {/*
            A CODE, not a link. The reset email no longer carries a button —
            the template is the code alone — so nothing will ever open the app
            from that inbox, and an instruction to "open the link" would be a
            step the owner cannot take. The code is typed on the next screen,
            which this one goes straight to.

            The ADDRESS is shown because this endpoint answers identically for
            a registered address and an unregistered one — deliberately, so it
            cannot be used to discover who has an account — which means a typo
            and a real address produce the same screen. Printing what we sent
            to is the only place that typo is still visible.
          */}
          <SuccessPanel
            icon="mail-unread-outline"
            tone="brand"
            body="If that email is registered, a recovery code is on its way to:"
            email={sentTo}
          />
          <T style={{ color: t.textSecondary, marginTop: space.md }}>
            Type that code on the next screen and you can set a new password here, without leaving the app. Codes
            expire, and each one works only once.
          </T>
          <Button
            title="Enter the code"
            variant="primary"
            onPress={() => navigation.navigate("ResetPassword", { email: sentTo })}
            style={{ marginTop: space.md }}
          />
          <Button
            title={resendLabel(cooldown.remaining, busy, true)}
            variant="secondary"
            disabled={busy || cooldown.remaining > 0}
            onPress={submit}
            style={{ marginTop: space.md }}
          />
          <Button
            title="Use a different email"
            variant="ghost"
            onPress={() => {
              focusEmailOnReturn.current = true;
              setSent(false);
            }}
          />
        </>
      ) : (
        <>
          <Field
            ref={emailRef}
            icon="mail-outline"
            label="Email"
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setEmailError(null);
            }}
            error={emailError}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            returnKeyType="done"
            onSubmitEditing={() => {
              if (!busy) submit();
            }}
          />
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {/* "Send code", because a code is what arrives. A button promising a
              link would be describing an email this app no longer sends. */}
          <Button title="Send code" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.sm }} />
        </>
      )}
    </AuthShell>
  );
}

/**
 * Where a password reset is finished: the emailed code in, a new password out.
 *
 * IT USED TO BE A DEEP LINK, and it is not one any more. The reset email's
 * button — `finsight://auth/reset-password`, carrying a token pair in the
 * fragment — has been taken out of the Supabase template, which now sends
 * GoTrue's recovery code and nothing else. So there is no link left to arrive
 * on, and a screen that could only be reached by one would have left every
 * mobile owner holding a code with nowhere to type it. This is that somewhere.
 * (Email CONFIRMATION is unaffected: it still has its link and its
 * `auth/confirm` deep link — see ConfirmEmailScreen.)
 *
 * THE CODE IS A LIVE CREDENTIAL, on exactly the footing the link's token was:
 * it is enough to change the password on the account. So it is never logged,
 * never put in a URL, and never sent to our backend. `verifyOtp` exchanges it
 * with Supabase for the same token pair the link used to deliver, and from
 * there this is the flow it always was.
 *
 * THE TOKENS NEVER REACH OUR SERVER as a password-bearing request either. The
 * new password is set directly against Supabase using a client that persists
 * nothing (see `createRecoveryClient`), so it never touches the keystore. The
 * backend is told only afterwards, and only so it can end every other session —
 * which the phone cannot do for itself and is often the entire reason someone
 * is resetting.
 */
export function ResetPasswordScreen({
  email: sentTo = "",
  onDone,
  onNewCode,
}: {
  /** The address the code was sent to, when we know it. May be empty. */
  email?: string;
  onDone: () => void;
  /** Back to the "email me a code" form. Absent when there is nowhere to go. */
  onNewCode?: () => void;
}) {
  const t = useTheme();
  /*
   * Only so a completed reset can end the local session — see `finish` below.
   * There is normally no session here at all (this screen lives on the auth
   * stack), which is why `profile` is checked rather than assumed.
   */
  const { profile, logout } = useAuth();

  /*
   * Step one. Held apart from the password form's state because the two are
   * never on screen together, and sharing one `error` would let a failed
   * verification's message survive onto the password step.
   */
  const [codeForm, setCodeForm] = useState({ email: sentTo, code: "" });
  const [codeFieldErrors, setCodeFieldErrors] = useState<FieldErrors<RecoveryCodeField>>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  /** What the verified code bought: the pair the link used to carry. */
  const [tokens, setTokens] = useState<{ accessToken: string; refreshToken: string } | null>(null);

  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ResetPasswordField>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const codeEmailRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const codeFieldOrder = [
    ["email", codeEmailRef],
    ["code", codeRef],
  ] as const satisfies readonly (readonly [RecoveryCodeField, React.RefObject<TextInput | null>])[];

  const newPasswordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const fieldOrder = [
    ["newPassword", newPasswordRef],
    ["confirmPassword", confirmRef],
  ] as const satisfies readonly (readonly [ResetPasswordField, React.RefObject<TextInput | null>])[];

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((prev) => (prev[k as ResetPasswordField] ? { ...prev, [k]: undefined } : prev));
  };

  const setCode = (k: keyof typeof codeForm) => (v: string) => {
    setCodeForm((f) => ({ ...f, [k]: v }));
    setCodeFieldErrors((prev) => (prev[k as RecoveryCodeField] ? { ...prev, [k]: undefined } : prev));
  };

  /**
   * Exchanges the emailed code for the token pair a link used to hand over.
   *
   * On success this sets `tokens` and nothing else: the password form below is
   * then reached with exactly the credentials the old deep link produced, so
   * there is one implementation of "change the password and end every other
   * session" rather than two.
   */
  async function verify() {
    setCodeError(null);

    const invalid = validateRecoveryCode(codeForm);
    if (!isValid(invalid)) {
      setCodeFieldErrors(invalid);
      focusFirstInvalid(invalid, codeFieldOrder);
      haptics.failed();
      return;
    }
    setCodeFieldErrors({});

    setVerifying(true);
    const recovery = createRecoveryClient();
    try {
      const { data, error: verifyError } = await recovery.auth.verifyOtp({
        email: codeForm.email.trim(),
        token: normaliseRecoveryCode(codeForm.code),
        type: "recovery",
      });

      /*
       * ONE MESSAGE FOR BOTH FAILURES, and it must stay that way.
       *
       * Supabase distinguishes an unknown address from a wrong token, and
       * repeating that distinction here would turn this form into the account
       * oracle that `/auth/recover-password` refuses to be — that endpoint
       * answers identically for a registered and an unregistered address
       * precisely so nobody can enumerate customers, and it is worth nothing if
       * the next screen along will confirm the address for free. So a wrong
       * code, a wrong address, and an expired code all read the same.
       *
       * The owner stays on this form either way: a mistyped digit is the most
       * likely cause and retyping it is the fix, which sending them back to the
       * start would not be.
       */
      if (verifyError || !data.session) {
        setCodeError(
          "That didn't work. Check the email address and the code — codes expire, so ask for a new one if this keeps failing.",
        );
        haptics.failed();
        return;
      }

      setTokens({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      });
      // Nothing keeps the typed code around: it is spent, and the pair in
      // state is what the next step uses.
      setCodeForm((f) => ({ ...f, code: "" }));
    } catch {
      // Deliberately not `errorMessage(err)`: a transport failure here must not
      // become a channel for the distinction the branch above refuses to draw.
      setCodeError("We couldn't check that code just now. Try again in a moment.");
    } finally {
      // The verification client has done its one job, whichever way it went.
      await recovery.auth.signOut({ scope: "local" }).catch(() => undefined);
      setVerifying(false);
    }
  }

  async function submit() {
    if (!tokens) return;
    setError(null);

    const invalid = validateResetPassword(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
      focusFirstInvalid(invalid, fieldOrder);
      haptics.failed();
      return;
    }
    setFieldErrors({});

    setBusy(true);
    const recovery = createRecoveryClient();
    try {
      const { error: sessionError } = await recovery.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (sessionError) {
        /*
         * Clearing the pair is what puts the code form back on screen: the
         * render below treats "no tokens" as step one, so leaving a dead pair
         * in state would strand the owner on a password form that can no
         * longer save anything.
         */
        setTokens(null);
        setCodeError("That has expired. Enter the code from your email again, or ask for a new one.");
        return;
      }

      const { error: updateError } = await recovery.auth.updateUser({ password: form.newPassword });
      if (updateError) {
        setError(updateError.message);
        return;
      }

      /*
       * Tell the backend, so every other session dies.
       *
       * Deliberately not fatal if it fails: the password IS already changed by
       * this point, and sending the owner back to a form that would now reject
       * their new password — to fix a session they cannot see — is worse than
       * the stale session it would be clearing. It is logged server-side either
       * way.
       */
      await api.postWithToken("/auth/reset-password/complete", tokens.accessToken).catch(() => undefined);

      /*
       * AND THE LOCAL SESSION GOES TOO, if there was one.
       *
       * The call above revokes every session globally, so anything this phone
       * still holds is a corpse: keeping it would leave the owner inside the
       * app on credentials the server has already thrown away, and the next
       * request would fail as an expired session rather than as the reset it
       * actually was. This used to live in App.tsx's `finishReset`, which the
       * deep link no longer reaches.
       */
      if (profile) void logout();

      // Spent, and never wanted again.
      setTokens(null);
      setForm({ newPassword: "", confirmPassword: "" });
      haptics.succeeded();
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // The recovery session is never wanted again, whichever way this went.
      await recovery.auth.signOut({ scope: "local" }).catch(() => undefined);
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Password changed" subtitle="You're all set." showMascot={false}>
        <SuccessPanel
          icon="shield-checkmark-outline"
          body="Your password has been changed, and every device that was signed in has been signed out. Log in with your new password to continue."
        />
        <Button title="Log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
      </AuthShell>
    );
  }

  /*
   * Step one: the code. No tokens means there is nothing to set a password
   * with, whether the owner has just arrived or a verified pair has since
   * expired under them.
   */
  if (!tokens) {
    return (
      <AuthShell
        title="Enter your recovery code"
        subtitle="Use the code from your password-reset email."
        showMascot={false}
      >
        <T style={{ color: t.textSecondary, marginBottom: space.lg }}>
          {sentTo
            ? `Your password-reset email — the one on its way to ${sentTo} — has a numbered code in it. Type it here and you can set a new password without leaving the app.`
            : "Your password-reset email has a numbered code in it. Type it here and you can set a new password without leaving the app."}
        </T>
        <Field
          ref={codeEmailRef}
          icon="mail-outline"
          label="Email"
          value={codeForm.email}
          onChangeText={setCode("email")}
          error={codeFieldErrors.email}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => codeRef.current?.focus()}
        />
        {/*
          A NUMBER PAD, and the OS's own one-time-code offer.

          `keyboardType="number-pad"` with `inputMode="numeric"` gets the digit
          keypad on both platforms without making this a numeric FIELD — a code
          is a string of digits, not a quantity, and a leading zero is part of
          it. `textContentType="oneTimeCode"` is what lets iOS put the code it
          just saw arrive above the keyboard; `autoComplete="sms-otp"` is
          Android's equivalent and is not a value iOS understands, hence the
          platform split rather than one string for both.

          `maxLength` is the top of GoTrue's configurable range plus room for
          the separators people paste — it is there to stop a runaway paste,
          not to enforce a length. `validateRecoveryCode` does that, after the
          separators are stripped, because the real length is a server setting
          (`MAILER_OTP_LENGTH`) this app does not get to see.
        */}
        <Field
          ref={codeRef}
          icon="keypad-outline"
          label="Recovery code"
          value={codeForm.code}
          onChangeText={setCode("code")}
          error={codeFieldErrors.code}
          accessibilityHint="The numbered code in your password-reset email."
          inputMode="numeric"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === "android" ? "sms-otp" : "one-time-code"}
          maxLength={MAX_RECOVERY_CODE_LENGTH + 4}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (!verifying) verify();
          }}
        />
        {codeError ? <ErrorNote>{codeError}</ErrorNote> : null}
        <Button
          title="Continue"
          variant="primary"
          onPress={verify}
          loading={verifying}
          style={{ marginTop: space.md }}
        />
        {onNewCode ? <Button title="Send a new code" variant="ghost" onPress={onNewCode} /> : null}
        <Button title="Back to log in" variant="ghost" onPress={onDone} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password" subtitle={`At least ${MIN_PASSWORD_LENGTH} characters.`} showMascot={false}>
      <Field
        ref={newPasswordRef}
        label="New password"
        value={form.newPassword}
        onChangeText={set("newPassword")}
        error={fieldErrors.newPassword}
        secureTextEntry
        autoComplete="new-password"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmRef.current?.focus()}
      />
      <Field
        ref={confirmRef}
        label="Confirm new password"
        value={form.confirmPassword}
        onChangeText={set("confirmPassword")}
        error={fieldErrors.confirmPassword}
        secureTextEntry
        autoComplete="new-password"
        returnKeyType="done"
        onSubmitEditing={() => {
          if (!busy) submit();
        }}
      />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button
        title="Save new password"
        variant="primary"
        onPress={submit}
        loading={busy}
        style={{ marginTop: space.md }}
      />
      <Button title="Cancel" variant="ghost" onPress={onDone} />
    </AuthShell>
  );
}

/**
 * The screen the registration confirmation link opens.
 *
 * Registration no longer hands out a session, so this is the step that turns a
 * pending registration into a usable account: the token goes to the backend,
 * which verifies it against Supabase before flipping the account to ACTIVE.
 *
 * AND THEN IT SIGNS THEM IN, which it did not used to. The owner tapped
 * "Confirm and open FinSight" in their inbox and was shown a log-in form —
 * asked, on the same tap, to prove again what the email had just proved, and
 * usually to invent the password they had typed ninety seconds earlier on a
 * different screen. The link's own tokens ARE a session the backend has just
 * validated; there is nothing left to check, so the phone adopts it and the
 * app opens on the inside. What the tokens never do is travel any further than
 * `adoptSession` — not into a log line, not into a message on screen.
 */
export function ConfirmEmailScreen({
  tokens,
  linkError,
  onDone,
}: {
  tokens: AuthLinkTokens | null;
  linkError: string | null;
  onDone: () => void;
}) {
  const t = useTheme();
  const { adoptSession } = useAuth();
  const [state, setState] = useState<"checking" | "confirmed" | "failed">(linkError ? "failed" : "checking");
  const [message, setMessage] = useState<string>(linkError ?? "");

  useEffect(() => {
    if (!tokens) return;
    let active = true;
    api
      .postWithToken<{ profile: Profile; message: string }>("/auth/confirm-email", tokens.accessToken)
      .then(async (data) => {
        /*
         * Adopted even if this screen has been torn down in the meantime — a
         * session belongs to the app, not to a mounted component, and dropping
         * it because the owner backgrounded the phone for a moment would put
         * them right back at the log-in form this exists to avoid. Only the
         * on-screen state is guarded by `active`.
         */
        await adoptSession(
          { access_token: tokens.accessToken, refresh_token: tokens.refreshToken },
          data.profile,
        );
        if (!active) return;
        setState("confirmed");
        setMessage(data.message);
      })
      .catch((err) => {
        if (!active) return;
        setState("failed");
        setMessage(errorMessage(err));
      });
    return () => {
      active = false;
    };
    // The link's tokens are the whole input. `adoptSession` is rebuilt on every
    // render of AuthProvider, and listing it would re-POST a one-time token the
    // second any unrelated state there changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  if (state === "checking") {
    return (
      <AuthShell title="Confirming your email">
        <T accessibilityLiveRegion="polite" accessibilityState={{ busy: true }} style={{ color: t.textSecondary }}>Just a moment…</T>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={state === "confirmed" ? "Email confirmed" : "That link didn't work"}
      subtitle={
        state === "confirmed"
          ? "Your account is ready — taking you in."
          : "Confirmation links expire, and each works once."
      }
    >
      {state === "confirmed" ? (
        <SuccessPanel icon="checkmark-circle-outline" body={message} />
      ) : (
        <ErrorNote>{message}</ErrorNote>
      )}
      {/*
        "Continue", not "Log in": there is a session on this phone by now, and
        a button that says log in describes work the owner no longer has to do.
        A failed confirmation lands back on the log-in screen instead, which is
        the only place a new link can be asked for.
      */}
      <Button
        title={state === "confirmed" ? "Continue" : "Back to log in"}
        variant="primary"
        onPress={onDone}
        style={{ marginTop: space.md }}
      />
    </AuthShell>
  );
}

/**
 * The screen the website's hand-back opens: `finsight://auth/handoff?code=…`.
 *
 * WHY THERE IS A SECOND WAY IN AT ALL. Confirmation emails point at the https
 * web origin for every owner now, and whether the OS gives that URL to this app
 * or to a browser is not something the app gets to decide — it depends on an
 * App Link/Universal Link association that a fresh install, a sideload or a
 * missing `assetlinks.json` can all leave unverified. When the browser wins,
 * the owner confirms on the website and the website offers to open the app; it
 * mints a short-lived one-time code, and this exchanges that code for the
 * session rather than putting tokens in a URL the OS will happily write to the
 * recents list, the system log and the browser's history.
 *
 * A code that has expired or already been spent is not recoverable from here,
 * so the failure state does the one useful thing left: back to log in.
 */
export function SessionHandoffScreen({
  code,
  linkError,
  onDone,
}: {
  code: string | null;
  linkError: string | null;
  onDone: () => void;
}) {
  const t = useTheme();
  const { adoptSession } = useAuth();
  const [state, setState] = useState<"exchanging" | "done" | "failed">(linkError ? "failed" : "exchanging");
  const [message, setMessage] = useState<string>(linkError ?? "");

  useEffect(() => {
    if (!code) return;
    let active = true;
    api
      .post<{ profile: Profile; session: { access_token: string; refresh_token: string } }>(
        "/auth/handoff/exchange",
        { code },
      )
      .then(async (data) => {
        // Same reasoning as the confirmation screen: the session is adopted
        // regardless of whether this component is still on screen.
        await adoptSession(data.session, data.profile);
        if (!active) return;
        setState("done");
      })
      .catch((err) => {
        if (!active) return;
        setState("failed");
        // The backend's message already says which of expired/used/invalid it
        // was, in words an owner can act on.
        setMessage(errorMessage(err));
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (state === "exchanging") {
    return (
      <AuthShell title="Signing you in">
        <T accessibilityLiveRegion="polite" accessibilityState={{ busy: true }} style={{ color: t.textSecondary }}>Just a moment…</T>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={state === "done" ? "You're signed in" : "That link didn't work"}
      subtitle={
        state === "done"
          ? "Taking you in."
          : "These links are good for one use, and only for a few minutes."
      }
    >
      {state === "done" ? (
        <SuccessPanel icon="checkmark-circle-outline" body="Your account is ready on this phone." />
      ) : (
        <ErrorNote>{message || "That link is no longer valid. Log in to continue."}</ErrorNote>
      )}
      <Button
        title={state === "done" ? "Continue" : "Back to log in"}
        variant="primary"
        onPress={onDone}
        style={{ marginTop: space.md }}
      />
    </AuthShell>
  );
}
