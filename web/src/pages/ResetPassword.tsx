import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, PasswordInput } from "../components/Field";
import { api } from "../lib/api";
import { createRecoveryClient } from "../lib/supabaseClient";
import { consumeAuthLink, describeAuthLinkError, type AuthLinkTokens } from "../lib/authLinkTokens";
import { getErrorMessage } from "../lib/errors";
import { isValid, validateResetPassword, MIN_PASSWORD_LENGTH, type FieldErrors, type ResetPasswordField } from "../lib/authValidation";

/**
 * The screen the password-reset email actually leads to.
 *
 * Before this existed, "Recover password" ended at "check your inbox" and the
 * link in that inbox went nowhere useful — the reset could be *started* and
 * never *finished*. Worse, because supabase-js reads auth tokens out of the URL
 * by default, the link silently signed its recipient in without changing
 * anything, so the one screen the flow was missing was also the reason the flow
 * was a security problem.
 *
 * THE TOKEN NEVER REACHES OUR SERVER as a password-bearing request. The new
 * password is set directly against Supabase, from here, using a client that
 * does not persist anything (see `createRecoveryClient`). Our backend is told
 * only afterwards, and only so it can end every other session — which the
 * browser cannot do for itself and is often the entire reason someone is
 * resetting.
 */
export function ResetPassword() {
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<AuthLinkTokens | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [form, setForm] = useState({ newPassword: "", confirmPassword: "" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<ResetPasswordField>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  /*
   * Read once, on mount, and never again.
   *
   * `consumeAuthLink` strips the fragment as it reads it, so a second run — a
   * StrictMode double-invoke in development, say — would find nothing and
   * report a broken link on a perfectly good one.
   */
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const result = consumeAuthLink();
    if (result.kind === "tokens") {
      setTokens(result.tokens);
    } else if (result.kind === "error") {
      setLinkError(describeAuthLinkError(result.error));
    } else {
      setLinkError("Open this page from the link in your password-reset email.");
    }
  }, []);

  function update(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
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
        setLinkError("That link has expired. Request a new one below.");
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

  if (linkError) {
    return (
      <AuthLayout
        title="That link didn't work"
        subtitle="Reset links expire, and each one can only be used once."
        heroTitle="Let's try that again."
        heroBody="Password-reset links are deliberately short-lived. Ask for a fresh one and it will arrive in a moment."
      >
        <p className="text-center text-sm text-ink-600">{linkError}</p>
        <div className="mt-6">
          <Button variant="primary" fullWidth onClick={() => navigate("/recover-password")}>
            Send a new reset link
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
