import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { Button, Card, Checkbox, ErrorNote, Field, Screen, T } from "../components/ui";
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
import { brand, ink, radius, space, TAP, typeScale } from "../theme/tokens";

/**
 * Auth screens. Every input uses `minHeight: TAP` rather than a fixed height so
 * the field grows when a user scales their system font up.
 */

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xxl, flexGrow: 1 }}>
          <T variant="titleLg" style={{ textAlign: "center", marginBottom: 4 }}>
            FinSight
          </T>
          <Card>
            <T variant="title" style={{ textAlign: "center" }}>
              {title}
            </T>
            {subtitle ? (
              <T style={{ textAlign: "center", color: ink[500], marginTop: 4, marginBottom: space.md, fontSize: typeScale.bodySm }}>
                {subtitle}
              </T>
            ) : (
              <View style={{ height: space.md }} />
            )}
            {children}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
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
  const passwordRef = useRef<TextInput>(null);

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
      setError(Object.keys(fromServer).length > 0 ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Log in" subtitle="Welcome back.">
      {/*
        The return key walks the form: "next" until the last field, then "done",
        which runs the same submit the button does. `submitBehavior="submit"`
        keeps the keyboard up between fields so it does not flicker closed and
        open again on every hop — it replaces `blurOnSubmit`, which React Native
        0.86 marks deprecated in favour of it.
      */}
      <Field
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
      <Checkbox label="Remember me" checked={saveAccount} onChange={setSaveAccount} />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button title="Log in" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
      <Button
        title="Forgot password?"
        variant="ghost"
        onPress={() => navigation.navigate("RecoverPassword")}
        style={{ marginTop: space.sm }}
      />
      <Button title="Create an account" variant="ghost" onPress={() => navigation.navigate("Register")} />
    </AuthShell>
  );
}

export function RegisterScreen({ navigation }: any) {
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
  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Correcting a marked field clears its mark straight away, rather than
    // making the owner submit again to find out whether they fixed it.
    setFieldErrors((prev) => (prev[k as RegisterField] ? { ...prev, [k]: undefined } : prev));
  };
  const lastNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmPasswordRef = useRef<TextInput>(null);

  async function submit() {
    setError(null);

    const invalid = validateRegister(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
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
    } catch (err) {
      // An address already registered, or a rule this screen let through,
      // lands under its own field; anything else stays form-level.
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
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
      <AuthShell title="Check your email" subtitle="One more step.">
        <View style={{ backgroundColor: brand[50], borderRadius: radius.md, padding: space.md }}>
          <T style={{ color: brand[900], fontSize: typeScale.bodySm }}>{acknowledgement}</T>
        </View>
        <T style={{ color: ink[500], fontSize: typeScale.bodySm, marginTop: space.md }}>
          Open the link on this phone and it will bring you straight back here. Nothing is active until you do.
        </T>
        <Button
          title="Back to log in"
          variant="primary"
          onPress={() => navigation.navigate("Login")}
          style={{ marginTop: space.md }}
        />
        <Button
          title={resent ? "Link sent — check your inbox" : resending ? "Sending…" : "Didn't arrive? Send it again"}
          variant="ghost"
          disabled={resending || resent}
          onPress={resend}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Start tracking your business in a few minutes.">
      <Field
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
      <Button title="I already have an account" variant="ghost" onPress={() => navigation.navigate("Login")} />
    </AuthShell>
  );
}

export function RecoverPasswordScreen({ navigation }: any) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setSent(true);
    } catch (err) {
      const fromServer = getFieldErrors(err);
      setEmailError(fromServer.email ?? null);
      setError(fromServer.email ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to set a new one.">
      {sent ? (
        <View style={{ backgroundColor: brand[50], borderRadius: radius.md, padding: space.md }}>
          {/*
            "Open the link" rather than the old "come back and log in".
            That instruction was wrong: it told owners to return and sign in
            with a password that had not been changed and could not be, because
            the link went nowhere. The link is now the step that matters — it
            opens the app on the screen where the new password is set.
          */}
          <T style={{ color: brand[900], fontSize: typeScale.bodySm }}>
            If that email is registered, a reset link is on its way. Open it on this phone and we'll bring you straight
            to the screen where you set a new password.
          </T>
        </View>
      ) : (
        <>
          <Field
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
  const confirmRef = useRef<TextInput>(null);

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
      <AuthShell title="Password changed" subtitle="You're all set.">
        <View style={{ backgroundColor: brand[50], borderRadius: radius.md, padding: space.md }}>
          <T style={{ color: brand[900], fontSize: typeScale.bodySm }}>
            Your password has been changed, and every device that was signed in has been signed out. Log in with your
            new password to continue.
          </T>
        </View>
        <Button title="Log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new password" subtitle={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
      <Field
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
        <View style={{ backgroundColor: brand[50], borderRadius: radius.md, padding: space.md }}>
          <T style={{ color: brand[900], fontSize: typeScale.bodySm }}>{message}</T>
        </View>
      ) : (
        <ErrorNote>{message}</ErrorNote>
      )}
      <Button title="Log in" variant="primary" onPress={onDone} style={{ marginTop: space.md }} />
    </AuthShell>
  );
}
