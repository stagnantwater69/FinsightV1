import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Checkbox, Field, FormError, PasswordInput, TextInput } from "../components/Field";
import { Callout } from "../components/ui";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import { isSavingAccount, savedEmail, setSavedAccount } from "../lib/savedAccount";
import { isValid, validateLogin, type FieldErrors, type LoginField } from "../lib/authValidation";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionExpired = (location.state as { sessionExpired?: boolean } | null)?.sessionExpired === true;
  // Prefilled from the last saved login. Only ever the address — a password
  // is never stored, whichever way the box is set.
  const [email, setEmail] = useState(savedEmail);
  const [password, setPassword] = useState("");
  const [saveAccount, setSaveAccount] = useState(isSavingAccount);
  const [error, setError] = useState<string | null>(null);
  /**
   * Per-field messages, from this form's own checks or from the server's.
   *
   * Set only on submit, never as you type. Validating a field the moment it
   * is touched marks an email "invalid" while it is still being typed, which
   * is a form arguing with someone who is doing nothing wrong. Once a field
   * HAS been marked, its message clears as soon as it changes — see
   * `clearField`.
   */
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<LoginField>>({});
  const [submitting, setSubmitting] = useState(false);

  const clearField = (field: LoginField) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const invalid = validateLogin({ email, password });
    if (!isValid(invalid)) {
      // Nothing is sent. The round trip would only bring back the same
      // answer, and on a phone tether it is a round trip the owner pays for.
      setFieldErrors(invalid);
      return;
    }
    setFieldErrors({});

    setSubmitting(true);
    try {
      await login({ email, password });
      // Saved only once the address is known to work. Prefilling a login that
      // fails would hand the owner a form that looks right and is not, which
      // is harder to recover from than an empty one.
      setSavedAccount(saveAccount, email);
      navigate("/business-profiles");
    } catch (err) {
      /*
       * The server may reject fields this form let through — an address it
       * parses differently, say. Those land under the fields they belong to;
       * anything else (wrong password, no network) stays a form-level
       * message, because there is no field to put it under.
       */
      const fromServer = getFieldErrors(err);
      setFieldErrors(fromServer);
      if (!isValid(fromServer)) setError(null);
      else setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Account access"
      title="Log in"
      subtitle="Welcome back."
      showBack
      heroBody={
        <>
          An AI-assisted financial monitoring platform that helps small business owners record expenses, track
          sales reference, and understand where their money goes.
        </>
      }
      points={[
        "Manage multiple business profiles in one account",
        "Scan receipts, import CSV, or add records manually",
        "Ask FinSight to explain your insights in plain language",
      ]}
    >
      {sessionExpired ? (
        <div className="mb-4" role="status">
          <Callout tone="warn">Your session expired — please log in again.</Callout>
        </div>
      ) : null}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Email" htmlFor="email" required error={fieldErrors.email}>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearField("email");
            }}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          required
          error={fieldErrors.password}
          labelAction={
            <Link
              to="/recover-password"
              className="tap-inline text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearField("password");
            }}
          />
        </Field>
        <Checkbox label="Remember me" checked={saveAccount} onChange={setSaveAccount} />
        {error ? <FormError>{error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">
        Don't have an account?{" "}
        <Link to="/register" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
          Register
        </Link>
      </p>
    </AuthLayout>
  );
}
