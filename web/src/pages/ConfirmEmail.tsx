import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, TextInput } from "../components/Field";
import { api } from "../lib/api";
import { consumeAuthLink, describeAuthLinkError } from "../lib/authLinkTokens";
import { getErrorMessage } from "../lib/errors";
import { isPlausibleEmail } from "../lib/authValidation";

type State = "checking" | "confirmed" | "failed";

/**
 * Where the registration confirmation email lands.
 *
 * Registration no longer hands out a session — an account exists only once its
 * address has been proved — so this screen is the step that turns a pending
 * registration into a usable account. It is deliberately a dead end that offers
 * exactly two ways out: log in, or send another link.
 *
 * The token is used once, here, and never stored: it is passed straight to the
 * backend, which verifies it against Supabase before flipping the account to
 * ACTIVE. Nothing on this page establishes a session, so a confirmation link
 * forwarded to the wrong person still cannot sign anyone in.
 */
export function ConfirmEmail() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState<string>("");
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // Once only: consumeAuthLink strips the fragment as it reads it, so a second
  // pass would fail a link that was fine.
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const result = consumeAuthLink();
    if (result.kind === "error") {
      setState("failed");
      setMessage(describeAuthLinkError(result.error));
      return;
    }
    if (result.kind === "none") {
      setState("failed");
      setMessage("Open this page from the link in your confirmation email.");
      return;
    }

    api
      .post<{ message: string }>("/auth/confirm-email", null, {
        headers: { Authorization: `Bearer ${result.tokens.accessToken}` },
      })
      .then(({ data }) => {
        setState("confirmed");
        setMessage(data.message);
      })
      .catch((err) => {
        setState("failed");
        setMessage(getErrorMessage(err));
      });
  }, []);

  async function resend() {
    setResendError(null);
    if (!isPlausibleEmail(email)) {
      setResendError("Enter the email address you registered with.");
      return;
    }
    setResending(true);
    try {
      await api.post("/auth/resend-verification", { email, platform: "web" });
      setResent(true);
    } catch (err) {
      setResendError(getErrorMessage(err));
    } finally {
      setResending(false);
    }
  }

  if (state === "checking") {
    return (
      <AuthLayout title="Confirming your email" heroTitle="One moment." heroBody="We're checking your confirmation link.">
        <p className="text-center text-sm text-ink-600">Just a moment…</p>
      </AuthLayout>
    );
  }

  if (state === "confirmed") {
    return (
      <AuthLayout
        title="Email confirmed"
        subtitle="Your account is ready."
        heroTitle="You're in."
        heroBody="Your address is confirmed and your FinSight account is active. Log in to set up your first business."
      >
        <p className="text-center text-sm text-ink-600">{message}</p>
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
      title="That link didn't work"
      subtitle="Confirmation links expire, and each one works only once."
      heroTitle="Let's send another."
      heroBody="Confirmation links are short-lived on purpose. Enter the address you registered with and we'll send a fresh one."
    >
      <p className="text-center text-sm text-ink-600">{message}</p>
      {resent ? (
        <p className="mt-6 text-center text-sm text-ink-600">
          If that address is waiting to be confirmed, a new link is on its way. Check your inbox.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <Field label="Email" htmlFor="email" required error={resendError}>
            <TextInput
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setResendError(null);
              }}
            />
          </Field>
          {resendError ? <FormError>{resendError}</FormError> : null}
          <Button variant="primary" fullWidth disabled={resending} onClick={() => void resend()}>
            {resending ? "Sending…" : "Send a new link"}
          </Button>
        </div>
      )}
      <p className="mt-6 text-center text-sm text-ink-500">
        <Link to="/login" className="tap-inline font-medium text-brand-700 hover:text-brand-800">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  );
}
