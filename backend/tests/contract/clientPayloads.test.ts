import { describe, expect, it } from "vitest";
import { confirmSchema } from "../../src/controllers/receiptScan.controller";
// Imported ACROSS the project boundary on purpose — this is the mobile app's
// real payload builder, not a copy of it. The file is deliberately free of
// React Native imports so it can be loaded here.
import {
  buildItemisedConfirmPayload,
  buildReceiptConfirmPayload,
} from "../../../mobile/src/lib/receiptConfirm";
// Web's real builder too, for the same reason — not a copy of it.
import { buildReceiptConfirmPayload as buildWebConfirmPayload } from "../../../web/src/lib/receiptConfirm";

/**
 * Client/server contract tests.
 *
 * WHY THIS FILE EXISTS: mobile posted `categoryId` to the receipt confirm
 * endpoint long after the server stopped accepting one. Zod strips unknown
 * keys rather than rejecting them, so the field disappeared without an error,
 * `splits` arrived empty, and EVERY receipt confirmation on mobile failed with
 * "Assign the receipt to at least one category". Nobody noticed because:
 *
 *   - backend tests only ever exercised payloads the backend itself built;
 *   - the mobile response was typed `any`;
 *   - the two apps share no contract, and this repo has no workspace linking
 *     them.
 *
 * Note what would NOT have caught it. Sharing a types package would not have:
 * the mobile call passed an untyped object literal, so no shared type was ever
 * involved. The only thing that catches a client sending the wrong shape is
 * checking a real client payload against the real server schema, which is what
 * this does.
 *
 * Both halves are imported rather than restated. A fixture copied into this
 * file would be free to drift exactly as the client did.
 */

describe("mobile -> POST /records/receipts/:id/confirm", () => {
  const input = {
    date: "2026-07-31",
    description: "Groceries",
    vendor: "ABC Sari-Sari Store",
    amount: 188,
    categoryId: 7,
  };

  it("builds a payload the server accepts", () => {
    const result = confirmSchema.safeParse(buildReceiptConfirmPayload(input));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  /**
   * The specific regression, pinned from the SERVER's side.
   *
   * A split is what actually carries the category. If a future change to this
   * screen goes back to a bare categoryId, the field is silently dropped and
   * the receipt cannot be confirmed at all — so assert the category survives
   * parsing, not merely that the payload is accepted.
   */
  it("carries the category through parsing, where a bare categoryId would be dropped", () => {
    const parsed = confirmSchema.parse(buildReceiptConfirmPayload(input));
    expect(parsed.splits).toEqual([{ categoryId: 7, amount: 188 }]);
    expect(parsed).not.toHaveProperty("categoryId");
  });

  it("survives a receipt with no vendor", () => {
    const result = confirmSchema.safeParse(buildReceiptConfirmPayload({ ...input, vendor: "" }));
    expect(result.success).toBe(true);
  });

  it("survives awkward but legal amounts", () => {
    for (const amount of [0.01, 1220.55, 99999.99]) {
      const result = confirmSchema.safeParse(buildReceiptConfirmPayload({ ...input, amount }));
      expect(result.success, `amount ${amount}`).toBe(true);
    }
  });

  /**
   * Guards the failure this endpoint produces when a client gets it wrong.
   * Kept here so the connection between "empty splits" and the error the owner
   * actually sees stays visible from the contract side.
   */
  it("would be rejected downstream if splits were ever empty again", () => {
    // Built from the builder rather than spread from `input`, which carries a
    // categoryId the schema now (correctly) refuses.
    const parsed = confirmSchema.parse({ ...buildReceiptConfirmPayload(input), splits: [] });
    // The schema itself allows it; receiptScan.service is what refuses, with
    // "Assign the receipt to at least one category". That split of
    // responsibility is why the schema alone could not catch the original bug.
    expect(parsed.splits).toEqual([]);
  });
});

/**
 * mobile -> the same endpoint, itemised.
 *
 * Mobile now reviews a multi-item receipt line by line, as web does, and
 * sends `itemAssignments` plus a reconciliation rather than splits it worked
 * out itself. Checked against the real schema for the same reason as above:
 * this is the shape most likely to drift, because it has the most parts.
 */
describe("mobile -> POST /records/receipts/:id/confirm (itemised)", () => {
  const base = {
    date: "2026-07-31",
    description: "Grocery run",
    vendor: "Savemore",
    totalAmount: 1400,
    itemsTotal: 1400,
    itemAssignments: [
      { itemId: 1, categoryId: 7 },
      { itemId: 2, categoryId: 8 },
    ],
    plan: null,
  } as const;

  it("builds a payload the server accepts when the items reconcile", () => {
    const result = confirmSchema.safeParse(buildItemisedConfirmPayload({ ...base }));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("builds an accepted payload for every reconciliation plan", () => {
    const withGap = { ...base, totalAmount: 1568 };
    const plans = [
      { ...withGap, plan: "proportional" as const },
      { ...withGap, plan: "category" as const, gapCategoryId: 9 },
      { ...withGap, plan: "shrink" as const },
    ];
    for (const input of plans) {
      const result = confirmSchema.safeParse(buildItemisedConfirmPayload(input));
      expect(result.success, `${input.plan}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  /**
   * The itemised path must not send splits as well. The server derives its
   * own from the assignments so the amounts it writes and the item -> record
   * links it writes come from one grouping; sending both invites them to
   * disagree.
   */
  it("builds an accepted payload with owner-added lines", () => {
    const result = confirmSchema.safeParse(
      buildItemisedConfirmPayload({
        ...base,
        itemsTotal: 1440,
        totalAmount: 1440,
        additionalItems: [{ name: "Bagged ice", amount: 40, categoryId: 7 }],
      }),
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("sends assignments rather than splits", () => {
    const parsed = confirmSchema.parse(buildItemisedConfirmPayload({ ...base }));
    expect(parsed.itemAssignments).toHaveLength(2);
    expect(parsed.splits).toBeUndefined();
  });
});

/**
 * web -> the same endpoint, in its two shapes.
 *
 * These now import web's REAL builder, the same way the mobile cases above
 * do. They previously restated web's payload by hand, which could only ever
 * catch the server changing under web and never web drifting away from the
 * fixture. Extracting that builder needed tests on the web side first, since
 * it is a working save path; those exist now
 * (web/src/lib/receiptConfirm.test.ts).
 */
describe("web -> POST /records/receipts/:id/confirm", () => {
  const common = {
    date: "2026-07-31",
    description: "Grocery run",
    vendor: "Savemore",
    amount: 1400,
    additionalItems: [],
    gapCategoryId: null,
    gapPlan: null,
  } as const;

  const manual = {
    ...common,
    isItemised: false,
    itemAssignments: [],
    itemsTotal: 0,
    splits: [{ categoryId: 7, amount: 1400 }],
  };

  const itemised = {
    ...common,
    isItemised: true,
    itemsTotal: 1400,
    itemAssignments: [
      { itemId: 1, categoryId: 7 },
      { itemId: 2, categoryId: 8 },
    ],
    splits: [],
  };

  it("accepts the manual split shape", () => {
    const result = confirmSchema.safeParse(buildWebConfirmPayload(manual));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("accepts a hand-made multi-category split", () => {
    const result = confirmSchema.safeParse(
      buildWebConfirmPayload({
        ...manual,
        splits: [
          { categoryId: 7, amount: 1000 },
          { categoryId: 8, amount: 400 },
        ],
      }),
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("accepts the itemised shape", () => {
    const result = confirmSchema.safeParse(buildWebConfirmPayload(itemised));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("accepts the itemised shape with owner-added lines", () => {
    const result = confirmSchema.safeParse(
      buildWebConfirmPayload({
        ...itemised,
        itemsTotal: 1440,
        amount: 1440,
        additionalItems: [{ name: "Bagged ice", amount: 40, categoryId: 7 }],
      }),
    );
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("accepts every reconciliation plan the screen can produce", () => {
    const withGap = { ...itemised, amount: 1568 };
    const plans = [
      { ...withGap, gapPlan: "proportional" as const },
      { ...withGap, gapPlan: "category" as const, gapCategoryId: 9 },
      { ...withGap, gapPlan: "shrink" as const },
    ];
    for (const input of plans) {
      const result = confirmSchema.safeParse(buildWebConfirmPayload(input));
      expect(result.success, `${input.gapPlan}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("never sends both shapes at once", () => {
    expect(confirmSchema.parse(buildWebConfirmPayload(itemised)).splits).toBeUndefined();
    expect(confirmSchema.parse(buildWebConfirmPayload(manual)).itemAssignments).toBeUndefined();
  });
});

/**
 * The systemic half of the fix.
 *
 * The original bug was only mysterious because the unknown field was thrown
 * away in silence. With `.strict()` the same mistake now names itself, so the
 * next client to drift gets told which key is wrong instead of being sent to
 * debug an unrelated error message.
 */
describe("unknown fields are refused rather than silently dropped", () => {
  const valid = {
    date: "2026-07-31",
    description: "Groceries",
    amount: 188,
    splits: [{ categoryId: 7, amount: 188 }],
  };

  it("accepts a payload with exactly the right keys", () => {
    expect(confirmSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects the historical mistake instead of ignoring it", () => {
    const result = confirmSchema.safeParse({ ...valid, categoryId: 7 });
    expect(result.success).toBe(false);
    // The error has to actually name the field, or this buys nothing.
    expect(JSON.stringify(result.error?.issues)).toContain("categoryId");
  });

  it("rejects a typo in a field name", () => {
    const result = confirmSchema.safeParse({ ...valid, splts: [] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("splts");
  });
});
