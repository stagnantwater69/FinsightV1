// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiChatProvider, useAiChat } from "./AiChatContext";
import type { ChatMessage, ChatSendResponse, Conversation, ReductionOpportunity } from "../lib/types";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks }));
vi.mock("./BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: { id: 1 } }) }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("../components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("../lib/serverStateCache", () => ({ captureServerStateAccount: () => ({ userId: "qa-chat-owner" }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function conversation(id: number, title = `Thread ${id}`): Conversation {
  return { id, title, originModule: "Dashboard", createdAt: "2026-10-13T00:00:00Z", lastMessageAt: "2026-10-13T00:00:00Z" };
}
function message(id: number, content = `Message ${id}`): ChatMessage {
  return { id, content, role: "assistant", createdAt: "2026-10-13T00:00:00Z", feedback: null };
}
function response(id: number): ChatSendResponse {
  return { conversation: conversation(id), userMessage: { ...message(id * 100 + 1, "Original question"), role: "user" }, assistantMessage: message(id * 100 + 2, "Recovered answer"), provider: "gemini", detectedAmount: null };
}
function missing() {
  return new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, { status: 404, statusText: "Not Found", headers: new AxiosHeaders(), data: { message: "Not found" }, config: { headers: new AxiosHeaders() } });
}
function rejectedBeforeClaim(status: number) {
  return new AxiosError("Question rejected", "ERR_BAD_REQUEST", undefined, undefined, { status, statusText: "Rejected", headers: new AxiosHeaders(), data: { message: "Question rejected" }, config: { headers: new AxiosHeaders() } });
}
const wrapper = ({ children }: { children: ReactNode }) => <AiChatProvider>{children}</AiChatProvider>;
function setup() { return renderHook(() => useAiChat(), { wrapper }); }
type Chat = ReturnType<typeof setup>;
async function open(chat: Chat) {
  act(() => chat.result.current.openChat("Dashboard"));
  await waitFor(() => expect(chat.result.current.conversations).toHaveLength(2));
}
async function select(chat: Chat, id: number) {
  act(() => chat.result.current.selectConversation(id));
  await waitFor(() => expect(chat.result.current.messagesLoading).toBe(false));
  expect(chat.result.current.activeId).toBe(id);
}
async function settle(operation: () => void) { await act(async () => { operation(); await Promise.resolve(); }); }

beforeEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  sessionStorage.clear();
  mocks.get.mockImplementation(async (url: string) => url === "/ai/conversations"
    ? { data: [conversation(1), conversation(2)] }
    : { data: { ...conversation(Number(url.split("/").pop())), messages: [message(Number(url.split("/").pop()) * 10)], nextCursor: null } });
  mocks.post.mockResolvedValue({ data: response(1) });
  mocks.patch.mockResolvedValue({ data: {} });
  mocks.put.mockResolvedValue({ data: {} });
  mocks.delete.mockResolvedValue({ data: {} });
});

describe("Ask FinSight requests preserve newer owner actions", () => {
  it("preserves confirmed feedback when a detail reload captured before the rating arrives late", async () => {
    const chat = setup(); await select(chat, 1);
    const heldDetail = deferred<{ data: unknown }>(); mocks.get.mockReturnValueOnce(heldDetail.promise);
    act(() => chat.result.current.reloadMessages());
    const rating = deferred<{ data: unknown }>(); mocks.put.mockReturnValueOnce(rating.promise);
    act(() => chat.result.current.rate(10, "up"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    await settle(() => rating.resolve({ data: {} }));
    await settle(() => heldDetail.resolve({ data: { ...conversation(1), messages: [message(10)], nextCursor: null } }));
    expect(chat.result.current.messages[0]?.feedback).toBe("up");
    await select(chat, 2); await select(chat, 1);
    expect(chat.result.current.messages[0]?.feedback).toBe("up");
    mocks.put.mockRejectedValueOnce(new Error("Second feedback failed"));
    act(() => chat.result.current.rate(10, "down"));
    await waitFor(() => expect(chat.result.current.error).toBe("Second feedback failed"));
    expect(chat.result.current.messages[0]?.feedback).toBe("up");
  });
  it("does not resurrect a deleted conversation from an already committed send's held response", async () => {
    const held = deferred<{ data: ChatSendResponse }>(); mocks.post.mockReturnValue(held.promise);
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    act(() => chat.result.current.remove(conversation(1)));
    await waitFor(() => expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]));
    await settle(() => held.resolve({ data: response(1) }));
    expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]);
    expect(chat.result.current.activeId).toBeNull();
    expect(chat.result.current.messages).toEqual([]);
    expect(chat.result.current.pendingQuestion).toBeNull();
  });

  it("does not resurrect a deleted row from a held history refresh", async () => {
    const chat = setup(); await open(chat);
    const held = deferred<{ data: Conversation[] }>(); mocks.get.mockReturnValueOnce(held.promise);
    act(() => chat.result.current.reloadConversations());
    act(() => chat.result.current.remove(conversation(1)));
    await waitFor(() => expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]));
    await settle(() => held.resolve({ data: [conversation(1), conversation(2)] }));
    expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]);
  });

  it("does not replace a confirmed rename with a held history response captured before it", async () => {
    const chat = setup(); await open(chat);
    const held = deferred<{ data: Conversation[] }>(); mocks.get.mockReturnValueOnce(held.promise);
    act(() => chat.result.current.reloadConversations());
    act(() => chat.result.current.rename(1, "Confirmed new title"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Conversation renamed"));
    await settle(() => held.resolve({ data: [conversation(1), conversation(2)] }));
    expect(chat.result.current.conversations.map((item) => item.title)).toEqual(["Confirmed new title", "Thread 2"]);
  });

  it("ignores a held detail response after deleting its selected conversation", async () => {
    const chat = setup(); await open(chat);
    const held = deferred<{ data: unknown }>(); mocks.get.mockReturnValueOnce(held.promise);
    act(() => chat.result.current.selectConversation(1));
    act(() => chat.result.current.remove(conversation(1)));
    await waitFor(() => expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]));
    await settle(() => held.resolve({ data: { ...conversation(1), messages: [message(10)], nextCursor: null } }));
    expect(chat.result.current.conversations.map((item) => item.id)).toEqual([2]);
    expect(chat.result.current.messages).toEqual([]);
    expect(chat.result.current.activeId).toBeNull();
  });

  it.each(["new chat", "other thread"])("saves a held reply without replacing a %s selection or its draft", async (choice) => {
    const held = deferred<{ data: ChatSendResponse }>();
    mocks.post.mockReturnValue(held.promise);
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => { chat.result.current.setInput("Original question"); chat.result.current.send("Original question"); });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    if (choice === "new chat") act(() => chat.result.current.newChat());
    else await select(chat, 2);
    act(() => chat.result.current.setInput("Newer draft"));
    await settle(() => held.resolve({ data: response(1) }));
    expect(chat.result.current.activeId).toBe(choice === "new chat" ? null : 2);
    expect(chat.result.current.input).toBe("Newer draft");
    expect(chat.result.current.messages.some((item) => item.content === "Recovered answer")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith('Answer saved in "Thread 1".');
    await select(chat, 1);
    expect(chat.result.current.messages.filter((item) => item.id === 102)).toHaveLength(1);
  });

  it("does not restore a failed send over a newer draft in the same thread", async () => {
    const held = deferred<{ data: ChatSendResponse }>(); mocks.post.mockReturnValue(held.promise);
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => { chat.result.current.setInput("Original question"); chat.result.current.send("Original question"); });
    act(() => chat.result.current.setInput("New draft while waiting"));
    await settle(() => held.reject(new Error("Connection lost")));
    expect(chat.result.current.input).toBe("New draft while waiting");
    expect(chat.result.current.pendingQuestion).toBe("Original question");
    expect(chat.result.current.error).toBe("Connection lost");
  });

  it("does not publish an old send failure onto another selected thread", async () => {
    const held = deferred<{ data: ChatSendResponse }>(); mocks.post.mockReturnValue(held.promise);
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => chat.result.current.send("Original question"));
    await select(chat, 2); act(() => chat.result.current.setInput("Other thread draft"));
    await settle(() => held.reject(new Error("Old send failed")));
    expect(chat.result.current.activeId).toBe(2);
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([20]);
    expect(chat.result.current.input).toBe("Other thread draft");
    expect(chat.result.current.error).toBeNull();
    expect(chat.result.current.pendingQuestion).toBe("Original question");
  });

  it("restores the original question when its cleared draft has not changed", async () => {
    mocks.post.mockRejectedValue(new Error("Connection lost"));
    const chat = setup();
    act(() => { chat.result.current.setInput("Original question"); chat.result.current.send("Original question"); });
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    expect(chat.result.current.input).toBe("Original question");
    expect(chat.result.current.recoveryMessage).toMatch(/not been confirmed/);
  });

  it("rolls back only the failed rename while preserving another rename and a deleted thread", async () => {
    const held = deferred<{ data: unknown }>();
    mocks.patch.mockImplementation((url: string) => url.endsWith("/1") ? held.promise : Promise.resolve({ data: {} }));
    const chat = setup(); await open(chat);
    act(() => chat.result.current.rename(1, "Failed rename"));
    act(() => chat.result.current.rename(2, "Saved rename"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    await settle(() => held.reject(new Error("Rename failed")));
    expect(chat.result.current.conversations.map((item) => item.title)).toEqual(["Thread 1", "Saved rename"]);
    const heldAgain = deferred<{ data: unknown }>(); mocks.patch.mockReturnValue(heldAgain.promise);
    act(() => chat.result.current.rename(1, "Deleted rename"));
    act(() => chat.result.current.remove(conversation(2, "Saved rename")));
    await waitFor(() => expect(chat.result.current.conversations).toHaveLength(1));
    await settle(() => heldAgain.reject(new Error("Another rename failed")));
    expect(chat.result.current.conversations.map((item) => item.id)).toEqual([1]);
  });

  it.each([false, true])("serializes a row's renames and restores its last confirmed title (first succeeds: %s)", async (firstSucceeds) => {
    const first = deferred<{ data: unknown }>(); const second = deferred<{ data: unknown }>();
    mocks.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const chat = setup(); await open(chat);
    act(() => chat.result.current.rename(1, "First edit"));
    act(() => chat.result.current.rename(1, "Second edit"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(chat.result.current.conversations[0]?.title).toBe("Second edit");
    await settle(() => firstSucceeds ? first.resolve({ data: {} }) : first.reject(new Error("First failed")));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    await settle(() => second.reject(new Error("Second failed")));
    expect(chat.result.current.conversations[0]?.title).toBe(firstSucceeds ? "First edit" : "Thread 1");
  });

  it.each([false, true])("serializes feedback and restores its last confirmed value (first succeeds: %s)", async (firstSucceeds) => {
    const first = deferred<{ data: unknown }>(); const second = deferred<{ data: unknown }>();
    mocks.put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => chat.result.current.rate(10, "up"));
    act(() => chat.result.current.rate(10, "down"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(chat.result.current.messages[0]?.feedback).toBe("down");
    await settle(() => firstSucceeds ? first.resolve({ data: {} }) : first.reject(new Error("First failed")));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    await settle(() => second.reject(new Error("Second failed")));
    expect(chat.result.current.messages[0]?.feedback).toBe(firstSucceeds ? "up" : null);
    await select(chat, 2); await select(chat, 1);
    expect(chat.result.current.messages[0]?.feedback).toBe(firstSucceeds ? "up" : null);
  });

  it("rolls back one message's failed feedback without clearing another message's successful feedback", async () => {
    const held = deferred<{ data: unknown }>();
    mocks.get.mockResolvedValueOnce({ data: { ...conversation(1), messages: [message(10), message(11)], nextCursor: null } });
    mocks.put.mockImplementation((url: string) => url.includes("/10/") ? held.promise : Promise.resolve({ data: {} }));
    const chat = setup(); await select(chat, 1);
    act(() => { chat.result.current.rate(10, "down"); chat.result.current.rate(11, "up"); });
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    await settle(() => held.reject(new Error("First feedback failed")));
    expect(chat.result.current.messages.map((item) => item.feedback)).toEqual([null, "up"]);
  });
});

describe("Ask FinSight durable send recovery", () => {
  it.each(["COMPLETE recovery", "held POST response"])("preserves a newer confirmed vote when an immutable commit snapshot is published through %s", async (publication) => {
    const snapshot = response(1);
    const heldSend = deferred<{ data: ChatSendResponse }>();
    if (publication === "held POST response") mocks.post.mockReturnValueOnce(heldSend.promise);
    else mocks.post.mockRejectedValueOnce(new Error("Original response lost"));
    const baseGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((url: string, config: unknown) => url === "/ai/conversations/1"
      ? Promise.resolve({ data: { ...conversation(1), messages: [structuredClone(snapshot.userMessage), structuredClone(snapshot.assistantMessage)], nextCursor: null } })
      : baseGet(url, config));
    const chat = setup();
    act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    if (publication === "COMPLETE recovery") await waitFor(() => expect(chat.result.current.sending).toBe(false));
    await open(chat); await select(chat, 1);
    const rating = deferred<{ data: unknown }>(); mocks.put.mockReturnValueOnce(rating.promise);
    act(() => chat.result.current.rate(102, "up"));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    await settle(() => rating.resolve({ data: {} }));
    expect(chat.result.current.messages.find((item) => item.id === 102)?.feedback).toBe("up");
    expect(snapshot.assistantMessage.feedback).toBeNull();
    act(() => chat.result.current.setInput("New draft after the saved answer"));
    if (publication === "held POST response") await settle(() => heldSend.resolve({ data: snapshot }));
    else {
      mocks.get.mockResolvedValueOnce({ data: { status: "COMPLETE", result: snapshot, error: null } });
      act(() => chat.result.current.checkSendStatus());
      await waitFor(() => expect(chat.result.current.checkingSend).toBe(false));
    }
    expect(chat.result.current.pendingQuestion).toBeNull();
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([101, 102]);
    expect(chat.result.current.messages.find((item) => item.id === 102)?.feedback).toBe("up");
    expect(chat.result.current.activeId).toBe(1);
    expect(chat.result.current.input).toBe("New draft after the saved answer");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    await select(chat, 2); await select(chat, 1);
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([101, 102]);
    expect(chat.result.current.messages.find((item) => item.id === 102)?.feedback).toBe("up");
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/1")).toHaveLength(1);
  });

  it.each([400, 422, 429])("allows a corrected question after a known HTTP %s rejection without retaining an unknown send", async (status) => {
    mocks.post.mockRejectedValueOnce(rejectedBeforeClaim(status));
    const chat = setup();
    act(() => { chat.result.current.setInput("Original question"); chat.result.current.send("Original question"); });
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    expect(chat.result.current.input).toBe("Original question");
    expect(chat.result.current.pendingQuestion).toBeNull();
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    const oldKey = mocks.post.mock.calls[0]![1].idempotencyKey;
    act(() => { chat.result.current.setInput("Corrected question"); chat.result.current.send("Corrected question"); });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1]![1].question).toBe("Corrected question");
    expect(mocks.post.mock.calls[1]![1].idempotencyKey).not.toBe(oldKey);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["question", "conversation"])("does not publish or clear recovery when a COMPLETE result has a mismatched %s", async (mismatch) => {
    mocks.post.mockRejectedValueOnce(new Error("Response lost"));
    const chat = setup(); await open(chat); await select(chat, 1);
    act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    const inconsistent = response(1);
    if (mismatch === "question") inconsistent.userMessage.content = "A different question";
    else inconsistent.conversation.id = 99;
    mocks.get.mockResolvedValueOnce({ data: { status: "COMPLETE", result: inconsistent, error: null } });
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.checkingSend).toBe(false));
    expect(chat.result.current.pendingQuestion).toBe("Original question");
    expect(chat.result.current.activeId).toBe(1);
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([10]);
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("keeps the question and sends nothing when its structured context exceeds recovery storage's read bound", async () => {
    const opportunity: ReductionOpportunity = {
      id: "large-context", type: "CATEGORY_PRESSURE", categoryId: 1, categoryName: "Inventory", priority: "high", confidence: "strong",
      observation: "x".repeat(17000), rationale: "y".repeat(17000), costBehavior: "unclassified", relatedRecordIds: [], limitations: [], suggestedChecks: [],
      evidence: { currentAmount: 0, previousAmount: 0, changeAmount: 0, changePercent: 0, expenseSharePercent: 0, recordCount: 0, unusualRecordCount: 0, possibleDuplicateCount: 0 },
    };
    const chat = setup();
    act(() => chat.result.current.openChat("Dashboard", "Original question", opportunity));
    act(() => chat.result.current.send("Original question"));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(chat.result.current.input).toBe("Original question");
    expect(chat.result.current.error).toMatch(/couldn't save this question/);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it("sends once on a double click and retains the immutable original payload for a 404 retry", async () => {
    mocks.post.mockRejectedValue(new Error("Response lost"));
    const chat = setup();
    act(() => { chat.result.current.send("Original question"); chat.result.current.send("Original question"); });
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const original = structuredClone(mocks.post.mock.calls[0]![1]);
    expect(original).toMatchObject({ businessProfileId: 1, question: "Original question", originModule: "Dashboard" });
    expect(original.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    act(() => { chat.result.current.setInput("Changed draft"); chat.result.current.openChat("Records Review"); chat.result.current.send("Changed draft"); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.get.mockRejectedValueOnce(missing());
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.canRetrySend).toBe(true));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockResolvedValueOnce({ data: response(1) });
    act(() => chat.result.current.retrySend());
    await waitFor(() => expect(chat.result.current.pendingQuestion).toBeNull());
    expect(mocks.post.mock.calls[1]![1]).toEqual(original);
    expect(chat.result.current.input).toBe("Changed draft");
  });

  it.each([false, true])("keeps an uncertain original send after a 404-enabled retry receives 429 (restored: %s)", async (restored) => {
    mocks.post.mockRejectedValueOnce(new Error("Original response lost"));
    let chat = setup();
    act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    const originalBody = structuredClone(mocks.post.mock.calls[0]![1]);
    if (restored) { chat.unmount(); chat = setup(); }
    expect(chat.result.current.pendingQuestion).toBe("Original question");
    act(() => chat.result.current.setInput("A newer question"));
    mocks.get.mockRejectedValueOnce(missing());
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.canRetrySend).toBe(true));
    mocks.post.mockRejectedValueOnce(rejectedBeforeClaim(429));
    act(() => chat.result.current.retrySend());
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    expect(mocks.post.mock.calls[1]![1]).toEqual(originalBody);
    expect(chat.result.current.pendingQuestion).toBe("Original question");
    const stored = sessionStorage.getItem("finsight.pendingChatSend.qa-chat-owner.1");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).body).toEqual(originalBody);
    expect(chat.result.current.input).toBe("A newer question");
    act(() => chat.result.current.send("A newer question"));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    mocks.get.mockResolvedValueOnce({ data: { status: "COMPLETE", result: response(1), error: null } });
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.pendingQuestion).toBeNull());
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(chat.result.current.conversations.some((item) => item.id === 1)).toBe(true);
    expect(chat.result.current.input).toBe("A newer question");
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it("uses one explicit GET for processing or unknown status and never resends automatically", async () => {
    mocks.post.mockRejectedValue(new Error("Response lost"));
    const chat = setup(); act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    const held = deferred<{ data: unknown }>(); mocks.get.mockReturnValue(held.promise);
    act(() => { chat.result.current.checkSendStatus(); chat.result.current.checkSendStatus(); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await settle(() => held.resolve({ data: { status: "PROCESSING", result: null, error: null } }));
    expect(chat.result.current.recoveryMessage).toMatch(/still processing/);
    expect(chat.result.current.canRetrySend).toBe(false);
    act(() => { chat.result.current.retrySend(); chat.result.current.send("Different question"); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.get.mockRejectedValueOnce(new Error("Status unreachable"));
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.recoveryMessage).toMatch(/Status unreachable/));
    expect(chat.result.current.pendingQuestion).toBe("Original question");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it.each(["FAILED", "DELETED"])("clears a terminal %s request and gives the next logical send a fresh key", async (status) => {
    mocks.post.mockRejectedValue(new Error("Response lost"));
    const chat = setup(); act(() => chat.result.current.send("Original question"));
    await waitFor(() => expect(chat.result.current.sending).toBe(false));
    const originalKey = mocks.post.mock.calls[0]![1].idempotencyKey;
    mocks.get.mockResolvedValueOnce({ data: { status, result: null, error: { message: "Provider failed" } } });
    act(() => chat.result.current.checkSendStatus());
    await waitFor(() => expect(chat.result.current.pendingQuestion).toBeNull());
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    mocks.post.mockResolvedValueOnce({ data: response(2) });
    act(() => chat.result.current.send("New logical question"));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1]![1].idempotencyKey).not.toBe(originalKey);
  });

  it("recovers after provider remount without selecting the origin thread or overwriting a newer draft", async () => {
    mocks.post.mockRejectedValue(new Error("Response lost"));
    const old = setup(); act(() => old.result.current.send("Original question"));
    await waitFor(() => expect(old.result.current.sending).toBe(false)); old.unmount();
    const restored = setup();
    expect(restored.result.current.pendingQuestion).toBe("Original question");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    act(() => restored.result.current.setInput("New draft after refresh"));
    mocks.get.mockResolvedValueOnce({ data: { status: "COMPLETE", result: response(1), error: null } });
    act(() => restored.result.current.checkSendStatus());
    await waitFor(() => expect(restored.result.current.pendingQuestion).toBeNull());
    expect(restored.result.current.activeId).toBeNull();
    expect(restored.result.current.input).toBe("New draft after refresh");
    expect(restored.result.current.conversations.map((item) => item.id)).toEqual([1]);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    act(() => restored.result.current.checkSendStatus());
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await select(restored, 1);
    expect(restored.result.current.messages.map((item) => item.id)).toEqual([101, 102]);
  });

  it("keeps input and performs no POST when recovery storage cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage denied", "SecurityError"); });
    const chat = setup();
    act(() => { chat.result.current.setInput("Original question"); chat.result.current.send("Original question"); });
    expect(chat.result.current.input).toBe("Original question");
    expect(chat.result.current.error).toMatch(/couldn't save this question/);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe("Ask FinSight bounded history and refresh", () => {
  it.each([false, true])("rejects a repeated or cycling conversation cursor and preserves loaded rows (cycling: %s)", async (cycling) => {
    mocks.get.mockImplementation(async (_url: string, config: { params: { cursor?: string } }) => {
      if (!config.params.cursor) return { data: { items: [conversation(1), conversation(2)], nextCursor: "cursor-a" } };
      if (cycling && config.params.cursor === "cursor-a") return { data: { items: [conversation(3)], nextCursor: "cursor-b" } };
      return { data: { items: [conversation(4)], nextCursor: "cursor-a" } };
    });
    const chat = setup(); await open(chat);
    if (cycling) {
      act(() => chat.result.current.loadOlderConversations());
      await waitFor(() => expect(chat.result.current.conversations).toHaveLength(3));
    }
    const loaded = chat.result.current.conversations;
    const cursor = chat.result.current.listNextCursor;
    act(() => chat.result.current.loadOlderConversations());
    await waitFor(() => expect(chat.result.current.listLoadingMore).toBe(false));
    expect(chat.result.current.listError).not.toBeNull();
    expect(chat.result.current.conversations).toEqual(loaded);
    expect(chat.result.current.listNextCursor).toBe(cursor);
    expect(mocks.get).toHaveBeenCalledTimes(cycling ? 3 : 2);
  });

  it.each([false, true])("rejects a repeated or cycling message cursor and preserves loaded messages (cycling: %s)", async (cycling) => {
    mocks.get.mockImplementation(async (_url: string, config: { params: { cursor?: string } }) => ({ data: {
      ...conversation(1),
      messages: !config.params.cursor ? [message(10)] : config.params.cursor === "cursor-a" && cycling ? [message(9)] : [message(8)],
      nextCursor: config.params.cursor === "cursor-a" && cycling ? "cursor-b" : "cursor-a",
    } }));
    const chat = setup(); await select(chat, 1);
    if (cycling) {
      act(() => chat.result.current.loadOlderMessages());
      await waitFor(() => expect(chat.result.current.messages).toHaveLength(2));
    }
    const loaded = chat.result.current.messages;
    const cursor = chat.result.current.messagesNextCursor;
    act(() => chat.result.current.loadOlderMessages());
    await waitFor(() => expect(chat.result.current.messagesLoadingOlder).toBe(false));
    expect(chat.result.current.error).not.toBeNull();
    expect(chat.result.current.messages).toEqual(loaded);
    expect(chat.result.current.messagesNextCursor).toBe(cursor);
    expect(mocks.get).toHaveBeenCalledTimes(cycling ? 3 : 2);
  });
  it("announces an initial history load failure and lets the owner retry it explicitly", async () => {
    mocks.get.mockRejectedValueOnce(new Error("History unavailable"));
    const chat = setup(); act(() => chat.result.current.openChat("Dashboard"));
    await waitFor(() => expect(chat.result.current.listError).toBe("History unavailable"));
    expect(chat.result.current.conversations).toEqual([]);
    act(() => chat.result.current.reloadConversations());
    await waitFor(() => expect(chat.result.current.conversations).toHaveLength(2));
    expect(chat.result.current.listError).toBeNull();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("retries an initial detail failure when the same thread is selected again", async () => {
    const chat = setup(); await open(chat);
    mocks.get.mockRejectedValueOnce(new Error("Thread unavailable"));
    act(() => chat.result.current.selectConversation(1));
    await waitFor(() => expect(chat.result.current.error).toBe("Thread unavailable"));
    await select(chat, 1);
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([10]);
    expect(chat.result.current.error).toBeNull();
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/1")).toHaveLength(2);
  });

  it("appends overlapping thread pages once and prepends message pages in oldest-first order", async () => {
    mocks.get.mockImplementation(async (url: string, config: { params: { cursor?: string } }) => {
      if (url === "/ai/conversations") return { data: config.params.cursor ? { items: [conversation(2), conversation(3)], nextCursor: null } : { items: [conversation(1), conversation(2)], nextCursor: "thread-cursor" } };
      return { data: { ...conversation(1), messages: config.params.cursor ? [message(1), message(10)] : [message(10), message(11)], nextCursor: config.params.cursor ? null : "message-cursor" } };
    });
    const chat = setup(); await open(chat);
    act(() => chat.result.current.loadOlderConversations());
    await waitFor(() => expect(chat.result.current.conversations.map((item) => item.id)).toEqual([1, 2, 3]));
    expect(mocks.get.mock.calls[1]![1].params).toEqual({ businessProfileId: 1, pageSize: 50, cursor: "thread-cursor" });
    await select(chat, 1);
    act(() => chat.result.current.loadOlderMessages());
    await waitFor(() => expect(chat.result.current.messages.map((item) => item.id)).toEqual([1, 10, 11]));
    expect(mocks.get.mock.calls.at(-1)![1].params).toEqual({ pageSize: 50, cursor: "message-cursor" });
    expect(chat.result.current.messagesNextCursor).toBeNull();
  });

  it("reopens fresh cache without a fetch and revalidates its stale data after 30 seconds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const chat = setup(); await open(chat); await select(chat, 1); await select(chat, 2); await select(chat, 1);
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/1")).toHaveLength(1);
    await select(chat, 2); now.mockReturnValue(130_001);
    const held = deferred<{ data: unknown }>(); mocks.get.mockReturnValueOnce(held.promise);
    act(() => chat.result.current.selectConversation(1));
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([10]);
    expect(chat.result.current.messagesLoading).toBe(true);
    await settle(() => held.resolve({ data: { ...conversation(1), messages: [message(12)], nextCursor: null } }));
    expect(chat.result.current.messages.map((item) => item.id)).toEqual([12]);
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/1")).toHaveLength(2);
  });

  it("evicts the oldest thread after caching 21 conversations", async () => {
    const chat = setup();
    for (let id = 1; id <= 21; id++) await select(chat, id);
    await select(chat, 1);
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/1")).toHaveLength(2);
    await select(chat, 21);
    expect(mocks.get.mock.calls.filter(([url]) => url === "/ai/conversations/21")).toHaveLength(1);
  });

  it("does not retain a thread with more than 200 loaded messages in cache", async () => {
    mocks.get.mockImplementation(async (url: string, config: { params: { cursor?: string } }) => {
      const id = Number(url.split("/").pop());
      return { data: { ...conversation(id), messages: id === 1 ? Array.from({ length: config.params.cursor ? 101 : 100 }, (_, index) => message(index + (config.params.cursor ? 1 : 102))) : [message(210)], nextCursor: id === 1 && !config.params.cursor ? "older" : null } };
    });
    const chat = setup(); await select(chat, 1);
    act(() => chat.result.current.loadOlderMessages());
    await waitFor(() => expect(chat.result.current.messages).toHaveLength(201));
    await select(chat, 2); await select(chat, 1);
    expect(mocks.get.mock.calls.filter(([url, config]) => url === "/ai/conversations/1" && !config.params.cursor)).toHaveLength(2);
  });
});
