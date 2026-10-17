import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ values: new Map<string, string>(), failSet: false, writes: vi.fn(), os: "android" }));
vi.mock("react-native", () => ({ Platform: { get OS() { return native.os; } } }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "deviceOnly",
  getItemAsync: async (key: string) => native.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options: unknown) => {
    native.writes(key, value, options);
    if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("Native value exceeds byte limit");
    if (native.failSet) throw new Error("Synthetic storage failure");
    native.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => { native.values.delete(key); },
}));

import {
  clearReceiptReviewDraft,
  clearReceiptReviewDraftsForOwner,
  readReceiptReviewDraft,
  saveReceiptReviewDraft,
  type ReceiptReviewEdits,
} from "../src/lib/receiptReviewDraft";
import { hasUnsavedReviewEdits, restorableReviewEdits, reviewEditsFromScan } from "../src/screens/records/scanReceipt/reviewDraft";
import type { ReceiptScanResult } from "../src/screens/records/scanReceipt/types";

const scope = { ownerId: 17, businessProfileId: 1, scanId: 41 };
const edits = (overrides: Partial<ReceiptReviewEdits> = {}): ReceiptReviewEdits => ({
  date: "2026-09-01",
  description: "Coffee beans, corrected",
  vendor: "Supplier",
  amount: "260.00",
  categoryId: 10,
  itemCategories: { 5: 11 },
  addedItems: [{ key: "added-1", name: "Bag", amount: "10", categoryId: 10 }],
  plan: "proportional",
  gapCategoryId: null,
  editingItem: null,
  ...overrides,
});
const scan = {
  id: 41,
  businessProfileId: 1,
  extractedDate: "2026-09-01T00:00:00.000Z",
  extractedVendor: "Supplier",
  extractedDescription: "Coffee beans",
  extractedAmount: 250,
  items: [
    { id: 5, name: "Coffee beans", amount: 200, categoryId: 10 },
    { id: 6, name: "Milk", amount: 50, categoryId: null },
  ],
} as unknown as ReceiptScanResult;

beforeEach(() => { native.values.clear(); native.failSet = false; native.writes.mockClear(); native.os = "android"; });

describe("receipt review draft storage", () => {
  it("restores exactly what was saved, using device-only keychain values under the byte ceiling", async () => {
    const saved = edits({ description: "商".repeat(200), addedItems: Array.from({ length: 20 }, (_, i) => ({ key: `added-${i}`, name: "🍚".repeat(40), amount: "1.00", categoryId: 10 })) });
    await saveReceiptReviewDraft(scope, saved);
    expect(await readReceiptReviewDraft(scope)).toEqual(saved);
    expect(native.writes.mock.calls.every((call) => (call[2] as { keychainAccessible: string }).keychainAccessible === "deviceOnly")).toBe(true);
    expect([...native.values.keys()].filter((key) => key.startsWith("finsight.receiptReview.17.1.41.")).length).toBeGreaterThan(1);
  });

  it("removes surplus chunks when a draft shrinks", async () => {
    await saveReceiptReviewDraft(scope, edits({ addedItems: Array.from({ length: 6 }, (_, i) => ({ key: `added-${i}`, name: "商".repeat(300), amount: "1.00", categoryId: 10 })) }));
    const before = [...native.values.keys()].filter((key) => key.startsWith("finsight.receiptReview.17.1.41.")).length;
    await saveReceiptReviewDraft(scope, edits());
    const after = [...native.values.keys()].filter((key) => key.startsWith("finsight.receiptReview.17.1.41."));
    expect(before).toBeGreaterThan(1);
    expect(after).toEqual(["finsight.receiptReview.17.1.41.0"]);
    expect(await readReceiptReviewDraft(scope)).toEqual(edits());
  });

  it("stores only review values: no image URIs, upload keys or tokens", async () => {
    await saveReceiptReviewDraft(scope, { ...edits(), uri: "file:///receipt.jpg", idempotencyKey: "secret-key", accessToken: "token" } as unknown as ReceiptReviewEdits);
    const raw = [...native.values.values()].join("");
    expect(raw).not.toContain("file:///");
    expect(raw).not.toContain("secret-key");
    expect(raw).not.toContain("token");
  });

  it("never returns a draft to a different account, business or scan", async () => {
    await saveReceiptReviewDraft(scope, edits());
    expect(await readReceiptReviewDraft({ ...scope, ownerId: 18 })).toBeNull();
    expect(await readReceiptReviewDraft({ ...scope, businessProfileId: 2 })).toBeNull();
    expect(await readReceiptReviewDraft({ ...scope, scanId: 42 })).toBeNull();
    expect(await readReceiptReviewDraft(scope)).not.toBeNull();
  });

  it("refuses a slot whose recorded scope does not match the key it was read from, and removes it", async () => {
    await saveReceiptReviewDraft(scope, edits());
    const key = "finsight.receiptReview.17.1.41";
    for (const [name, value] of [...native.values]) {
      if (name.startsWith(`${key}.`)) native.values.set(`finsight.receiptReview.17.2.41${name.slice(key.length)}`, value);
    }
    native.values.set("finsight.receiptReview.17.2.41", native.values.get(key)!);
    expect(await readReceiptReviewDraft({ ...scope, businessProfileId: 2 })).toBeNull();
    expect(native.values.has("finsight.receiptReview.17.2.41")).toBe(false);
  });

  it("clears one scan's draft without touching another", async () => {
    await saveReceiptReviewDraft(scope, edits());
    await saveReceiptReviewDraft({ ...scope, scanId: 42 }, edits({ amount: "1.00" }));
    await clearReceiptReviewDraft(scope);
    expect(await readReceiptReviewDraft(scope)).toBeNull();
    expect((await readReceiptReviewDraft({ ...scope, scanId: 42 }))?.amount).toBe("1.00");
  });

  it("clears every draft for an account on sign-out and leaves other accounts alone", async () => {
    await saveReceiptReviewDraft(scope, edits());
    await saveReceiptReviewDraft({ ...scope, businessProfileId: 2, scanId: 50 }, edits());
    await saveReceiptReviewDraft({ ...scope, ownerId: 18 }, edits());
    await clearReceiptReviewDraftsForOwner(17);
    expect([...native.values.keys()].some((key) => key.startsWith("finsight.receiptReview.17."))).toBe(false);
    expect(await readReceiptReviewDraft({ ...scope, ownerId: 18 })).not.toBeNull();
  });

  it("refuses a save that was queued before the account was cleared", async () => {
    const pending = saveReceiptReviewDraft(scope, edits());
    const cleared = clearReceiptReviewDraftsForOwner(17);
    await expect(pending).rejects.toThrow(/account changed/);
    await cleared;
    expect(await readReceiptReviewDraft(scope)).toBeNull();
  });

  it("rejects a failed write and an oversized draft", async () => {
    native.failSet = true;
    await expect(saveReceiptReviewDraft(scope, edits())).rejects.toThrow();
    native.failSet = false;
    await expect(saveReceiptReviewDraft(scope, edits({ addedItems: Array.from({ length: 100 }, (_, i) => ({ key: `added-${i}`, name: "x".repeat(1000), amount: "1", categoryId: 10 })) }))).rejects.toThrow(/too large/);
  });

  it("removes a corrupt draft instead of restoring it", async () => {
    await saveReceiptReviewDraft(scope, edits());
    native.values.set("finsight.receiptReview.17.1.41.0", "{not json");
    expect(await readReceiptReviewDraft(scope)).toBeNull();
    expect(native.values.has("finsight.receiptReview.17.1.41")).toBe(false);
  });

  it("keeps at most fifty drafts per account, dropping the oldest", async () => {
    for (let scanId = 1; scanId <= 51; scanId += 1) await saveReceiptReviewDraft({ ...scope, scanId }, edits());
    expect(await readReceiptReviewDraft({ ...scope, scanId: 1 })).toBeNull();
    expect(await readReceiptReviewDraft({ ...scope, scanId: 51 })).not.toBeNull();
    expect(JSON.parse(native.values.get("finsight.receiptReview.17.index")!)).toHaveLength(50);
  });
});

describe("receipt review unsaved-change rules", () => {
  const seeded = reviewEditsFromScan(scan);

  it("treats the freshly seeded form as unchanged", () => {
    expect(seeded).toMatchObject({ date: "2026-09-01", description: "Coffee beans", amount: "250.00", categoryId: null, itemCategories: { 5: 10, 6: null } });
    expect(hasUnsavedReviewEdits(seeded, seeded, scan.items)).toBe(false);
  });

  it("counts typed fields, chosen categories, plans and real added rows, but not blank rows or an untouched item editor", () => {
    expect(hasUnsavedReviewEdits({ ...seeded, vendor: "Other" }, seeded, scan.items)).toBe(true);
    expect(hasUnsavedReviewEdits({ ...seeded, itemCategories: { 5: 10, 6: 11 } }, seeded, scan.items)).toBe(true);
    expect(hasUnsavedReviewEdits({ ...seeded, plan: "shrink" }, seeded, scan.items)).toBe(true);
    expect(hasUnsavedReviewEdits({ ...seeded, addedItems: [{ key: "a", name: "", amount: "", categoryId: null }] }, seeded, scan.items)).toBe(false);
    expect(hasUnsavedReviewEdits({ ...seeded, addedItems: [{ key: "a", name: "Bag", amount: "", categoryId: null }] }, seeded, scan.items)).toBe(true);
    expect(hasUnsavedReviewEdits({ ...seeded, editingItem: { id: 5, name: "Coffee beans", amount: "200.00" } }, seeded, scan.items)).toBe(false);
    expect(hasUnsavedReviewEdits({ ...seeded, editingItem: { id: 5, name: "Coffee", amount: "200.00" } }, seeded, scan.items)).toBe(true);
  });

  it("ignores category choices for lines no longer on the scan", () => {
    const remaining = scan.items.filter((item) => item.id !== 6);
    expect(hasUnsavedReviewEdits({ ...seeded, itemCategories: { 5: 10, 6: 11 } }, seeded, remaining)).toBe(false);
  });

  it("narrows a restored draft to the scan's current lines", () => {
    const stored = edits({ itemCategories: { 5: 11, 99: 10 }, editingItem: { id: 99, name: "Gone", amount: "1.00" } });
    const restored = restorableReviewEdits(stored, seeded, scan.items);
    expect(restored.itemCategories).toEqual({ 5: 11, 6: null });
    expect(restored.editingItem).toBeNull();
    expect(restored.description).toBe("Coffee beans, corrected");
  });
});
