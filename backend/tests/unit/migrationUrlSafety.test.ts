import { describe, expect, it } from "vitest";
import {
  ConnectionUrlError,
  formatSanitizedTarget,
  isLocalAllowedHost,
  looksLikeHostedSupabaseHost,
  normalizeHost,
  parseConnectionUrl,
  resolveEffectiveUrl,
  sanitizeTarget,
} from "../../scripts/migrate-workflow/urlSafety";

describe("parseConnectionUrl", () => {
  it("parses a plain local URL", () => {
    const parsed = parseConnectionUrl("postgresql://testuser:testpass@localhost:55432/finsight_test");
    expect(parsed).toEqual({
      host: "localhost",
      port: "55432",
      database: "finsight_test",
      protocol: "postgresql:",
    });
  });

  it("normalizes and accepts a bracketed IPv6 loopback", () => {
    const parsed = parseConnectionUrl("postgresql://user:pass@[::1]:5432/finsight_test");
    expect(parsed.host).toBe("::1");
    expect(parsed.port).toBe("5432");
  });

  it("handles percent-encoded credentials without leaking them into host/db", () => {
    const parsed = parseConnectionUrl("postgresql://us%40er:p%40ss%3Aword@localhost:5432/finsight_test");
    expect(parsed.host).toBe("localhost");
    expect(parsed.database).toBe("finsight_test");
  });

  it("parses query parameters without letting them affect host/database", () => {
    const parsed = parseConnectionUrl(
      "postgresql://user:pass@localhost:5432/finsight_test?sslmode=require&pgbouncer=true"
    );
    expect(parsed.host).toBe("localhost");
    expect(parsed.database).toBe("finsight_test");
  });

  it("parses the Supabase pooler host format", () => {
    const parsed = parseConnectionUrl(
      "postgresql://postgres.exampleref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
    );
    expect(parsed.host).toBe("aws-0-ap-southeast-1.pooler.supabase.com");
    expect(parsed.port).toBe("6543");
  });

  it("parses the Supabase direct host format", () => {
    const parsed = parseConnectionUrl("postgresql://postgres:pw@db.exampleref.supabase.co:5432/postgres");
    expect(parsed.host).toBe("db.exampleref.supabase.co");
  });

  it("defaults database to empty string when missing", () => {
    const parsed = parseConnectionUrl("postgresql://localhost:5432");
    expect(parsed.database).toBe("");
  });

  it("rejects malformed URLs cleanly, not with a raw crash", () => {
    expect(() => parseConnectionUrl("not a url at all::: garbage")).toThrow(ConnectionUrlError);
  });

  it("rejects an empty/undefined connection string cleanly", () => {
    expect(() => parseConnectionUrl(undefined)).toThrow(ConnectionUrlError);
    expect(() => parseConnectionUrl("")).toThrow(ConnectionUrlError);
    expect(() => parseConnectionUrl("   ")).toThrow(ConnectionUrlError);
  });

  it("rejects a non-postgres protocol", () => {
    expect(() => parseConnectionUrl("mysql://localhost:3306/db")).toThrow(ConnectionUrlError);
  });
});

describe("normalizeHost", () => {
  it("strips IPv6 brackets and lowercases", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("LOCALHOST")).toBe("localhost");
  });
});

describe("isLocalAllowedHost — exact match only", () => {
  it.each(["localhost", "127.0.0.1", "::1", "host.docker.internal", "finsight-test-db"])(
    "accepts %s",
    (host) => {
      expect(isLocalAllowedHost(host)).toBe(true);
    }
  );

  it("accepts the bracketed IPv6 form", () => {
    expect(isLocalAllowedHost("[::1]")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isLocalAllowedHost("LOCALHOST")).toBe(true);
  });

  it("rejects the Supabase pooler hostname pattern", () => {
    expect(isLocalAllowedHost("aws-0-ap-southeast-1.pooler.supabase.com")).toBe(false);
  });

  it("rejects the Supabase direct hostname pattern", () => {
    expect(isLocalAllowedHost("db.exampleref.supabase.co")).toBe(false);
  });

  it("rejects lookalike hostnames — no substring matching", () => {
    expect(isLocalAllowedHost("localhost.attacker.example")).toBe(false);
    expect(isLocalAllowedHost("evil-localhost")).toBe(false);
    expect(isLocalAllowedHost("notlocalhost")).toBe(false);
    expect(isLocalAllowedHost("127.0.0.1.attacker.example")).toBe(false);
    expect(isLocalAllowedHost("sub.finsight-test-db.attacker.example")).toBe(false);
  });

  it("rejects arbitrary other hosts", () => {
    expect(isLocalAllowedHost("192.168.1.50")).toBe(false);
    expect(isLocalAllowedHost("example.com")).toBe(false);
  });
});

describe("looksLikeHostedSupabaseHost", () => {
  it("flags pooler and direct Supabase host shapes", () => {
    expect(looksLikeHostedSupabaseHost("aws-0-ap-southeast-1.pooler.supabase.com")).toBe(true);
    expect(looksLikeHostedSupabaseHost("db.exampleref.supabase.co")).toBe(true);
  });

  it("does not flag local hosts", () => {
    expect(looksLikeHostedSupabaseHost("localhost")).toBe(false);
    expect(looksLikeHostedSupabaseHost("finsight-test-db")).toBe(false);
  });
});

describe("sanitizeTarget / formatSanitizedTarget never leak credentials", () => {
  const hostileInputs = [
    "postgresql://admin:S3cr3t!@localhost:5432/finsight_test?password=another-secret",
    "postgresql://postgres.ref:hunter2@aws-0-x.pooler.supabase.com:6543/postgres?pgbouncer=true&apikey=leak-me",
    "postgresql://us%40er:p%40ss@[::1]:5432/db",
    "postgresql://:onlypassword@localhost:5432/db",
  ];

  it.each(hostileInputs)("never includes credentials for input: %s", (rawUrl) => {
    const parsed = parseConnectionUrl(rawUrl);
    const target = sanitizeTarget("test-env", parsed);
    const formatted = formatSanitizedTarget(target);
    const serialized = JSON.stringify(target) + formatted;

    expect(serialized).not.toContain("S3cr3t");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("onlypassword");
    expect(serialized).not.toContain("admin");
    expect(serialized).not.toContain("postgres.ref");
    expect(serialized).not.toContain("us@er");
    expect(serialized).not.toContain("p@ss");
  });

  it("only exposes environment, host, port, database", () => {
    const parsed = parseConnectionUrl("postgresql://user:pw@localhost:5432/finsight_test");
    const target = sanitizeTarget("local", parsed);
    expect(Object.keys(target).sort()).toEqual(["database", "environment", "host", "port"]);
  });
});

describe("resolveEffectiveUrl", () => {
  it("prefers DIRECT_URL over DATABASE_URL when both are set and differ", () => {
    const result = resolveEffectiveUrl({
      DATABASE_URL: "postgresql://user:pw@pooler-host:6543/postgres?pgbouncer=true",
      DIRECT_URL: "postgresql://user:pw@direct-host:5432/postgres",
    });
    expect(result.source).toBe("DIRECT_URL");
    expect(result.url).toContain("direct-host");
  });

  it("falls back to DATABASE_URL only when DIRECT_URL is entirely absent", () => {
    const result = resolveEffectiveUrl({
      DATABASE_URL: "postgresql://user:pw@pooler-host:6543/postgres",
    });
    expect(result.source).toBe("DATABASE_URL");
  });

  it("rejects when neither is set", () => {
    expect(() => resolveEffectiveUrl({})).toThrow(ConnectionUrlError);
  });

  it("falls back to DATABASE_URL when DIRECT_URL is present but blank", () => {
    const result = resolveEffectiveUrl({
      DIRECT_URL: "   ",
      DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
    });
    expect(result.source).toBe("DATABASE_URL");
  });
});
