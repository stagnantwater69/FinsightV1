import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, PasswordInput, TextInput } from "../components/Field";
import { api } from "../lib/api";
import { createRecoveryClient } from "../lib/supabaseClient";
import { getErrorMessage } from "../lib/errors";
import {
  isValid,
  normaliseRecoveryCode,
  validateRecoveryCode,
  validateResetPassword,
  MAX_RECOVERY_CODE_LENGTH,
  MIN_PASSWORD_LENGTH,
  type FieldErrors,
  type RecoveryCodeField,
  type ResetPasswordField,
} from "../lib/authValidation";

/**
 * Where a password reset is finished — by CODE, and only by code.
 *
 * WHY THERE IS NO LONGER A LINK. The reset email used to carry a button, and
 * the button was the problem: it has to survive an in-app mail viewer, a
 * desktop client with no browser handoff, a phone reading an inbox for an
 * account it is not signed into, and a redirect allow-list in a dashboard this
 * repository cannot see. Every one of those failed in practice, and each one
 * failed as a dead end rather than as an error anyone could act on. The email
 * now carries GoTrue's recovery OTP ({{ .Token }}) and nothing else, so there
 * is exactly one road and it is the one that works from any device, including
 * the one that cannot open this site at all.
 *
 * IT IS ALSO THE SAFER SHAPE, which was not the reason but is worth stating: a
 * link puts a live credential in a URL, where it survives in browser history,
 * in a screenshot and in the `Referer` of the next request. A typed code is
 * never written anywhere. The old link path is gone from here entirely —
 * `consumeAuthLink` is still used by email CONFIRMATION, which keeps its link.
 *
 * THE CODE NEVER REACHES OUR SERVER. It is exchanged with Supabase directly for
 * a session (`verifyOtp`), on a client that persists nothing (see
 * `createRecoveryClient`), and the new password is set against that. Our
 * backend is told only afterwards, and only so it can end every OTHER session —
 * which the browser cannot do for itself, and is often the entire reason
 * somebody is resetting.
 */
export function ResetPassword() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { email?: string } };
  /**
   * The token pair the CODE was exchanged for. Null until then, and null again
   * if it dies under us — which is what puts the code form back on screen.
   */
  const [tokens, setTokens] = useState<{ accessToken: string; refreshToken: string } | null>(null);
  /** Set when a verified code's session expired before the password was saved. */
  const [expired, setExpired] = useState<string | null>(null);
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ResetPasswordField>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // The code path. Held apart from the password form's state because the two
  // are never on screen together, and sharing one `error` would let a failed
  // verification's message survive onto the password step.
  /*
   * The address is carried in router STATE, not in the URL.
   *
   * `/recover-password` already asked for it thirty seconds ago, and making
   * someone retype it to prove they can read their own inbox is friction for
   * nothing. It stays out of the query string because an address in a URL ends
   * up in history and in the `Referer` of the next request — and it is empty
   * whenever this screen is reached directly, which is a normal way in.
   */
  const [codeForm, setCodeForm] = useState({ email: state?.email ?? "", code: "" });
  const [codeFieldErrors, setCodeFieldErrors] = useState<FieldErrors<RecoveryCodeField>>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  function update(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function updateCode(key: keyof typeof codeForm, value: string) {
    setCodeForm((f) => ({ ...f, [key]: value }));
    setCodeFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  /**
   * Exchanges the emailed code for the same token pair a link would have given.
   *
   * On success this sets `tokens` and nothing else: the password form and its
   * whole submit path below are then reached identically to the link route, so
   * there is exactly one implementation of "change the password and end every
   * other session" no matter how the owner got here.
   */
  async function handleVerifyCode(e: FormEvent) {
    e.preventDefault();
    setCodeError(null);

    const invalid = validateRecoveryCode(codeForm);
    if (!isValid(invalid)) {
      setCodeFieldErrors(invalid);
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
       * The person stays on this form either way: a mistyped digit is the most
       * likely cause and retyping it is the fix, which sending them back to the
       * start would not be.
       */
      if (verifyError || !data.session) {
        setCodeError("That didn't work. Check the email address and the code — codes expire, so request a new one if this keeps failing.");
        return;
      }

      setExpired(null);
      setTokens({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      });
      // Nothing keeps the typed code around: it is spent, and the token pair
      // in state is what the next step uses.
      setCodeForm({ email: "", code: "" });
    } catch {
      // Deliberately not `getErrorMessage(err)`: a transport failure here must
      // not become a channel for the distinction the branch above refuses to
      // draw.
      setCodeError("We couldn't check that code just now. Try again in a moment.");
    } finally {
      // The verification client has done its one job; it is signed out on every
      // path, exactly as the link path signs out its own.
      await recovery.auth.signOut({ scope: "local" }).catch(() => undefined);
      setVerifying(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!tokens) return;
    setError(null);

    const invalid = validateResetPassword(form);
    if (!isValid(invalid)) {
      setFieldErrors(invalid);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    const recovery = createRecoveryClient();
    try {
      const { error: sessionError } = await recovery.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (sessionError) {
        /*
         * Clearing the tokens is what puts the code form back on screen: the
         * render below treats "no tokens" as the way in, so leaving a dead pair
         * in state would strand the owner on a password form that can no longer
         * save anything.
         */
        setTokens(null);
        setExpired("That code has expired. Enter a new one, or ask for another email.");
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
       * Deliberately not fatal if it fails: the password IS already changed at
       * this point, and sending the owner back to a form that would now reject
       * their new password — to fix a session they cannot see — would be worse
       * than the stale session it is trying to clear. It is logged server-side
       * either way.
       */
      await api
        .post("/auth/reset-password/complete", null, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        })
        .catch(() => undefined);

      setDone(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      // The recovery session is never wanted again, whichever way this went.
      await recovery.auth.signOut({ scope: "local" }).catch(() => undefined);
      setSubmitting(false);
    }
  }

  /*
   * No verified code yet — which is simply the start of the flow now, not a
   * failure. It is also where an expired code lands, so `expired` sits above
   * the form rather than replacing it: the useful next action in both cases is
   * to type a code, and the only difference is whether we owe an explanation
   * for why the last one did not work.
   */
  if (!tokens && !done) {
    return (
      <AuthLayout
        title="Enter your recovery code"
        subtitle="Use the code from your password-reset email."
        heroTitle="Check your email for the code."
        heroBody="We've sent a numbered code to your inbox. Type it in here and you can set a new password — no link to open, so it works on any device."
      >
        {expired ? <p className="mb-6 text-center text-sm text-ink-600">{expired}</p> : null}
        <form onSubmit={handleVerifyCode} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="recoveryEmail" required error={codeFieldErrors.email}>
            <TextInput
              id="recoveryEmail"
              type="email"
              autoComplete="email"
              value={codeForm.email}
              onChange={(e) => updateCode("email", e.target.value)}
            />
          </Field>
          <Field
            label="Recovery code"
            htmlFor="recoveryCode"
            required
            hint="The numbered code in your password-reset email."
            error={codeFieldErrors.code}
          >
            <TextInput
              id="recoveryCode"
              /*
               * `text` rather than `number`: a code is a string of digits, not
               * a quantity, and `number` brings spinners, scroll-to-change and
               * a browser that will happily eat a leading zero. `inputMode`
               * gets the numeric keypad on a phone without any of that, and
               * `one-time-code` lets the OS offer the code it just saw arrive.
               *
               * `maxLength` is the top of GoTrue's configurable range plus the
               * separators people paste — it exists to stop a runaway paste,
               * not to enforce a length, which `validateRecoveryCode` does
               * after the separators are stripped.
               */
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={MAX_RECOVERY_CODE_LENGTH + 4}
              value={codeForm.code}
              onChange={(e) => updateCode("code", e.target.value)}
            />
          </Field>
          {codeError ? <FormError>{codeError}</FormError> : null}
          <Button type="submit" variant="primary" fullWidth disabled={verifying}>
            {verifying ? "Checking…" : "Continue"}
          </Button>
        </form>
        <div className="mt-4">
          <Button variant="secondary" fullWidth onClick={() => navigate("/recover-password")}>
            Send another code
          </Button>
        </div>
        <p className="mt-6 text-center text-sm text-ink-500">
          <Link to="/login" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
            Back to log in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title="Password changed"
        subtitle="You're all set."
        heroTitle="Done."
        heroBody="Your new password is active, and anything that was signed in to your account has been signed out."
      >
        <p className="text-center text-sm text-ink-600">
          Your password has been changed and every device that was signed in has been signed out. Log in with your new
          password to continue.
        </p>
        <div className="mt-6">
          <Button variant="primary" fullWidth onClick={() => navigate("/login")}>
            Log in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      heroTitle="Choose a new password."
      heroBody="Pick something long that you'll remember. A short phrase beats a short scramble, and a password manager beats both."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="New password" htmlFor="newPassword" required error={fieldErrors.newPassword}>
          <PasswordInput
            id="newPassword"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => update("newPassword", e.target.value)}
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword" required error={fieldErrors.confirmPassword}>
          <PasswordInput
            id="confirmPassword"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) => update("confirmPassword", e.target.value)}
          />
        </Field>
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting || !tokens}>
          {submitting ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
