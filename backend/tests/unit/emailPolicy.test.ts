import { describe, expect, it } from "vitest";
import { isDisposableEmail, normalizeEmail } from "../../src/lib/emailPolicy";

/**
 * Normalisation is not cosmetic here, and that is what these pin.
 *
 * Supabase Auth lowercases addresses on its side; `User_Email` is a
 * case-SENSITIVE unique column. When the two disagree, the profile row and the
 * identity it mirrors drift apart — and Prisma's uniqueness turns out to have
 * been enforced only by Supabase happening to reject the duplicate first, which
 * is luck rather than a constraint.
 */
describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Owner@Shop.PH  ")).toBe("owner@shop.ph");
  });

  it("is idempotent, so applying it twice cannot change an answer", () => {
    const once = normalizeEmail(" Owner@Shop.PH ");
    expect(normalizeEmail(once)).toBe(once);
  });

  /**
   * Local parts are NOT case-folded away beyond lowercasing, and plus-addresses
   * are NOT stripped. Both are tempting "normalisations" and both are wrong:
   * `owner+receipts@shop.ph` is a real, distinct address that its owner may
   * have registered with deliberately, and treating it as the same account as
   * `owner@shop.ph` would either merge two people or refuse a legitimate one.
   */
  it("leaves plus-addressing and dots intact", () => {
    expect(normalizeEmail("Owner+Receipts@Shop.ph")).toBe("owner+receipts@shop.ph");
    expect(normalizeEmail("first.last@shop.ph")).toBe("first.last@shop.ph");
  });
});

/**
 * A REPORTER, NOT A GATE. Registration accepts these addresses; it logs a
 * `register.disposable_domain` event when it sees one. The tests below still
 * matter — a signal that misfires is worse than none, because it is the
 * evidence a future decision about CAPTCHA or tighter limits would rest on.
 */
describe("isDisposableEmail", () => {
  it("catches the large, unambiguous throwaway providers", () => {
    for (const address of ["a@mailinator.com", "a@guerrillamail.com", "a@yopmail.com", "a@10minutemail.com"]) {
      expect(isDisposableEmail(address), address).toBe(true);
    }
  });

  /** Wildcard inboxes on a subdomain are the normal way these are used. */
  it("catches subdomains of them", () => {
    expect(isDisposableEmail("a@inbox.mailinator.com")).toBe(true);
    expect(isDisposableEmail("a@team.sub.mailinator.com")).toBe(true);
  });

  it("does not care about case or surrounding space", () => {
    expect(isDisposableEmail("  A@Mailinator.COM ")).toBe(true);
  });

  /**
   * THE FAILURE THAT MATTERS MORE than a missed throwaway: a false positive on
   * a real owner. It no longer turns anyone away — that is why the block was
   * removed — but a signal that fires on `mailbox.ph` would send someone
   * hunting an abuse pattern that is really just customers. If this test ever
   * has to be relaxed, the list has gone too far.
   */
  it("leaves ordinary providers alone, including small and lookalike ones", () => {
    for (const address of [
      "owner@gmail.com",
      "owner@yahoo.com.ph",
      "owner@tindahan.ph",
      "owner@mail.shop.ph",
      // Contains "mail" and looks generic, but is not on the list.
      "owner@mailbox.ph",
      // Shares a suffix word with a blocked domain without being one.
      "owner@notmailinator.ph",
    ]) {
      expect(isDisposableEmail(address), address).toBe(false);
    }
  });

  it("says no rather than throwing on something that is not an address", () => {
    expect(isDisposableEmail("no-at-sign")).toBe(false);
    expect(isDisposableEmail("")).toBe(false);
    expect(isDisposableEmail("trailing@")).toBe(false);
  });
});
