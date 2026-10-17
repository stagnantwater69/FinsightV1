import { describe, expect, it } from "vitest";
import { manualRecordBaselineInstant, manualRecordIdempotencyKeySchema, manualRecordRequestIdentity } from "../../src/lib/manualRecordCreate";

describe("manual record request identity", () => {
  it("produces deterministic SHA-256 identities without storing the raw client key or financial details", () => {
    const input = [7, 12, "2026-10-10", "Synthetic purchase", "1234.56"];
    const first = manualRecordRequestIdentity(2, 7, "EXPENSE", "synthetic-save-0001", input);
    expect(manualRecordRequestIdentity(2, 7, "EXPENSE", "synthetic-save-0001", [...input])).toEqual(first);
    expect(first.keyHash).toMatch(/^[a-f0-9]{64}$/); expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("synthetic-save-0001"); expect(JSON.stringify(first)).not.toContain("Synthetic purchase");
  });

  it("separates owners, business profiles, record kinds and client keys", () => {
    const hashes = [
      manualRecordRequestIdentity(1, 7, "EXPENSE", "same-key-0001", []),
      manualRecordRequestIdentity(2, 7, "EXPENSE", "same-key-0001", []),
      manualRecordRequestIdentity(1, 8, "EXPENSE", "same-key-0001", []),
      manualRecordRequestIdentity(1, 7, "SALES", "same-key-0001", []),
      manualRecordRequestIdentity(1, 7, "EXPENSE", "other-key-0001", []),
    ].map((identity) => identity.keyHash);
    expect(new Set(hashes).size).toBe(5);
  });

  it("keeps request identity stable while a changed financial input changes its fingerprint", () => {
    const first = manualRecordRequestIdentity(1, 7, "EXPENSE", "same-key-0001", ["1234.56"]);
    const changed = manualRecordRequestIdentity(1, 7, "EXPENSE", "same-key-0001", ["1234.57"]);
    expect(changed.keyHash).toBe(first.keyHash); expect(changed.inputHash).not.toBe(first.inputHash);
  });

  it.each(["abcdefgh", "A_Z-0123456789", "x".repeat(100)])("accepts the documented safe key boundary %s", (key) => {
    expect(manualRecordIdempotencyKeySchema.parse(key)).toBe(key);
  });

  it.each(["x".repeat(7), "x".repeat(101), "abc defghi", "abc/defghi", "café-0001", 12345678, null])("rejects invalid key %j", (key) => {
    expect(manualRecordIdempotencyKeySchema.safeParse(key).success).toBe(false);
  });

  it("canonicalizes equivalent baseline instants without conflating missing and explicit decisions", () => {
    expect(manualRecordBaselineInstant("2026-10-10T08:00:00+08:00")).toBe("2026-10-10T00:00:00.000Z");
    expect(manualRecordBaselineInstant("2026-10-10T00:00:00Z")).toBe("2026-10-10T00:00:00.000Z");
    expect(manualRecordBaselineInstant(undefined)).toBeNull();
    expect(manualRecordBaselineInstant("invalid")).toBe("invalid");
  });
});
