import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { CodeInput, CodeResend } from "../components/CodeInput";
import { Field, FormError, PasswordInput } from "../components/Field";
import { api } from "../lib/api";
import { useCodeResend } from "../hooks/useCodeResend";
import { createRecoveryClient, disposeIsolatedAuthClient } from "../lib/supabaseClient";
import { getErrorMessage } from "../lib/errors";
import {
  isValid,
  isPlausibleEmail,
  normaliseRecoveryCode,
  validateRecoveryCode,
  validateResetPassword,
  MIN_PASSWORD_LENGTH,
  type FieldErrors,
  type RecoveryCodeField,
  type ResetPasswordField,
} from "../lib/authValidation";

/** Recovery sessions remain isolated from the app and are used only to change
 * the password. The backend then revokes the account's other refresh sessions. */
export function ResetPassword() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { email?: string; codeSent?: boolean } };
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
  const [completion, setCompletion] = useState<"complete" | "revocation-unconfirmed" | null>(null);

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
  const [codeForm, setCodeForm] = useState({ email: typeof state?.email === "string" ? state.email.trim() : "", code: "" });
  const [codeFieldErrors, setCodeFieldErrors] = useState<FieldErrors<RecoveryCodeField>>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const codeDelivery = useCodeResend("/auth/recover-password", state?.codeSent === true);

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
      setCodeForm((previous) => ({ ...previous, code: "" }));
    } catch {
      // Deliberately not `getErrorMessage(err)`: a transport failure here must
      // not become a channel for the distinction the branch above refuses to
      // draw.
      setCodeError("We couldn't check that code just now. Try again in a moment.");
    } finally {
      // Signing out here would revoke the refresh token needed by the next step.
      disposeIsolatedAuthClient(recovery);
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

      // The password is already active; revocation failure is a completion
      // state, never a reason to submit the password mutation again.
      try {
        const { data } = await api.post<{ message: string; refreshSessionsRevoked: boolean }>(
          "/auth/reset-password/complete",
          null,
          {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
          },
        );
        setCompletion(data.refreshSessionsRevoked ? "complete" : "revocation-unconfirmed");
      } catch {
        setCompletion("revocation-unconfirmed");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      // The recovery session is never wanted again, whichever way this went.
      await recovery.auth.signOut({ scope: "local" }).catch(() => undefined);
      disposeIsolatedAuthClient(recovery);
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
  if (!tokens && !completion) {
    if (!isPlausibleEmail(codeForm.email)) return <Navigate to="/recover-password" replace />;
    return (
      <AuthLayout
        title="Enter your recovery code"
        subtitle="Use the code from your password-reset email."
        heroTitle="Check your email for the code."
        heroBody="Use the numbered code from your password-reset email to set a new password. If it hasn't arrived, check your spam folder or request another code."
      >
        {expired ? <p className="mb-6 text-center text-sm text-ink-600">{expired}</p> : null}
        <form onSubmit={handleVerifyCode} className="space-y-4" noValidate>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 text-sm text-ink-600">
              Code for <span className="block break-all font-medium text-ink-900">{codeForm.email}</span>
            </p>
            <button type="button" disabled={verifying || codeDelivery.sending}
              onClick={() => navigate("/recover-password", { replace: true, state: { email: codeForm.email } })}
              className="min-h-tap max-w-full rounded text-sm font-medium text-tone-brand underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
              Change email
            </button>
          </div>
          <div>
            <Field
              label="Recovery code"
              htmlFor="recoveryCode"
              required
              hint="The numbered code in your password-reset email."
              error={codeFieldErrors.code}
            >
              <CodeInput
                id="recoveryCode"
                disabled={verifying || codeDelivery.sending}
                value={codeForm.code}
                onChange={(e) => updateCode("code", e.target.value)}
              />
            </Field>
            <CodeResend remaining={codeDelivery.remaining} sending={codeDelivery.sending} disabled={verifying}
              onResend={() => void codeDelivery.resend(codeForm.email)} />
            {codeDelivery.message ? <p className="text-sm text-ink-600" role="status">{codeDelivery.message}</p> : null}
            {codeDelivery.error ? <FormError>{codeDelivery.error}</FormError> : null}
          </div>
          {codeError ? <FormError>{codeError}</FormError> : null}
          <Button type="submit" variant="primary" fullWidth disabled={verifying || codeDelivery.sending}>
            {verifying ? "Checking…" : "Continue"}
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-ink-500">
          <Link to="/login" className="tap-inline link-action">
            Back to log in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  if (completion === "complete") {
    return (
      <AuthLayout
        title="Password changed"
        subtitle="You're all set."
        heroTitle="Done."
        heroBody="Your new password is active, and existing sessions cannot be renewed."
      >
        <div role="status" aria-live="polite" aria-atomic="true">
          <p className="text-center text-sm text-ink-600">
            Your password has been changed. Other devices will need to sign in again after their current access expires.
            Log in with your new password to continue.
          </p>
        </div>
        <div className="mt-6">
          <Button variant="primary" fullWidth onClick={() => navigate("/login")}>
            Log in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (completion === "revocation-unconfirmed") {
    return (
      <AuthLayout
        title="Password changed"
        subtitle="One security step remains."
        heroTitle="Your new password is active."
        heroBody="FinSight couldn't confirm that other refresh sessions were revoked."
      >
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <p className="text-center text-sm text-ink-600">
            Log in with your new password, open Profile, go to Security, and choose “Log out on all devices.”
          </p>
        </div>
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
