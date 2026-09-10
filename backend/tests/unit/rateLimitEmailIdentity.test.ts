import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { byEmail } from "../../src/middleware/rateLimit.middleware";

function reqWith(body: unknown): Request {
  return { body } as unknown as Request;
}

/**
 * THE DEFECT THIS PINS (SEC-001). This identity becomes the PRIMARY KEY of a
 * varchar(255) row in ApiRateLimit, and the limiter runs BEFORE Zod — so the
 * raw address it used to return meant an over-long "email" reached the INSERT
 * unvalidated and failed at the database, turning a rate-limit check on the
 * login route into a 500. Storing the address itself was also PII the limiter
 * never needed: it only has to know that two requests name the same account.
 */
describe("byEmail rate-limit identity", () => {
  it("stays short and fixed-length however long the address is", () => {
    const absurd = `${"a".repeat(5000)}@shop.ph`;
    const identity = byEmail(reqWith({ email: absurd }))!;

    expect(identity).toBeDefined();
    // Comfortably inside varchar(255) even once the limiter name is prefixed.
    expect(identity.length).toBeLessThan(64);
    expect(identity.length).toBe(byEmail(reqWith({ email: "owner@shop.ph" }))!.length);
  });

  it("does not carry the address itself", () => {
    const identity = byEmail(reqWith({ email: "owner@shop.ph" }))!;
    expect(identity).not.toContain("owner");
    expect(identity).not.toContain("shop.ph");
    expect(identity).toMatch(/^e[0-9a-f]+$/);
  });

  it("keeps the `e` prefix so it cannot collide with a user- or IP-keyed bucket", () => {
    // `u<id>` and `ip<addr>` are the other two identity shapes; a hex digest
    // behind `e` can never be read as either.
    expect(byEmail(reqWith({ email: "owner@shop.ph" }))!.startsWith("e")).toBe(true);
  });

  it("still maps one address to one bucket, whatever its case or spacing", () => {
    // Normalisation has to happen BEFORE hashing, or the limit is bypassed by
    // holding down shift.
    expect(byEmail(reqWith({ email: "  OWNER@Shop.PH " }))).toBe(byEmail(reqWith({ email: "owner@shop.ph" })));
  });

  it("still gives two addresses two buckets", () => {
    expect(byEmail(reqWith({ email: "a@shop.ph" }))).not.toBe(byEmail(reqWith({ email: "b@shop.ph" })));
  });

  it("still skips the limiter when there is no address to key on", () => {
    expect(byEmail(reqWith({}))).toBeUndefined();
    expect(byEmail(reqWith({ email: "   " }))).toBeUndefined();
    expect(byEmail(reqWith(undefined))).toBeUndefined();
    expect(byEmail(reqWith({ email: 42 }))).toBeUndefined();
  });
});
