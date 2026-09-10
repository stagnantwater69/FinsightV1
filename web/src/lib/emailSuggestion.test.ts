import { describe, expect, it } from "vitest";
import { suggestEmail } from "./emailSuggestion";

/**
 * The reported case: `proximate69@gmail.co` sailed through registration
 * because it is a genuinely valid address — `.co` is Colombia. The
 * confirmation email then goes nowhere and the owner waits for a message that
 * will never come.
 */
describe("suggestEmail", () => {
  it("catches the reported typo", () => {
    expect(suggestEmail("proximate69@gmail.co")).toBe("proximate69@gmail.com");
  });

  it.each([
    ["a@gmail.con", "a@gmail.com"],
    ["a@gmial.com", "a@gmail.com"],
    ["a@gmai.com", "a@gmail.com"],
    ["a@gmail.cm", "a@gmail.com"],
    ["a@yahoo.co", "a@yahoo.com"],
    ["a@hotmial.com", "a@hotmail.com"],
    ["a@outlok.com", "a@outlook.com"],
    ["a@iclould.com", "a@icloud.com"],
  ])("suggests a fix for %s", (input, expected) => {
    expect(suggestEmail(input)).toBe(expected);
  });

  it("stays silent on addresses that are already right", () => {
    for (const good of [
      "owner@gmail.com",
      "owner@yahoo.com",
      "owner@outlook.com",
      "owner@icloud.com",
      "owner@proton.me",
    ]) {
      expect(suggestEmail(good), good).toBeNull();
    }
  });

  /**
   * The false-positive cases that matter. `mail.com` and `gmx.com` are one
   * edit from `gmail.com` and would be "corrected" by a naive distance check;
   * they are real providers and must be left alone.
   */
  it("never second-guesses a real domain that merely looks close", () => {
    for (const real of ["owner@mail.com", "owner@gmx.com", "owner@me.com", "owner@qq.com"]) {
      expect(suggestEmail(real), real).toBeNull();
    }
  });

  it("leaves corporate and subdomained addresses alone", () => {
    expect(suggestEmail("owner@finsight.ph")).toBeNull();
    expect(suggestEmail("owner@mail.company.co.uk")).toBeNull();
    expect(suggestEmail("owner@sari-sari-store.com.ph")).toBeNull();
  });

  it("does not invent a correction for a short unrelated domain", () => {
    // Would become "zoho.com" under a flat distance-2 threshold.
    expect(suggestEmail("owner@x.io")).toBeNull();
    expect(suggestEmail("owner@abc.de")).toBeNull();
  });

  it("returns null rather than throwing on malformed input", () => {
    for (const bad of ["", "   ", "no-at-sign", "@gmail.com", "owner@", "a@b@gmail.co"]) {
      expect(suggestEmail(bad), bad).toBeNull();
    }
  });

  it("preserves the local part exactly as typed", () => {
    // Only the domain was ever in question; casing the owner chose survives.
    expect(suggestEmail("First.Last+tag@gmail.co")).toBe("First.Last+tag@gmail.com");
  });

  it("is case-insensitive about the domain", () => {
    expect(suggestEmail("owner@GMAIL.CO")).toBe("owner@gmail.com");
    expect(suggestEmail("owner@GMAIL.COM")).toBeNull();
  });
});
