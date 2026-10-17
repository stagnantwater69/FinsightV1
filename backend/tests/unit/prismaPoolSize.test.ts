import { describe, expect, it } from "vitest";
import { withPoolSize, withSocketTimeout } from "../../src/config/prisma";

const POOLER = "postgresql://u:p@pooler.example.com:6543/postgres?pgbouncer=true";

describe("withPoolSize", () => {
  it("adds connection_limit and keeps the existing parameters", () => {
    const url = new URL(withPoolSize(POOLER, "8")!);
    expect(url.searchParams.get("connection_limit")).toBe("8");
    expect(url.searchParams.get("pgbouncer")).toBe("true");
  });

  it("never overrides a connection_limit already in the URL", () => {
    const pinned = `${POOLER}&connection_limit=2`;
    expect(withPoolSize(pinned, "8")).toBe(pinned);
  });

  it("leaves the URL alone when no valid size is configured", () => {
    expect(withPoolSize(POOLER, undefined)).toBe(POOLER);
    expect(withPoolSize(POOLER, "0")).toBe(POOLER);
    expect(withPoolSize(POOLER, "abc")).toBe(POOLER);
    expect(withPoolSize(undefined, "8")).toBeUndefined();
  });
});

describe("withSocketTimeout", () => {
  it("adds a 30 second socket_timeout by default and keeps the existing parameters", () => {
    const url = new URL(withSocketTimeout(POOLER, undefined)!);
    expect(url.searchParams.get("socket_timeout")).toBe("30");
    expect(url.searchParams.get("pgbouncer")).toBe("true");
  });

  it("uses a configured number of seconds", () => {
    expect(new URL(withSocketTimeout(POOLER, "45")!).searchParams.get("socket_timeout")).toBe("45");
  });

  it("never overrides a socket_timeout already in the URL", () => {
    const pinned = `${POOLER}&socket_timeout=5`;
    expect(withSocketTimeout(pinned, "45")).toBe(pinned);
  });

  it("leaves the URL alone when the configured value is invalid", () => {
    expect(withSocketTimeout(POOLER, "0")).toBe(POOLER);
    expect(withSocketTimeout(POOLER, "abc")).toBe(POOLER);
    expect(withSocketTimeout(undefined, "30")).toBeUndefined();
  });

  it("composes with withPoolSize", () => {
    const url = new URL(withSocketTimeout(withPoolSize(POOLER, "5"), undefined)!);
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("socket_timeout")).toBe("30");
  });
});
