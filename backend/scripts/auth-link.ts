/**
 * Print a confirmation or password-reset link WITHOUT sending an email.
 *
 * Why this exists: Supabase's built-in mailer is a development convenience and
 * is capped at a handful of messages per hour (docs/AUTH-CONFIGURATION.md says
 * to move to real SMTP before relying on it). A normal testing session — a few
 * registrations, a couple of password resets — exhausts that cap in minutes,
 * and every send after it fails with `429: email rate limit exceeded`. The
 * failure is deliberately quiet at the API surface, because registration and
 * recovery must answer identically whether or not an address exists, so from
 * the app it looks exactly like "Gmail stopped delivering".
 *
 * `auth.admin.generateLink` mints the SAME one-time token the email would have
 * carried and hands it back instead of mailing it. No message is sent, so no
 * quota is consumed and the local loop is not rate-limited at all.
 *
 * Usage (from backend/):
 *   npx tsx scripts/auth-link.ts signup   someone@example.com
 *   npx tsx scripts/auth-link.ts recovery someone@example.com
 *
 * Open the printed URL in the browser you are testing in. The link still obeys
 * the real expiry and is still single-use, so it exercises the genuine flow —
 * this bypasses DELIVERY, not verification.
 *
 * DEVELOPMENT ONLY. It uses the service-role key and will happily mint a
 * password-reset link for any address in the project, so it refuses to run
 * against a non-local WEB_APP_URL rather than becoming a way to take over an
 * account on a deployed environment.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type LinkType = "signup" | "recovery";

const USAGE = `Usage: npx tsx scripts/auth-link.ts <signup|recovery> <email>`;

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const [, , rawType, email] = process.argv;

if (!rawType || !email) fail(USAGE);
if (rawType !== "signup" && rawType !== "recovery") {
  fail(`Unknown link type "${rawType}".\n  ${USAGE}`);
}
const type: LinkType = rawType;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEB_APP_URL } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — run this from backend/ so .env loads.");
}

const webAppUrl = WEB_APP_URL ?? "http://localhost:5173";

/*
 * The safety gate. A service-role recovery link is a full account takeover for
 * whatever address is passed, so this stays pinned to a machine-local target:
 * loopback, or a private-range LAN address (the cross-device dev setup in
 * docs/AUTH-CONFIGURATION.md). Anything else — a real host, a tunnel — is a
 * deployed environment as far as this script is concerned.
 */
const host = new URL(webAppUrl).hostname;
const isLocal =
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);

if (!isLocal) {
  fail(
    `Refusing to run: WEB_APP_URL is ${webAppUrl}, which is not a local address.\n` +
      `  This mints a working one-time auth token for any address using the service-role key.`,
  );
}

/*
 * The redirect must match what the app would have asked for, and — like every
 * other auth redirect — it has to be on the dashboard's Redirect URLs
 * allow-list or Supabase silently swaps it for the Site URL. That substitution
 * is what makes a link open the wrong port; see AUTH-CONFIGURATION.md.
 */
const redirectTo = `${webAppUrl.replace(/\/+$/, "")}/${
  type === "signup" ? "auth/confirm" : "auth/reset-password"
}`;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/*
 * `signup` needs a password because it CREATES the pending user, the way the
 * register endpoint does. If the address already exists it will error — use
 * `recovery` for an account that is already registered.
 *
 * Wrapped in a main() rather than using top-level await: this project's tsx
 * transform emits CJS, which does not support it.
 */
async function main() {
  const { data, error } = await admin.auth.admin.generateLink(
    type === "signup"
      ? { type: "signup", email, password: `Dev-${crypto.randomUUID()}`, options: { redirectTo } }
      : { type: "recovery", email, options: { redirectTo } },
  );

  if (error) fail(`Supabase refused: ${error.message}`);

  const link = data?.properties?.action_link;
  if (!link) fail("Supabase returned no action_link.");

  console.log(`\n  ${type} link for ${email}\n  (no email sent — no rate limit consumed)\n`);
  console.log(`  ${link}\n`);

  /*
   * Make the silent substitution loud.
   *
   * Supabase does not reject a `redirectTo` that is missing from the
   * dashboard's Redirect URLs allow-list — it quietly swaps in the Site URL
   * and returns success. The only visible symptom is that the link opens the
   * wrong origin, which reads as an app bug and sends people looking in the
   * code, where nothing is wrong. The generated link carries the substituted
   * value, so it can be compared against what was actually asked for.
   */
  const granted = new URL(link).searchParams.get("redirect_to");
  if (granted && granted.replace(/\/+$/, "") !== redirectTo.replace(/\/+$/, "")) {
    console.log(`  ⚠ Supabase REPLACED the redirect.`);
    console.log(`      asked for: ${redirectTo}`);
    console.log(`      you get:   ${granted}`);
    console.log(`    That means "${redirectTo}" is not on the dashboard's`);
    console.log(`    Redirect URLs allow-list, so Supabase fell back to the Site URL.`);
    console.log(`    Add it under Authentication → URL Configuration.`);
    console.log(`    Following this link as-is will open ${granted}, not the app.\n`);
  } else {
    console.log(`  redirect target: ${redirectTo} (honoured)`);
  }
  console.log(`  This link is single-use and still expires normally.\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
