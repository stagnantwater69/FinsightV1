import { useState } from "react";
import { Button } from "./Button";
import { FormError } from "./Field";
import { createGoogleAuthClient } from "../lib/supabaseClient";

export function GoogleSignInButton({ disabled = false, placement = "before-email" }: {
  disabled?: boolean;
  placement?: "before-email" | "after-email";
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    if (starting || disabled) return;
    setStarting(true);
    setError(null);
    try {
      const { data, error: oauthError } = await createGoogleAuthClient().auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/google/callback`,
          skipBrowserRedirect: true,
          queryParams: { prompt: "select_account" },
        },
      });
      if (oauthError || !data.url) throw new Error("Could not start Google sign-in");
      window.location.assign(data.url);
    } catch {
      setError("Google sign-in couldn't start. Try again, or use your email and password.");
      setStarting(false);
    }
  }
  const divider = (
    <div className="flex items-center gap-3 text-xs text-ink-500" aria-hidden="true">
      <span className="h-px flex-1 bg-ink-200" />
      {placement === "after-email" ? "or" : "or use email"}
      <span className="h-px flex-1 bg-ink-200" />
    </div>
  );
  return (
    <div className={`${placement === "after-email" ? "mt-5" : "mb-5"} space-y-3`}>
      {placement === "after-email" ? divider : null}
      <Button type="button" variant="secondary" fullWidth disabled={disabled || starting} onClick={() => void start()}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c1.9-1.7 2.9-4.2 2.9-7.4Z" />
          <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3v2.6A10 10 0 0 0 12 22Z" />
          <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3a10 10 0 0 0 0 9l3.4-2.6Z" />
          <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.6C7.2 7.7 9.4 5.9 12 5.9Z" />
        </svg>
        {starting ? "Opening Google…" : "Continue with Google"}
      </Button>
      {error ? <FormError>{error}</FormError> : null}
      {placement === "before-email" ? divider : null}
    </div>
  );
}
