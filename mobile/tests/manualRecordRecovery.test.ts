import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ values: new Map<string, string>(), failSet: "", failDelete: "", writes: vi.fn(), os: "android" }));
vi.mock("react-native", () => ({ Platform: { get OS() { return native.os; } } }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "deviceOnly",
  getItemAsync: async (key: string) => native.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options: unknown) => {
    native.writes(key, value, options);
    if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("Native value exceeds byte limit");
    if (key.includes(native.failSet) && native.failSet) throw new Error("Synthetic storage failure");
    native.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (key === native.failDelete) throw new Error("Synthetic deletion failure");
    native.values.delete(key);
  },
}));

import { clearManualRecordIntent, clearManualRecordRecoveryForOwner, discardManualRecordRecovery, manualRecoveryChunks, PendingManualRecordError, prepareManualRecordIntent, readManualRecordIntent, verifiedManualRecordResult, type ManualRecordScope } from "../src/lib/manualRecordRecovery";

const scope: ManualRecordScope = { ownerId: 17, businessProfileId: 23, kind: "expense" };
const payload = () => ({ businessProfileId: 23, categoryId: 10, date: "2026-10-10", description: "Synthetic purchase", vendor: "Synthetic supplier", amount: 1234.56 });
const draft = () => ({ date: "2026-10-10", description: " Synthetic purchase ", vendor: "Synthetic supplier", categoryId: 10, amount: "1234.56" });
const slot = "finsight.manual.17.23.expense";
beforeEach(() => { native.values.clear(); native.failSet = ""; native.failDelete = ""; native.writes.mockClear(); native.os = "android"; });

describe("durable native manual record recovery", () => {
  it("persists and verifies a frozen request before returning it, then restores exact financial details", async () => {
    const input = payload(); const entered = draft();
    const intent = await prepareManualRecordIntent(scope, input, entered);
    expect(intent.key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(native.values.has(slot)).toBe(true);
    expect(native.writes.mock.calls.every((call) => (call[2] as { keychainAccessible: string }).keychainAccessible === "deviceOnly")).toBe(true);
    input.amount = 8888; entered.amount = "8888";
    expect(intent.payload.amount).toBe(1234.56); expect(intent.draft.amount).toBe("1234.56");
    expect(Object.isFrozen(intent)).toBe(true); expect(Object.isFrozen(intent.payload)).toBe(true);
    const restored = await readManualRecordIntent(scope);
    expect(restored).toEqual(intent); expect(restored?.payload.amount).toBe(1234.56);
  });

  it("chunks multibyte descriptions and vendor values by bytes rather than JavaScript length", async () => {
    const description = "🍚".repeat(100); const vendor = "商".repeat(150);
    const intent = await prepareManualRecordIntent(scope, { ...payload(), description, vendor }, { ...draft(), description, vendor });
    expect((await readManualRecordIntent(scope))?.payload).toEqual(intent.payload);
    const financialParts = [...native.values].filter(([key]) => key.startsWith(`${slot}.${intent.key}.`));
    expect(financialParts.length).toBeGreaterThan(1);
    expect(financialParts.every(([, value]) => Buffer.byteLength(value, "utf8") <= 1500)).toBe(true);
    const value = "🙂漢字".repeat(1000);
    const chunks = manualRecoveryChunks(value);
    expect(chunks.join("")).toBe(value); expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1500)).toBe(true);
    expect(chunks.every((chunk) => !chunk.endsWith("\ud83d"))).toBe(true);
  });

  it("refuses to replace a pending request when the draft changes", async () => {
    const first = await prepareManualRecordIntent(scope, payload(), draft());
    await expect(prepareManualRecordIntent(scope, { ...payload(), amount: 999 }, { ...draft(), amount: "999" })).rejects.toBeInstanceOf(PendingManualRecordError);
    expect((await readManualRecordIntent(scope))?.key).toBe(first.key);
    expect((await readManualRecordIntent(scope))?.payload.amount).toBe(1234.56);
  });

  it("serializes double-tap preparations and returns only one durable intent", async () => {
    const outcomes = await Promise.allSettled([prepareManualRecordIntent(scope, payload(), draft()), prepareManualRecordIntent(scope, payload(), draft())]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readManualRecordIntent(scope)).not.toBeNull();
  });

  it("isolates owner, business and record kind while allowing the original owner to restore after logout", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    expect(await readManualRecordIntent({ ...scope, ownerId: 18 })).toBeNull();
    expect(await readManualRecordIntent({ ...scope, businessProfileId: 24 })).toBeNull();
    expect(await readManualRecordIntent({ ...scope, kind: "sales" })).toBeNull();
    expect((await readManualRecordIntent(scope))?.key).toBe(intent.key);
  });

  it("fails closed if the intent payload cannot be persisted", async () => {
    native.failSet = `${slot}.`;
    await expect(prepareManualRecordIntent(scope, payload(), draft())).rejects.toThrow("Synthetic storage failure");
    await expect(readManualRecordIntent(scope)).rejects.toThrow(/incomplete/i);
    native.failSet = "";
    await expect(prepareManualRecordIntent(scope, payload(), draft())).rejects.toThrow(/incomplete/i);
    await discardManualRecordRecovery(scope, null);
    expect(await readManualRecordIntent(scope)).toBeNull();
  });

  it("retains incomplete recovery evidence instead of silently replacing a damaged payload", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    native.values.delete(`${slot}.${intent.key}.0`);
    await expect(readManualRecordIntent(scope)).rejects.toThrow("incomplete");
    await expect(prepareManualRecordIntent(scope, payload(), draft())).rejects.toThrow("incomplete");
    expect(native.values.has(slot)).toBe(true);
    await discardManualRecordRecovery(scope, intent.key);
    expect(await readManualRecordIntent(scope)).toBeNull();
  });

  it("refuses a stale cleanup key and leaves a later request intact", async () => {
    const first = await prepareManualRecordIntent(scope, payload(), draft());
    await clearManualRecordIntent(scope, first.key);
    const second = await prepareManualRecordIntent(scope, payload(), draft());
    await expect(clearManualRecordIntent(scope, first.key)).rejects.toThrow("changed");
    expect((await readManualRecordIntent(scope))?.key).toBe(second.key);
  });

  it("refuses a stale explicit resolution after a replacement request was saved", async () => {
    const first = await prepareManualRecordIntent(scope, payload(), draft());
    await clearManualRecordIntent(scope, first.key);
    const second = await prepareManualRecordIntent(scope, payload(), draft());
    await expect(discardManualRecordRecovery(scope, first.key)).rejects.toThrow("changed");
    await expect(discardManualRecordRecovery(scope, null)).rejects.toThrow("now available");
    expect((await readManualRecordIntent(scope))?.key).toBe(second.key);
  });

  it("fails closed on Expo web without IndexedDB instead of falling back to unsupported SecureStore", async () => {
    native.os = "web";
    await expect(prepareManualRecordIntent(scope, payload(), draft())).rejects.toThrow("cannot store recovery safely");
    expect(native.writes).not.toHaveBeenCalled(); expect(native.values.size).toBe(0);
  });

  it("retains the pending request when storage cleanup fails and supports a later cleanup", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    native.failDelete = slot;
    await expect(clearManualRecordIntent(scope, intent.key)).rejects.toThrow("deletion failure");
    expect((await readManualRecordIntent(scope))?.key).toBe(intent.key);
    native.failDelete = "";
    await clearManualRecordIntent(scope, intent.key);
    expect(await readManualRecordIntent(scope)).toBeNull();
    expect([...native.values.keys()].some((key) => key.startsWith(`${slot}.${intent.key}.`))).toBe(false);
  });

  it("blocks recovery reads after partial cleanup removed the header but left its journal", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    native.failDelete = `${slot}.${intent.key}.0`;
    await expect(clearManualRecordIntent(scope, intent.key)).rejects.toThrow("deletion failure");
    expect(native.values.has(slot)).toBe(false);
    native.failDelete = "";
    await expect(readManualRecordIntent(scope)).rejects.toThrow(/incomplete/i);
    await clearManualRecordIntent(scope, intent.key);
    expect(await readManualRecordIntent(scope)).toBeNull();
  });

  it("blocks fresh preparation after partial cleanup rather than silently rotating the save key", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    native.failDelete = `${slot}.${intent.key}.0`;
    await expect(clearManualRecordIntent(scope, intent.key)).rejects.toThrow("deletion failure");
    native.failDelete = "";
    await expect(prepareManualRecordIntent(scope, { ...payload(), amount: 999 }, { ...draft(), amount: "999" })).rejects.toThrow(/incomplete/i);
    expect(native.values.has(slot)).toBe(false);
    await discardManualRecordRecovery(scope, null);
    const next = await prepareManualRecordIntent(scope, payload(), draft());
    expect(next.key).not.toBe(intent.key);
  });

  it("allows another scope while retaining incomplete recovery for the original business", async () => {
    const intent = await prepareManualRecordIntent(scope, payload(), draft());
    native.failDelete = `${slot}.${intent.key}.0`;
    await expect(clearManualRecordIntent(scope, intent.key)).rejects.toThrow("deletion failure");
    native.failDelete = "";
    const otherScope = { ...scope, businessProfileId: 24 };
    expect(await readManualRecordIntent(otherScope)).toBeNull();
    const other = await prepareManualRecordIntent(otherScope, { ...payload(), businessProfileId: 24 }, draft());
    expect(other.scope.businessProfileId).toBe(24);
    expect(native.values.has(slot)).toBe(false);
  });

  it("erases account-deletion recovery for that owner and preserves other owners", async () => {
    await prepareManualRecordIntent(scope, payload(), draft());
    const other = await prepareManualRecordIntent({ ...scope, ownerId: 18 }, payload(), draft());
    await clearManualRecordRecoveryForOwner(17);
    expect(await readManualRecordIntent(scope)).toBeNull();
    expect((await readManualRecordIntent({ ...scope, ownerId: 18 }))?.key).toBe(other.key);
    expect([...native.values.keys()].some((key) => key.startsWith("finsight.manual.17."))).toBe(false);
  });

  it.each([{ id: 3 }, { id: 3, businessProfileId: 24, type: "expense" }, { id: 3, businessProfileId: 23, type: "sales" }, { id: -1, businessProfileId: 23, type: "expense" }])("keeps unverifiable response %j ambiguous", (response) => {
    expect(() => verifiedManualRecordResult(response, scope)).toThrow("could not be verified");
  });
  it("accepts only a matching business/kind response with a positive record identity", () => {
    expect(verifiedManualRecordResult({ id: 91, businessProfileId: 23, type: "expense" }, scope)).toBe(91);
  });
});
