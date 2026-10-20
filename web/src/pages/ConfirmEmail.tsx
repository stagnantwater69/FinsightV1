import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "../components/Button";
import { CodeInput, CodeResend } from "../components/CodeInput";
import { Field, FormError, TextInput } from "../components/Field";
import { useAuth } from "../context/AuthContext";
import { createRecoveryClient, disposeIsolatedAuthClient } from "../lib/supabaseClient";
import { useCodeResend } from "../hooks/useCodeResend";
import { api } from "../lib/api";
import { consumeAuthLink, describeAuthLinkError, type AuthLinkTokens } from "../lib/authLinkTokens";
import { getErrorMessage } from "../lib/errors";
import { isPlausibleEmail, isValid, validateRecoverPassword, validateRecoveryCode, normaliseRecoveryCode, type FieldErrors, type RecoveryCodeField } from "../lib/authValidation";
import { focusFirstInvalidField } from "../lib/formFocus";
import { isMobileBrowser } from "../lib/mobileBrowser";
import type { Profile } from "../lib/types";

type State = "checking" | "email" | "code" | "confirmed" | "failed";

/** Long enough for "you're confirmed" to be read, short enough not to be a wait. */
const HANDOFF_TO_APP_DELAY_MS = 900;

/** Codes are verified on an isolated client; backend approval precedes session adoption.
 * Previously issued confirmation links and the mobile handoff remain supported. */
export function ConfirmEmail() {
  const navigate = useNavigate();
  const routeState = useLocation().state as { email?: string; codeSent?: boolean } | null;
  const { adoptSession, profile, loading } = useAuth();
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState<string>("");
  const [email, setEmail] = useState(typeof routeState?.email === "string" ? routeState.email.trim() : "");
  const emailFormRef = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeFieldErrors, setCodeFieldErrors] = useState<FieldErrors<RecoveryCodeField>>({});
  const codeDelivery = useCodeResend("/auth/resend-verification", routeState?.codeSent === true);
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
      if (profile && !routeState?.codeSent) {
        navigate("/dashboard", { replace: true });
        return;
      }
      setState(isPlausibleEmail(email) ? "code" : "email");
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

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (codeDelivery.sending || codeDelivery.remaining > 0) return;
    const invalid = validateRecoverPassword({ email });
    setCodeFieldErrors(invalid);
    if (!isValid(invalid)) {
      focusFirstInvalidField(emailFormRef.current);
      return;
    }
    if (await codeDelivery.resend(email)) {
      setEmail(email.trim());
      setCode("");
      setCodeError(null);
      setState("code");
    }
  }

  function changeEmail() {
    setCode("");
    setCodeFieldErrors({});
    setCodeError(null);
    codeDelivery.clearFeedback();
    setState("email");
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (verifying) return;
    setCodeError(null);
    const invalid = validateRecoveryCode({ email, code });
    setCodeFieldErrors(invalid);
    if (!isValid(invalid)) return;
    setVerifying(true);
    const client = createRecoveryClient();
    let approvedForApp = false;
    try {
      const { data, error: verificationError } = await client.auth.verifyOtp({
        email: email.trim(), token: normaliseRecoveryCode(code), type: "email",
      });
      if (verificationError || !data.session) {
        setCodeError("That code couldn't be verified. Check the address and code, or request a new code if it has expired.");
        return;
      }
      const tokens = data.session;
      const { data: confirmed } = await api.post<{ message: string; profile: Profile; needsOnboarding: boolean }>(
        "/auth/confirm-email", null, { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      await adoptSession({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, profile: confirmed.profile });
      approvedForApp = true;
      linkTokens.current = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, type: "signup" };
      setCode("");
      setDestination(confirmed.needsOnboarding ? "/onboarding" : "/dashboard");
      setMessage(confirmed.message);
      setState("confirmed");
    } catch {
      setCodeError("We couldn't finish confirming your email. Try again, or request another code.");
    } finally {
      if (!approvedForApp) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      disposeIsolatedAuthClient(client);
      setVerifying(false);
    }
  }

  if (state === "code") {
    return (
      <AuthLayout title="Confirm your email" subtitle="Enter the code from your FinSight email."
        heroTitle="One more step." heroBody="Confirm that this inbox belongs to you before accessing your business records.">
        <form onSubmit={verifyCode} className="space-y-4" noValidate>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 text-sm text-ink-600">
              Code for <span className="block break-all font-medium text-ink-900">{email}</span>
            </p>
            <button type="button" disabled={verifying || codeDelivery.sending} onClick={changeEmail}
              className="min-h-tap max-w-full rounded text-sm font-medium text-tone-brand underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
              Change email
            </button>
          </div>
          <div>
            <Field label="Confirmation code" htmlFor="confirmationCode" required error={codeFieldErrors.code}
              hint="Paste or type the numbered code in your email. Each code can be used once.">
              <CodeInput id="confirmationCode" value={code} disabled={verifying || codeDelivery.sending}
                onChange={(event) => { setCode(event.target.value); setCodeFieldErrors((previous) => ({ ...previous, code: undefined })); setCodeError(null); }} />
            </Field>
            <CodeResend remaining={codeDelivery.remaining} sending={codeDelivery.sending} disabled={verifying}
              onResend={() => void codeDelivery.resend(email)} />
            {codeDelivery.message ? <p className="text-sm text-ink-600" role="status">{codeDelivery.message}</p> : null}
            {codeDelivery.error ? <FormError>{codeDelivery.error}</FormError> : null}
          </div>
          {codeError ? <FormError>{codeError}</FormError> : null}
          <Button type="submit" variant="primary" fullWidth disabled={verifying || codeDelivery.sending}>
            {verifying ? "Checking…" : "Confirm email"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-ink-500">Use the newest code. If it hasn't arrived, check your spam folder.</p>
        <p className="mt-6 text-center text-sm"><Link to="/login" className="tap-inline link-action">Back to log in</Link></p>
      </AuthLayout>
    );
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
      title={state === "failed" ? "That link didn't work" : "Confirm your email"}
      subtitle={state === "failed" ? "Confirmation links expire, and each one works only once." : "Enter the email you used to register."}
      heroTitle="Check your inbox."
      heroBody="We'll send a confirmation code to the address you registered with. You'll enter the code on the next screen."
    >
      {state === "failed" ? <p className="mb-6 text-center text-sm text-ink-600">{message}</p> : null}
      <form ref={emailFormRef} onSubmit={sendCode} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="confirmationEmail" required error={codeFieldErrors.email}>
          <TextInput id="confirmationEmail" type="email" autoComplete="email" value={email} disabled={codeDelivery.sending}
            onChange={(event) => {
              setEmail(event.target.value);
              setCodeFieldErrors({});
              codeDelivery.clearFeedback();
            }} />
        </Field>
        {codeDelivery.error ? <FormError>{codeDelivery.error}</FormError> : null}
        <Button type="submit" variant="primary" fullWidth disabled={codeDelivery.sending || codeDelivery.remaining > 0}>
          {codeDelivery.sending ? "Sending…" : codeDelivery.remaining > 0 ? `Resend code in ${codeDelivery.remaining}s` : state === "failed" ? "Send a new code" : "Send confirmation code"}
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
