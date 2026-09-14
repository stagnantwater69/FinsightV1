import { describe, expect, it } from "vitest";
import { confirmSchema } from "../../src/controllers/receiptScan.controller";

/**
 * P2-7. The confirm body has two modes and nothing else:
 *
 *   manual    { ...shared, splits }
 *   itemised  { ...shared, itemAssignments, additionalItems?, reconciliation? }
 *
 * The schema used to accept every combination, and the service picked the
 * itemised path whenever `itemAssignments` was present, so a body carrying
 * both had its `splits` dropped in silence, and a manual body carrying
 * `additionalItems` lost lines the owner had typed in. Financial input that
 * the server accepts must never be ignored, so every mix is refused here, at
 * the boundary, with the ordinary validation response.
 */

const shared = {
  expectedScanRevision: 3,
  date: "2026-07-31",
  description: "Grocery run",
  vendor: "Savemore",
  amount: 1400,
};

const splits = [{ categoryId: 7, amount: 1400 }];
const itemAssignments = [
  { itemId: 1, categoryId: 7 },
  { itemId: 2, categoryId: 8 },
];
const additionalItems = [{ name: "Bagged ice", amount: 40, categoryId: 7 }];
const reconciliation = { mode: "proportional" as const };
const duplicateDecision = { action: "SAVE_ANYWAY" as const, candidateSetHash: "a".repeat(64) };

function issues(body: unknown) {
  const result = confirmSchema.safeParse(body);
  expect(result.success).toBe(false);
  return result.error!.flatten();
}

describe("accepted confirmation modes", () => {
  it("manual: shared fields plus splits", () => {
    const parsed = confirmSchema.parse({ ...shared, splits });
    expect(parsed).toEqual({ ...shared, splits });
  });

  it("manual with the optional shared fields present", () => {
    const parsed = confirmSchema.parse({ ...shared, duplicateDecision, splits });
    expect(parsed.duplicateDecision).toEqual(duplicateDecision);
  });

  it("manual with the optional shared fields absent", () => {
    const { expectedScanRevision: _revision, vendor: _vendor, ...required } = shared;
    expect(confirmSchema.safeParse({ ...required, splits }).success).toBe(true);
  });

  it("itemised: shared fields plus itemAssignments alone", () => {
    const parsed = confirmSchema.parse({ ...shared, itemAssignments });
    expect(parsed).toEqual({ ...shared, itemAssignments });
  });

  it("itemised with owner-added lines and every reconciliation mode", () => {
    for (const mode of [
      { mode: "none" as const },
      { mode: "proportional" as const },
      { mode: "category" as const, categoryId: 9 },
    ]) {
      const body = { ...shared, itemAssignments, additionalItems, reconciliation: mode };
      const result = confirmSchema.safeParse(body);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });

  it("itemised where every line was typed in by the owner", () => {
    const parsed = confirmSchema.parse({ ...shared, itemAssignments: [], additionalItems });
    expect(parsed.itemAssignments).toEqual([]);
    expect(parsed.additionalItems).toEqual(additionalItems);
  });

  it("manual with an empty split list still reaches the service, which names the problem", () => {
    // Pinned so the owner keeps seeing "Assign the receipt to at least one
    // category" rather than a generic validation failure for this case.
    expect(confirmSchema.parse({ ...shared, splits: [] }).splits).toEqual([]);
  });
});

describe("mixed modes are refused, never silently trimmed", () => {
  const BOTH = "Send either splits or itemAssignments, not both";
  const ONLY_ITEMISED = (field: string) => `${field} only applies to an itemised confirmation`;

  it("splits + itemAssignments", () => {
    expect(issues({ ...shared, splits, itemAssignments }).formErrors).toEqual([BOTH]);
  });

  it("splits + additionalItems", () => {
    expect(issues({ ...shared, splits, additionalItems }).fieldErrors).toEqual({
      additionalItems: [ONLY_ITEMISED("additionalItems")],
    });
  });

  it("splits + reconciliation", () => {
    expect(issues({ ...shared, splits, reconciliation }).fieldErrors).toEqual({
      reconciliation: [ONLY_ITEMISED("reconciliation")],
    });
  });

  it("splits + itemAssignments + additionalItems", () => {
    const flat = issues({ ...shared, splits, itemAssignments, additionalItems });
    expect(flat.formErrors).toEqual([BOTH]);
    expect(flat.fieldErrors).toEqual({ additionalItems: [ONLY_ITEMISED("additionalItems")] });
  });

  it("splits + itemAssignments + reconciliation", () => {
    const flat = issues({ ...shared, splits, itemAssignments, reconciliation });
    expect(flat.formErrors).toEqual([BOTH]);
    expect(flat.fieldErrors).toEqual({ reconciliation: [ONLY_ITEMISED("reconciliation")] });
  });

  it("splits + additionalItems + reconciliation", () => {
    const flat = issues({ ...shared, splits, additionalItems, reconciliation });
    expect(flat.formErrors).toEqual([]);
    expect(flat.fieldErrors).toEqual({
      additionalItems: [ONLY_ITEMISED("additionalItems")],
      reconciliation: [ONLY_ITEMISED("reconciliation")],
    });
  });

  it("every field at once", () => {
    const flat = issues({ ...shared, splits, itemAssignments, additionalItems, reconciliation });
    expect(flat.formErrors).toEqual([BOTH]);
    expect(Object.keys(flat.fieldErrors).sort()).toEqual(["additionalItems", "reconciliation"]);
  });

  it("an empty split list is still a manual confirmation and still conflicts", () => {
    expect(issues({ ...shared, splits: [], itemAssignments }).formErrors).toEqual([BOTH]);
    expect(issues({ ...shared, splits: [], additionalItems }).fieldErrors).toHaveProperty("additionalItems");
    // Both empty: presence decides, so two empty lists are still two modes.
    expect(issues({ ...shared, splits: [], itemAssignments: [] }).formErrors).toEqual([BOTH]);
  });
});

describe("missing members", () => {
  it("neither splits nor itemAssignments", () => {
    expect(issues({ ...shared }).formErrors).toEqual([
      "Send splits for a manual confirmation or itemAssignments for an itemised one",
    ]);
  });

  it("additionalItems or reconciliation without itemAssignments is not an itemised confirmation", () => {
    expect(issues({ ...shared, additionalItems }).formErrors).toEqual([
      "Send splits for a manual confirmation or itemAssignments for an itemised one",
    ]);
    expect(issues({ ...shared, reconciliation }).formErrors).toEqual([
      "Send splits for a manual confirmation or itemAssignments for an itemised one",
    ]);
  });

  it("a required shared field, in either mode", () => {
    for (const field of ["date", "description", "amount"] as const) {
      const { [field]: _omitted, ...rest } = shared;
      expect(issues({ ...rest, splits }).fieldErrors).toHaveProperty(field);
      expect(issues({ ...rest, itemAssignments }).fieldErrors).toHaveProperty(field);
    }
  });

  it("a required member of a split, an assignment, an added line or a category reconciliation", () => {
    expect(issues({ ...shared, splits: [{ amount: 1400 }] }).fieldErrors).toHaveProperty("splits");
    expect(issues({ ...shared, splits: [{ categoryId: 7 }] }).fieldErrors).toHaveProperty("splits");
    expect(issues({ ...shared, itemAssignments: [{ itemId: 1 }] }).fieldErrors).toHaveProperty("itemAssignments");
    expect(issues({ ...shared, itemAssignments: [{ categoryId: 7 }] }).fieldErrors).toHaveProperty("itemAssignments");
    expect(issues({ ...shared, itemAssignments, additionalItems: [{ amount: 40, categoryId: 7 }] }).fieldErrors)
      .toHaveProperty("additionalItems");
    expect(issues({ ...shared, itemAssignments, additionalItems: [{ name: "Ice", categoryId: 7 }] }).fieldErrors)
      .toHaveProperty("additionalItems");
    expect(issues({ ...shared, itemAssignments, additionalItems: [{ name: "Ice", amount: 40 }] }).fieldErrors)
      .toHaveProperty("additionalItems");
    expect(issues({ ...shared, itemAssignments, reconciliation: { mode: "category" } }).fieldErrors)
      .toHaveProperty("reconciliation");
    expect(issues({ ...shared, duplicateDecision: { action: "SAVE_ANYWAY" }, splits }).fieldErrors)
      .toHaveProperty("duplicateDecision");
  });
});

describe("unknown members", () => {
  it("at the top level, in either mode", () => {
    expect(JSON.stringify(issues({ ...shared, splits, categoryId: 7 }))).toContain("categoryId");
    expect(JSON.stringify(issues({ ...shared, itemAssignments, mode: "itemised" }))).toContain("mode");
  });

  it("inside a split, an assignment, an added line, a reconciliation or a duplicate decision", () => {
    expect(issues({ ...shared, splits: [{ categoryId: 7, amount: 1400, itemIds: [1] }] }).fieldErrors)
      .toHaveProperty("splits");
    expect(issues({ ...shared, itemAssignments: [{ itemId: 1, categoryId: 7, amount: 5 }] }).fieldErrors)
      .toHaveProperty("itemAssignments");
    expect(issues({ ...shared, itemAssignments, additionalItems: [{ ...additionalItems[0], itemId: 3 }] }).fieldErrors)
      .toHaveProperty("additionalItems");
    expect(issues({ ...shared, itemAssignments, reconciliation: { mode: "proportional", categoryId: 9 } }).fieldErrors)
      .toHaveProperty("reconciliation");
    expect(issues({ ...shared, splits, duplicateDecision: { ...duplicateDecision, note: "x" } }).fieldErrors)
      .toHaveProperty("duplicateDecision");
  });
});
