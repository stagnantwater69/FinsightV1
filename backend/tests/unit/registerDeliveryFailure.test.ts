import { describe, expect, it } from "vitest";

/**
 * A mail-send failure during registration must be LOUD in the logs and SILENT
 * to the caller.
 *
 * Silent to the caller because registration answers identically whether or not
 * an address exists — telling someone "we couldn't send that" leaks that the
 * address was registerable. Loud in the logs because the owner is meanwhile
 * being told to check an inbox nothing was sent to, and nobody finds that by
 * staring at the UI.
 *
 * It previously filed under `register.rejected`, which also fires on every
 * duplicate-address signup, so a mail outage was indistinguishable from
 * routine traffic. Supabase's built-in mailer caps at a few sends an hour and
 * answers 429 past that, so this is the common case in development, not a
 * rare one.
 *
 * The classifier is unexported, so this pins its behaviour through the source
 * — enough to catch someone narrowing it to `status === 429` and losing the
 * SMTP-fault cases, which is the plausible regression.
 */
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../src/services/auth.service.ts"),
  "utf8",
);

describe("registration delivery failures", () => {
  it("classifies mailer failures separately from address rejections", () => {
    expect(SOURCE).toContain("function isDeliveryFailure");
    // Every shape GoTrue reports a send problem in.
    expect(SOURCE).toMatch(/error\.status === 429/);
    expect(SOURCE).toMatch(/error\.status >= 500/);
    expect(SOURCE).toMatch(/rate_limit\|email_send\|smtp\|mail/);
    expect(SOURCE).toMatch(/rate limit\|sending\|smtp\|mailer\|confirmation email/);
    // The SMTP reply-code branch, which prose matching alone misses.
    expect(SOURCE).toMatch(/\[45\]\\d\{2\}/);
  });

  /*
   * Reproduces the exact string Gmail returned when the App Password was
   * wrong. It names neither "smtp" nor "sending", so a keyword-only classifier
   * filed a total mail outage as a routine registration rejection. The
   * classifier is unexported, so this re-implements it from the source to
   * evaluate real inputs rather than only asserting the source text.
   */
  it("catches a real SMTP failure that names neither smtp nor sending", () => {
    const body = SOURCE.slice(
      SOURCE.indexOf("function isDeliveryFailure"),
      SOURCE.indexOf("function redirectFor"),
    );
    const isDeliveryFailure = new Function(
      "error",
      body.replace(/^function isDeliveryFailure\([^)]*\)[^{]*\{/, "").replace(/\}\s*$/, ""),
    ) as (e: unknown) => boolean;

    const gmailBadCredentials = {
      status: 500,
      message:
        '535 "5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials"',
    };
    expect(isDeliveryFailure(gmailBadCredentials)).toBe(true);

    // The same reply code with no status attached still classifies.
    expect(isDeliveryFailure({ message: '535 "5.7.8 Username and Password not accepted"' })).toBe(true);
    expect(isDeliveryFailure({ message: "550 5.1.1 The email account does not exist" })).toBe(true);
    expect(isDeliveryFailure({ status: 429, message: "email rate limit exceeded" })).toBe(true);

    // And the request-level rejections must NOT be swept up as delivery.
    expect(isDeliveryFailure({ status: 422, message: "User already registered" })).toBe(false);
    expect(isDeliveryFailure({ status: 400, code: "weak_password", message: "Password is too short" })).toBe(
      false,
    );
    expect(isDeliveryFailure(null)).toBe(false);
  });

  it("reports them as an alertable delivery event, not as a rejection", () => {
    const branch = SOURCE.slice(SOURCE.indexOf("if (isDeliveryFailure(error))"));
    const body = branch.slice(0, branch.indexOf('reason: error?.message ?? "no user returned"'));
    expect(body).toContain('securityEvent("recovery.delivery_failed"');
    expect(body).toContain('kind: "registration"');
  });

  it("still answers the caller with the neutral acknowledgement", () => {
    const branch = SOURCE.slice(SOURCE.indexOf("if (isDeliveryFailure(error))"));
    const body = branch.slice(0, branch.indexOf('reason: error?.message ?? "no user returned"'));
    // No throw: a delivery failure must not become a distinguishable error.
    expect(body).not.toMatch(/throw new ApiError/);
    expect(body).toContain("return REGISTRATION_ACKNOWLEDGEMENT");
  });

  it("checks for delivery failure before the rejection path, or it is dead code", () => {
    /*
     * Anchored on the signUp-error rejection specifically. `register.rejected`
     * also fires earlier, for the already-has-a-profile check, and matching
     * that one would compare against the wrong branch entirely.
     */
    const signUpRejection = SOURCE.indexOf(
      'reason: error?.message ?? "no user returned"',
    );
    expect(signUpRejection).toBeGreaterThan(-1);
    expect(SOURCE.indexOf("if (isDeliveryFailure(error))")).toBeLessThan(signUpRejection);
  });
});
