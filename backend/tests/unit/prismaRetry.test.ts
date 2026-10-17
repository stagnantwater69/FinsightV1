import { describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { shouldRetryQuery, withIdleConnectionLifetime, withPoolSize, withSocketTimeout } from "../../src/config/prisma";

const POOLER = "postgresql://u:p@pooler.example.com:5432/postgres";

function knownError(code: string) {
  return new Prisma.PrismaClientKnownRequestError("connection failure", { code, clientVersion: "test" });
}

describe("withIdleConnectionLifetime", () => {
  it("recycles idle connections after 60 seconds by default", () => {
    expect(new URL(withIdleConnectionLifetime(POOLER, undefined)!).searchParams.get("max_idle_connection_lifetime")).toBe("60");
  });

  it("uses a configured number of seconds and never overrides the URL", () => {
    expect(new URL(withIdleConnectionLifetime(POOLER, "20")!).searchParams.get("max_idle_connection_lifetime")).toBe("20");
    const pinned = `${POOLER}?max_idle_connection_lifetime=5`;
    expect(withIdleConnectionLifetime(pinned, "20")).toBe(pinned);
    expect(withIdleConnectionLifetime(POOLER, "abc")).toBe(POOLER);
  });

  it("composes with the other URL settings", () => {
    const url = new URL(withIdleConnectionLifetime(withSocketTimeout(withPoolSize(POOLER, "5"), undefined), undefined)!);
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("socket_timeout")).toBe("30");
    expect(url.searchParams.get("max_idle_connection_lifetime")).toBe("60");
  });
});

describe("shouldRetryQuery", () => {
  it("retries failures that happen before the statement is sent, writes included", () => {
    expect(shouldRetryQuery(knownError("P2024"), "create", false, 0)).toBe(true);
    expect(shouldRetryQuery(knownError("P1001"), "update", false, 0)).toBe(true);
    expect(shouldRetryQuery(knownError("P1001"), "update", false, 1)).toBe(true);
  });

  it("gives a pool timeout only one retry, since it already waited out pool_timeout", () => {
    expect(shouldRetryQuery(knownError("P2024"), "findMany", false, 1)).toBe(false);
  });

  it("retries a dropped connection only for reads", () => {
    expect(shouldRetryQuery(knownError("P1017"), "findUnique", false, 0)).toBe(true);
    expect(shouldRetryQuery(knownError("P1008"), "count", false, 0)).toBe(true);
    expect(shouldRetryQuery(knownError("P1017"), "create", false, 0)).toBe(false);
    expect(shouldRetryQuery(knownError("P1017"), "$executeRaw", false, 0)).toBe(false);
  });

  it("never retries inside a transaction, after two retries, or for other errors", () => {
    expect(shouldRetryQuery(knownError("P2024"), "findMany", true, 0)).toBe(false);
    expect(shouldRetryQuery(knownError("P1001"), "findMany", false, 2)).toBe(false);
    expect(shouldRetryQuery(knownError("P2002"), "create", false, 0)).toBe(false);
    expect(shouldRetryQuery(new Error("boom"), "findMany", false, 0)).toBe(false);
  });

  it("recognises an initialization error that carries a connection code", () => {
    const err = new Prisma.PrismaClientInitializationError("can't reach database", "test", "P1001");
    expect(shouldRetryQuery(err, "findUnique", false, 0)).toBe(true);
    expect(shouldRetryQuery(new Prisma.PrismaClientInitializationError("connection refused", "test"), "create", false, 0)).toBe(true);
  });
});

describe("Prisma's transaction marker", () => {
  /*
   * config/prisma.ts reads `__internalParams.transaction` to keep retries out
   * of transactions. It is not public API, so this pins it: if an upgrade
   * renames it, every call would look non-transactional and a retried
   * statement could run outside its transaction.
   */
  it("is present inside $transaction and absent outside it", async () => {
    const seen: boolean[] = [];
    const client = new PrismaClient({ datasourceUrl: "postgresql://u:p@127.0.0.1:1/none" }).$extends({
      query: {
        async $allOperations({ query: _query, ...rest }) {
          const internal = (rest as { __internalParams?: { transaction?: unknown } }).__internalParams;
          seen.push(internal?.transaction !== undefined);
          throw new Error("stop before the engine");
        },
      },
    });

    await expect(client.user.findMany()).rejects.toThrow("stop before the engine");
    await expect(client.$transaction([client.user.findMany(), client.user.count()])).rejects.toThrow();

    expect(seen[0]).toBe(false);
    expect(seen.slice(1)).not.toHaveLength(0);
    expect(seen.slice(1).every(Boolean)).toBe(true);
  });
});
