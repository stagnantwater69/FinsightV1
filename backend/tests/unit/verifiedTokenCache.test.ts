import { beforeEach, describe, expect, it } from "vitest";
import {
  VERIFIED_TOKEN_TTL_MS,
  clearVerifiedTokenCache,
  evictAuthUser,
  evictTokenOwner,
  getVerifiedTokenOwner,
  rememberVerifiedToken,
} from "../../src/lib/verifiedTokenCache";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const NOW = 1_800_000_000_000;
const farExp = NOW / 1000 + 3600;

describe("verifiedTokenCache", () => {
  beforeEach(() => clearVerifiedTokenCache());

  it("expires an entry after the TTL", () => {
    const token = jwt({ sub: "a", exp: farExp });
    rememberVerifiedToken(token, "a", NOW);
    expect(getVerifiedTokenOwner(token, NOW + VERIFIED_TOKEN_TTL_MS - 1)).toBe("a");
    expect(getVerifiedTokenOwner(token, NOW + VERIFIED_TOKEN_TTL_MS)).toBeUndefined();
  });

  it("never outlives the token's own expiry", () => {
    const token = jwt({ sub: "a", exp: NOW / 1000 + 5 });
    rememberVerifiedToken(token, "a", NOW);
    expect(getVerifiedTokenOwner(token, NOW + 4_999)).toBe("a");
    expect(getVerifiedTokenOwner(token, NOW + 5_000)).toBeUndefined();
  });

  it("evicts every token of the owner, including ones it was not given", () => {
    const phone = jwt({ sub: "a", exp: farExp, session_id: "phone" });
    const laptop = jwt({ sub: "a", exp: farExp, session_id: "laptop" });
    const other = jwt({ sub: "b", exp: farExp });
    rememberVerifiedToken(phone, "a", NOW);
    rememberVerifiedToken(laptop, "a", NOW);
    rememberVerifiedToken(other, "b", NOW);

    evictTokenOwner(phone);

    expect(getVerifiedTokenOwner(phone, NOW)).toBeUndefined();
    expect(getVerifiedTokenOwner(laptop, NOW)).toBeUndefined();
    expect(getVerifiedTokenOwner(other, NOW)).toBe("b");
  });

  it("evicts by the token's subject when that token was never cached", () => {
    const cached = jwt({ sub: "a", exp: farExp, session_id: "1" });
    rememberVerifiedToken(cached, "a", NOW);
    evictTokenOwner(jwt({ sub: "a", exp: farExp, session_id: "2" }));
    expect(getVerifiedTokenOwner(cached, NOW)).toBeUndefined();
  });

  it("evictAuthUser leaves other owners alone", () => {
    const token = jwt({ sub: "b", exp: farExp });
    rememberVerifiedToken(token, "b", NOW);
    evictAuthUser("a");
    expect(getVerifiedTokenOwner(token, NOW)).toBe("b");
  });
});
