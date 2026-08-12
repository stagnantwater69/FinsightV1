// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  isSavingAccount,
  normaliseSavedEmail,
  parseSaveAccount,
  savedEmail,
  SAVE_ACCOUNT_KEY,
  SAVED_EMAIL_KEY,
  setSavedAccount,
} from "./savedAccount";

/**
 * Saving the login email so it does not have to be typed again.
 *
 * The rules that matter are the negative ones — what must NOT be on disk
 * after the box is unticked, and the fact that a password is never among what
 * is stored at all.
 */

beforeEach(() => {
  window.localStorage.clear();
});

describe("normaliseSavedEmail", () => {
  it("trims, because a stray space is the same account", () => {
    expect(normaliseSavedEmail("  owner@shop.ph \n")).toBe("owner@shop.ph");
  });

  /** Empty means "nothing worth saving", which callers treat as a clear. */
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

describe("setSavedAccount", () => {
  it("stores the address when asked to", () => {
    setSavedAccount(true, "owner@shop.ph");

    expect(savedEmail()).toBe("owner@shop.ph");
    expect(isSavingAccount()).toBe(true);
  });

  it("stores it trimmed", () => {
    setSavedAccount(true, "  owner@shop.ph  ");
    expect(savedEmail()).toBe("owner@shop.ph");
  });

  /**
   * THE RULE THAT MATTERS. Unticking means "do not keep my address", so
   * whatever was already stored has to go. Merely stopping future writes
   * would answer a different question from the one the owner was asked.
   */
  it("erases an address already stored when the box is unticked", () => {
    setSavedAccount(true, "owner@shop.ph");
    setSavedAccount(false, "owner@shop.ph");

    expect(savedEmail()).toBe("");
    expect(window.localStorage.getItem(SAVED_EMAIL_KEY)).toBeNull();
  });

  /**
   * The choice outlives the address, so unticking is remembered even though
   * nothing is left to read it off.
   */
  it("remembers the refusal itself", () => {
    setSavedAccount(false, "owner@shop.ph");

    expect(isSavingAccount()).toBe(false);
    expect(window.localStorage.getItem(SAVE_ACCOUNT_KEY)).toBe("false");
  });

  it("keeps nothing when there is nothing to keep", () => {
    setSavedAccount(true, "   ");
    expect(savedEmail()).toBe("");
    // Still recorded as wanted, so the next successful login does save.
    expect(isSavingAccount()).toBe(true);
  });

  /**
   * The claim the checkbox's own hint makes to the owner. Nothing resembling
   * a password may reach storage, under any key, in either mode.
   */
  it("never writes a password anywhere", () => {
    setSavedAccount(true, "owner@shop.ph");

    const stored = Object.entries({ ...window.localStorage } as Record<string, string>);
    expect(stored.length).toBeGreaterThan(0);
    for (const [key, value] of stored) {
      expect(key.toLowerCase()).not.toContain("password");
      expect(value).not.toContain("hunter2");
    }
  });
});

describe("reading before anything has been chosen", () => {
  it("prefills nothing and still offers to save", () => {
    expect(savedEmail()).toBe("");
    expect(isSavingAccount()).toBe(true);
  });
});
