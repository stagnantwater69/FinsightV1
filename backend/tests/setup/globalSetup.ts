import { execSync } from "node:child_process";

// Runs once before the whole suite. Applies the real migration history to the
// throwaway test database, so the schema under test is exactly the schema that
// ships — not a `db push` approximation of it.
export default function globalSetup() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL is not set — is .env.test present?");
  }

  // Hard guard. The integration tests TRUNCATE every table, so pointing this
  // at the Supabase project would destroy real development data. Refuse to run
  // anywhere that isn't an obviously local test database.
  assertLocalTestDatabase("DATABASE_URL", url);

  // `prisma migrate deploy` connects through `directUrl`, so a DIRECT_URL
  // inherited from the operator's shell would send the migration somewhere the
  // DATABASE_URL guard never looked. Both hosted incidents in
  // docs/phase-2/HOSTED-MIGRATION-INCIDENT.md took that path. Hold DIRECT_URL
  // to the same rule, and require it to name the same server and database.
  const directUrl = process.env.DIRECT_URL ?? url;
  assertLocalTestDatabase("DIRECT_URL", directUrl);
  if (databaseIdentity(directUrl) !== databaseIdentity(url)) {
    throw new Error(
      `Refusing to run tests: DIRECT_URL (${redact(directUrl)}) does not name the same database as DATABASE_URL (${redact(url)}).`
    );
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: directUrl },
  });
}

export function assertLocalTestDatabase(name: string, url: string): void {
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
  const namedTest = /finsight_test/.test(url);
  if (!isLocal || !namedTest) {
    throw new Error(
      `Refusing to run tests against ${redact(url)}\n` +
        `The test suite truncates all tables. ${name} must point at a local database named finsight_test.\n` +
        "Run `npm run test:db:up` and make sure .env.test is being loaded."
    );
  }
}

/** host:port/database, ignoring credentials and query parameters. */
export function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}

function redact(url: string): string {
  return url.replace(/:[^:@]*@/, ":****@");
}
