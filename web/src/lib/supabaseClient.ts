import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy web/.env.example to web/.env and fill in your Supabase project values."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    /*
     * OFF, and this is a security control rather than a preference.
     *
     * supabase-js defaults this to true in a browser: it reads any auth tokens
     * out of the URL fragment on load and installs them as the stored session.
     * A password-reset email carries exactly such a fragment. With the default,
     * clicking "reset my password" silently signed the recipient in — no
     * password required, nothing reset — and because api.ts takes its bearer
     * token from `supabase.auth.getSession()`, that session was a fully
     * authorised one against every financial record in the account. The
     * recovery email was, in effect, a permanent passwordless login.
     *
     * Recovery links are now handled deliberately and in one place: see
     * `createRecoveryClient` below and pages/ResetPassword.tsx. That client
     * never writes to storage, so a recovery token cannot become a session.
     */
    detectSessionInUrl: false,
  },
});

/**
 * A throwaway client for the password-reset screen, and nowhere else.
 *
 * The recovery token in a reset link is a real credential — enough to change
 * the password on the account. It must be usable for that one operation and
 * then be gone. So this client:
 *
 *   - does NOT persist: the token never reaches localStorage, so an abandoned
 *     reset tab leaves nothing behind and the main client's session (if the
 *     visitor was already signed in as someone else) is untouched;
 *   - does NOT auto-refresh: it exists for a single `updateUser` call;
 *   - uses its own `storageKey` as belt-and-braces, so even a future change to
 *     the two options above cannot have it overwrite the app's real session.
 */
export function createRecoveryClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      detectSessionInUrl: false,
      persistSession: false,
      autoRefreshToken: false,
      storageKey: "finsight-recovery-ephemeral",
    },
  });
}
