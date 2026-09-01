// Connection-string parsing and target-classification helpers shared by the
// migration-authoring wrapper and the hosted-deployment guard.
//
// Everything in this file is pure (no I/O, no process.env reads, no network)
// so it can be unit tested in isolation and so callers can be certain that
// merely *importing* this module never risks a connection to anything,
// hosted or otherwise.

export interface ParsedTarget {
  /** Normalized host — brackets stripped from IPv6 literals, lowercased. */
  host: string;
  port: string;
  /** Database name with the leading "/" stripped; "" if not present. */
  database: string;
  protocol: string;
}

export interface SanitizedTarget {
  environment: string;
  host: string;
  port: string;
  database: string;
}

export class ConnectionUrlError extends Error {}

/**
 * Parses a Postgres connection string with Node's URL class (never
 * regex/string matching against the raw URL) and returns only the
 * non-secret parts. Throws ConnectionUrlError on anything malformed.
 */
export function parseConnectionUrl(rawUrl: string | undefined | null): ParsedTarget {
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new ConnectionUrlError("Connection string is missing or empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConnectionUrlError("Connection string is not a valid URL.");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new ConnectionUrlError(
      `Unexpected protocol "${parsed.protocol}" — expected postgresql:// or postgres://.`
    );
  }

  if (!parsed.hostname) {
    throw new ConnectionUrlError("Connection string has no host.");
  }

  const host = normalizeHost(parsed.hostname);
  const port = parsed.port || "5432";
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

  return { host, port, database, protocol: parsed.protocol };
}

/**
 * Strips the [] IPv6 bracket syntax the URL class preserves in `.hostname`
 * and lowercases for comparison. "[::1]" -> "::1", "LOCALHOST" -> "localhost".
 */
export function normalizeHost(hostname: string): string {
  const unbracketed =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unbracketed.toLowerCase();
}

/**
 * Exact-match allowlist for local/disposable-database targets. Deliberately
 * NOT a substring/prefix match — "localhost.attacker.example" must fail.
 */
export const LOCAL_ALLOWED_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  // host.docker.internal: how a process running inside a container reaches a
  // container published on the host's loopback interface. Already relied on
  // by tests/setup/globalSetup.ts's own local-target guard.
  "host.docker.internal",
  // The exact container name `npm run test:db:up` creates (see package.json).
  // Reserved for backend integration tests, not migration-authoring scratch
  // space — kept here only because it is a legitimate non-hosted target.
  "finsight-test-db",
];

export function isLocalAllowedHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return LOCAL_ALLOWED_HOSTS.includes(normalized);
}

/** Known hosted-Supabase host shapes, used only to produce a clearer error
 *  message when local mode is pointed at one by mistake — never used to
 *  decide the guard's ALLOW path, only to improve the reject message. */
export function looksLikeHostedSupabaseHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return /\.pooler\.supabase\.com$/.test(normalized) || /^db\.[^.]+\.supabase\.co$/.test(normalized);
}

/**
 * Reduces a parsed target down to the non-secret fields that are safe to
 * log: environment name, host, port, database name. Never the credentials,
 * never the raw URL, never query-string contents (which can carry secrets
 * such as pgbouncer session tokens on some providers).
 */
export function sanitizeTarget(environment: string, parsed: ParsedTarget): SanitizedTarget {
  return {
    environment,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database || "(unspecified)",
  };
}

export function formatSanitizedTarget(target: SanitizedTarget): string {
  return `[${target.environment}] ${target.host}:${target.port}/${target.database}`;
}

export interface EffectiveUrlResult {
  url: string;
  source: "DIRECT_URL" | "DATABASE_URL";
}

/**
 * Resolves the effective migration target. Prisma's `directUrl` datasource
 * setting (prisma/schema.prisma) is what migration commands actually use
 * against a pooled connection, so DIRECT_URL always wins over DATABASE_URL
 * when both are present and differ — this function never falls back to
 * DATABASE_URL unless DIRECT_URL is entirely absent.
 */
export function resolveEffectiveUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined>): EffectiveUrlResult {
  const direct = env.DIRECT_URL;
  if (direct && direct.trim() !== "") {
    return { url: direct, source: "DIRECT_URL" };
  }
  const database = env.DATABASE_URL;
  if (database && database.trim() !== "") {
    return { url: database, source: "DATABASE_URL" };
  }
  throw new ConnectionUrlError(
    "Neither DIRECT_URL nor DATABASE_URL is set. Refusing to resolve a migration target."
  );
}
