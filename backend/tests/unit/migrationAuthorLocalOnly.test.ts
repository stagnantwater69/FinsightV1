import { describe, expect, it } from "vitest";
import { assertLocalTarget, parseAuthorArgs } from "../../scripts/migrate-workflow/author";

// No combination of local-mode flags can reach a hosted target: every URL
// the authoring wrapper would ever actually use is run through
// assertLocalTarget(), which is an exact-hostname allowlist check with no
// escape hatch (no "--force", no "--allow-hosted", nothing).
describe("migration-authoring wrapper stays local-only", () => {
  it("accepts an explicit --target-url pointing at an allowlisted local host", () => {
    expect(() => assertLocalTarget("local", "postgresql://u:p@localhost:5432/finsight_migration_scratch")).not.toThrow();
    expect(() => assertLocalTarget("local", "postgresql://u:p@127.0.0.1:5432/db")).not.toThrow();
    expect(() => assertLocalTarget("local", "postgresql://u:p@[::1]:5432/db")).not.toThrow();
  });

  it("rejects a --target-url pointing at the Supabase pooler host format, regardless of --environment label", () => {
    for (const environment of ["local", "production", "staging", "anything-goes"]) {
      expect(() =>
        assertLocalTarget(
          environment,
          "postgresql://postgres.ref:pw@aws-0-x.pooler.supabase.com:6543/postgres"
        )
      ).toThrow(/local allowlist/);
    }
  });

  it("rejects a --target-url pointing at the Supabase direct host format", () => {
    expect(() => assertLocalTarget("local", "postgresql://postgres:pw@db.ref.supabase.co:5432/postgres")).toThrow(
      /local allowlist/
    );
  });

  it("rejects lookalike hostnames even under a --target-url flag", () => {
    expect(() => assertLocalTarget("local", "postgresql://u:p@localhost.attacker.example:5432/db")).toThrow(
      /local allowlist/
    );
  });

  it("no flag combination on the CLI arg parser can request a hosted mode — there is no such flag", () => {
    const args = parseAuthorArgs([
      "--environment",
      "production",
      "--name",
      "sneaky",
      "--target-url",
      "postgresql://u:p@db.ref.supabase.co:5432/postgres",
    ]);
    // parseAuthorArgs itself never validates the URL — that's assertLocalTarget's
    // job, and runAuthorWorkflow always calls it before using args.targetUrl.
    expect(() => assertLocalTarget(args.environment, args.targetUrl!)).toThrow(/local allowlist/);
  });

  it("requires --environment", () => {
    expect(() => parseAuthorArgs(["--name", "x"])).toThrow(/--environment/);
  });
});
