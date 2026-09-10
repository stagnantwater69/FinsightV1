import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { suggestEmail } from "../lib/emailSuggestion";
import { Button } from "../components/Button";
import { Field, FormError, TextInput } from "../components/Field";
import { api } from "../lib/api";
import { getErrorMessage, getFieldErrors } from "../lib/errors";
import { isValid, validateRecoverPassword } from "../lib/authValidation";
import { focusFirstInvalidField } from "../lib/formFocus";

export function RecoverPassword() {
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  /** A likely domain typo, offered under the field. Never blocks submission. */
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
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
      focusFirstInvalidField(formRef.current);
      return;
    }
    setEmailError(null);

    setSubmitting(true);
    try {
      // `platform` is still sent because the endpoint's contract takes it, and
      // mobile still uses it for confirmation. The reset email itself no longer
      // carries a link at all — only the code — so nothing here depends on a
      // redirect target any more.
      await api.post("/auth/recover-password", { email, platform: "web" });
      setSent(true);
    } catch (err) {
      const fromServer = getFieldErrors(err);
      setEmailError(fromServer.email ?? null);
      if (fromServer.email) focusFirstInvalidField(formRef.current);
      setError(fromServer.email ? null : getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Recover password"
      subtitle="We'll email you a code to reset it."
      heroTitle="Reset your password."
      heroBody="Enter the email linked to your FinSight account and we'll send a recovery code so you can get back to your records."
    >
      {sent ? (
        /*
         * NOT A DEAD END ANY MORE.
         *
         * This used to say "check your inbox" and stop, because the next step
         * happened in a different place — the mail client, via a link. With a
         * code there is no such handover: the person stays in this tab, so the
         * screen that takes the code should be one press away rather than
         * something they have to find. The address goes with them in router
         * state so they are not asked for it twice.
         *
         * The wording stays non-committal ("if that email is registered") for
         * the same reason the endpoint's answer does: saying "we sent it" would
         * confirm the address exists to anyone who typed one in.
         */
        <div className="space-y-4">
          <p className="text-center text-sm text-ink-600">
            If that email is registered, a recovery code is on its way. Check your inbox.
          </p>
          <Button
            variant="primary"
            fullWidth
            onClick={() => navigate("/auth/reset-password", { state: { email } })}
          >
            Enter the code
          </Button>
        </div>
      ) : (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="email" required error={emailError}>
            <TextInput
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
                // Editing invalidates the previous guess; blur re-evaluates.
                setEmailSuggestion(null);
              }}
              onBlur={(e) => setEmailSuggestion(suggestEmail(e.target.value))}
            />
            {emailSuggestion ? (
              /*
               * Recovery answers identically for an address that does not
               * exist — it has to, or it becomes a way to test which addresses
               * have accounts. So a mistyped domain here is completely silent:
               * the owner is told to check an inbox that will never receive
               * anything. This is the only chance to catch it.
               */
              <p className="mt-1.5 text-xs text-ink-600">
                Did you mean{" "}
                <button
                  type="button"
                  className="font-semibold text-tone-brand underline underline-offset-2 hover:no-underline"
                  onClick={() => {
                    setEmail(emailSuggestion);
                    setEmailSuggestion(null);
                  }}
                >
                  {emailSuggestion}
                </button>
                ?
              </p>
            ) : null}
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
