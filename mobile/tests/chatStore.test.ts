import { describe, expect, it, vi } from "vitest";
import { createChatStore, type ChatStore, type ChatTransport } from "../src/lib/chatStore";
import type {
  ChatMessage,
  ChatSendResponse,
  Conversation,
  ConversationDetail,
  ReductionOpportunity,
} from "../src/lib/types";

/**
 * The rules Ask FinSight's conversations have to obey.
 *
 * WHY THE STORE AND NOT THE SHEET: there is no render harness in this project
 * (docs/PROGRESS-REPORT.md), and `lib/api` reaches react-native through the
 * Supabase client, so a test runner in plain Node cannot mount the sheet at
 * all. That is exactly why the state was written as a transport-injectable
 * store with the component left as a view over it — the behaviours that matter
 * here are not visual, they are about what is persisted and what survives.
 *
 * WHAT THIS DOES NOT COVER, said plainly: nothing about the sheet's gestures,
 * its keyboard handling, the history panel's animation, or the Alert.alert
 * confirmations. Those need a physical device.
 */

const conversation = (id: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Conversation ${id}`,
  originModule: "Dashboard",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastMessageAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const message = (id: number, role: "user" | "assistant", content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: "2026-08-01T00:00:00.000Z",
});

/** A minimal but shape-valid opportunity, matching `reductionOpportunitySchema` in ai.controller.ts. */
const opportunity = (over: Partial<ReductionOpportunity> = {}): ReductionOpportunity => ({
  id: "opp-1",
  type: "CATEGORY_PRESSURE",
  categoryId: 10,
  categoryName: "Stock",
  priority: "high",
  confidence: "strong",
  observation: "Stock rose sharply against the period before.",
  rationale: "Stock is 42% of expenses this period, up from 28%.",
  evidence: {
    currentAmount: 8400,
    previousAmount: 5200,
    changeAmount: 3200,
    changePercent: 61.5,
    expenseSharePercent: 42,
    recordCount: 9,
    unusualRecordCount: 1,
    possibleDuplicateCount: 0,
  },
  costBehavior: "unclassified",
  suggestedChecks: ["Compare supplier prices"],
  relatedRecordIds: [101, 102],
  limitations: [],
  ...over,
});

const sendResponse = (conv: Conversation, question: string, answer: string): ChatSendResponse => ({
  conversation: conv,
  userMessage: message(conv.id * 100 + 1, "user", question),
  assistantMessage: message(conv.id * 100 + 2, "assistant", answer),
  provider: "gemini",
  detectedAmount: null,
});

/** A transport whose every method is a spy, so "was anything persisted?" is answerable. */
function fakeTransport(over: Partial<ChatTransport> = {}) {
  return {
    listConversations: vi.fn(async () => [] as Conversation[]),
    getConversation: vi.fn(async (id: number) => ({
      ...conversation(id),
      messages: [message(1, "user", "earlier question"), message(2, "assistant", "earlier answer")],
    } as ConversationDetail)),
    createConversation: vi.fn(async ({ question }: { question: string }) =>
      sendResponse(conversation(7, { title: question.slice(0, 20) }), question, "created answer"),
    ),
    sendMessage: vi.fn(async (id: number, question: string) =>
      sendResponse(conversation(id), question, "follow-up answer"),
    ),
    renameConversation: vi.fn(async () => undefined),
    deleteConversation: vi.fn(async () => undefined),
    ...over,
  } satisfies ChatTransport;
}

function ready(transport: ChatTransport): ChatStore {
  const store = createChatStore(transport);
  store.setBusinessProfile(1);
  return store;
}

describe("lazy creation", () => {
  /**
   * THE RULE THIS FILE EXISTS FOR. Reading the greeting and leaving must
   * persist nothing, or the history list fills with empty threads nobody
   * started — which is what makes a history list worth opening at all.
   */
  it("persists nothing until the first send", async () => {
    const transport = fakeTransport();
    const store = ready(transport);

    store.newChat();
    store.setInput("half a question");
    store.newChat();

    expect(transport.createConversation).not.toHaveBeenCalled();
    expect(store.getState().conversations).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    // And a blank send is not a send.
    await store.send("   ");
    expect(transport.createConversation).not.toHaveBeenCalled();
  });

  it("creates the conversation on the first send and continues it on the second", async () => {
    const transport = fakeTransport();
    const store = ready(transport);

    await store.send("Why did my expenses increase?");
    expect(transport.createConversation).toHaveBeenCalledTimes(1);
    expect(store.getState().activeId).toBe(7);
    expect(store.getState().messages.map((m) => m.content)).toEqual([
      "Why did my expenses increase?",
      "created answer",
    ]);
    // The new thread is at the top of the list, where the server would put it.
    expect(store.getState().conversations[0]?.id).toBe(7);

    await store.send("And in June?");
    expect(transport.createConversation).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage).toHaveBeenCalledWith(7, "And in June?");
    expect(store.getState().messages).toHaveLength(4);
  });

  /**
   * The server derives the title from the first question. The client must not
   * send one — two titling rules would drift, and the server's is the one the
   * stored row can never be empty under.
   */
  it("never sends a title of its own", async () => {
    const transport = fakeTransport();
    const store = ready(transport);
    await store.send("Summarise this month for me");
    expect(transport.createConversation).toHaveBeenCalledWith({
      businessProfileId: 1,
      originModule: "Dashboard",
      question: "Summarise this month for me",
    });
  });

  it("puts the question back in the box when the send fails", async () => {
    const transport = fakeTransport({
      createConversation: vi.fn(async () => {
        throw new Error("Couldn't reach FinSight.");
      }),
    });
    const store = ready(transport);

    await store.send("What needs my attention?");
    expect(store.getState().input).toBe("What needs my attention?");
    expect(store.getState().error).toBe("Couldn't reach FinSight.");
    expect(store.getState().activeId).toBeNull();
  });
});

describe("what survives closing the sheet", () => {
  /**
   * Closing and reopening the sheet, and walking to another screen, are not
   * events the store can even see — which is the point. This drives the only
   * things the sheet does on open (seed the module, ask for the list) and
   * asserts the thread is untouched by them.
   */
  it("keeps the conversation and its messages across an open/close cycle", async () => {
    const transport = fakeTransport();
    const store = ready(transport);

    await store.send("How can I reduce my expenses?");
    const before = store.getState();

    // Closing the sheet on Expense Insights and reopening it on the Dashboard.
    store.setSeedModule("Dashboard");
    store.ensureList();
    store.setSeedModule("Expense Insights");
    store.ensureList();

    const after = store.getState();
    expect(after.activeId).toBe(before.activeId);
    expect(after.messages).toEqual(before.messages);
    expect(transport.createConversation).toHaveBeenCalledTimes(1);
  });

  it("asks for the history list once per business, however often the sheet is opened", async () => {
    const transport = fakeTransport({ listConversations: vi.fn(async () => [conversation(3)]) });
    const store = ready(transport);

    store.ensureList();
    await Promise.resolve();
    store.ensureList();
    store.ensureList();
    await Promise.resolve();

    expect(transport.listConversations).toHaveBeenCalledTimes(1);
    expect(store.getState().conversations).toHaveLength(1);
  });

  /**
   * The one thing that IS allowed to reset a thread. Another business's
   * conversation must never be on screen under the wrong profile.
   */
  it("drops everything when the business profile changes", async () => {
    const store = ready(fakeTransport());
    await store.send("Did I reach today's target?");
    expect(store.getState().activeId).toBe(7);

    store.setBusinessProfile(2);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().conversations).toEqual([]);
    expect(store.getState().listLoaded).toBe(false);
  });
});

describe("switching conversations", () => {
  it("loads the chosen conversation's messages", async () => {
    const transport = fakeTransport({ listConversations: vi.fn(async () => [conversation(3), conversation(4)]) });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();

    await store.selectConversation(4);
    expect(transport.getConversation).toHaveBeenCalledWith(4);
    expect(store.getState().activeId).toBe(4);
    expect(store.getState().messages.map((m) => m.content)).toEqual(["earlier question", "earlier answer"]);
    expect(store.getState().messagesLoading).toBe(false);
  });

  it("serves a conversation already read from memory", async () => {
    const transport = fakeTransport();
    const store = ready(transport);

    await store.selectConversation(4);
    await store.selectConversation(5);
    await store.selectConversation(4);

    expect(transport.getConversation).toHaveBeenCalledTimes(2);
    expect(store.getState().messages).toHaveLength(2);
  });
});

describe("renaming and deleting", () => {
  it("renames the row and tells the server", async () => {
    const transport = fakeTransport({ listConversations: vi.fn(async () => [conversation(3)]) });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();

    await store.rename(3, "  Fridge decision  ");
    expect(transport.renameConversation).toHaveBeenCalledWith(3, "Fridge decision");
    expect(store.getState().conversations[0]?.title).toBe("Fridge decision");
  });

  it("puts the old title back if the server refuses", async () => {
    const transport = fakeTransport({
      listConversations: vi.fn(async () => [conversation(3)]),
      renameConversation: vi.fn(async () => {
        throw new Error("Title is too long.");
      }),
    });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();

    await store.rename(3, "Something else");
    expect(store.getState().conversations[0]?.title).toBe("Conversation 3");
    expect(store.getState().error).toBe("Title is too long.");
  });

  /** An empty title is a slip, not an edit — the row would become blank space. */
  it("ignores a blank rename entirely", async () => {
    const transport = fakeTransport({ listConversations: vi.fn(async () => [conversation(3)]) });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();

    await store.rename(3, "   ");
    expect(transport.renameConversation).not.toHaveBeenCalled();
    expect(store.getState().conversations[0]?.title).toBe("Conversation 3");
  });

  it("removes the row and empties the sheet when the open thread is deleted", async () => {
    const transport = fakeTransport({
      listConversations: vi.fn(async () => [conversation(3), conversation(4)]),
    });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();
    await store.selectConversation(3);

    await store.remove(3);
    expect(transport.deleteConversation).toHaveBeenCalledWith(3);
    expect(store.getState().conversations.map((c) => c.id)).toEqual([4]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().messages).toEqual([]);
  });

  it("leaves the open thread alone when another one is deleted", async () => {
    const transport = fakeTransport({
      listConversations: vi.fn(async () => [conversation(3), conversation(4)]),
    });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();
    await store.selectConversation(3);

    await store.remove(4);
    expect(store.getState().conversations.map((c) => c.id)).toEqual([3]);
    expect(store.getState().activeId).toBe(3);
    expect(store.getState().messages).toHaveLength(2);
  });

  it("keeps the row when the delete fails", async () => {
    const transport = fakeTransport({
      listConversations: vi.fn(async () => [conversation(3)]),
      deleteConversation: vi.fn(async () => {
        throw new Error("Request failed (500)");
      }),
    });
    const store = ready(transport);
    store.ensureList();
    await Promise.resolve();

    await store.remove(3);
    expect(store.getState().conversations).toHaveLength(1);
    expect(store.getState().error).toBe("Request failed (500)");
  });
});

describe("a queued reduction opportunity", () => {
  /**
   * The Reduction Opportunities deep link (lib/reductionOpportunityAsk.ts)
   * primes both the composer and this in one call, so the two can never be
   * set out of order or one forgotten. The object sent over the wire is the
   * verbatim `ReductionOpportunity`, matching
   * `createConversationSchema.reductionOpportunity`/
   * `appendMessageSchema.reductionOpportunity` in
   * backend/src/controllers/ai.controller.ts — never a client-serialized
   * string.
   */
  it("sends the queued opportunity on the very next send, then forgets it", async () => {
    const transport = fakeTransport();
    const store = ready(transport);
    const target = opportunity();

    store.prepareQuestion("Why was this selected?", target);
    expect(store.getState().input).toBe("Why was this selected?");

    await store.send(store.getState().input);
    expect(transport.createConversation).toHaveBeenCalledWith({
      businessProfileId: 1,
      originModule: "Dashboard",
      question: "Why was this selected?",
      reductionOpportunity: target,
    });
    expect(store.getState().pendingReductionOpportunity).toBeNull();

    // The next send is an ordinary follow-up — no stale opportunity is replayed.
    await store.send("And what about last month?");
    expect(transport.sendMessage).toHaveBeenCalledWith(7, "And what about last month?");
  });

  it("carries the queued opportunity onto an already-open conversation as a 3-argument call", async () => {
    const transport = fakeTransport();
    const store = ready(transport);
    await store.send("first question"); // opens conversation 7

    const target = opportunity({ id: "opp-2" });
    store.prepareQuestion("Why was this selected?", target);
    await store.send(store.getState().input);

    expect(transport.sendMessage).toHaveBeenLastCalledWith(7, "Why was this selected?", target);
  });

  it("restores the queued opportunity alongside the question if the send fails", async () => {
    const transport = fakeTransport({
      createConversation: vi.fn(async () => {
        throw new Error("Couldn't reach FinSight.");
      }),
    });
    const store = ready(transport);
    const target = opportunity();

    store.prepareQuestion("Why was this selected?", target);
    await store.send(store.getState().input);

    expect(store.getState().input).toBe("Why was this selected?");
    expect(store.getState().pendingReductionOpportunity).toEqual(target);
  });

  it("is dropped by starting a new chat, so it cannot bleed into a later question", async () => {
    const store = ready(fakeTransport());
    store.prepareQuestion("Why was this selected?", opportunity());

    store.newChat();
    expect(store.getState().pendingReductionOpportunity).toBeNull();
  });
});

describe("the outage and amount disclosures", () => {
  it("flags a placeholder answer when both providers failed", async () => {
    const transport = fakeTransport({
      createConversation: vi.fn(async () => ({
        ...sendResponse(conversation(7), "q", "placeholder"),
        provider: "unavailable" as const,
      })),
    });
    const store = ready(transport);
    await store.send("q");
    expect(store.getState().unavailable).toBe(true);
  });

  it("carries the amount the server parsed out of the question", async () => {
    const transport = fakeTransport({
      createConversation: vi.fn(async () => ({
        ...sendResponse(conversation(7), "What if I spend 11,000 on a fridge?", "…"),
        detectedAmount: 11000,
      })),
    });
    const store = ready(transport);
    await store.send("What if I spend 11,000 on a fridge?");
    expect(store.getState().detectedAmount).toBe(11000);

    // And it does not linger over the next answer, which was about something else.
    await store.send("And next month?");
    expect(store.getState().detectedAmount).toBeNull();
  });
});
