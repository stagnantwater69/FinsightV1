import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  recoverPasswordSchema,
  MIN_PASSWORD_LENGTH,
  MAX_EMAIL_LENGTH,
} from "../../src/controllers/auth.controller";
// The REAL client validators, imported across the project boundary — not
// copies. Both files are deliberately free of React/react-native imports so
// they can be loaded here, the same arrangement receiptConfirm uses.
import * as mobileAuth from "../../../mobile/src/lib/authValidation";
import * as webAuth from "../../../web/src/lib/authValidation";

/**
 * The auth rules exist in THREE places, and this is what stops them drifting.
 *
 * The server owns them. Both clients now check the same things before sending
 * anything, which saves a round trip an owner on a phone tether pays for and
 * lets a rejection be shown under the field it belongs to. The cost of that
 * is two more copies of the rules, and two ways to be wrong:
 *
 *   - a client STRICTER than the server refuses an account the server would
 *     have created, and nothing tells the owner the app invented the rule;
 *   - a client LOOSER than the server sends a request already known to fail,
 *     which is the round trip the checking was meant to save.
 *
 * So this asserts AGREEMENT on real inputs rather than restating either side.
 * Each client's own suite pins the individual messages; this pins the verdict.
 */

/** Whether the server would accept this registration. */
const serverAcceptsRegister = (input: Record<string, unknown>) => registerSchema.safeParse(input).success;
const serverAcceptsLogin = (input: Record<string, unknown>) => loginSchema.safeParse(input).success;
const serverAcceptsChange = (input: Record<string, unknown>) => changePasswordSchema.safeParse(input).success;

const clientAcceptsRegister = {
  web: (i: Parameters<typeof webAuth.validateRegister>[0]) => webAuth.isValid(webAuth.validateRegister(i)),
  mobile: (i: Parameters<typeof mobileAuth.validateRegister>[0]) =>
    mobileAuth.isValid(mobileAuth.validateRegister(i)),
};

describe("the two clients are copies of each other", () => {
  /**
   * They are hand-kept mirrors, for the reason theme/tokens.ts gives: the
   * apps have no build-time relationship and a package to share ~150 lines
   * would couple their release cycles. Mirrors have to be checked.
   */
  it("agree on every constant", () => {
    expect(mobileAuth.MIN_PASSWORD_LENGTH).toBe(webAuth.MIN_PASSWORD_LENGTH);
    expect(mobileAuth.MAX_NAME_LENGTH).toBe(webAuth.MAX_NAME_LENGTH);
    expect(mobileAuth.MAX_PHONE_LENGTH).toBe(webAuth.MAX_PHONE_LENGTH);
    expect(mobileAuth.MAX_EMAIL_LENGTH).toBe(webAuth.MAX_EMAIL_LENGTH);
  });

  /**
   * The password minimum is the one constant that exists in all THREE files,
   * and the only one where a mismatch is silent in both directions: a client
   * short of the server refuses accounts the server would create, and a client
   * ahead of it sends requests it knows will fail. Pinned against the server's
   * own exported figure rather than against a literal, so raising it is one
   * edit in one place and this test says whether the other two followed.
   */
  it("agree with the SERVER on the password minimum", () => {
    expect(webAuth.MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
    expect(mobileAuth.MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
  });

  /**
   * The email ceiling is not a style choice: `User_Email` is `VARCHAR(150)`.
   * Without it on the server, registration created the Supabase Auth user,
   * failed the Prisma insert, rolled the auth user back and answered 500 — a
   * validation error dressed as a server fault. Without it on the clients, the
   * refusal only arrives after that round trip.
   */
  it("agrees with the SERVER on the widest address the database can hold", () => {
    expect(webAuth.MAX_EMAIL_LENGTH).toBe(MAX_EMAIL_LENGTH);
    expect(mobileAuth.MAX_EMAIL_LENGTH).toBe(MAX_EMAIL_LENGTH);
  });

  it("agree on which addresses are plausible", () => {
    for (const address of [
      "owner@shop.ph",
      "owner+receipts@shop.ph",
      "first.last@sub.domain.co.uk",
      "",
      "owner",
      "owner@shop",
      "owner@shop..ph",
      " owner@shop.ph",
    ]) {
      expect(mobileAuth.isPlausibleEmail(address), address).toBe(webAuth.isPlausibleEmail(address));
    }
  });
});

describe("register: client and server agree", () => {
  /*
   * `confirmPassword` is on the client side of this only. The server has no
   * counterpart — it is not in `registerSchema` and is never sent — so it is
   * carried in `base` purely to satisfy the client validators, and the schema
   * strips it. That asymmetry is intentional and is why it is stated here
   * rather than looking like an oversight.
   */
  const password = "a".repeat(webAuth.MIN_PASSWORD_LENGTH);
  const base = {
    firstName: "Ken",
    lastName: "Reyes",
    email: "owner@shop.ph",
    password,
    confirmPassword: password,
  };

  const cases: { name: string; input: typeof base & Record<string, string> }[] = [
    { name: "a complete registration", input: { ...base } },
    { name: "an address with plus-addressing", input: { ...base, email: "owner+r@shop.ph" } },
    { name: "a subdomain address", input: { ...base, email: "o@a.b.co.uk" } },
    { name: "an optional middle name", input: { ...base, middleName: "Cruz" } },
    { name: "an optional phone number", input: { ...base, phoneNumber: "09171234567" } },
    {
      name: "a password exactly at the minimum",
      input: { ...base, password: "a".repeat(MIN_PASSWORD_LENGTH), confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH) },
    },
    { name: "a name exactly at the ceiling", input: { ...base, firstName: "a".repeat(100) } },
    {
      name: "an address exactly at the ceiling",
      input: { ...base, email: `${"a".repeat(MAX_EMAIL_LENGTH - "@shop.ph".length)}@shop.ph` },
    },
  ];

  for (const { name, input } of cases) {
    it(`accepts ${name} on all three`, () => {
      expect(serverAcceptsRegister(input), "server").toBe(true);
      expect(clientAcceptsRegister.web(input), "web").toBe(true);
      expect(clientAcceptsRegister.mobile(input), "mobile").toBe(true);
    });
  }

  const rejected: { name: string; input: Record<string, string> }[] = [
    { name: "a missing first name", input: { ...base, firstName: "" } },
    { name: "a missing last name", input: { ...base, lastName: "" } },
    {
      name: "a password one short of the minimum",
      input: {
        ...base,
        password: "a".repeat(MIN_PASSWORD_LENGTH - 1),
        confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
      },
    },
    { name: "an address with no domain", input: { ...base, email: "owner@" } },
    { name: "an address with no @", input: { ...base, email: "owner.shop.ph" } },
    { name: "a name past the ceiling", input: { ...base, firstName: "a".repeat(101) } },
    { name: "a phone past the ceiling", input: { ...base, phoneNumber: "9".repeat(21) } },
    {
      name: "an address past what the column can hold",
      input: { ...base, email: `${"a".repeat(MAX_EMAIL_LENGTH)}@shop.ph` },
    },
  ];

  for (const { name, input } of rejected) {
    it(`rejects ${name} on all three`, () => {
      expect(serverAcceptsRegister(input), "server").toBe(false);
      expect(clientAcceptsRegister.web(input as never), "web").toBe(false);
      expect(clientAcceptsRegister.mobile(input as never), "mobile").toBe(false);
    });
  }
});

describe("login: client and server agree", () => {
  it("accepts any non-empty password, because the server does", () => {
    /*
      THE ASYMMETRY WORTH PINNING. `registerSchema` requires MIN_PASSWORD_LENGTH
      characters; `loginSchema` requires one. A client that applied the register
      rule here would tell someone with an older, shorter password that it is
      "too short" — refusing to even attempt a login that would have succeeded.
      That case became REAL, not theoretical, when the minimum went from eight
      to twelve: every account created before that has a password this form must
      still send.
    */
    const input = { email: "owner@shop.ph", password: "abc" };
    expect(serverAcceptsLogin(input), "server").toBe(true);
    expect(webAuth.isValid(webAuth.validateLogin(input)), "web").toBe(true);
    expect(mobileAuth.isValid(mobileAuth.validateLogin(input)), "mobile").toBe(true);
  });

  it("rejects an empty password on all three", () => {
    const input = { email: "owner@shop.ph", password: "" };
    expect(serverAcceptsLogin(input), "server").toBe(false);
    expect(webAuth.isValid(webAuth.validateLogin(input)), "web").toBe(false);
    expect(mobileAuth.isValid(mobileAuth.validateLogin(input)), "mobile").toBe(false);
  });
});

describe("change password: client and server agree", () => {
  it("holds the new password to the minimum and the current one to nothing", () => {
    const input = { currentPassword: "x", newPassword: "a".repeat(MIN_PASSWORD_LENGTH) };
    expect(serverAcceptsChange(input), "server").toBe(true);

    const withConfirm = { ...input, confirmPassword: input.newPassword };
    expect(webAuth.isValid(webAuth.validateChangePassword(withConfirm)), "web").toBe(true);
    expect(mobileAuth.isValid(mobileAuth.validateChangePassword(withConfirm)), "mobile").toBe(true);
  });

  it("rejects a short new password on all three", () => {
    const input = { currentPassword: "old-password", newPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1) };
    expect(serverAcceptsChange(input), "server").toBe(false);
    const withConfirm = { ...input, confirmPassword: input.newPassword };
    expect(webAuth.isValid(webAuth.validateChangePassword(withConfirm)), "web").toBe(false);
    expect(mobileAuth.isValid(mobileAuth.validateChangePassword(withConfirm)), "mobile").toBe(false);
  });

  /**
   * The one place the clients are ALLOWED to be stricter, and it is not a
   * drift: `confirmPassword` never reaches the server and exists only so a
   * typo in a field nobody can read is caught before it becomes a password
   * the owner cannot reproduce — a lockout rather than an error message.
   */
  it("adds a confirmation check the server has no opinion about", () => {
    const mismatch = {
      currentPassword: "old",
      newPassword: "a".repeat(MIN_PASSWORD_LENGTH),
      confirmPassword: "b".repeat(MIN_PASSWORD_LENGTH),
    };
    expect(
      serverAcceptsChange({ currentPassword: "old", newPassword: "a".repeat(MIN_PASSWORD_LENGTH) }),
      "server",
    ).toBe(true);
    expect(webAuth.isValid(webAuth.validateChangePassword(mismatch)), "web").toBe(false);
    expect(mobileAuth.isValid(mobileAuth.validateChangePassword(mismatch)), "mobile").toBe(false);
  });
});

describe("reset password: the two clients agree", () => {
  /*
   * No server counterpart, deliberately. The new password on a reset is set
   * directly against Supabase from the client holding the recovery token — it
   * never travels to our API — so there is no schema here to agree with, only
   * the two clients to keep identical. Supabase enforces its own minimum; these
   * validators exist so the owner is told before the round trip rather than by
   * a provider error.
   */
  const good = { newPassword: "a".repeat(MIN_PASSWORD_LENGTH), confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH) };

  it("accepts a matching pair at the minimum", () => {
    expect(webAuth.isValid(webAuth.validateResetPassword(good)), "web").toBe(true);
    expect(mobileAuth.isValid(mobileAuth.validateResetPassword(good)), "mobile").toBe(true);
  });

  it("rejects a short password on both", () => {
    const short = { newPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1), confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1) };
    expect(webAuth.isValid(webAuth.validateResetPassword(short)), "web").toBe(false);
    expect(mobileAuth.isValid(mobileAuth.validateResetPassword(short)), "mobile").toBe(false);
  });

  it("rejects a mismatch on both", () => {
    const mismatch = { ...good, confirmPassword: "b".repeat(MIN_PASSWORD_LENGTH) };
    expect(webAuth.isValid(webAuth.validateResetPassword(mismatch)), "web").toBe(false);
    expect(mobileAuth.isValid(mobileAuth.validateResetPassword(mismatch)), "mobile").toBe(false);
  });

  /**
   * The difference from change-password, pinned so it is not "fixed" later.
   * Someone on a reset screen is there because they do NOT know the old
   * password, so there is nothing to compare against and no "that is the one
   * you already use" to warn about.
   */
  it("has no current-password field to check against", () => {
    expect(webAuth.isValid(webAuth.validateResetPassword(good))).toBe(true);
    expect(
      webAuth.isValid(
        webAuth.validateChangePassword({ currentPassword: "", newPassword: good.newPassword, confirmPassword: good.confirmPassword }),
      ),
    ).toBe(false);
  });
});

describe("the server normalises addresses before anything else sees them", () => {
  const base = {
    firstName: "Ken",
    lastName: "Reyes",
    password: "a".repeat(MIN_PASSWORD_LENGTH),
  };

  /**
   * Supabase Auth lowercases addresses on its side. `User_Email` is a
   * case-SENSITIVE unique column. Without normalisation the profile row and the
   * identity it mirrors drift apart, and the uniqueness constraint turns out to
   * have been enforced only by Supabase happening to reject the duplicate
   * first — which is luck, not a constraint.
   */
  it("lowercases and trims what the clients send", () => {
    const parsed = registerSchema.parse({ ...base, email: "  Owner@Shop.PH  " });
    expect(parsed.email).toBe("owner@shop.ph");
  });

  it("normalises on login and recovery too, not just registration", () => {
    expect(loginSchema.parse({ email: "OWNER@shop.ph", password: "x" }).email).toBe("owner@shop.ph");
    expect(recoverPasswordSchema.parse({ email: "Owner@Shop.ph" }).email).toBe("owner@shop.ph");
  });

  it("defaults the redirect platform to web, and accepts only the two known clients", () => {
    expect(registerSchema.parse({ ...base, email: "a@b.ph" }).platform).toBe("web");
    expect(registerSchema.safeParse({ ...base, email: "a@b.ph", platform: "mobile" }).success).toBe(true);
    // Not a URL, and not an arbitrary string: the redirect address is chosen
    // from configuration server-side, because echoing back a client-supplied
    // one would be an open redirect carrying a live reset token.
    expect(registerSchema.safeParse({ ...base, email: "a@b.ph", platform: "https://evil.example" }).success).toBe(false);
  });

  /**
   * A THROWAWAY INBOX IS ACCEPTED, and that is the decision rather than an
   * oversight.
   *
   * Registration used to refuse these. The coverage maths kills it in both
   * directions at once: someone signing up in earnest is not using a throwaway,
   * and someone farming accounts to burn the AI budget uses one of the
   * thousands of services no hand-kept list contains. What remains is a narrow
   * middle that barely exists, set against a silent false positive — an owner
   * whose business email runs on a small provider, turned away, telling nobody.
   *
   * Email confirmation is what carries this weight. `isDisposableEmail` stays
   * as a logged signal (`register.disposable_domain`), asserted in
   * tests/integration/accountLifecycle.test.ts.
   */
  it("accepts a disposable address, leaving confirmation to do the work", () => {
    expect(registerSchema.safeParse({ ...base, email: "someone@mailinator.com" }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, email: "owner@shop.ph" }).success).toBe(true);
  });
});
