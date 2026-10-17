import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  operations: [] as string[],
  execute: vi.fn(async (_query: unknown) => undefined),
  disconnect: vi.fn(async () => undefined),
  migrate: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execSync: mocks.migrate }));
vi.mock("@prisma/client", () => ({ PrismaClient: class {
  constructor(options: unknown) { mocks.construct(options); }
  $executeRaw = mocks.execute;
  $disconnect = mocks.disconnect;
} }));

import globalSetup, { assertLocalTestDatabase } from "../setup/globalSetup";

const local = "postgresql://testuser:testpass@127.0.0.1:55434/finsight_test";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operations.length = 0;
  mocks.execute.mockImplementation(async () => { mocks.operations.push("roles"); });
  mocks.disconnect.mockImplementation(async () => { mocks.operations.push("disconnect"); });
  mocks.migrate.mockImplementation(() => { mocks.operations.push("migrate"); });
  vi.stubEnv("DATABASE_URL", local);
  vi.stubEnv("DIRECT_URL", local);
});
afterEach(() => vi.unstubAllEnvs());

describe("local test database bootstrap safety", () => {
  it.each(["localhost", "127.0.0.1", "host.docker.internal"])("allows the exact test database on %s", (host) => {
    expect(() => assertLocalTestDatabase("DATABASE_URL", `postgresql://testuser:testpass@${host}:55434/finsight_test`)).not.toThrow();
  });

  it.each([
    "postgresql://testuser:testpass@127.0.0.1:55434/finsight_test_backup",
    "postgresql://testuser:testpass@127.0.0.1:55434/production?tag=finsight_test",
    "postgresql://testuser:testpass@remote.example/finsight_test",
    "postgresql://testuser:testpass@localhost.attacker.example/finsight_test",
    "postgresql://localhost@remote.example/finsight_test",
    "https://testuser:testpass@localhost/finsight_test",
    "not a URL",
  ])("rejects an unsafe database before opening it: %s", async (url) => {
    vi.stubEnv("DATABASE_URL", url);
    vi.stubEnv("DIRECT_URL", url);
    await expect(Promise.resolve().then(() => globalSetup())).rejects.toThrow(/Refusing to run tests/);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it.each([
    "postgresql://testuser:testpass@remote.example/finsight_test",
    "postgresql://testuser:testpass@127.0.0.1:55434/finsight_test_backup",
    "postgresql://testuser:testpass@127.0.0.1:55435/finsight_test",
  ])("validates DIRECT_URL and database identity before any bootstrap: %s", async (direct) => {
    vi.stubEnv("DIRECT_URL", direct);
    await expect(Promise.resolve().then(() => globalSetup())).rejects.toThrow(/Refusing to run tests/);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("creates missing NOLOGIN client roles before migration deployment and disconnects its client", async () => {
    await globalSetup();
    expect(mocks.construct).toHaveBeenCalledWith({ datasources: { db: { url: local } } });
    const sql = (mocks.execute.mock.calls[0]![0] as readonly string[]).join("");
    expect(sql).toContain("CREATE ROLE anon NOLOGIN");
    expect(sql).toContain("CREATE ROLE authenticated NOLOGIN");
    expect(sql).toContain("CREATE ROLE postgres NOLOGIN");
    expect(sql.match(/IF NOT EXISTS/g)).toHaveLength(3);
    expect(mocks.operations).toEqual(["roles", "disconnect", "migrate"]);
    expect(mocks.migrate).toHaveBeenCalledWith("npx prisma migrate deploy", expect.objectContaining({
      env: expect.objectContaining({ DATABASE_URL: local, DIRECT_URL: local }),
    }));
  });

  it("does not deploy migrations after role bootstrap fails", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("Role bootstrap failed"));
    await expect(Promise.resolve().then(() => globalSetup())).rejects.toThrow("Role bootstrap failed");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.migrate).not.toHaveBeenCalled();
  });
});
