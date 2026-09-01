import { useCallback, useEffect, useRef, useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { Button, Card, Checkbox, ErrorNote, Field, Screen, T } from "../components/ui";
import { Mascot, mascotSource, type MascotState } from "../components/MascotState";
import { useAuth } from "../context/AuthContext";
import * as haptics from "../lib/haptics";
import { api, errorMessage, getFieldErrors } from "../lib/api";
import {
  isValid,
  validateLogin,
  validateRecoverPassword,
  validateRegister,
  validateResetPassword,
  MIN_PASSWORD_LENGTH,
  type FieldErrors,
  type LoginField,
  type RegisterField,
  type ResetPasswordField,
} from "../lib/authValidation";
import { createRecoveryClient } from "../lib/supabase";
import type { AuthLinkTokens } from "../lib/authLinkTokens";
import { isSavingAccount, savedEmail, setSavedAccount } from "../lib/savedAccountStore";
import { font, radius, space, typeScale } from "../theme/tokens";
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

/**
 * The brand moment: one calm logo, the product name, and one line about why
 * the app is worth the form below it.
 *
 * DELIBERATELY SMALL. The plan's rule is that the form stays visually
 * dominant, so this is a small mark and two lines of type — not a hero. The
 * logo is decorative; everything it could say is said by the product name
 * beside it. Auth states with approved scenario art can still opt into it.
 *
 * ONE FOCAL POINT. `AuthShell` renders exactly one illustration, whichever
 * state the screen names, so a screen can never end up with a pose above the
 * card and a second one inside it.
 */
function BrandMoment({ mascot, benefit }: { mascot: MascotState; benefit?: string }) {
  return (
    <View style={{ alignItems: "center", marginBottom: space.md }}>
      {mascot === "brandMark" ? (
        <Image
          source={mascotSource("brandMark")}
          style={{ width: 72, height: 72 }}
          resizeMode="contain"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : (
        <Mascot state={mascot} size={64} plate />
      )}
      <T variant="titleLg" style={{ textAlign: "center", marginTop: space.sm }}>
        FinSight
      </T>
      {benefit ? (
        <T variant="caption" style={{ textAlign: "center", marginTop: 2 }}>
          {benefit}
        </T>
      ) : null}
    </View>
  );
}

function AuthHero({ title, benefit }: { title: string; benefit?: string }) {
  const t = useTheme();
  const foreground = t.mode === "light" ? t.brandHeading : t.onBrandSolid;
  const secondary = t.mode === "light" ? t.textSecondary : t.onBrandSolidMuted;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl }}>
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", inset: 0, overflow: "hidden" }}
      >
        <View
          style={{
            position: "absolute",
            width: 190,
            height: 190,
            borderRadius: 95,
            borderWidth: 1,
            borderColor: t.mode === "light" ? t.brand[300] : t.onBrandSolidMuted,
            opacity: t.mode === "light" ? 0.38 : 0.18,
            top: -80,
            right: -36,
          }}
        />
        <View
          style={{
            position: "absolute",
            width: 84,
            height: 84,
            borderRadius: 42,
            backgroundColor: t.ACCENT.fill,
            opacity: 0.12,
            right: 52,
            bottom: 18,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Image
          source={mascotSource("brandMark")}
          style={{ width: 52, height: 52 }}
          resizeMode="contain"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        <T variant="title" style={{ color: foreground }}>
          FinSight
        </T>
      </View>
      <T
        variant="titleLg"
        style={{ color: foreground, maxWidth: 310, marginTop: space.lg, lineHeight: 34 }}
      >
        {title}
      </T>
      {benefit ? (
        <T style={{ color: secondary, maxWidth: 320, marginTop: space.sm }}>
          {benefit}
        </T>
      ) : null}
    </View>
  );
}

function AuthGradientBackground({ colors }: { colors: readonly [string, string, string] }) {
  return (
    <Svg
      width="100%"
      height="100%"
      style={{ position: "absolute", inset: 0 }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <SvgLinearGradient id="authBackground" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors[0]} />
          <Stop offset="0.44" stopColor={colors[1]} />
          <Stop offset="1" stopColor={colors[2]} />
        </SvgLinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#authBackground)" />
    </Svg>
  );
}

function AuthTextLink({ title, onPress }: { title: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: space.xs,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <T variant="caption" style={{ color: t.brandText, fontFamily: font.sansSemibold }}>
        {title}
      </T>
    </Pressable>
  );
}

function AuthShell({
  title,
  subtitle,
  mascot = "brandMark",
  benefit,
  decorated = false,
  heroTitle,
  switchPrompt,
  switchAction,
  onSwitch,
  children,
}: {
  title: string;
  subtitle?: string;
  mascot?: MascotState;
  benefit?: string;
  decorated?: boolean;
  heroTitle?: string;
  switchPrompt?: string;
  switchAction?: string;
  onSwitch?: () => void;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const { ink } = t;
  const gradientColors =
    t.mode === "light"
      ? (["#cdeee0", "#e8f7f0", "#fbfaf4"] as const)
      : ([t.brandSolid, t.brand[900], t.brand[950]] as const);
  const formContent = (
    <>
      <T accessibilityRole="header" variant="title" style={{ textAlign: "center" }}>
        {title}
      </T>
      {subtitle ? (
        <T
          style={{
            textAlign: "center",
            color: ink[500],
            marginTop: 4,
            marginBottom: space.md,
            fontSize: typeScale.bodySm,
          }}
        >
          {subtitle}
        </T>
      ) : (
        <View style={{ height: space.md }} />
      )}
      {switchPrompt && switchAction && onSwitch ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            marginTop: -space.sm,
            marginBottom: space.sm,
          }}
        >
          <T variant="caption">{switchPrompt}</T>
          <AuthTextLink title={switchAction} onPress={onSwitch} />
        </View>
      ) : null}
      {children}
    </>
  );

  return (
    <Screen
      safeTop
      style={decorated ? { backgroundColor: gradientColors[0] } : undefined}
    >
      {decorated ? <StatusBar style={t.mode === "light" ? "dark" : "light"} /> : null}
      {decorated ? <AuthGradientBackground colors={gradientColors} /> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={
            decorated
              ? { flexGrow: 1 }
              : { padding: space.lg, paddingTop: space.xl, flexGrow: 1 }
          }
          keyboardShouldPersistTaps="handled"
        >
          {decorated ? (
            <>
              <AuthHero title={heroTitle ?? title} benefit={benefit} />
              <View
                style={{
                  flexGrow: 1,
                  backgroundColor: t.surface,
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  padding: space.lg,
                  paddingTop: space.xl,
                }}
              >
                {formContent}
              </View>
            </>
          ) : (
            <>
              <BrandMoment mascot={mascot} benefit={benefit} />
              <Card>{formContent}</Card>
            </>
          )}
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
        padding: space.md,
        alignItems: "center",
        gap: space.sm,
      }}
    >
      {/* Decorative: `body` below states the outcome in words. */}
      <Ionicons name={icon} size={28} color={tint} accessibilityElementsHidden importantForAccessibility="no" />
      <T style={{ color: t.textPrimary, textAlign: "center", fontSize: typeScale.bodySm }}>{body}</T>
      {email ? (
        <T
          style={{ color: t.textPrimary, textAlign: "center", fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}
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
  const { login } = useAuth();
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
      heroTitle="Know where your business stands."
      benefit="Sales, expenses and receipts—clear and together."
      decorated
      switchPrompt="New to FinSight?"
      switchAction="Sign up"
      onSwitch={() => navigation.navigate("Register")}
    >
      {/*
        The return key walks the form: "next" until the last field, then "done",
        which runs the same submit the button does. `submitBehavior="submit"`
        keeps the keyboard up between fields so it does not flicker closed and
        open again on every hop — it replaces `blurOnSubmit`, which React Native
        0.86 marks deprecated in favour of it.
      */}
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
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <Checkbox
            label="Remember me"
            checked={saveAccount}
            onChange={setSaveAccount}
            style={{ marginBottom: 0 }}
          />
        </View>
        <AuthTextLink title="Forgot password?" onPress={() => navigation.navigate("RecoverPassword")} />
      </View>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button title="Log in" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
    </AuthShell>
  );
}

export function RegisterScreen({ navigation }: any) {
  const t = useTheme();
  const { ink } = t;
  const { register } = useAuth();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", confirmPassword: "" });
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
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);
  // Only the fields this form actually renders — RegisterField also names
  // middleName and phoneNumber, which mobile registration does not ask for.
  const fieldOrder = [
    ["firstName", firstNameRef],
    ["lastName", lastNameRef],
    ["email", emailRef],
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
        email: form.email.trim(),
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
        <T style={{ color: ink[500], fontSize: typeScale.bodySm, marginTop: space.md }}>
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
            setAcknowledgement(null);
            setResent(false);
            // The next registration mails a fresh link; the old cooldown was
            // about the old address.
            emailRef.current?.focus();
          }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start tracking your business in a few minutes."
      heroTitle="Build a clearer view of your business."
      benefit="Set up FinSight in a few minutes. Your records stay yours."
      decorated
      switchPrompt="Already have an account?"
      switchAction="Log in"
      onSwitch={() => navigation.navigate("Login")}
    >
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
        placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
        autoComplete="new-password"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmPasswordRef.current?.focus()}
      />
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
      subtitle={sent ? "The link is on its way." : "We'll email you a link to set a new one."}
      // The approved recovery pose — helpful, not playful, and paired with the
      // direct instructions below rather than standing in for them.
      mascot="forgotPassword"
    >
      {sent ? (
        <>
          {/*
            "Open the link" rather than the old "come back and log in".
            That instruction was wrong: it told owners to return and sign in
            with a password that had not been changed and could not be, because
            the link went nowhere. The link is now the step that matters — it
            opens the app on the screen where the new password is set.

            The ADDRESS is shown because this endpoint answers identically for
            a registered address and an unregistered one — deliberately, so it
            cannot be used to discover who has an account — which means a typo
            and a real address produce the same screen. Printing what we sent
            to is the only place that typo is still visible.
          */}
          <SuccessPanel
            icon="mail-unread-outline"
            tone="brand"
            body="If that email is registered, a reset link is on its way to:"
            email={sentTo}
          />
          <T style={{ color: t.textMuted, fontSize: typeScale.bodySm, marginTop: space.md }}>
            Open it on this phone and we'll bring you straight to the screen where you set a new password. The link
            expires, and each one works only once.
          </T>
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
              setSent(false);
              emailRef.current?.focus();
            }}
          />
        </>
      ) : (
        <>
          <Field
            ref={emailRef}
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
          <Button title="Send reset link" onPress={submit} loading={busy} style={{ marginTop: space.sm }} />
        </>
      )}
      <Button title="Back to log in" variant="ghost" onPress={() => navigation.navigate("Login")} />
    </AuthShell>
  );
}

/**
 * The screen the password-reset deep link opens.
 *
 * Before this existed, "Reset your password" ended at "check your inbox" and
 * the link in that inbox had nowhere on the phone to go — the reset could be
 * started and never finished, while the screen cheerfully told the owner to
 * come back and log in with a password that had not changed.
 *
 * THE TOKEN NEVER REACHES OUR SERVER as a password-bearing request. The new
 * password is set directly against Supabase using a client that persists
 * nothing (see `createRecoveryClient`), so it never touches the keystore. The
 * backend is told only afterwards, and only so it can end every other session —
 * which the phone cannot do for itself and is often the entire reason someone
 * is resetting.
 *
 * Rendered by App.tsx over whatever else is on screen, rather than pushed onto
 * the auth stack: the link can arrive while somebody is already signed in, and
 * "set a new password" has to win over whatever they were doing.
 */
export function ResetPasswordScreen({
  tokens,
  linkError,
  onDone,
}: {
  tokens: AuthLinkTokens | null;
  linkError: string | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ResetPasswordField>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
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
        setError("That link has expired. Ask for a new one from the log-in screen.");
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

  if (linkError) {
    return (
      <AuthShell title="That link didn't work" subtitle="Reset links expire, and each works only once.">
        <ErrorNote>{linkError}</ErrorNote>
        <Button title="Back to log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
      </AuthShell>
    );
  }

  if (done) {
    return (
      // The one genuinely security-POSITIVE moment in this file, and the only
      // place the approved reset-success pose belongs: the change has actually
      // been made, not merely requested.
      <AuthShell title="Password changed" subtitle="You're all set." mascot="passwordResetSuccess">
        <SuccessPanel
          icon="shield-checkmark-outline"
          body="Your password has been changed, and every device that was signed in has been signed out. Log in with your new password to continue."
        />
        <Button title="Log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password" subtitle={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
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
        disabled={!tokens}
        style={{ marginTop: space.md }}
      />
      <Button title="Cancel" variant="ghost" onPress={onDone} />
    </AuthShell>
  );
}

/**
 * The screen the registration confirmation deep link opens.
 *
 * Registration no longer hands out a session, so this is the step that turns a
 * pending registration into a usable account. Nothing here establishes a
 * session either: the token goes straight to the backend, which verifies it
 * against Supabase before flipping the account to ACTIVE. A confirmation link
 * forwarded to the wrong person still cannot sign anyone in.
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
  const { ink } = t;
  const [state, setState] = useState<"checking" | "confirmed" | "failed">(linkError ? "failed" : "checking");
  const [message, setMessage] = useState<string>(linkError ?? "");

  useEffect(() => {
    if (!tokens) return;
    let active = true;
    api
      .postWithToken<{ message: string }>("/auth/confirm-email", tokens.accessToken)
      .then((data) => {
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
  }, [tokens]);

  if (state === "checking") {
    return (
      <AuthShell title="Confirming your email">
        <T style={{ textAlign: "center", color: ink[500], fontSize: typeScale.bodySm }}>Just a moment…</T>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={state === "confirmed" ? "Email confirmed" : "That link didn't work"}
      subtitle={state === "confirmed" ? "Your account is ready." : "Confirmation links expire, and each works once."}
    >
      {state === "confirmed" ? (
        <SuccessPanel icon="checkmark-circle-outline" body={message} />
      ) : (
        <ErrorNote>{message}</ErrorNote>
      )}
      <Button title="Log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
    </AuthShell>
  );
}
