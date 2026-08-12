import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

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
  });
}
