import { describe, expect, it } from "vitest";
import { hashHandoffCode, newHandoffCode, open, seal } from "../../src/lib/authHandoff";

/**
 * The cryptography under the web → mobile session handoff.
 *
 * These are the properties the rest of the flow ASSUMES rather than checks: the
 * service asserts that a row cannot be replayed and that a database read cannot
 * lift a session, and both of those are claims about this module. They are also
 * the kind of claim that keeps being true right up until someone swaps a
 * primitive for a "simpler" one, which is why they are pinned here rather than
 * left to the integration suite — where a weakened code would still pass every
 * test, because every test would still round-trip.
 */
describe("handoff codes", () => {
  it("mints something no one can guess", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(newHandoffCode().code);
    expect(seen.size).toBe(500);

    // 32 bytes, base64url. Anything materially shorter is a brute-force target
    // and the rate limiter is the backstop, not the defence.
    expect(newHandoffCode().code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores a hash the code cannot be read back out of", () => {
    const { code, codeHash } = newHandoffCode();
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash).not.toContain(code);
    // Deterministic, because the exchange has to FIND the row from the code.
    expect(hashHandoffCode(code)).toBe(codeHash);
    expect(hashHandoffCode(`${code}x`)).not.toBe(codeHash);
  });
});

describe("sealing a refresh token", () => {
  const TOKEN = "rt_v1.some-refresh-token-value";

  it("round-trips", () => {
    expect(open(seal(TOKEN))).toBe(TOKEN);
  });

  it("never shows the token to anyone reading the row", () => {
    const sealed = seal(TOKEN);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("refresh");
  });

  it("produces a different ciphertext every time, so equal tokens are not visibly equal", () => {
    expect(seal(TOKEN)).not.toBe(seal(TOKEN));
  });

  /**
   * GCM rather than CBC precisely for this. A tampered row must fail to open,
   * not decrypt to garbage that then gets sent to GoTrue as a refresh token.
   */
  it("refuses a tampered or truncated blob instead of returning nonsense", () => {
    const sealed = seal(TOKEN);
    const [iv, tag, body] = sealed.split(".");

    expect(open(`${iv}.${tag}.${body.slice(0, -4)}AAAA`)).toBeNull();
    expect(open(`${iv}.AAAAAAAAAAAAAAAAAAAAAA.${body}`)).toBeNull();
    expect(open("not-a-sealed-value")).toBeNull();
    expect(open("")).toBeNull();
  });
});
