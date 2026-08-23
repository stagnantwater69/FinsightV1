import type {
  ChatMessage,
  ChatSendResponse,
  Conversation,
  ConversationDetail,
  InteractionModule,
} from "./types";

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
 * Sends carry the question and nothing else. The server rebuilds the module
 * context from fresh data on every message and threads this conversation's own
 * recent turns into it, which is what lets a follow-up see a record added
 * seconds ago. Posting a snapshot captured when the sheet opened is exactly the
 * staleness bug that avoids — the same reasoning the original sheet carried.
 */

/** Everything the store needs from the network, so a test can supply its own. */
export interface ChatTransport {
  listConversations(businessProfileId: number): Promise<Conversation[]>;
  getConversation(id: number): Promise<ConversationDetail>;
  createConversation(input: {
    businessProfileId: number;
    originModule: InteractionModule;
    question: string;
  }): Promise<ChatSendResponse>;
  sendMessage(conversationId: number, question: string): Promise<ChatSendResponse>;
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

  // --- the open conversation ---
  activeId: number | null;
  messages: ChatMessage[];
  messagesLoading: boolean;

  // --- the composer ---
  input: string;
  sending: boolean;
  error: string | null;
  unavailable: boolean;
  detectedAmount: number | null;
}

const EMPTY: ChatState = {
  seedModule: "Dashboard",
  conversations: [],
  listLoading: false,
  listError: null,
  listLoaded: false,
  activeId: null,
  messages: [],
  messagesLoading: false,
  input: "",
  sending: false,
  error: null,
  unavailable: false,
  detectedAmount: null,
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
  setBusinessProfile(id: number | null): void;
  setSeedModule(module: InteractionModule): void;
  setInput(value: string): void;

  /** Fetch the history list once per business profile. Safe to call on every open. */
  ensureList(): void;

  newChat(): void;
  selectConversation(id: number): Promise<void>;
  send(text: string): Promise<void>;
  rename(id: number, title: string): Promise<void>;
  remove(id: number): Promise<void>;
}

export function createChatStore(transport: ChatTransport): ChatStore {
  let state: ChatState = EMPTY;
  let businessProfileId: number | null = null;
  const listeners = new Set<() => void>();

  /**
   * Messages by conversation id, so returning to one already read is instant
   * and silent. Not part of `state`: nothing renders differently because an
   * entry landed in it.
   */
  const cache = new Map<number, ChatMessage[]>();
  /** The conversation a fetch was started for, so a slow one cannot land late over a newer choice. */
  let wanted: number | null = null;

  function set(patch: Partial<ChatState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function clearExchangeState(): Partial<ChatState> {
    return { error: null, unavailable: false, detectedAmount: null };
  }

  return {
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
    setBusinessProfile(id) {
      if (id === businessProfileId) return;
      businessProfileId = id;
      cache.clear();
      wanted = null;
      set({
        conversations: [],
        listError: null,
        listLoaded: false,
        listLoading: false,
        activeId: null,
        messages: [],
        messagesLoading: false,
        ...clearExchangeState(),
      });
    },

    setSeedModule(module) {
      // Seeds the NEXT new conversation only. An existing thread keeps the
      // origin it was created with, whichever screen it is reopened from.
      if (module !== state.seedModule) set({ seedModule: module });
    },

    setInput(value) {
      if (value !== state.input) set({ input: value });
    },

    /*
     * The guard is on HAVING FETCHED, not on the sheet being open, which is
     * what keeps reopening the sheet free — and what stops a toggle from ever
     * re-requesting anything.
     */
    ensureList() {
      if (businessProfileId === null || state.listLoaded || state.listLoading) return;
      const forProfile = businessProfileId;
      set({ listLoading: true, listError: null });
      void transport
        .listConversations(forProfile)
        .then((conversations) => {
          if (businessProfileId !== forProfile) return;
          set({ conversations, listLoaded: true, listLoading: false });
        })
        .catch((err: unknown) => {
          if (businessProfileId !== forProfile) return;
          set({ listError: messageOf(err), listLoading: false });
        });
    },

    newChat() {
      wanted = null;
      set({
        activeId: null,
        messages: [],
        messagesLoading: false,
        input: "",
        ...clearExchangeState(),
      });
    },

    async selectConversation(id) {
      if (id === state.activeId) return;
      wanted = id;

      const cached = cache.get(id);
      if (cached) {
        set({ activeId: id, messages: cached, messagesLoading: false, ...clearExchangeState() });
        return;
      }

      set({ activeId: id, messages: [], messagesLoading: true, ...clearExchangeState() });
      try {
        const detail = await transport.getConversation(id);
        cache.set(id, detail.messages);
        if (wanted !== id) return;
        set({ messages: detail.messages, messagesLoading: false });
      } catch (err) {
        if (wanted !== id) return;
        set({ error: messageOf(err), messagesLoading: false });
      }
    },

    async send(text) {
      const question = text.trim();
      if (!question || state.sending || businessProfileId === null) return;

      const creating = state.activeId === null;
      const previous = creating ? [] : state.messages;
      const conversationId = state.activeId;

      set({ input: "", sending: true, ...clearExchangeState() });

      try {
        const data = creating
          ? await transport.createConversation({
              businessProfileId,
              originModule: state.seedModule,
              question,
            })
          : await transport.sendMessage(conversationId as number, question);

        const next = [...previous, data.userMessage, data.assistantMessage];
        cache.set(data.conversation.id, next);
        wanted = data.conversation.id;

        // Newest activity first, which is where the server would have put it
        // too — so the row does not jump on the next reload.
        const without = state.conversations.filter((c) => c.id !== data.conversation.id);

        set({
          activeId: data.conversation.id,
          messages: next,
          conversations: [data.conversation, ...without],
          sending: false,
          // Both providers failed. The backend still answers with a
          // placeholder, so surface it as an outage rather than as a
          // considered reply.
          unavailable: data.provider === "unavailable",
          detectedAmount: data.detectedAmount,
        });
      } catch (err) {
        // The question goes back in the box rather than being lost with the
        // failure — retyping it is the last thing anyone wants after a network
        // error on a phone.
        set({ error: messageOf(err), input: question, sending: false });
      }
    },

    async rename(id, title) {
      const next = title.trim().slice(0, CONVERSATION_TITLE_MAX);
      // An empty title is not an edit, it is a slip — the row would become
      // blank space. Silently keep what was there.
      if (!next) return;

      const before = state.conversations;
      set({ conversations: before.map((c) => (c.id === id ? { ...c, title: next } : c)) });
      try {
        await transport.renameConversation(id, next);
      } catch (err) {
        set({ conversations: before, error: messageOf(err) });
      }
    },

    async remove(id) {
      try {
        await transport.deleteConversation(id);
      } catch (err) {
        set({ error: messageOf(err) });
        return;
      }
      cache.delete(id);
      if (wanted === id) wanted = null;
      const conversations = state.conversations.filter((c) => c.id !== id);
      // Deleting the thread being read empties the sheet back to the greeting;
      // deleting any other one leaves it alone.
      set(
        state.activeId === id
          ? { conversations, activeId: null, messages: [], ...clearExchangeState() }
          : { conversations },
      );
    },
  };
}
