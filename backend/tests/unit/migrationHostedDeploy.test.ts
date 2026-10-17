import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import { main } from "../../scripts/migrate-workflow/deploy-hosted";

const args = [
  "--environment", "staging",
  "--project-ref", "fake-project-ref",
  "--confirm-project", "fake-project-ref",
];

describe("hosted migration CLI launcher", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.stubEnv("DIRECT_URL", "postgresql://postgres.fake-project-ref:fakepassword@fake-project.pooler.supabase.com:5432/postgres");
    vi.stubEnv("FINSIGHT_CI_DEPLOY_APPROVED", "1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs the installed Prisma CLI with Node and no shell after confirmation", () => {
    expect(main(args)).toBe(0);
    expect(execFileSyncMock).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
      { cwd: path.resolve(__dirname, "../.."), stdio: "inherit", env: process.env },
    );
  });

  it("does not launch Prisma when the project confirmation differs", () => {
    expect(main([...args.slice(0, -1), "different-project-ref"])).toBe(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("propagates a failed migration instead of reporting success", () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("synthetic migration failure"); });
    expect(() => main(args)).toThrow("synthetic migration failure");
  });
});
