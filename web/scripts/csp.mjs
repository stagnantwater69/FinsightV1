// The Content-Security-Policy the production edge sends with the web app.
//
// WHY ONE MATTERS HERE: supabase-js keeps the signed-in session in
// localStorage, which any script on the page can read. Without a policy, a
// single injected script is a stolen session and every financial record in
// the account. With one, a script can only run if it came from this origin
// or is one of the two inline theme-boot scripts in index.html, allowed by
// the hash of its exact contents.
//
// Built from the production build itself: the hashes from dist/index.html,
// and the only outside origins the app talks to from the Vite env the build
// used (Supabase for auth, data and images; Sentry when configured).

import { createHash } from "node:crypto";

/** sha256 of every inline <script> (no src), as CSP source expressions. */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${createHash("sha256").update(match[1], "utf8").digest("base64")}'`);
  }
  return hashes;
}

function originOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function buildCsp({ html, supabaseUrl, sentryDsn }) {
  const supabase = originOf(supabaseUrl);
  if (!supabase) throw new Error("VITE_SUPABASE_URL must be an https URL to build the CSP");
  const realtime = supabase.replace(/^https:/, "wss:");
  // The DSN's host (o123.ingest.sentry.io) is where reports are posted.
  const sentry = originOf(sentryDsn);

  const directives = [
    ["default-src", "'self'"],
    ["script-src", "'self'", ...inlineScriptHashes(html)],
    // React and the chart library set style attributes; styles cannot run code.
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", supabase],
    ["font-src", "'self'", "data:"],
    ["connect-src", "'self'", supabase, realtime, ...(sentry ? [sentry] : [])],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  // A blocked script is either an attack or a deploy that broke the app, and
  // both should reach someone rather than fail silently in a visitor's console.
  const reportUri = sentrySecurityEndpoint(sentryDsn);
  if (reportUri) directives.push(["report-uri", reportUri]);
  return directives.map((parts) => parts.join(" ")).join("; ");
}

/**
 * Sentry's CSP-report endpoint for a DSN: https://KEY@HOST/PROJECT becomes
 * https://HOST/api/PROJECT/security/?sentry_key=KEY. The key is the public
 * one the browser SDK already ships.
 */
export function sentrySecurityEndpoint(dsn) {
  if (!dsn) return null;
  try {
    const parsed = new URL(dsn);
    const project = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (parsed.protocol !== "https:" || !parsed.username || !/^\d+$/.test(project)) return null;
    return `${parsed.origin}/api/${project}/security/?sentry_key=${encodeURIComponent(parsed.username)}`;
  } catch {
    return null;
  }
}

/** An nginx snippet the edge includes; the policy has single quotes only. */
export function nginxSnippet(csp) {
  if (csp.includes('"') || csp.includes("\n")) throw new Error("unexpected character in CSP");
  return `set $finsight_csp "${csp}";\n`;
}
