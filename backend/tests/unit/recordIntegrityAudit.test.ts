import { describe, expect, it, vi } from "vitest";
import {
  HELP_TEXT,
  databaseTargetFingerprint,
  main,
  parseAuditArguments,
  runRecordIntegrityAudit,
  validateAuditDatabaseUrl,
} from "../../scripts/record-integrity-audit";

describe("record integrity audit command safety", () => {
  it("parses only the documented flags", () => {
    expect(parseAuditArguments([])).toEqual({ allowRemoteReadOnly: false, help: false });
    expect(parseAuditArguments(["--allow-remote-read-only", "--help"])).toEqual({
      allowRemoteReadOnly: true,
      help: true,
    });
    expect(() => parseAuditArguments(["--repair"])).toThrowError("UNKNOWN_ARGUMENT");
  });

  it("requires the dedicated URL and accepts IPv4 and IPv6 loopback", () => {
    expect(() => validateAuditDatabaseUrl(undefined, false)).toThrowError("DATABASE_URL_MISSING");
    expect(() => validateAuditDatabaseUrl("not a url", false)).toThrowError("DATABASE_URL_INVALID");
    expect(validateAuditDatabaseUrl("postgresql://user:pass@127.0.0.8:5432/db", false))
      .toContain("127.0.0.8");
    expect(validateAuditDatabaseUrl("postgres://user:pass@[::1]:5432/db", false)).toContain("[::1]");
  });

  it("refuses remote hosts unless the read-only override is explicit", () => {
    const remote = "postgresql://user:secret@db.example.invalid:5432/production";
    expect(() => validateAuditDatabaseUrl(remote, false))
      .toThrowError("REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG");
    expect(() => validateAuditDatabaseUrl(remote, true))
      .toThrowError("REMOTE_DATABASE_TARGET_BINDING_MISSING");
    expect(validateAuditDatabaseUrl(
      remote,
      true,
      "db.example.invalid",
      "production",
      databaseTargetFingerprint(remote),
    )).toBe(remote);
  });

  it("validates and exactly matches both parts of a remote target binding", () => {
    const remote = "postgresql://user:secret@db.example.invalid:6543/production?sslmode=require";
    const fingerprint = databaseTargetFingerprint(remote);
    expect(() => validateAuditDatabaseUrl(
      remote, true, "https://db.example.invalid", "production", fingerprint,
    ))
      .toThrowError("REMOTE_DATABASE_TARGET_BINDING_INVALID");
    expect(() => validateAuditDatabaseUrl(
      remote, true, "db.example.invalid", "production/name", fingerprint,
    ))
      .toThrowError("REMOTE_DATABASE_TARGET_BINDING_INVALID");
    expect(() => validateAuditDatabaseUrl(
      remote, true, "db.example.invalid", "production", "not-a-fingerprint",
    ))
      .toThrowError("REMOTE_DATABASE_TARGET_BINDING_INVALID");
    expect(() => validateAuditDatabaseUrl(
      remote, true, "other.example.invalid", "production", fingerprint,
    ))
      .toThrowError("REMOTE_DATABASE_TARGET_MISMATCH");
    expect(() => validateAuditDatabaseUrl(
      remote, true, "db.example.invalid", "other", fingerprint,
    ))
      .toThrowError("REMOTE_DATABASE_TARGET_MISMATCH");
    const otherUser = "postgresql://other-user:secret@db.example.invalid:6543/production?sslmode=require";
    expect(() => validateAuditDatabaseUrl(
      otherUser, true, "db.example.invalid", "production", fingerprint,
    )).toThrowError("REMOTE_DATABASE_FINGERPRINT_MISMATCH");
  });

  it("does not expose a connection-opening API that bypasses target validation", async () => {
    const remote = "postgresql://user:secret@db.example.invalid:6543/production";
    await expect(runRecordIntegrityAudit({
      databaseUrl: remote,
      allowRemoteReadOnly: true,
      expectedHostname: "db.example.invalid",
      expectedDatabase: "production",
      expectedFingerprint: "0".repeat(64),
    })).rejects.toThrowError("REMOTE_DATABASE_FINGERPRINT_MISMATCH");
  });

  it("shows help without requiring or opening a database", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["--help"], {})).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(HELP_TEXT);
    log.mockRestore();
  });

  it("emits a stable aggregate-only configuration error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(main([], {})).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(JSON.stringify({
      check: "record-integrity",
      version: 1,
      status: "failed",
      code: "DATABASE_URL_MISSING",
    }));
    error.mockRestore();
  });

  it("does not echo a refused remote URL or its credentials", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(main([], {
      RECORD_INTEGRITY_DATABASE_URL: "postgresql://operator:do-not-print@db.example.invalid/prod",
      RECORD_INTEGRITY_EXPECTED_HOST: "expected.example.invalid",
      RECORD_INTEGRITY_EXPECTED_DATABASE: "prod",
    })).resolves.toBe(2);
    const output = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toEqual({
      check: "record-integrity",
      version: 1,
      status: "failed",
      code: "REMOTE_DATABASE_REQUIRES_EXPLICIT_FLAG",
    });
    expect(output).not.toContain("do-not-print");
    expect(output).not.toContain("db.example.invalid");
    error.mockRestore();
  });
});
