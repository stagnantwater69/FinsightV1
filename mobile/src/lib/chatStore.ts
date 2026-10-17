import type {
  ChatFocus,
  ChatMessage,
  ChatSendResponse,
  Conversation,
  ConversationDetail,
  ConversationPage,
  ChatSendStatus,
  InteractionModule,
  ReductionOpportunity,
} from "./types";
import { createPendingChatSend, parsePendingChatSend, type ChatSendPersistence, type PendingChatSend } from "./chatSendIntent";

/**
 * Ask FinSight's whole conversation state, held OUTSIDE the sheet that draws it.
 *
 * ---------------------------------------------------------------------
 * Why a store and not the sheet's own useState
 * ---------------------------------------------------------------------
 * The sheet's `visible` flag used to BE the conversation lifecycle: it fetched
 * `/ai/history` on every open and threw everything away on close, and every
 * screen kept its own copy of the thread. Closing the sheet on Home and
 * reopening it on Expense Insights showed a different conversation.
 *
 * So the invariant this file exists to hold is the one web's AiChatContext
 * holds: opening the sheet, closing it, and moving between screens must NEVER
 * start a new conversation or reset the current one. None of those actions can
 * reach `activeId`, `messages` or the cache, because they are not in the
 * sheet's scope to reset — structural, rather than a guard clause someone can
 * later delete.
 *
 * ---------------------------------------------------------------------
 * Why it is a plain store rather than hooks
 * ---------------------------------------------------------------------
 * There is NO render harness in this project (see docs/PROGRESS-REPORT.md) —
 * `mobile/tests` runs in plain Node and cannot even import `lib/api`, which
 * reaches react-native through the Supabase client. A store that knows nothing
 * about React and takes its transport as an argument is therefore the only
 * shape of this logic that can be tested at all: `tests/chatStore.test.ts`
 * drives it with a fake transport. `context/AiChatContext.tsx` is the thin
 * React wrapper that hands it the real one.
 *
 * ---------------------------------------------------------------------
 * Lazy creation
 * ---------------------------------------------------------------------
 * `newChat()` persists NOTHING. It clears to the greeting and only the first
 * send calls POST /ai/conversations. An owner who opens the sheet, reads the
 * greeting and leaves has an untouched history — which is why a list of empty
 * "New chat" rows can never appear.
 *
 * ---------------------------------------------------------------------
 * Context is still rebuilt server-side
 * ---------------------------------------------------------------------
 * Almost every send carries the question and nothing else: the server rebuilds
 * the module context from fresh data on every message and threads this
 * conversation's own recent turns into it, which is what lets a follow-up see
 * a record added seconds ago. Posting a snapshot captured when the sheet
 * opened is exactly the staleness bug that avoids — the same reasoning the
 * original sheet carried.
 *
 * `pendingReductionOpportunity` is the one deliberate exception. It carries
 * the SAME structured object `GET /insights/reduction-opportunities` already
 * returned for a SINGLE deep-linked question — see
 * lib/reductionOpportunityAsk.ts — and is queued only for the next send,
 * never replayed on a later one. It does not undo the rule above: the server
 * still rebuilds everything else fresh; it only adds this one flat field to
 * the request body, matching `askSchema`/`createConversationSchema`/
 * `appendMessageSchema`'s `reductionOpportunity` field in
 * backend/src/controllers/ai.controller.ts exactly — never free-form prose
 * serialized client-side (see the plan's §11.1 warning against that).
 */

/** Everything the store needs from the network, so a test can supply its own. */
export interface ChatTransport {
  listConversations(businessProfileId: number, cursor?: string): Promise<ConversationPage | Conversation[]>;
  getConversation(id: number, cursor?: string): Promise<ConversationDetail>;
  createConversation(input: {
    businessProfileId: number;
    originModule: InteractionModule;
    question: string;
    idempotencyKey?: string;
    /**
     * The selected Reduction Opportunity card for THIS one message — see
     * lib/reductionOpportunityAsk.ts for the entry point that fills it. Sent
     * as the verbatim structured object, matching
     * `createConversationSchema.reductionOpportunity` server-side; the
     * server only honours it on the "Expense Insights" module and still
     * rebuilds the rest of the context fresh.
     */
    reductionOpportunity?: ReductionOpportunity;
    /** The flag or record "Explain this flag" was pressed on — ids only. */
    focus?: ChatFocus;
  }): Promise<ChatSendResponse>;
  sendMessage(
    conversationId: number,
    question: string,
    reductionOpportunity?: ReductionOpportunity,
    focus?: ChatFocus,
    send?: { businessProfileId: number; idempotencyKey: string },
  ): Promise<ChatSendResponse>;
  getSendStatus?(key: string, businessProfileId: number): Promise<ChatSendStatus>;
  /** Thumbs up/down on one assistant reply; null clears it. */
  rateMessage(conversationId: number, messageId: number, feedback: "up" | "down" | null): Promise<void>;
  renameConversation(conversationId: number, title: string): Promise<void>;
  deleteConversation(conversationId: number): Promise<void>;
}

export interface ChatState {
  /** Where the next NEW conversation will say it started. Metadata only. */
  seedModule: InteractionModule;

  // --- history ---
  conversations: Conversation[];
  listLoading: boolean;
  listError: string | null;
  /** Whether the list has been fetched for the profile currently selected. */
  listLoaded: boolean;
  listCursor: string | null;
  listLoadingMore: boolean;

  // --- the open conversation ---
  activeId: number | null;
  messages: ChatMessage[];
  messagesLoading: boolean;
  messagesCursor: string | null;
  messagesLoadingMore: boolean;
  messagesError: string | null;

  // --- the composer ---
  input: string;
  /**
   * The reduction opportunity queued for the NEXT send only — see
   * `ChatTransport.createConversation`'s `reductionOpportunity` field.
   * Cleared the moment a send is attempted (successful or not), so it can
   * never bleed into a later, unrelated question the way `input` deliberately
   * can.
   */
  pendingReductionOpportunity: ReductionOpportunity | null;
  /**
   * The flag or record the next send is about. Same one-shot lifetime as the
   * reduction opportunity; the server stores it on the conversation, so later
   * messages in that thread stay about it without the client resending it.
   */
  pendingFocus: ChatFocus | null;
  sending: boolean;
  error: string | null;
  unavailable: boolean;
  detectedAmount: number | null;
  pendingSend: PendingChatSend | null;
  recoveryLoading: boolean;
  recoveryError: string | null;
  checkingSend: boolean;
  canRetrySend: boolean;
}

const EMPTY: ChatState = {
  seedModule: "Dashboard",
  conversations: [],
  listLoading: false,
  listError: null,
  listLoaded: false,
  listCursor: null,
  listLoadingMore: false,
  activeId: null,
  messages: [],
  messagesLoading: false,
  messagesCursor: null,
  messagesLoadingMore: false,
  messagesError: null,
  input: "",
  pendingReductionOpportunity: null,
  pendingFocus: null,
  sending: false,
  error: null,
  unavailable: false,
  detectedAmount: null,
  pendingSend: null,
  recoveryLoading: false,
  recoveryError: null,
  checkingSend: false,
  canRetrySend: false,
};

/**
 * `Conversation_Title` is VARCHAR(120) and PATCH /ai/conversations/:id rejects
 * anything longer.
 *
 * Deliberately NOT added to lib/fieldLimits.ts, for the same reason web's
 * ConversationItem.tsx keeps its own copy: that object is asserted key-for-key
 * equal to web's by backend/tests/contract/fieldLimits.test.ts, and adding a
 * key here alone would fail the contract.
 */
export const CONVERSATION_TITLE_MAX = 120;

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}

export interface ChatStore {
  getState(): ChatState;
  subscribe(listener: () => void): () => void;

  /** The business the thread belongs to. Changing it drops everything. */
  setBusinessProfile(id: number | null, ownerId?: string | number | null): void;
  setSeedModule(module: InteractionModule): void;
  setInput(value: string): void;
  /**
   * Primes `input` AND `pendingReductionOpportunity` together, in one update
   * — see lib/reductionOpportunityAsk.ts. A separate setter call would leave
   * a window where the two could be set in the wrong order, or where a caller
   * sets one and forgets the other.
   */
  prepareQuestion(question: string, reductionOpportunity?: ReductionOpportunity, focus?: ChatFocus): void;

  /** Fetch the history list once per business profile. Safe to call on every open. */
  ensureList(): void;
  reloadList(): void;
  loadMoreConversations(): Promise<void>;

  newChat(): void;
  selectConversation(id: number): Promise<void>;
  reloadConversation(): Promise<void>;
  loadOlderMessages(): Promise<void>;
  send(text: string): Promise<void>;
  checkSend(): Promise<void>;
  retrySend(): Promise<void>;
  reloadRecovery(): Promise<void>;
  rename(id: number, title: string): Promise<void>;
  remove(id: number): Promise<void>;
  /** Thumbs on one reply of the open conversation. Optimistic; rolled back on failure. */
  rate(messageId: number, feedback: "up" | "down" | null): Promise<void>;
}

export function createChatStore(transport: ChatTransport, persistence?: ChatSendPersistence): ChatStore {
  let state: ChatState = EMPTY;
  let businessProfileId: number | null = null;
  let businessGeneration = 0;
  let ownerId: string | null = null;
  let selectionVersion = 0;
  let draftVersion = 0;
  let listVersion = 0;
  let listLoadedAt = 0;
  let sendFlight: PendingChatSend | null = null;
  const seenListCursors = new Set<string>();
  const seenMessageCursors = new Set<string>();
  const deleted = new Set<number>();
  const mutations = new Map<string, Promise<void>>();
  const mutationVersions = new Map<string, number>();
  const messageVersions = new Map<number, number>();
  const attemptedSends = new Set<string>();
  const sendContexts = new Map<string, { selection: number; draft: number; messages: ChatMessage[]; nextCursor: string | null }>();
  const listeners = new Set<() => void>();

  /**
   * Messages by conversation id, so returning to one already read is instant
   * and silent. Not part of `state`: nothing renders differently because an
   * entry landed in it.
   */
  const cache = new Map<number, { messages: ChatMessage[]; at: number; nextCursor: string | null }>();
  /** The conversation a fetch was started for, so a slow one cannot land late over a newer choice. */
  let wanted: number | null = null;

  function set(patch: Partial<ChatState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function clearExchangeState(): Partial<ChatState> {
    return { error: null, unavailable: false, detectedAmount: null, pendingReductionOpportunity: null, pendingFocus: null };
  }

  const mergeMessages = (...lists: ChatMessage[][]) => [...new Map(lists.flat().map((message) => [message.id, message])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);

  function cacheMessages(id: number, messages: ChatMessage[], nextCursor: string | null, at = Date.now()) {
    cache.delete(id);
    if (messages.length > 200 || deleted.has(id)) return;
    cache.set(id, { messages, nextCursor, at });
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
  }

  function serializeMutation(key: string, action: () => Promise<void>) {
    const previous = mutations.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    mutations.set(key, pending);
    void pending.finally(() => { if (mutations.get(key) === pending) mutations.delete(key); }).catch(() => undefined);
    return pending;
  }

  async function restoreRecovery() {
    if (!persistence || ownerId === null || businessProfileId === null) return;
    const owner = ownerId;
    const business = businessProfileId;
    const generation = businessGeneration;
    set({ recoveryLoading: true, recoveryError: null });
    try {
      const pending = await persistence.read(owner, business);
      if (generation !== businessGeneration) return;
      const restored = pending ? parsePendingChatSend(pending, owner, business) : null;
      if (restored) attemptedSends.add(restored.body.idempotencyKey);
      set({ pendingSend: restored, recoveryLoading: false, canRetrySend: false });
    } catch (err) {
      if (generation === businessGeneration) set({ recoveryLoading: false, recoveryError: messageOf(err) });
    }
  }

  async function loadList(cursor?: string, force = false) {
    if (businessProfileId === null || state.listLoading || state.listLoadingMore) return;
    if (!cursor && !force && state.listLoaded && Date.now() - listLoadedAt < 30_000) return;
    const business = businessProfileId;
    const generation = businessGeneration;
    const request = ++listVersion;
    const before = new Map(state.conversations.map((row) => [row.id, row]));
    set(cursor ? { listLoadingMore: true, listError: null } : { listLoading: true, listError: null });
    try {
      const result = cursor ? await transport.listConversations(business, cursor) : await transport.listConversations(business);
      if (generation !== businessGeneration || request !== listVersion) return;
      const page = Array.isArray(result) ? { items: result, nextCursor: null } : result;
      if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new Error("The conversation page could not be read.");
      if (cursor && page.nextCursor !== null && (page.nextCursor === cursor || seenListCursors.has(page.nextCursor))) throw new Error("The conversation page did not advance. Reload history before continuing.");
      if (cursor) seenListCursors.add(cursor); else seenListCursors.clear();
      const rows = cursor ? [...state.conversations, ...page.items] : [...page.items];
      for (const row of state.conversations) {
        if (before.get(row.id) !== row || row.id === state.activeId) {
          const at = rows.findIndex((item) => item.id === row.id);
          if (at >= 0) rows[at] = row; else rows.push(row);
        }
      }
      const conversations = [...new Map(rows.filter((row) => !deleted.has(row.id)).map((row) => [row.id, row])).values()]
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id - a.id);
      listLoadedAt = Date.now();
      set({ conversations, listCursor: page.nextCursor, listLoaded: true, listLoading: false, listLoadingMore: false });
    } catch (err) {
      if (generation === businessGeneration && request === listVersion) set({ listError: messageOf(err), listLoading: false, listLoadingMore: false });
    }
  }

  async function openConversation(id: number, force = false, cursor?: string) {
    if (businessProfileId === null || deleted.has(id)) return;
    const generation = businessGeneration;
    const business = businessProfileId;
    if (cursor && state.messagesLoadingMore) return;
    if (!cursor) {
      if (!force && id === state.activeId && (state.messagesLoading || !state.messagesError)) return;
      selectionVersion += 1;
      wanted = id;
      seenMessageCursors.clear();
      const cached = cache.get(id);
      if (!force && cached && Date.now() - cached.at < 30_000) {
        cache.delete(id); cache.set(id, cached);
        set({ activeId: id, messages: cached.messages, messagesCursor: cached.nextCursor, messagesLoading: false, messagesLoadingMore: false, messagesError: null, ...clearExchangeState() });
        return;
      }
      set({ activeId: id, messages: [], messagesCursor: null, messagesLoading: true, messagesLoadingMore: false, messagesError: null, ...clearExchangeState() });
    } else set({ messagesLoadingMore: true, messagesError: null });
    const selection = selectionVersion;
    const messageVersion = messageVersions.get(id) ?? 0;
    try {
      const detail = cursor ? await transport.getConversation(id, cursor) : await transport.getConversation(id);
      if (generation !== businessGeneration || deleted.has(id) || (messageVersions.get(id) ?? 0) !== messageVersion) return;
      if (!detail || detail.id !== id || !Array.isArray(detail.messages)) throw new Error("This conversation could not be verified.");
      const receivedBusiness = (detail as ConversationDetail & { businessProfileId?: number }).businessProfileId;
      if (receivedBusiness !== undefined && receivedBusiness !== business) throw new Error("This conversation belongs to another business.");
      const nextCursor = detail.nextCursor ?? null;
      if (cursor && nextCursor !== null && (nextCursor === cursor || seenMessageCursors.has(nextCursor))) throw new Error("The message page did not advance. Reload this conversation before continuing.");
      const current = selection === selectionVersion && wanted === id;
      if (cursor && !current) return;
      if (cursor) seenMessageCursors.add(cursor);
      const messages = mergeMessages(cursor ? state.messages : [], detail.messages);
      cacheMessages(id, messages, nextCursor);
      if (current) set({ messages, messagesCursor: nextCursor, messagesLoading: false, messagesLoadingMore: false, messagesError: null });
    } catch (err) {
      if (generation === businessGeneration && selection === selectionVersion && wanted === id) set({ error: messageOf(err), messagesError: messageOf(err), messagesLoading: false, messagesLoadingMore: false });
    } finally {
      if (generation === businessGeneration && selection === selectionVersion && wanted === id) set({ messagesLoading: false, messagesLoadingMore: false });
    }
  }

  async function finishIntent(intent: PendingChatSend, generation: number) {
    try {
      if (persistence) await persistence.remove(intent);
      if (generation === businessGeneration && state.pendingSend?.body.idempotencyKey === intent.body.idempotencyKey) {
        sendContexts.delete(intent.body.idempotencyKey);
        attemptedSends.delete(intent.body.idempotencyKey);
        set({ pendingSend: null, canRetrySend: false, recoveryError: null });
      }
    } catch (err) {
      if (generation === businessGeneration) set({ recoveryError: `The request outcome is known, but device recovery could not be cleared. ${messageOf(err)}`, canRetrySend: false });
    }
  }

  function publish(intent: PendingChatSend, result: ChatSendResponse, generation: number, selection: number | null) {
    if (generation !== businessGeneration || deleted.has(result.conversation.id)) return;
    if (!result.userMessage || result.userMessage.content !== intent.body.question || (intent.conversationId !== null && result.conversation.id !== intent.conversationId)) throw new Error("FinSight returned a different question's result. Check the previous request before sending again.");
    const id = result.conversation.id;
    const entry = cache.get(id);
    const origin = sendContexts.get(intent.body.idempotencyKey);
    const previous = state.activeId === id ? state.messages : entry?.messages ?? origin?.messages ?? [];
    const knownMessages = new Map([...(entry?.messages ?? []), ...(state.activeId === id ? state.messages : [])].map((message) => [message.id, message]));
    // Send results are immutable commit snapshots; ratings can change afterward.
    const receivedMessages = [result.userMessage, result.assistantMessage].map((message) => {
      const existing = knownMessages.get(message.id);
      return existing?.feedback !== undefined ? { ...message, feedback: existing.feedback } : message;
    });
    const messages = mergeMessages(previous, receivedMessages);
    const nextCursor = state.activeId === id ? state.messagesCursor : entry?.nextCursor ?? origin?.nextCursor ?? null;
    messageVersions.set(id, (messageVersions.get(id) ?? 0) + 1);
    if (intent.conversationId === null || entry || origin || (state.activeId === id && !state.messagesError)) cacheMessages(id, messages, nextCursor);
    const current = state.conversations.find((row) => row.id === id);
    const conversation = current && mutationVersions.has(`rename:${id}`)
      ? { ...result.conversation, title: current.title } : result.conversation;
    const conversations = [conversation, ...state.conversations.filter((row) => row.id !== id)];
    const sameSelection = selection !== null && selection === selectionVersion && state.activeId === intent.conversationId;
    set({ conversations, ...((sameSelection || state.activeId === id) ? { ...(sameSelection ? { activeId: id } : {}), messages, messagesCursor: nextCursor, messagesLoading: false, unavailable: result.provider === "unavailable", detectedAmount: result.detectedAmount } : {}) });
    if (sameSelection) wanted = id;
  }

  async function postIntent(intent: PendingChatSend, generation: number, selection: number | null, draft: number) {
    const previouslyAttempted = attemptedSends.has(intent.body.idempotencyKey);
    sendFlight = intent;
    set({ sending: true, pendingSend: intent, canRetrySend: false, error: null, recoveryError: null });
    let posted = false;
    try {
      if (persistence) {
        if (intent.ownerId === null) throw new Error("Sign in before sending a question.");
        await persistence.store(intent);
      }
      if (generation !== businessGeneration) return;
      if (selection === selectionVersion && draft === draftVersion) { set({ input: "", pendingReductionOpportunity: null, pendingFocus: null }); draftVersion += 1; draft = draftVersion; }
      const origin = sendContexts.get(intent.body.idempotencyKey);
      if (origin && selection === selectionVersion) origin.draft = draft;
      const { body, conversationId } = intent;
      posted = true;
      attemptedSends.add(body.idempotencyKey);
      const result = conversationId === null ? await transport.createConversation({ ...body, originModule: body.originModule! })
        : await transport.sendMessage(conversationId, body.question, body.reductionOpportunity, body.focus, { businessProfileId: body.businessProfileId, idempotencyKey: body.idempotencyKey });
      if (generation !== businessGeneration) return;
      publish(intent, result, generation, selection);
      await finishIntent(intent, generation);
    } catch (err) {
      if (generation !== businessGeneration) return;
      const status = (err as { status?: number } | null)?.status;
      const code = (err as { code?: string } | null)?.code;
      const unknown = previouslyAttempted || (posted && (status === undefined || status === 0 || status === 408 || status >= 500 || code === "CHAT_SEND_IN_PROGRESS"));
      if (posted && !unknown) await finishIntent(intent, generation);
      const message = unknown ? "FinSight did not confirm whether this question finished. Check its status before retrying; your original question is kept."
        : !posted ? `Question recovery could not be saved. Nothing was sent. ${messageOf(err)}` : messageOf(err);
      const restore = selection === selectionVersion && draft === draftVersion && !state.input;
      set({ error: message, ...(!posted ? { recoveryError: message } : {}), ...(restore ? { input: intent.body.question, pendingReductionOpportunity: intent.body.reductionOpportunity ?? null, pendingFocus: intent.body.focus ?? null } : {}) });
    } finally {
      if (sendFlight === intent) { sendFlight = null; if (generation === businessGeneration) set({ sending: false }); }
    }
  }

  async function resolveSend(retry: boolean) {
    const intent = state.pendingSend;
    if (!intent || !transport.getSendStatus || sendFlight || state.checkingSend) return;
    const generation = businessGeneration;
    const origin = sendContexts.get(intent.body.idempotencyKey);
    const selection = origin?.selection ?? null;
    const draft = origin?.draft ?? draftVersion;
    set({ checkingSend: true, error: null });
    try {
      const status = await transport.getSendStatus(intent.body.idempotencyKey, intent.body.businessProfileId);
      if (generation !== businessGeneration) return;
      if (status.status === "COMPLETE" && status.result) {
        publish(intent, status.result, generation, selection);
        await finishIntent(intent, generation);
      } else if (status.status === "FAILED" || status.status === "DELETED") {
        await finishIntent(intent, generation);
        set({ error: status.error?.message ?? "The earlier conversation was deleted. You can start a new question." });
      } else set({ error: "FinSight is still working on this question. Check again before retrying.", canRetrySend: false });
    } catch (err) {
      if (generation !== businessGeneration) return;
      if ((err as { status?: number } | null)?.status === 404) {
        set({ canRetrySend: true, error: "FinSight has no saved outcome for this request. Retry the original question when you are ready." });
        if (retry) await postIntent(intent, generation, selection, draft);
      } else set({ error: `The earlier question could not be checked. ${messageOf(err)}`, canRetrySend: false });
    } finally {
      if (generation === businessGeneration) set({ checkingSend: false });
    }
  }

  const store: ChatStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /*
     * A thread belongs to one business, so switching business drops whatever
     * was open along with the list it came from. This is the ONLY thing that
     * resets a conversation without the owner asking — and it is another
     * business's data, which must never be on screen under the wrong profile.
     */
    setBusinessProfile(id, account) {
      const nextOwner = account === undefined ? ownerId : account === null ? null : String(account);
      if (id === businessProfileId && nextOwner === ownerId) return;
      businessProfileId = id;
      ownerId = nextOwner;
      businessGeneration += 1;
      selectionVersion += 1;
      draftVersion += 1;
      listVersion += 1;
      listLoadedAt = 0;
      sendFlight = null;
      seenListCursors.clear();
      seenMessageCursors.clear();
      deleted.clear();
      mutations.clear();
      mutationVersions.clear();
      messageVersions.clear();
      attemptedSends.clear();
      sendContexts.clear();
      cache.clear();
      wanted = null;
      set({ ...EMPTY });
      void restoreRecovery();
    },

    setSeedModule(module) {
      if (businessProfileId === null) return;
      // Seeds the NEXT new conversation only. An existing thread keeps the
      // origin it was created with, whichever screen it is reopened from.
      if (module !== state.seedModule) set({ seedModule: module });
    },

    setInput(value) {
      if (businessProfileId === null) return;
      draftVersion += 1;
      if (value !== state.input) set({ input: value });
    },

    prepareQuestion(question, reductionOpportunity, focus) {
      if (businessProfileId === null) return;
      draftVersion += 1;
      if (focus) {
        // A question about one specific flag gets a thread of its own:
        // continuing whatever was open would answer it with that thread's
        // history and focus.
        wanted = null;
        selectionVersion += 1;
        set({
          activeId: null,
          messages: [],
          messagesLoading: false,
          messagesCursor: null,
          messagesLoadingMore: false,
          messagesError: null,
          ...clearExchangeState(),
          input: question,
          pendingReductionOpportunity: reductionOpportunity ?? null,
          pendingFocus: focus,
        });
        return;
      }
      set({ input: question, pendingReductionOpportunity: reductionOpportunity ?? null, pendingFocus: null });
    },

    /*
     * The guard is on HAVING FETCHED, not on the sheet being open, which is
     * what keeps reopening the sheet free — and what stops a toggle from ever
     * re-requesting anything.
     */
    ensureList() {
      void loadList();
    },
    reloadList() { void loadList(undefined, true); },
    async loadMoreConversations() { if (state.listCursor) await loadList(state.listCursor); },
    async reloadRecovery() { await restoreRecovery(); },
    async checkSend() { await resolveSend(false); },
    async retrySend() { await resolveSend(true); },

    newChat() {
      if (businessProfileId === null) return;
      wanted = null;
      selectionVersion += 1;
      draftVersion += 1;
      set({
        activeId: null,
        messages: [],
        messagesLoading: false,
        messagesCursor: null,
        messagesLoadingMore: false,
        messagesError: null,
        input: "",
        ...clearExchangeState(),
      });
    },

    async selectConversation(id) {
      await openConversation(id);
    },
    async reloadConversation() { if (state.activeId !== null) await openConversation(state.activeId, true); },
    async loadOlderMessages() { if (state.activeId !== null && state.messagesCursor) await openConversation(state.activeId, false, state.messagesCursor); },

    async send(text) {
      const question = text.trim();
      if (!question || sendFlight || state.sending || businessProfileId === null || state.recoveryLoading || state.recoveryError) return;
      if (state.pendingSend) { set({ error: "Check the earlier question before sending different details." }); return; }
      try {
        const intent = createPendingChatSend(ownerId, state.activeId, {
          businessProfileId, question,
          ...(state.activeId === null ? { originModule: state.seedModule } : {}),
          ...(state.pendingReductionOpportunity ? { reductionOpportunity: state.pendingReductionOpportunity } : {}),
          ...(state.pendingFocus ? { focus: state.pendingFocus } : {}),
        });
        sendContexts.set(intent.body.idempotencyKey, { selection: selectionVersion, draft: draftVersion, messages: state.messages, nextCursor: state.messagesCursor });
        await postIntent(intent, businessGeneration, selectionVersion, draftVersion);
      } catch (err) { set({ error: messageOf(err) }); }
    },

    async rename(id, title) {
      if (businessProfileId === null) return;
      const forProfile = businessProfileId;
      const generation = businessGeneration;
      const next = title.trim().slice(0, CONVERSATION_TITLE_MAX);
      // An empty title is not an edit, it is a slip — the row would become
      // blank space. Silently keep what was there.
      if (!next) return;

      await serializeMutation(`rename:${id}`, async () => {
        if (businessProfileId !== forProfile || businessGeneration !== generation || deleted.has(id)) return;
        const before = state.conversations.find((row) => row.id === id)?.title;
        if (before === undefined) return;
        const key = `rename:${id}`;
        const version = (mutationVersions.get(key) ?? 0) + 1;
        mutationVersions.set(key, version);
        set({ conversations: state.conversations.map((row) => row.id === id ? { ...row, title: next } : row) });
        try { await transport.renameConversation(id, next); }
        catch (err) {
          if (businessProfileId !== forProfile || businessGeneration !== generation || deleted.has(id) || mutationVersions.get(key) !== version) return;
          set({ conversations: state.conversations.map((row) => row.id === id && row.title === next ? { ...row, title: before } : row), error: messageOf(err) });
        }
      });
    },

    async remove(id) {
      if (businessProfileId === null) return;
      const forProfile = businessProfileId;
      const generation = businessGeneration;
      try {
        await transport.deleteConversation(id);
      } catch (err) {
        if (businessProfileId !== forProfile || businessGeneration !== generation) return;
        set({ error: messageOf(err) });
        return;
      }
      if (businessProfileId !== forProfile || businessGeneration !== generation) return;
      deleted.add(id);
      messageVersions.set(id, (messageVersions.get(id) ?? 0) + 1);
      cache.delete(id);
      if (wanted === id) wanted = null;
      const conversations = state.conversations.filter((c) => c.id !== id);
      // Deleting the thread being read empties the sheet back to the greeting;
      // deleting any other one leaves it alone.
      set(
        state.activeId === id
          ? { conversations, activeId: null, messages: [], messagesCursor: null, messagesLoading: false, messagesError: null, ...clearExchangeState() }
          : { conversations },
      );
      if (state.activeId === null) selectionVersion += 1;
    },

    async rate(messageId, feedback) {
      if (businessProfileId === null || state.activeId === null) return;
      const forProfile = businessProfileId;
      const generation = businessGeneration;
      const conversationId = state.activeId;
      const apply = (list: ChatMessage[], value: "up" | "down" | null) =>
        list.map((m) => (m.id === messageId ? { ...m, feedback: value } : m));
      await serializeMutation(`feedback:${conversationId}:${messageId}`, async () => {
        if (businessProfileId !== forProfile || businessGeneration !== generation || deleted.has(conversationId)) return;
        const entry = cache.get(conversationId);
        const messages = state.activeId === conversationId ? state.messages : entry?.messages ?? [];
        if (!messages.some((message) => message.id === messageId)) return;
        const before = messages.find((message) => message.id === messageId)?.feedback ?? null;
        const key = `feedback:${conversationId}:${messageId}`;
        const version = (mutationVersions.get(key) ?? 0) + 1;
        mutationVersions.set(key, version);
        const next = apply(messages, feedback);
        messageVersions.set(conversationId, (messageVersions.get(conversationId) ?? 0) + 1);
        cacheMessages(conversationId, next, entry?.nextCursor ?? state.messagesCursor, entry?.at);
        if (state.activeId === conversationId) set({ messages: next });
        try { await transport.rateMessage(conversationId, messageId, feedback); }
        catch (err) {
          if (businessProfileId !== forProfile || businessGeneration !== generation || deleted.has(conversationId) || mutationVersions.get(key) !== version) return;
          const current = cache.get(conversationId);
          const restored = apply(state.activeId === conversationId ? state.messages : current?.messages ?? [], before);
          cacheMessages(conversationId, restored, current?.nextCursor ?? null, current?.at);
          set({ ...(state.activeId === conversationId ? { messages: restored } : {}), error: messageOf(err) });
        }
      });
    },
  };
  return store;
}
