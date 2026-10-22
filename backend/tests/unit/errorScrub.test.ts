import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText } from "../../src/lib/errorScrub";

describe("scrubText", () => {
  it("redacts emails, bearer tokens, JWTs and connection strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const text =
      `Unknown email owner@example.ph; Authorization: Bearer abc.def; token ${jwt}; ` +
      "db postgresql://postgres.ref:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres";
    const scrubbed = scrubText(text);
    expect(scrubbed).not.toContain("owner@example.ph");
    expect(scrubbed).not.toContain("abc.def");
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).toBe(
      "Unknown email [email]; Authorization: Bearer [token] token [token]; db [connection-string]",
    );
  });

  it("leaves ordinary error text alone", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'id')")).toBe(
      "Cannot read properties of undefined (reading 'id')",
    );
  });
});

describe("scrubEvent", () => {
  it("drops the request, the user and breadcrumbs entirely", () => {
    const event = scrubEvent({
      request: { data: { password: "hunter2" }, headers: { authorization: "Bearer x" } },
      user: { email: "owner@example.ph" },
      breadcrumbs: [{ message: "POST /auth/login" }],
    });
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("breadcrumbs");
  });

  it("keeps only the operation and the reason from a Prisma error, never its arguments", () => {
    const value = [
      "Invalid `prisma.expenseRecord.create()` invocation in",
      "/app/dist/services/expenseRecord.service.js:120:40",
      "{",
      '  data: { description: "Rice for Aling Nena", amount: 1250, vendor: "owner@example.ph" }',
      "}",
      "Argument `date`: Invalid value provided. Expected DateTime, provided String.",
    ].join("\n");
    const event = scrubEvent({ exception: { values: [{ type: "PrismaClientValidationError", value }] } });
    const kept = event.exception?.values?.[0]?.value ?? "";
    expect(kept).toBe(
      "Invalid `prisma.expenseRecord.create()` invocation in … Argument `date`: Invalid value provided. Expected DateTime, provided String.",
    );
    expect(kept).not.toContain("Aling Nena");
    expect(kept).not.toContain("1250");
  });

  it("redacts the message and every other exception value", () => {
    const event = scrubEvent({
      message: "reset failed for owner@example.ph",
      exception: { values: [{ type: "Error", value: "no account for owner@example.ph" }] },
    });
    expect(event.message).toBe("reset failed for [email]");
    expect(event.exception?.values?.[0]?.value).toBe("no account for [email]");
  });
});
