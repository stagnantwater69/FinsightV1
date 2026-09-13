import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { databaseErrorCode, describeDatabaseEndpoint } from "../../scripts/check-database";

describe("database incident diagnostics", () => {
  it.each([
    ["postgresql://user:password@aws-0-example.pooler.supabase.com:6543/postgres", "6543", "shared-transaction-pooler"],
    ["postgresql://user:password@aws-0-example.pooler.supabase.com:5432/postgres", "5432", "shared-session-pooler"],
    ["postgres://user:password@localhost/finsight_test", "5432", "postgres"],
  ])("identifies the configured endpoint mode: %s", (url, port, mode) => {
    expect(describeDatabaseEndpoint(url)).toMatchObject({ port, mode });
  });

  it("prints only endpoint metadata, excluding credentials, database name, and query secrets", () => {
    const endpoint = describeDatabaseEndpoint(
      "postgresql://private-user:secret%40password@localhost:55432/private-database?token=query-secret#private-fragment",
    );
    expect(endpoint).toEqual({ host: "localhost", port: "55432", mode: "postgres" });
  });

  it.each([undefined, "", "not-a-url", "https://localhost/database", "postgres:/database"])(
    "rejects an absent or invalid database endpoint: %s",
    (url) => expect(() => describeDatabaseEndpoint(url)).toThrow(),
  );

  it.each([
    [{ code: "P1001", message: "private connection details" }, "P1001"],
    [{ errorCode: "P1002", message: "private connection details" }, "P1002"],
    [{ code: "unsafe-code", errorCode: "P2024" }, "P2024"],
    [{ code: "P1001\nsecret" }, "DATABASE_CHECK_FAILED"],
    [{ code: "secret-password" }, "DATABASE_CHECK_FAILED"],
    [new Error("postgresql://user:secret@localhost/postgres"), "DATABASE_CHECK_FAILED"],
    ["postgresql://user:secret@localhost/postgres", "DATABASE_CHECK_FAILED"],
    [null, "DATABASE_CHECK_FAILED"],
    [undefined, "DATABASE_CHECK_FAILED"],
  ])("emits only a recognized Prisma error code for %j", (error, expected) => {
    expect(databaseErrorCode(error)).toBe(expected);
  });

  it("exits unsuccessfully without exposing a malformed connection string", () => {
    // URL parser errors carry their raw input. Verify the actual CLI boundary,
    // including stderr, so a future raw-error log cannot disclose a password.
    const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), "scripts/check-database.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "postgresql://private-user:secret-password@[invalid-host/postgres" },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ status: "failed", errorCode: "DATABASE_URL_INVALID" });
    expect(result.stdout + result.stderr).not.toMatch(/private-user|secret-password|invalid-host/);
  });
});
