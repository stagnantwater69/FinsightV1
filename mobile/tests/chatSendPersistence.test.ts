import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ values: new Map<string, string>(), set: vi.fn(), remove: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => native.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { await native.set(key, value); native.values.set(key, value); },
  deleteItemAsync: async (key: string) => { await native.remove(key); native.values.delete(key); },
}));
import { createPendingChatSend, parsePendingChatSend, utf8Bytes } from "../src/lib/chatSendIntent";
import { chatSendPersistence, clearChatSendRecovery } from "../src/lib/chatSendRecovery";
import { createChatStore } from "../src/lib/chatStore";

beforeEach(() => { native.values.clear(); native.set.mockReset().mockResolvedValue(undefined); native.remove.mockReset().mockResolvedValue(undefined); });
const intent = (owner = "synthetic-owner", business = 1, question = "What should I review?") => createPendingChatSend(owner, null, { businessProfileId: business, originModule: "Dashboard", question });

describe("native question recovery storage", () => {
  it("retains cleanup discoverability after a chunk delete failure and erases every owned chunk on retry", async () => {
    const saved = intent("cleanup-owner", 1, "🧾".repeat(450));
    await chatSendPersistence.store(saved);
    let failed = false;
    native.remove.mockImplementation(async (key: string) => {
      if (!failed && key === "finsight.chat.pending.cleanup-owner.1.0") {
        failed = true;
        throw new Error("Synthetic native chunk deletion failure");
      }
    });
    await expect(clearChatSendRecovery("cleanup-owner")).rejects.toThrow("Synthetic native chunk deletion failure");
    expect(native.values.has("finsight.chat.pending.cleanup-owner.index")).toBe(true);
    await clearChatSendRecovery("cleanup-owner");
    expect([...native.values.keys()].filter((key) => key.startsWith("finsight.chat.pending.cleanup-owner."))).toEqual([]);
  });

  it("cleans indexed chunks left by a partial store failure before the header exists", async () => {
    native.set.mockImplementation(async (key: string) => {
      if (key === "finsight.chat.pending.partial-store-owner.1.1") throw new Error("Synthetic native partial write failure");
    });
    const dispatch = vi.fn();
    const store = createChatStore({ listConversations: vi.fn(), getConversation: vi.fn(), createConversation: dispatch,
      sendMessage: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(), rateMessage: vi.fn() }, chatSendPersistence);
    store.setBusinessProfile(1, "partial-store-owner");
    await store.reloadRecovery();
    const question = "🧾".repeat(450);
    store.setInput(question);
    await store.send(question);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getState().input).toBe(question);
    expect(store.getState().recoveryError).toMatch(/Nothing was sent.*Synthetic native partial write failure/);
    expect(native.values.has("finsight.chat.pending.partial-store-owner.index")).toBe(true);
    expect(native.values.has("finsight.chat.pending.partial-store-owner.1.0")).toBe(true);
    expect(native.values.has("finsight.chat.pending.partial-store-owner.1")).toBe(false);
    await clearChatSendRecovery("partial-store-owner");
    expect([...native.values.keys()].filter((key) => key.startsWith("finsight.chat.pending.partial-store-owner."))).toEqual([]);
  });

  it("erases bounded indexed chunks even if the saved slot header is corrupt", async () => {
    await chatSendPersistence.store(intent("corrupt-header-owner"));
    native.values.set("finsight.chat.pending.corrupt-header-owner.1", "{not valid JSON");
    await clearChatSendRecovery("corrupt-header-owner");
    expect([...native.values.keys()].filter((key) => key.startsWith("finsight.chat.pending.corrupt-header-owner."))).toEqual([]);
  });

  it("round-trips Unicode through bounded SecureStore chunks without changing the request", async () => {
    const saved = intent("unicode-owner", 1, "🧾".repeat(450));
    await chatSendPersistence.store(saved);
    expect(await chatSendPersistence.read("unicode-owner", 1)).toEqual(saved);
    const parts = [...native.values].filter(([key]) => /\.1\.\d+$/.test(key));
    expect(parts.length).toBeGreaterThan(1);
    for (const [, part] of parts) expect(utf8Bytes(part)).toBeLessThanOrEqual(1500);
  });

  it("isolates identical business IDs across accounts and clears only the signed-out owner", async () => {
    const first = intent("owner-a");
    const second = intent("owner-b");
    await chatSendPersistence.store(first);
    await chatSendPersistence.store(second);
    await clearChatSendRecovery("owner-a");
    expect(await chatSendPersistence.read("owner-a", 1)).toBeNull();
    expect(await chatSendPersistence.read("owner-b", 1)).toEqual(second);
  });

  it("does not replace unresolved intent with a new key or remove it using another key", async () => {
    const saved = intent("exclusive-owner");
    await chatSendPersistence.store(saved);
    const newer = intent("exclusive-owner");
    await expect(chatSendPersistence.store(newer)).rejects.toThrow(/previous question/);
    await chatSendPersistence.remove(newer);
    expect(await chatSendPersistence.read("exclusive-owner", 1)).toEqual(saved);
  });

  it("fails closed when a persisted part is missing or the restored scope is changed", async () => {
    const saved = intent("broken-owner");
    await chatSendPersistence.store(saved);
    native.values.delete("finsight.chat.pending.broken-owner.1.0");
    await expect(chatSendPersistence.read("broken-owner", 1)).rejects.toThrow(/incomplete/);
    expect(() => parsePendingChatSend(saved, "another-owner", 1)).toThrow(/account and business/);
    expect(() => parsePendingChatSend(saved, "broken-owner", 2)).toThrow(/account and business/);
  });

  it("invalidates a queued write on logout before it can leave recovery content behind", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    native.set.mockImplementationOnce(() => gate);
    const saved = intent("logout-owner");
    const writing = chatSendPersistence.store(saved).catch((error: unknown) => error);
    let clearing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(native.set).toHaveBeenCalledTimes(1));
      clearing = clearChatSendRecovery("logout-owner");
      release();
      expect(await writing).toEqual(expect.objectContaining({ message: expect.stringMatching(/account changed/) }));
      await clearing;
      expect([...native.values.keys()].filter((key) => key.includes("logout-owner"))).toEqual([]);
    } finally { release(); await Promise.all([writing, ...(clearing ? [clearing] : [])]); }
  });

  it("does not report successful persistence when read-back storage loses a chunk", async () => {
    native.set.mockImplementation(async (key: string) => {
      if (key === "finsight.chat.pending.readback-owner.1") native.values.delete("finsight.chat.pending.readback-owner.1.0");
    });
    await expect(chatSendPersistence.store(intent("readback-owner"))).rejects.toThrow(/incomplete|could not be saved/);
  });
});
