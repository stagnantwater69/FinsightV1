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

// Isolated auth operations use memory storage. Only Google's PKCE verifier
// needs to survive navigation, so its key alone may use sessionStorage.
const disposers = new WeakMap<typeof supabase, () => void>();
function createIsolatedClient(storageKey: string, google = false) {
  const memory = new Map<string, string>();
  const verifierKey = `${storageKey}-code-verifier`;
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      detectSessionInUrl: false,
      autoRefreshToken: false,
      flowType: google ? "pkce" : "implicit",
      // Supabase accepts custom storage only with persistSession enabled.
      // The adapter persists no session credentials to browser storage.
      persistSession: true,
      storageKey,
      storage: {
        getItem: (key) => google && key === verifierKey ? sessionStorage.getItem(key) : memory.get(key) ?? null,
        setItem: (key, value) => {
          if (google && key === verifierKey) sessionStorage.setItem(key, value);
          else memory.set(key, value);
        },
        removeItem: (key) => {
          if (google && key === verifierKey) sessionStorage.removeItem(key);
          else memory.delete(key);
        },
      },
    },
  });
  disposers.set(client, () => {
    memory.clear();
    if (google) sessionStorage.removeItem(verifierKey);
  });
  return client;
}

export function createRecoveryClient() {
  return createIsolatedClient("finsight-recovery-ephemeral");
}

let googleClient: typeof supabase | undefined;
export function createGoogleAuthClient() {
  googleClient ??= createIsolatedClient("finsight-google-ephemeral", true);
  return googleClient;
}

/** Clear local memory without revoking a session being handed to the main client. */
export function disposeIsolatedAuthClient(client: typeof supabase) {
  disposers.get(client)?.();
  void client.auth.stopAutoRefresh();
}
