import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Per-request ceiling on every Supabase call (Auth, Storage, PostgREST).
 *
 * WHY A NUMBER AT ALL. supabase-js hands the platform fetch straight through,
 * and undici's default is ~300s of silence before it gives up. The durable
 * worker runs one job per pass, so a single stalled Storage read froze the
 * receipt, purge, CSV, analysis and account-deletion queues together for five
 * minutes — with the receipt heartbeat still beating, so nothing reclaimed the
 * lease either.
 *
 * WHY 60 SECONDS. The largest object this backend moves is a 10 MiB receipt
 * (RECEIPT_UPLOAD_MAX_OBJECT_BYTES); CSV uploads are capped at 5 MiB. 60s for
 * 10 MiB is ~1.4 Mbit/s of sustained throughput — an order of magnitude below
 * what server-to-Supabase transfers actually get, so a legitimate large
 * download has ample headroom and only a genuinely degraded connection hits
 * it. It is also half the 120s processing lease (RECEIPT_PROCESSING_LEASE_MS,
 * CSV_LEASE_MS), so a stalled call fails and the attempt is retried within one
 * lease period rather than outliving it.
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * A fetch bounded by `timeoutMs`.
 *
 * The timeout fires as an abort on the in-flight request, which supabase-js
 * already treats as a transport failure: storage-js wraps it in a
 * StorageUnknownError returned as `{ error }`, and auth-js likewise. Callers
 * see the same shape they handle for any other network failure, so this adds
 * no new crash path. The message is rewritten only so the log says which
 * ceiling was hit instead of a bare "The operation was aborted".
 *
 * Parameterised rather than hard-coded so a test can exercise the abort path
 * without waiting a real minute for it.
 */
export function createBoundedFetch(timeoutMs: number) {
  return function boundedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    // Composed rather than replaced: some supabase-js calls pass their own
    // signal, and dropping it would silently disable the caller's cancellation.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal }).catch((error: unknown) => {
      // Only the deadline is relabelled; a caller's own abort keeps its error.
      if (timeout.aborted) {
        throw new Error(`Supabase request exceeded ${timeoutMs}ms and was aborted`);
      }
      throw error;
    });
  };
}

const fetchWithTimeout = createBoundedFetch(SUPABASE_REQUEST_TIMEOUT_MS);

// Service-role client — backend-only, never expose this key to a client.
// Used for privileged Auth admin calls (create/delete user), Storage
// uploads, and verifying access tokens sent by the web/mobile clients.
//
// ⚠ NEVER call supabaseAdmin.auth.signInWithPassword() (or any other
// non-admin sign-in method) on this client. Doing so stores that user's
// session on the client instance, after which supabase-js sends the
// user's `authenticated`-role JWT as the Authorization header on every
// subsequent Storage/PostgREST request instead of the service-role key —
// and RLS then rejects those requests with a 403 "new row violates
// row-level security policy". `persistSession: false` does NOT prevent
// this; it only stops the session being written to durable storage, not
// from being held in memory.
//
// This was the true cause of the long-standing "intermittent Storage RLS
// failure under concurrent load". It was never load-related and never a
// Supabase-side hiccup: uploads failed if and only if some login,
// registration, or password change had already run in the same server
// process, and kept failing until the process restarted. Use
// createPasswordAuthClient() for anything that signs a user in.
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: { fetch: fetchWithTimeout },
});

// A throwaway client for password sign-in, so the session it picks up dies
// with it instead of contaminating supabaseAdmin. One per call rather than
// one shared instance: concurrent logins would otherwise overwrite each
// other's session on a shared client. createClient does no I/O, so this is
// cheap.
export function createPasswordAuthClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: fetchWithTimeout },
  });
}

/**
 * A throwaway client on the ANON key, for sign-up.
 *
 * WHY NOT THE ADMIN API, which registration used to use. `admin.createUser()`
 * writes a user straight into the auth schema, bypassing GoTrue's own signup
 * path — and with it the confirmation email, the project's email-confirmation
 * setting, and the "this address already exists" handling that GoTrue does
 * without disclosing the fact. Registration therefore had to force
 * `email_confirm: true`, because nothing else was ever going to send the
 * confirmation. That is the single reason an unowned address could become a
 * working account.
 *
 * Going through `signUp` on the anon key puts GoTrue back in charge of all of
 * it. The service-role key would defeat the point: privileged keys skip the
 * very checks being asked for here.
 */
export function createAnonAuthClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: fetchWithTimeout },
  });
}
