import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore, type ChatTransport } from "../src/lib/chatStore";
import type { ChatSendPersistence, PendingChatSend } from "../src/lib/chatSendIntent";
import type { ChatMessage, ChatSendResponse, ChatSendStatus, Conversation, ConversationDetail } from "../src/lib/types";

const conversation = (id: number, title = `Thread ${id}`): Conversation => ({ id, title, originModule: "Dashboard", createdAt: "2026-10-01T00:00:00Z", lastMessageAt: "2026-10-01T00:00:00Z" });
const message = (id: number, role: "user" | "assistant", content = `Message ${id}`): ChatMessage => ({ id, role, content, createdAt: "2026-10-01T00:00:00Z" });
const detail = (id: number): ConversationDetail => ({ ...conversation(id), messages: [message(id * 10, "user"), message(id * 10 + 1, "assistant")] });
const result = (id: number, question: string): ChatSendResponse => ({ conversation: conversation(id), userMessage: message(id * 10 + 2, "user", question), assistantMessage: message(id * 10 + 3, "assistant", "Recorded answer."), provider: "gemini", detectedAmount: null });
const outcome = (status: ChatSendStatus["status"], response: ChatSendResponse | null = null): ChatSendStatus => ({ status, result: response, error: status === "FAILED" || status === "DELETED" ? { status: 409, code: "SYNTHETIC_TERMINAL", message: "This request is finished." } : null, createdAt: "2026-10-01T00:00:00Z", completedAt: status === "PROCESSING" ? null : "2026-10-01T00:00:01Z" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transport(over: Partial<ChatTransport> = {}) {
  return {
    listConversations: vi.fn(async () => [conversation(1), conversation(2)]),
    getConversation: vi.fn(async (id: number) => detail(id)),
    createConversation: vi.fn(async (input: { question: string }) => result(7, input.question)),
    sendMessage: vi.fn(async (id: number, question: string) => result(id, question)),
    getSendStatus: vi.fn(async () => outcome("PROCESSING")),
    renameConversation: vi.fn(async () => undefined), deleteConversation: vi.fn(async () => undefined), rateMessage: vi.fn(async () => undefined),
    ...over,
  } satisfies ChatTransport;
}
function ready(api: ChatTransport, persistence?: ChatSendPersistence) {
  const store = createChatStore(api, persistence);
  store.setBusinessProfile(1, "owner-a");
  return store;
}
async function loaded(store: ReturnType<typeof ready>) {
  store.ensureList();
  await vi.waitFor(() => expect(store.getState().listLoading).toBe(false));
}
afterEach(() => vi.restoreAllMocks());

describe("chat responses and concurrent local intent", () => {
  it("keeps a new conversation selection and independent draft while an older send completes", async () => {
    const gate = deferred<ChatSendResponse>();
    const api = transport({ sendMessage: vi.fn(() => gate.promise) });
    const store = ready(api);
    await loaded(store);
    await store.selectConversation(1);
    const pending = store.send("Question for thread one?");
    try {
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
      await store.selectConversation(2);
      store.setInput("Draft for thread two");
      gate.resolve(result(1, "Question for thread one?"));
      await pending;
      expect(store.getState().activeId).toBe(2);
      expect(store.getState().messages.map((row) => row.id)).toEqual([20, 21]);
      expect(store.getState().input).toBe("Draft for thread two");
      await store.selectConversation(1);
      expect(store.getState().messages.map((row) => row.id)).toEqual([10, 11, 12, 13]);
    } finally { gate.resolve(result(1, "Question for thread one?")); await pending; }
  });

  it("does not restore a failed old question over a newer draft", async () => {
    const gate = deferred<ChatSendResponse>();
    const store = ready(transport({ createConversation: vi.fn(() => gate.promise) }));
    const pending = store.send("Old question?");
    store.setInput("Newer draft");
    gate.reject(Object.assign(new Error("Rejected"), { status: 400 }));
    await pending;
    expect(store.getState().input).toBe("Newer draft");
    expect(store.getState().pendingSend).toBeNull();
  });

  it("preserves a confirmed rename when a held send returns its old title", async () => {
    const gate = deferred<ChatSendResponse>();
    const api = transport({ sendMessage: vi.fn(() => gate.promise) });
    const store = ready(api);
    await loaded(store);
    await store.selectConversation(1);
    const pending = store.send("Held question?");
    try {
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
      await store.rename(1, "Confirmed title");
      gate.resolve(result(1, "Held question?"));
      await pending;
      expect(store.getState().conversations.find((row) => row.id === 1)?.title).toBe("Confirmed title");
    } finally { gate.resolve(result(1, "Held question?")); await pending; }
  });

  it("preserves an optimistic rename through a held send then rolls back only that failed rename", async () => {
    const sendGate = deferred<ChatSendResponse>();
    const renameGate = deferred<void>();
    const api = transport({ sendMessage: vi.fn(() => sendGate.promise), renameConversation: vi.fn(() => renameGate.promise) });
    const store = ready(api);
    await loaded(store);
    await store.selectConversation(1);
    const pending = store.send("Held question?");
    const rename = store.rename(1, "Pending title");
    try {
      await vi.waitFor(() => expect(api.renameConversation).toHaveBeenCalledTimes(1));
      sendGate.resolve(result(1, "Held question?"));
      await pending;
      expect(store.getState().conversations.find((row) => row.id === 1)?.title).toBe("Pending title");
      renameGate.reject(new Error("Rename rejected"));
      await rename;
      expect(store.getState().conversations.find((row) => row.id === 1)?.title).toBe("Thread 1");
      expect(store.getState().messages.map((row) => row.id)).toEqual([10, 11, 12, 13]);
    } finally { sendGate.resolve(result(1, "Held question?")); renameGate.resolve(); await Promise.all([pending, rename]); }
  });

  it("retains a confirmed rename when an earlier list request returns", async () => {
    const gate = deferred<Conversation[]>();
    const api = transport();
    const store = ready(api);
    await loaded(store);
    vi.mocked(api.listConversations).mockImplementationOnce(() => gate.promise);
    store.reloadList();
    await store.rename(1, "New title");
    gate.resolve([conversation(1), conversation(2)]);
    await vi.waitFor(() => expect(store.getState().listLoading).toBe(false));
    expect(store.getState().conversations.find((row) => row.id === 1)?.title).toBe("New title");
  });

  it("rolls back only the failed row rename while preserving another row's success", async () => {
    const gate = deferred<void>();
    const api = transport({ renameConversation: vi.fn((id: number) => id === 1 ? gate.promise : Promise.resolve()) });
    const store = ready(api);
    await loaded(store);
    const old = store.rename(1, "Failed title");
    await store.rename(2, "Saved second title");
    gate.reject(new Error("First rename rejected"));
    await old;
    expect(store.getState().conversations.map((row) => row.title).sort()).toEqual(["Saved second title", "Thread 1"]);
  });

  it("serializes feedback so a failed earlier rating cannot undo the later choice", async () => {
    const gate = deferred<void>();
    const api = transport({ rateMessage: vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined) });
    const store = ready(api);
    await store.selectConversation(1);
    const first = store.rate(11, "up");
    await vi.waitFor(() => expect(api.rateMessage).toHaveBeenCalledTimes(1));
    const second = store.rate(11, "down");
    expect(api.rateMessage).toHaveBeenCalledTimes(1);
    gate.reject(new Error("First rating rejected"));
    await Promise.all([first, second]);
    expect(vi.mocked(api.rateMessage).mock.calls.map((args) => args[2])).toEqual(["up", "down"]);
    expect(store.getState().messages.find((row) => row.id === 11)?.feedback).toBe("down");
  });

  it("does not publish held send content into a thread confirmed deleted", async () => {
    const gate = deferred<ChatSendResponse>();
    const api = transport({ sendMessage: vi.fn(() => gate.promise) });
    const store = ready(api);
    await loaded(store);
    await store.selectConversation(1);
    const pending = store.send("Held question?");
    await store.remove(1);
    gate.resolve(result(1, "Held question?"));
    await pending;
    expect(store.getState().conversations.some((row) => row.id === 1)).toBe(false);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().messages).toEqual([]);
  });

  it("does not resurrect deleted rows from held list or detail responses", async () => {
    const list = deferred<Conversation[]>();
    const row = deferred<ConversationDetail>();
    const api = transport({ getConversation: vi.fn(() => row.promise) });
    const store = ready(api);
    await loaded(store);
    vi.mocked(api.listConversations).mockImplementationOnce(() => list.promise);
    store.reloadList();
    const selected = store.selectConversation(1);
    await store.remove(1);
    list.resolve([conversation(1), conversation(2)]);
    row.resolve(detail(1));
    await selected;
    await vi.waitFor(() => expect(store.getState().listLoading).toBe(false));
    expect(store.getState().conversations.map((item) => item.id)).toEqual([2]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().messages).toEqual([]);
  });
});

describe("explicit durable question recovery", () => {
  it("preserves confirmed feedback when recovering an older immutable commit snapshot", async () => {
    const committed = result(7, "Original question?");
    const api = transport({ createConversation: vi.fn().mockRejectedValue(new Error("Lost commit response")),
      getConversation: vi.fn(async (id: number) => id === 7
        ? { ...committed.conversation, messages: [committed.userMessage, { ...committed.assistantMessage, feedback: null }] }
        : detail(id)), getSendStatus: vi.fn(async () => outcome("COMPLETE", { ...committed,
          assistantMessage: { ...committed.assistantMessage, feedback: null } })) });
    const store = ready(api);
    await store.send("Original question?");
    await store.selectConversation(7);
    await store.rate(committed.assistantMessage.id, "up");
    expect(store.getState().messages.find((row) => row.id === committed.assistantMessage.id)?.feedback).toBe("up");
    store.setInput("Independent newer draft");
    await store.checkSend();
    expect(store.getState().messages.find((row) => row.id === committed.assistantMessage.id)?.feedback).toBe("up");
    expect(store.getState().pendingSend).toBeNull();
    expect(store.getState().input).toBe("Independent newer draft");
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.rateMessage).toHaveBeenCalledExactlyOnceWith(7, committed.assistantMessage.id, "up");
    await store.selectConversation(2);
    await store.selectConversation(7);
    expect(store.getState().messages.find((row) => row.id === committed.assistantMessage.id)?.feedback).toBe("up");
    expect(store.getState().messages).toHaveLength(2);
  });

  it.each([400, 422, 429])("clears a fresh first attempt rejected with known status %s", async (status) => {
    const api = transport({ createConversation: vi.fn().mockRejectedValueOnce(Object.assign(new Error("Known first rejection"), { status })).mockImplementation(async (input: { question: string }) => result(7, input.question)) });
    const store = ready(api);
    await store.send("First rejected question?");
    const firstKey = vi.mocked(api.createConversation).mock.calls[0]![0].idempotencyKey;
    expect(store.getState().pendingSend).toBeNull();
    expect(store.getState().input).toBe("First rejected question?");
    await store.send("Deliberate new question?");
    expect(vi.mocked(api.createConversation).mock.calls[1]![0].idempotencyKey).not.toBe(firstKey);
  });

  it("keeps the original uncertain key after status 404 and a retry rejected with 429", async () => {
    const api = transport({ createConversation: vi.fn().mockRejectedValueOnce(new Error("Lost first response")).mockRejectedValue(Object.assign(new Error("Rate limited"), { status: 429 })), getSendStatus: vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })) });
    const store = ready(api);
    await store.send("Original uncertain question?");
    const original = store.getState().pendingSend;
    await store.retrySend();
    expect(store.getState().pendingSend).toEqual(original);
    await store.send("Another question must stay blocked");
    expect(api.createConversation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.createConversation).mock.calls[1]![0]).toEqual(vi.mocked(api.createConversation).mock.calls[0]![0]);
  });

  it("keeps a restored uncertain key after status 404 and retry 429", async () => {
    const saved: PendingChatSend = { version: 1, ownerId: "owner-a", conversationId: null, body: { businessProfileId: 1, originModule: "Dashboard", idempotencyKey: "restored-key-123", question: "Restored uncertain question?" } };
    const persistence = { read: vi.fn(async () => saved), store: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const api = transport({ createConversation: vi.fn().mockRejectedValue(Object.assign(new Error("Rate limited"), { status: 429 })), getSendStatus: vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })) });
    const store = ready(api, persistence);
    await store.reloadRecovery();
    await store.retrySend();
    expect(store.getState().pendingSend).toEqual(saved);
    expect(persistence.remove).not.toHaveBeenCalled();
    await store.send("Another question must stay blocked");
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it("keeps an immutable original request and blocks a different POST after an unknown outcome", async () => {
    const api = transport({ createConversation: vi.fn().mockRejectedValue(new Error("Lost response")) });
    const store = ready(api);
    await store.send("Original question?");
    const pending = store.getState().pendingSend!;
    expect(pending.body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(Object.isFrozen(pending.body)).toBe(true);
    store.setInput("Independent newer draft");
    await store.send("Different question?");
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingSend).toBe(pending);
    expect(store.getState().input).toBe("Independent newer draft");
  });

  it("recovers COMPLETE without another POST or stealing a newer selection/draft", async () => {
    const api = transport({ createConversation: vi.fn().mockRejectedValue(new Error("Lost response")), getSendStatus: vi.fn(async () => outcome("COMPLETE", result(7, "Original question?"))) });
    const store = ready(api);
    await store.send("Original question?");
    await store.selectConversation(2);
    store.setInput("Newer draft");
    await store.checkSend();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingSend).toBeNull();
    expect(store.getState().activeId).toBe(2);
    expect(store.getState().input).toBe("Newer draft");
    expect(store.getState().conversations.filter((row) => row.id === 7)).toHaveLength(1);
    await store.selectConversation(7);
    expect(store.getState().messages.map((row) => row.id)).toEqual([72, 73]);
  });

  it("does not retry or expire PROCESSING based on elapsed time", async () => {
    const api = transport({ createConversation: vi.fn().mockRejectedValue(new Error("Lost response")) });
    const store = ready(api);
    await store.send("Original question?");
    await store.checkSend();
    vi.spyOn(Date, "now").mockReturnValue(new Date("2036-01-01T00:00:00Z").getTime());
    await store.retrySend();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingSend?.body.question).toBe("Original question?");
    expect(store.getState().canRetrySend).toBe(false);
  });

  it("uses exactly the same key and body for an explicit retry after status 404", async () => {
    const api = transport({ createConversation: vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockImplementation(async (input: { question: string }) => result(7, input.question)), getSendStatus: vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })) });
    const store = ready(api);
    await store.send("Original question?");
    const original = structuredClone(vi.mocked(api.createConversation).mock.calls[0]![0]);
    await store.checkSend();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().canRetrySend).toBe(true);
    store.setInput("New draft");
    await store.retrySend();
    expect(vi.mocked(api.createConversation).mock.calls[1]![0]).toEqual(original);
    expect(store.getState().input).toBe("New draft");
    expect(store.getState().pendingSend).toBeNull();
  });

  it.each(["FAILED", "DELETED"] as const)("allows a deliberate new key only after a known %s outcome", async (terminal) => {
    const api = transport({ createConversation: vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockImplementation(async (input: { question: string }) => result(7, input.question)), getSendStatus: vi.fn(async () => outcome(terminal)) });
    const store = ready(api);
    await store.send("Original question?");
    const oldKey = store.getState().pendingSend!.body.idempotencyKey;
    await store.checkSend();
    expect(store.getState().pendingSend).toBeNull();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    await store.send("Deliberate new question?");
    expect(vi.mocked(api.createConversation).mock.calls[1]![0].idempotencyKey).not.toBe(oldKey);
  });

  it("preserves input and stops before POST if persistence fails", async () => {
    const api = transport();
    const persistence = { read: vi.fn(async () => null), store: vi.fn().mockRejectedValue(new Error("Device storage unavailable")), remove: vi.fn(async () => undefined) };
    const store = ready(api, persistence);
    await store.reloadRecovery();
    store.setInput("Keep this question");
    await store.send("Keep this question");
    expect(api.createConversation).not.toHaveBeenCalled();
    expect(store.getState().input).toBe("Keep this question");
    expect(store.getState().recoveryError).toMatch(/Nothing was sent/);
  });

  it("rejects a restored intent for a different owner and never sends its question", async () => {
    const foreign: PendingChatSend = { version: 1, ownerId: "owner-b", conversationId: null, body: { businessProfileId: 1, originModule: "Dashboard", idempotencyKey: "foreign-key-123", question: "Foreign private question" } };
    const api = transport();
    const store = ready(api, { read: vi.fn(async () => foreign), store: vi.fn(), remove: vi.fn() });
    await store.reloadRecovery();
    expect(store.getState().pendingSend).toBeNull();
    expect(store.getState().recoveryError).toMatch(/account and business/);
    await store.send("Safe question?");
    expect(api.createConversation).not.toHaveBeenCalled();
  });
});

describe("bounded history loading", () => {
  it("lets the owner explicitly reload a failed active thread", async () => {
    const api = transport({ getConversation: vi.fn().mockRejectedValueOnce(new Error("Thread offline")).mockResolvedValue(detail(1)) });
    const store = ready(api);
    await store.selectConversation(1);
    expect(store.getState().messagesError).toBe("Thread offline");
    expect(store.getState().activeId).toBe(1);
    await store.reloadConversation();
    expect(store.getState().messages.map((row) => row.id)).toEqual([10, 11]);
    expect(store.getState().messagesError).toBeNull();
  });

  it("avoids caching more than two hundred messages without dropping the visible history", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => message(index + 1, index % 2 ? "assistant" : "user"));
    const api = transport({ getConversation: vi.fn(async (id: number) => id === 1 ? { ...detail(id), messages: rows } : detail(id)) });
    const store = ready(api);
    await store.selectConversation(1);
    expect(store.getState().messages).toHaveLength(201);
    await store.selectConversation(2);
    await store.selectConversation(1);
    expect(api.getConversation).toHaveBeenCalledTimes(3);
    expect(store.getState().messages).toHaveLength(201);
  });

  it("reaches older conversation/message pages without duplicates", async () => {
    const api = transport({ listConversations: vi.fn().mockResolvedValueOnce({ items: [conversation(3), conversation(2)], nextCursor: "older-list" }).mockResolvedValueOnce({ items: [conversation(2), conversation(1)], nextCursor: null }), getConversation: vi.fn().mockResolvedValueOnce({ ...detail(3), messages: [message(3, "user"), message(4, "assistant")], nextCursor: "older-messages" }).mockResolvedValueOnce({ ...detail(3), messages: [message(1, "user"), message(2, "assistant"), message(3, "user")], nextCursor: null }) });
    const store = ready(api);
    await loaded(store);
    await store.loadMoreConversations();
    expect(api.listConversations).toHaveBeenLastCalledWith(1, "older-list");
    expect(store.getState().conversations.map((row) => row.id)).toEqual([3, 2, 1]);
    await store.selectConversation(3);
    await store.loadOlderMessages();
    expect(api.getConversation).toHaveBeenLastCalledWith(3, "older-messages");
    expect(store.getState().messages.map((row) => row.id)).toEqual([1, 2, 3, 4]);
    expect(store.getState().messagesCursor).toBeNull();
  });

  it("reports a non-advancing page while retaining already loaded history", async () => {
    const api = transport({ listConversations: vi.fn().mockResolvedValueOnce({ items: [conversation(2)], nextCursor: "same" }).mockResolvedValueOnce({ items: [conversation(1)], nextCursor: "same" }) });
    const store = ready(api);
    await loaded(store);
    await store.loadMoreConversations();
    expect(store.getState().listError).toMatch(/did not advance/);
    expect(store.getState().conversations.map((row) => row.id)).toEqual([2]);
  });

  it("exposes failed history loading and permits an explicit retry", async () => {
    const api = transport({ listConversations: vi.fn().mockRejectedValueOnce(new Error("History offline")).mockResolvedValue([conversation(1)]) });
    const store = ready(api);
    await loaded(store);
    expect(store.getState().listError).toBe("History offline");
    expect(store.getState().listLoaded).toBe(false);
    store.reloadList();
    await vi.waitFor(() => expect(store.getState().listLoaded).toBe(true));
    expect(store.getState().listError).toBeNull();
  });

  it("revalidates stale detail and evicts the oldest of twenty cached threads", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const api = transport();
    const store = ready(api);
    for (let id = 1; id <= 21; id += 1) await store.selectConversation(id);
    await store.selectConversation(2);
    expect(api.getConversation).toHaveBeenCalledTimes(21);
    await store.selectConversation(1);
    expect(api.getConversation).toHaveBeenCalledTimes(22);
    clock += 30_001;
    await store.selectConversation(2);
    expect(api.getConversation).toHaveBeenCalledTimes(23);
  });
});
