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
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
  const namedTest = /finsight_test/.test(url);
  if (!isLocal || !namedTest) {
    throw new Error(
      `Refusing to run tests against ${url.replace(/:[^:@]*@/, ":****@")}\n` +
        "The test suite truncates all tables. DATABASE_URL must point at a local database named finsight_test.\n" +
        "Run `npm run test:db:up` and make sure .env.test is being loaded."
    );
  }

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: process.env.DIRECT_URL ?? url },
  });
}
