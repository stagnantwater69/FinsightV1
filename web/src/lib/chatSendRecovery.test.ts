// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearChatSendRecovery, readPendingChatSend, removePendingChatSend, storePendingChatSend, type PendingChatSend } from "./chatSendRecovery";
let owner: string | null = "owner-a";
vi.mock("./serverStateCache", () => ({ captureServerStateAccount: () => owner ? { userId: owner } : null }));
function request(overrides: Partial<PendingChatSend> = {}): PendingChatSend {
  return { ownerId: "owner-a", conversationId: 4, body: { businessProfileId: 1, idempotencyKey: "original-key-123", question: "Original question", originModule: "Dashboard" }, ...overrides };
}
beforeEach(() => { owner = "owner-a"; sessionStorage.clear(); });
describe("chat recovery storage ownership and corruption", () => {
  it("stores a snapshot of the original body and separates account and business scopes", () => {
    const original = request(); storePendingChatSend(original); original.body.question = "Changed later";
    expect(readPendingChatSend(1)?.body.question).toBe("Original question");
    expect(readPendingChatSend(2)).toBeNull();
    owner = "owner-b"; expect(readPendingChatSend(1)).toBeNull();
    owner = null; expect(readPendingChatSend(1)).toBeNull();
    owner = "owner-a"; expect(readPendingChatSend(1)?.conversationId).toBe(4);
  });

  it.each([
    "not json", "null", "{}", JSON.stringify({ ...request(), ownerId: "another-owner" }),
    JSON.stringify({ ...request(), conversationId: -1 }), JSON.stringify({ ...request(), conversationId: 1.2 }),
    JSON.stringify({ ...request(), body: { ...request().body, businessProfileId: 2 } }),
    JSON.stringify({ ...request(), body: { ...request().body, question: " " } }),
    JSON.stringify({ ...request(), body: { ...request().body, question: "x".repeat(1001) } }),
    JSON.stringify({ ...request(), body: { ...request().body, idempotencyKey: "bad/key" } }), "x".repeat(32769),
  ])("ignores malformed recovery entry %# without dispatching it", (raw) => {
    sessionStorage.setItem("finsight.pendingChatSend.owner-a.1", raw);
    expect(readPendingChatSend(1)).toBeNull();
  });

  it("does not remove a newer request when an older request completes", () => {
    const old = request(); const newer = request({ body: { ...request().body, idempotencyKey: "newer-key-123" } });
    storePendingChatSend(newer); removePendingChatSend(old);
    expect(readPendingChatSend(1)?.body.idempotencyKey).toBe("newer-key-123");
    removePendingChatSend(newer); expect(readPendingChatSend(1)).toBeNull();
  });

  it("rejects oversized writes so refresh cannot silently lose an unreadable send intent", () => {
    const oversized = request();
    const payload = { ...oversized, body: { ...oversized.body, focus: { explanation: "x".repeat(32769) } } };
    expect(() => storePendingChatSend(payload as unknown as PendingChatSend)).toThrow();
    expect(sessionStorage.getItem("finsight.pendingChatSend.owner-a.1")).toBeNull();
  });

  it("rejects a restored create request that has no origin module", () => {
    const incomplete = request({ conversationId: null, body: { businessProfileId: 1, idempotencyKey: "original-key-123", question: "Original question" } });
    sessionStorage.setItem("finsight.pendingChatSend.owner-a.1", JSON.stringify(incomplete));
    expect(readPendingChatSend(1)).toBeNull();
  });

  it("clears recovery entries while preserving other session settings", () => {
    storePendingChatSend(request()); sessionStorage.setItem("unrelated-setting", "keep");
    clearChatSendRecovery(); expect(readPendingChatSend(1)).toBeNull();
    expect(sessionStorage.getItem("unrelated-setting")).toBe("keep");
  });
});
