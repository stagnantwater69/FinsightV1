import { describe, expect, it } from "vitest";
import { withPoolSize } from "../../src/config/prisma";

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
