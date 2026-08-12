import { describe, expect, it } from "vitest";
import { normaliseSavedEmail, parseSaveAccount } from "../src/lib/savedAccount";

/**
 * The rules behind "save my email on this phone".
 *
 * Only the rules are here; the keystore side of it lives in
 * lib/savedAccountStore.ts, which imports expo-secure-store and so cannot be
 * loaded by this runner. Mirrors web/src/lib/savedAccount.test.ts, because
 * the two clients implement the same policy against different backends.
 */

describe("normaliseSavedEmail", () => {
  it("trims, because a stray space is the same account", () => {
    expect(normaliseSavedEmail("  owner@shop.ph \n")).toBe("owner@shop.ph");
  });

  /**
   * Empty means "nothing worth saving", which `setSavedAccount` treats as a
   * clear — prefilling a blank would look like a stored account that is not
   * there.
   */
  it("reduces whitespace-only input to nothing", () => {
    expect(normaliseSavedEmail("   ")).toBe("");
    expect(normaliseSavedEmail("")).toBe("");
  });
});

describe("parseSaveAccount", () => {
  /** Default on — the entire point is not having to type it. */
  it("defaults to saving when nothing has been chosen", () => {
    expect(parseSaveAccount(null)).toBe(true);
  });

  it("only treats the explicit string as a refusal", () => {
    expect(parseSaveAccount("false")).toBe(false);
    expect(parseSaveAccount("true")).toBe(true);
    // Anything unrecognised falls back to the default rather than to "off",
    // so a corrupted value cannot silently stop the prefill.
    expect(parseSaveAccount("")).toBe(true);
    expect(parseSaveAccount("no")).toBe(true);
  });
});
