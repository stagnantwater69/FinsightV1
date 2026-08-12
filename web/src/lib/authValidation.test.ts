import { describe, expect, it } from "vitest";
import {
  isPlausibleEmail,
  isValid,
  MAX_NAME_LENGTH,
  MAX_PHONE_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateChangePassword,
  validateLogin,
  validateRecoverPassword,
  validateRegister,
  validateResetPassword,
} from "./authValidation";

/**
 * The auth forms' own checks, pinned against the SERVER'S rules.
 *
 * These are not a restatement of the implementation. Every figure below is
 * read off `registerSchema` / `loginSchema` / `changePasswordSchema` in
 * backend/src/controllers/auth.controller.ts, because the only failure that
 * matters here is the two drifting apart:
 *
 *   - stricter than the server → an owner is refused an account the server
 *     would have created, and nothing tells them the app invented the rule;
 *   - looser than the server → a request is sent that is already known to
 *     fail, which is the round trip client validation exists to save.
 *
 * mobile/tests/authValidation.test.ts asserts the same figures against its
 * own copy, which is what keeps the two clients honest with each other.
 */

describe("the figures match the server's schema", () => {
  it("requires the same password length the server does", () => {
    // `MIN_PASSWORD_LENGTH` in backend/src/controllers/auth.controller.ts.
    // Raised from eight: eight is within reach of an offline attack on a leaked
    // hash, and this app holds a business's financial history. The backend's
    // contract suite asserts all three files agree; this pins the figure so a
    // change here is a deliberate edit rather than a silent drift.
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it("uses the same name and phone ceilings", () => {
    // `z.string().min(1).max(100)` on names, `.max(20)` on phoneNumber.
    expect(MAX_NAME_LENGTH).toBe(100);
    expect(MAX_PHONE_LENGTH).toBe(20);
  });
});

describe("isPlausibleEmail", () => {
  /**
   * DELIBERATELY PERMISSIVE. `z.string().email()` accepts all of these, and a
   * client that refused one would lock a real person out of an account the
   * server was willing to create.
   */
  it("accepts the awkward addresses that are still valid", () => {
    for (const address of [
      "owner@shop.ph",
      "owner+receipts@shop.ph",
      "first.last@sub.domain.co.uk",
      "o'brien@shop.ph",
      "shop123@my-store.ph",
      "OWNER@SHOP.PH",
    ]) {
      expect(isPlausibleEmail(address), address).toBe(true);
    }
  });

  /** Only the shapes that cannot be an address at all. */
  it("rejects what could not be an address", () => {
    for (const address of [
      "",
      "owner",
      "@shop.ph",
      "owner@",
      "owner@shop",
      "owner@@shop.ph",
      "owner @shop.ph",
      "owner@shop..ph",
      "owner@.ph",
    ]) {
      expect(isPlausibleEmail(address), address).toBe(false);
    }
  });

  /** Leading or trailing space is a paste artefact, not an address. */
  it("rejects untrimmed input rather than silently trimming it", () => {
    expect(isPlausibleEmail(" owner@shop.ph")).toBe(false);
    expect(isPlausibleEmail("owner@shop.ph ")).toBe(false);
  });
});

describe("validateLogin", () => {
  it("passes a filled-in form", () => {
    expect(isValid(validateLogin({ email: "owner@shop.ph", password: "hunter2" }))).toBe(true);
  });

  it("names each empty box separately", () => {
    const errors = validateLogin({ email: "", password: "" });
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });

  /**
   * THE ONE THAT WOULD BE WRONG TO ADD. The server's `loginSchema` asks only
   * for `password: z.string().min(1)` — it does not re-apply the eight
   * character rule. Telling someone their existing password is "too short"
   * while trying to log in would be false, and alarming in a way that
   * suggests their account has been changed.
   */
  it("does not apply the minimum length to an existing password", () => {
    expect(isValid(validateLogin({ email: "owner@shop.ph", password: "abc" }))).toBe(true);
  });
});

describe("validateRegister", () => {
  /*
   * `confirmPassword` is carried here because registration now asks for it.
   * The server has no counterpart — it is never sent — so it is the one rule on
   * this form that is the client's alone, and it exists because a mistyped
   * password at registration is a lockout rather than an error message: the
   * account it creates cannot be logged into, and the way out is a reset link
   * sent to an inbox that may have been mistyped in the same sitting.
   */
  const good = {
    firstName: "Ken",
    lastName: "Reyes",
    email: "owner@shop.ph",
    password: "a".repeat(MIN_PASSWORD_LENGTH),
    confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH),
  };

  it("passes a complete form", () => {
    expect(isValid(validateRegister(good))).toBe(true);
  });

  it("requires a name at both ends", () => {
    expect(validateRegister({ ...good, firstName: "   " }).firstName).toBeTruthy();
    expect(validateRegister({ ...good, lastName: "" }).lastName).toBeTruthy();
  });

  it("applies the server's password minimum", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateRegister({ ...good, password: short, confirmPassword: short }).password).toBeTruthy();
    expect(isValid(validateRegister({ ...good }))).toBe(true);
  });

  it("catches a mistyped confirmation", () => {
    expect(validateRegister({ ...good, confirmPassword: "something-else-entirely" }).confirmPassword).toBeTruthy();
    expect(validateRegister({ ...good, confirmPassword: "" }).confirmPassword).toBeTruthy();
  });

  it("applies the server's length ceilings", () => {
    expect(validateRegister({ ...good, firstName: "a".repeat(MAX_NAME_LENGTH + 1) }).firstName).toBeTruthy();
    expect(validateRegister({ ...good, middleName: "a".repeat(MAX_NAME_LENGTH + 1) }).middleName).toBeTruthy();
    expect(validateRegister({ ...good, phoneNumber: "9".repeat(MAX_PHONE_LENGTH + 1) }).phoneNumber).toBeTruthy();
  });

  /** Both are `.optional()` server-side, so blank must not be an error. */
  it("leaves the optional fields alone when they are empty", () => {
    expect(isValid(validateRegister({ ...good, middleName: "", phoneNumber: "" }))).toBe(true);
  });

  /**
   * All at once, not one at a time. Reporting the first problem and stopping
   * turns a six-field form into six submissions.
   */
  it("reports every problem in one pass", () => {
    const errors = validateRegister({
      firstName: "",
      lastName: "",
      email: "nope",
      password: "short",
      confirmPassword: "",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "confirmPassword",
      "email",
      "firstName",
      "lastName",
      "password",
    ]);
  });
});

describe("validateRecoverPassword", () => {
  it("checks the address before a request that cannot report a typo", () => {
    expect(validateRecoverPassword({ email: "not-an-address" }).email).toBeTruthy();
    expect(isValid(validateRecoverPassword({ email: "owner@shop.ph" }))).toBe(true);
  });
});

describe("validateChangePassword", () => {
  const good = { currentPassword: "old-password", newPassword: "new-password", confirmPassword: "new-password" };

  it("passes a complete form", () => {
    expect(isValid(validateChangePassword(good))).toBe(true);
  });

  it("applies the minimum to the NEW password only", () => {
    // The current one is whatever it already is — the server asks `min(1)`.
    expect(isValid(validateChangePassword({ ...good, currentPassword: "x" }))).toBe(true);
    expect(validateChangePassword({ ...good, newPassword: "short", confirmPassword: "short" }).newPassword)
      .toBeTruthy();
  });

  /**
   * `confirmPassword` has no server counterpart — it is not in
   * `changePasswordSchema` and never leaves the client. It exists so a typo
   * in a field nobody can read is caught before it becomes a password the
   * owner cannot reproduce, which is a lockout rather than an error message.
   */
  it("catches a mistyped confirmation", () => {
    expect(validateChangePassword({ ...good, confirmPassword: "new-passwrod" }).confirmPassword).toBeTruthy();
  });

  it("refuses a new password identical to the current one", () => {
    const same = { currentPassword: "same-password", newPassword: "same-password", confirmPassword: "same-password" };
    expect(validateChangePassword(same).newPassword).toBeTruthy();
  });
});

describe("validateResetPassword", () => {
  const good = { newPassword: "a".repeat(MIN_PASSWORD_LENGTH), confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH) };

  it("accepts a matching pair at the minimum", () => {
    expect(isValid(validateResetPassword(good))).toBe(true);
  });

  it("applies the same minimum as every other password this app creates", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateResetPassword({ newPassword: short, confirmPassword: short }).newPassword).toBeTruthy();
  });

  it("catches a mistyped confirmation", () => {
    expect(validateResetPassword({ ...good, confirmPassword: "b".repeat(MIN_PASSWORD_LENGTH) }).confirmPassword).toBeTruthy();
  });

  /**
   * The difference from `validateChangePassword`, pinned so nobody "fixes" it
   * later by adding a current-password check. Someone on a reset screen is
   * there precisely because they do not know the old password — there is
   * nothing to compare against, and no "that is the one you already use" that
   * could be said truthfully.
   */
  it("has no current password to compare against", () => {
    expect(Object.keys(validateResetPassword({ newPassword: "", confirmPassword: "" })).sort()).toEqual([
      "confirmPassword",
      "newPassword",
    ]);
  });
});
