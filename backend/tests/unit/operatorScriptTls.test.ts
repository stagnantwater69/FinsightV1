import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseTargetFingerprint, validateAuditDatabaseUrl } from "../../scripts/record-integrity-audit";
import { main as verifyStorageBuckets } from "../../scripts/storage-buckets/verify";

// The operator scripts that build their own Prisma client apply the same
// database TLS policy as the API (src/config/databaseTls.ts), on the URL they
// actually connect with, and before any request.
const BACKEND = path.resolve(__dirname, "../..");
const CA = path.resolve(__dirname, "../fixtures/database-tls/test-ca.crt").replace(/\\/g, "/");
const TLS = `sslmode=require&sslcert=${CA}&sslaccept=strict`;
const REF = "abcdefghijklmnopqrst";
const POOLER = `postgresql://postgres.${REF}:secret-password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;

function runScript(script: string, databaseUrl: string, ...args: string[]) {
  return spawnSync(process.execPath, [require.resolve("tsx/cli"), script, ...args], {
    cwd: BACKEND,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("operator scripts refuse a database URL that would not verify the server", () => {
  it("record-integrity-audit, even with --allow-remote-read-only and a matching target binding", () => {
    const unverified = "postgresql://user:secret@db.example.invalid:5432/production";
    expect(() => validateAuditDatabaseUrl(
      unverified, true, "db.example.invalid", "production", databaseTargetFingerprint(unverified),
    )).toThrowError("DATABASE_TLS_UNVERIFIED");
    const verified = `${unverified}?${TLS}`;
    expect(validateAuditDatabaseUrl(
      verified, true, "db.example.invalid", "production", databaseTargetFingerprint(verified),
    )).toBe(verified);
  });

  it("storage:buckets:verify, before any Storage or database request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
    const environment = {
      SUPABASE_STORAGE_BUCKET: "receipts",
      SUPABASE_URL: `https://${REF}.supabase.co`,
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-real",
      DIRECT_URL: POOLER,
    };
    await expect(verifyStorageBuckets([], environment)).rejects.toMatchObject({ code: "DIRECT_URL_TLS_UNVERIFIED" });
    await expect(verifyStorageBuckets([], { ...environment, DIRECT_URL: `${POOLER}?sslmode=require` }))
      .rejects.toMatchObject({ code: "DIRECT_URL_TLS_UNVERIFIED" });
    // An escaped CA name, which the script's own URL rewriting would otherwise normalize.
    const escaped = `${POOLER}?sslmode=require&sslcert=${CA.replace("test-ca", "test%2Dca")}&sslaccept=strict`;
    await expect(verifyStorageBuckets([], { ...environment, DIRECT_URL: escaped }))
      .rejects.toMatchObject({ code: "DIRECT_URL_TLS_UNVERIFIED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("receipt-queue-readiness, without checking the database", () => {
    const result = runScript("scripts/receipt-queue-readiness.ts", "postgresql://u:secret-password@db.example.invalid:5432/postgres");
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr.trim().split("\n").pop()!)).toMatchObject({
      status: "failed",
      database: "not-checked",
      errorCode: "DATABASE_TLS_UNVERIFIED",
    });
    expect(result.stdout + result.stderr).not.toContain("secret-password");
    // An escaped CA name, which the script's own URL rewriting would otherwise normalize.
    const escaped = runScript(
      "scripts/receipt-queue-readiness.ts",
      `postgresql://u:secret-password@db.example.invalid:5432/postgres?sslmode=require&sslcert=${CA.replace("test-ca", "test%2Dca")}&sslaccept=strict`,
    );
    expect(JSON.parse(escaped.stderr.trim().split("\n").pop()!)).toMatchObject({ errorCode: "DATABASE_TLS_UNVERIFIED" });
  }, 60_000);

  it("check-available-funds, even with --allow-remote", () => {
    const result = runScript(
      "scripts/check-available-funds.ts",
      "postgresql://u:secret-password@db.example.invalid:5432/postgres?sslmode=require",
      "--allow-remote",
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DATABASE_URL needs sslaccept=strict");
    expect(result.stdout + result.stderr).not.toContain("secret-password");
  }, 60_000);
});
