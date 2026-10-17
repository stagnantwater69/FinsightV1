import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthLayout } from "../components/AuthLayout";
import { ButtonLink } from "../components/Button";
import { FormError } from "../components/Field";
import { useAuth } from "../context/AuthContext";
import { createGoogleAuthClient, disposeIsolatedAuthClient } from "../lib/supabaseClient";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { Profile } from "../lib/types";

export function GoogleCallback() {
  const { adoptSession, loading } = useAuth();
  const navigate = useNavigate();
  const consumed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loading || consumed.current) return;
    consumed.current = true;
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code");
    const denied = query.has("error");
    window.history.replaceState(null, "", window.location.pathname);
    if (denied || !code) {
      disposeIsolatedAuthClient(createGoogleAuthClient());
      setError("Google sign-in wasn't completed. You can try again from the login page.");
      return;
    }
    const client = createGoogleAuthClient();
    void (async () => {
      let approvedForApp = false;
      try {
        const { data, error: exchangeError } = await client.auth.exchangeCodeForSession(code);
        if (exchangeError || !data.session) {
          throw new Error("This Google sign-in has expired or couldn't be verified. Please try again.");
        }
        const session = data.session;
        const { data: approved } = await api.post<{ profile: Profile; needsOnboarding: boolean }>(
          "/auth/google", null, { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        await adoptSession({
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          profile: approved.profile,
        });
        approvedForApp = true;
        navigate(approved.needsOnboarding ? "/onboarding" : "/business-profiles", { replace: true });
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        if (!approvedForApp) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
        disposeIsolatedAuthClient(client);
      }
    })();
  }, [loading, adoptSession, navigate]);
  return (
    <AuthLayout title={error ? "Google sign-in didn't finish" : "Signing in with Google"}
      subtitle={error ? "Try again or use your email and password." : "Checking your account…"}>
      {error ? <div className="space-y-4"><FormError>{error}</FormError>
        <ButtonLink to="/login" variant="primary" fullWidth>Back to log in</ButtonLink></div>
        : <p className="text-sm text-ink-600" role="status">Please keep this page open while we finish signing you in.</p>}
    </AuthLayout>
  );
}
