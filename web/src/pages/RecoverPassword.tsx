import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, TextInput } from "../components/Field";
import { api } from "../lib/api";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import { isValid, validateRecoverPassword } from "../lib/authValidation";

export function RecoverPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    /*
      Checked here as much for the OWNER as for the server. This endpoint
      answers identically whether or not the address is registered —
      deliberately, so it cannot be used to discover who has an account —
      which means a typo produces the same "check your inbox" as a real
      address, and the reset that never arrives is unexplainable. Catching a
      malformed address before sending is the only place that typo can still
      be pointed at.
    */
    const invalid = validateRecoverPassword({ email });
    if (!isValid(invalid)) {
      setEmailError(invalid.email ?? null);
      return;
    }
    setEmailError(null);

    setSubmitting(true);
    try {
      // `platform` tells the server which app to point the emailed link at; the
      // address itself comes from configuration there, never from here — a
      // client-supplied redirect would be an open redirect carrying a live
      // reset token.
      await api.post("/auth/recover-password", { email, platform: "web" });
      setSent(true);
    } catch (err) {
      const fromServer = getFieldErrors(err);
      setEmailError(fromServer.email ?? null);
      setError(fromServer.email ? null : getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Recover password"
      subtitle="We'll email you a link to reset it."
      heroTitle="Reset your password."
      heroBody="Enter the email linked to your FinSight account and we'll send a recovery link so you can get back to your records."
    >
      {sent ? (
        <p className="text-center text-sm text-ink-600">
          If that email is registered, a reset link is on its way. Check your inbox.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email" htmlFor="email" required error={emailError}>
            <TextInput
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
            />
          </Field>
          {error ? <FormError>{error}</FormError> : null}
          <Button type="submit" variant="primary" fullWidth disabled={submitting}>
            {submitting ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-ink-500">
        <Link to="/login" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
