/**
 * The production Content-Security-Policy (scripts/csp.mjs).
 *
 * The session lives in localStorage, so the policy is what stands between an
 * injected script and every record in the account. Checked against the real
 * index.html: if someone edits an inline theme-boot script, its hash changes,
 * and this proves the build-time hashing picks the new one up rather than the
 * app silently losing its theme in production.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp, inlineScriptHashes, nginxSnippet, sentrySecurityEndpoint } from "../../scripts/csp.mjs";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const SUPABASE = "https://abcd1234.supabase.co";

function directive(csp: string, name: string): string[] {
  const found = csp.split("; ").find((part) => part.startsWith(`${name} `));
  return found ? found.split(" ").slice(1) : [];
}

describe("production CSP", () => {
  it("allows exactly the inline scripts in index.html, by hash", () => {
    const hashes = inlineScriptHashes(indexHtml);
    expect(hashes).toHaveLength(2);
    const firstBody = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";
    const expected = `'sha256-${createHash("sha256").update(firstBody).digest("base64")}'`;
    expect(hashes[0]).toBe(expected);

    const scripts = directive(buildCsp({ html: indexHtml, supabaseUrl: SUPABASE }), "script-src");
    expect(scripts).toEqual(["'self'", ...hashes]);
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("ignores the module script with a src", () => {
    expect(inlineScriptHashes('<script type="module" src="/assets/index.js"></script>')).toEqual([]);
  });

  it("lets the app reach Supabase and nothing else outside its origin", () => {
    const csp = buildCsp({ html: indexHtml, supabaseUrl: `${SUPABASE}/` });
    expect(directive(csp, "connect-src")).toEqual(["'self'", SUPABASE, "wss://abcd1234.supabase.co"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:", "blob:", SUPABASE]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
  });

  it("refuses plain strings at HTML sinks and lets no Trusted Types policy be created", () => {
    const csp = buildCsp({ html: indexHtml, supabaseUrl: SUPABASE });
    expect(directive(csp, "require-trusted-types-for")).toEqual(["'script'"]);
    expect(directive(csp, "trusted-types")).toEqual(["'none'"]);
  });

  it("adds Sentry's ingest host only when a DSN is configured", () => {
    const csp = buildCsp({
      html: indexHtml,
      supabaseUrl: SUPABASE,
      sentryDsn: "https://publickey@o123.ingest.us.sentry.io/456",
    });
    expect(directive(csp, "connect-src")).toContain("https://o123.ingest.us.sentry.io");
    expect(directive(buildCsp({ html: indexHtml, supabaseUrl: SUPABASE }), "connect-src")).toHaveLength(3);
  });

  it("reports violations to Sentry only when a DSN is configured", () => {
    const csp = buildCsp({
      html: indexHtml,
      supabaseUrl: SUPABASE,
      sentryDsn: "https://publickey@o123.ingest.us.sentry.io/456",
    });
    expect(directive(csp, "report-uri")).toEqual([
      "https://o123.ingest.us.sentry.io/api/456/security/?sentry_key=publickey",
    ]);
    expect(directive(buildCsp({ html: indexHtml, supabaseUrl: SUPABASE }), "report-uri")).toEqual([]);
    expect(sentrySecurityEndpoint("not a url")).toBeNull();
    expect(sentrySecurityEndpoint("https://o123.ingest.us.sentry.io/456")).toBeNull();
  });

  it("refuses to build without an https Supabase URL", () => {
    expect(() => buildCsp({ html: indexHtml, supabaseUrl: undefined })).toThrow(/VITE_SUPABASE_URL/);
    expect(() => buildCsp({ html: indexHtml, supabaseUrl: "http://abcd1234.supabase.co" })).toThrow();
  });

  it("renders a one-line nginx variable", () => {
    const snippet = nginxSnippet(buildCsp({ html: indexHtml, supabaseUrl: SUPABASE }));
    expect(snippet.startsWith('set $finsight_csp "default-src \'self\'; ')).toBe(true);
    expect(snippet.trimEnd().endsWith('";')).toBe(true);
    expect(snippet.trim().split("\n")).toHaveLength(1);
  });
});
