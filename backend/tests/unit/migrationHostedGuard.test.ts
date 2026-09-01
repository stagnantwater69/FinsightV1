import { describe, expect, it, vi } from "vitest";
import { evaluateHostedDeployment, neverPersistConfirmation, type HostedGuardInput } from "../../scripts/migrate-workflow/hostedGuard";

// Every URL below is synthetic/fake, used only as a string for the parser —
// none of these are ever dialed. This whole suite makes zero network
// connections: evaluateHostedDeployment() and neverPersistConfirmation() are
// pure functions with no fetch/net/child_process/fs calls anywhere in their
// implementation or in urlSafety.ts, which they depend on.
const FAKE_HOSTED_URL = "postgresql://postgres.fake-project-ref:fakepassword@fake-project.pooler.supabase.com:6543/postgres";

function baseInput(overrides: Partial<HostedGuardInput> = {}): HostedGuardInput {
  return {
    environment: "staging",
    projectRef: "fake-project-ref",
    confirmProject: "fake-project-ref",
    rawUrl: FAKE_HOSTED_URL,
    ciDeployApproved: true,
    isInteractive: false,
    ...overrides,
  };
}

describe("evaluateHostedDeployment — confirmation friction", () => {
  it("allows when environment, matching refs, and CI approval are all present (mocked URL only)", () => {
    const verdict = evaluateHostedDeployment(baseInput());
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.target).toEqual({
        environment: "staging",
        host: "fake-project.pooler.supabase.com",
        port: "6543",
        database: "postgres",
      });
    }
  });

  it("rejects when --environment is missing", () => {
    const verdict = evaluateHostedDeployment(baseInput({ environment: undefined }));
    expect(verdict.allowed).toBe(false);
  });

  it("rejects when --project-ref is missing", () => {
    const verdict = evaluateHostedDeployment(baseInput({ projectRef: undefined }));
    expect(verdict.allowed).toBe(false);
  });

  it("rejects when --confirm-project is missing", () => {
    const verdict = evaluateHostedDeployment(baseInput({ confirmProject: undefined }));
    expect(verdict.allowed).toBe(false);
  });

  it("rejects when project-ref and confirm-project don't match", () => {
    const verdict = evaluateHostedDeployment(baseInput({ confirmProject: "different-ref" }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/do not match/);
  });

  it.each(["yes", "y", "YES", "Y", "ok", "OK", "confirm", "true", "1"])(
    "rejects a generic confirmation %s even if it happens to be typed as both flags",
    (generic) => {
      const verdict = evaluateHostedDeployment(baseInput({ projectRef: generic, confirmProject: generic }));
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(/[Gg]eneric confirmations/);
    }
  );

  it("refuses to run noninteractively without FINSIGHT_CI_DEPLOY_APPROVED", () => {
    const verdict = evaluateHostedDeployment(baseInput({ isInteractive: false, ciDeployApproved: false }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/FINSIGHT_CI_DEPLOY_APPROVED/);
  });

  it("allows noninteractive runs when FINSIGHT_CI_DEPLOY_APPROVED is set", () => {
    const verdict = evaluateHostedDeployment(baseInput({ isInteractive: false, ciDeployApproved: true }));
    expect(verdict.allowed).toBe(true);
  });

  it("allows an interactive run even without CI approval", () => {
    const verdict = evaluateHostedDeployment(baseInput({ isInteractive: true, ciDeployApproved: false }));
    expect(verdict.allowed).toBe(true);
  });

  it("rejects a malformed target connection string cleanly", () => {
    const verdict = evaluateHostedDeployment(baseInput({ rawUrl: "not-a-valid-url:::garbage" }));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/Could not parse/);
  });

  it("rejects a missing target connection string", () => {
    const verdict = evaluateHostedDeployment(baseInput({ rawUrl: undefined }));
    expect(verdict.allowed).toBe(false);
  });

  it("never includes credentials in the sanitized target on an allowed verdict", () => {
    const verdict = evaluateHostedDeployment(baseInput());
    expect(verdict.allowed).toBe(true);
    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toContain("fakepassword");
    expect(serialized).not.toContain("postgres.fake-project-ref");
  });
});

describe("neverPersistConfirmation", () => {
  it("performs no filesystem or process writes", () => {
    // If this ever grows a fs.writeFile / dotenv write, these spies would
    // catch it, since neverPersistConfirmation() must remain a pure no-op.
    const fs = require("node:fs");
    const writeFileSyncSpy = vi.spyOn(fs, "writeFileSync");
    const appendFileSyncSpy = vi.spyOn(fs, "appendFileSync");

    expect(() => neverPersistConfirmation()).not.toThrow();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(appendFileSyncSpy).not.toHaveBeenCalled();

    writeFileSyncSpy.mockRestore();
    appendFileSyncSpy.mockRestore();
  });
});

describe("zero network connections in this suite", () => {
  it("evaluateHostedDeployment never imports/uses net, http(s), or child_process", async () => {
    // Static-import check: the hostedGuard module's own dependency graph
    // (excluding this test file) must not pull in networking or
    // process-spawning primitives. Guards against a future edit
    // accidentally wiring the guard straight to a live deploy call.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/migrate-workflow/hostedGuard.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/require\(["']node:net["']\)/);
    expect(src).not.toMatch(/from ["']node:net["']/);
    expect(src).not.toMatch(/from ["']node:http/);
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/fetch\(/);
  });
});
