import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { Field, FormError, TextInput } from "../components/Field";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { consumeAuthLink, describeAuthLinkError, type AuthLinkTokens } from "../lib/authLinkTokens";
import { getErrorMessage } from "../lib/errors";
import { isPlausibleEmail } from "../lib/authValidation";
import { isMobileBrowser } from "../lib/mobileBrowser";
import type { Profile } from "../lib/types";

type State = "checking" | "confirmed" | "failed";

/** Long enough for "you're confirmed" to be read, short enough not to be a wait. */
const HANDOFF_TO_APP_DELAY_MS = 900;

/**
 * Where the registration confirmation email lands.
 *
 * This screen used to be a dead end that said "confirmed — now go and log in",
 * which asked the owner to prove their identity a second time immediately
 * after proving it. The link itself carries a Supabase token pair, and
 * POST /auth/confirm-email verifies that token server-side before flipping the
 * account to ACTIVE — so by the time we have a 200 here, the person holding
 * this tab has demonstrably received mail at that address. That is the same
 * evidence a password would have produced, so we sign them in and send them
 * onward: onboarding if they have no business yet, the dashboard if they do.
 *
 * The token is still never stored by this page and never rendered or logged.
 * It is read once out of the fragment (which `consumeAuthLink` strips as it
 * reads, so nothing lands in history), passed to the backend, and handed to
 * AuthContext's `adoptSession` — which is the only place a session is ever
 * installed. Sign-in follows the SUCCESSFUL backend confirmation; a forwarded
 * or replayed link that the backend rejects signs nobody in.
 */
export function ConfirmEmail() {
  const navigate = useNavigate();
  const { adoptSession, profile, loading } = useAuth();
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState<string>("");
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [destination, setDestination] = useState("/dashboard");
  const [handingOff, setHandingOff] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  /*
   * The link's credentials live in a ref, not in state.
   *
   * They are needed once more after the confirmation — the app handoff trades
   * the refresh token for an opaque code — but they are not something the view
   * derives from, and a re-render must never be able to put them anywhere they
   * could be serialised into a DOM attribute or a devtools state snapshot.
   */
  const linkTokens = useRef<AuthLinkTokens | null>(null);
  // Only offered where the deep link can actually resolve; read once, because
  // the answer cannot change while this tab is open.
  const canOpenApp = useRef(isMobileBrowser());

  // Once only: consumeAuthLink strips the fragment as it reads it, so a second
  // pass would fail a link that was fine.
  const consumed = useRef(false);
  useEffect(() => {
    /*
     * Nothing is decided until the stored session has been read. Someone who
     * clicks the link a second time — from the same mail, on the same phone —
     * arrives with no fragment at all, and the honest answer for them is "you
     * are already in", not "that link didn't work". Acting before `loading`
     * settles would show them the error screen for a session we simply had not
     * looked up yet.
     */
    if (loading) return;
    if (consumed.current) return;
    consumed.current = true;

    const result = consumeAuthLink();
    if (result.kind === "error") {
      setState("failed");
      setMessage(describeAuthLinkError(result.error));
      return;
    }
    if (result.kind === "none") {
      if (profile) {
        navigate("/dashboard", { replace: true });
        return;
      }
      setState("failed");
      setMessage("Open this page from the link in your confirmation email.");
      return;
    }

    const tokens = result.tokens;
    api
      .post<{ message: string; profile: Profile; needsOnboarding: boolean }>("/auth/confirm-email", null, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      })
      .then(async ({ data }) => {
        linkTokens.current = tokens;
        await adoptSession({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          profile: data.profile,
        });
        setDestination(data.needsOnboarding ? "/onboarding" : "/dashboard");
        setState("confirmed");
        setMessage(data.message);
      })
      .catch((err) => {
        setState("failed");
        setMessage(getErrorMessage(err));
      });
    // `adoptSession`/`navigate` are stable for this page's lifetime and the
    // `consumed` guard makes a re-run a no-op regardless; `loading` is the one
    // input that must re-trigger it.
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * On a desktop the success panel is a beat, not a stop: the owner is signed
   * in and there is nothing here for them to do, so it announces itself and
   * moves on. On a phone it WAITS, because that is the one place where a real
   * choice exists — continue here or open the app they installed — and
   * navigating out from under that choice would remove it before it was read.
   */
  useEffect(() => {
    if (state !== "confirmed" || canOpenApp.current) return;
    const timer = setTimeout(() => navigate(destination, { replace: true }), HANDOFF_TO_APP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, destination, navigate]);

  /**
   * Hands this session to the installed app WITHOUT putting it in a URL.
   *
   * A deep link is visible to anything that can see the URL — the OS chooser,
   * the browser's history, other apps registered for the scheme — so the
   * refresh token, which is a long-lived credential, never goes in one. The
   * backend swaps it for an opaque single-use code that expires in two
   * minutes; the code alone is worthless to anyone who cannot also reach our
   * API within that window.
   */
  async function openInApp() {
    const tokens = linkTokens.current;
    if (!tokens) return;
    setHandoffError(null);
    setHandingOff(true);
    try {
      const { data } = await api.post<{ code: string; expiresInSeconds: number }>(
        "/auth/handoff",
        { refreshToken: tokens.refreshToken },
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
      );
      window.location.href = `finsight://auth/handoff?code=${encodeURIComponent(data.code)}`;
    } catch {
      /*
       * Quietly, and deliberately without the server's wording: the owner is
       * already signed in on this page, so a failed handoff costs them one tap
       * rather than access. Anything alarming here would be describing a
       * problem they do not have.
       */
      setHandoffError("We couldn't open the app just now — carry on here instead.");
    } finally {
      setHandingOff(false);
    }
  }

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
        title="You're confirmed"
        /* The desktop branch is already on its way out, so it says so. The
           phone branch is waiting on a choice, so promising movement would be
           a lie — it names the choice instead. */
        subtitle={canOpenApp.current ? "Pick up where you like." : "Taking you in…"}
        heroTitle="You're in."
        heroBody="Your address is confirmed and you're signed in — no need to log in again."
      >
        <p className="text-center text-sm text-ink-600" role="status">
          {message}
        </p>
        <div className="mt-6 space-y-3">
          {canOpenApp.current ? (
            <Button variant="primary" fullWidth disabled={handingOff} onClick={() => void openInApp()}>
              {handingOff ? "Opening…" : "Open in the FinSight app"}
            </Button>
          ) : null}
          <Button
            variant={canOpenApp.current ? "secondary" : "primary"}
            fullWidth
            onClick={() => navigate(destination, { replace: true })}
          >
            Continue on the web
          </Button>
          {handoffError ? <p className="text-center text-sm text-ink-600">{handoffError}</p> : null}
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
