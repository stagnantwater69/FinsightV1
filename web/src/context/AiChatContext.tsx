import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import type {
  ChatMessage,
  ChatSendResponse,
  Conversation,
  ConversationDetail,
  InteractionModule,
} from "../lib/types";

/**
 * Ask FinSight's whole conversation state, held ABOVE the drawer that draws it.
 *
 * ---------------------------------------------------------------------
 * Why a provider and not the drawer's own useState
 * ---------------------------------------------------------------------
 * The original drawer's defining bug was that its open/closed flag WAS its
 * conversation lifecycle: it refetched on open, and unmounting it on navigation
 * threw the thread away. Owners lost a line of enquiry by pressing Escape.
 *
 * So the invariant this file exists to hold is: opening the drawer, closing it,
 * and navigating between pages must NEVER start a new conversation or reset the
 * current one. Closing it on the Dashboard and reopening it on Records shows the
 * same conversation with the same messages, because none of those actions can
 * reach `activeId`, `messages` or the cache — they are not in the drawer's
 * scope to reset. That is structural rather than a guard clause someone can
 * later delete.
 *
 * Mounted inside AuthenticatedLayout (see the provider-ordering comment there),
 * so it lives for as long as the authenticated session and outlives every route
 * change under it.
 *
 * ---------------------------------------------------------------------
 * Lazy creation
 * ---------------------------------------------------------------------
 * "New chat" persists NOTHING. It sets the active conversation to null and
 * empties the message list; only the first send calls POST /ai/conversations,
 * and the id that comes back becomes active. An owner who opens the drawer,
 * reads the greeting and leaves has an untouched history — which is why a
 * history list of empty "New chat" rows never appears.
 *
 * ---------------------------------------------------------------------
 * Context is still rebuilt server-side
 * ---------------------------------------------------------------------
 * Sends carry {businessProfileId, question} and nothing else. The server
 * rebuilds the module context from fresh data on every message and threads the
 * conversation's own recent turns into it. Posting a context snapshot captured
 * when the drawer opened is exactly the staleness bug this avoids — the same
 * reasoning the first drawer carried, unchanged.
 */

interface AiChatValue {
  // --- the drawer, as a view ---
  open: boolean;
  /** Open it from a module, optionally priming the box with a ready question. */
  openChat: (originModule: InteractionModule, initialQuestion?: string) => void;
  closeChat: () => void;

  /** Where the next NEW conversation will say it started. */
  seedModule: InteractionModule;

  // --- history ---
  conversations: Conversation[];
  listLoading: boolean;
  listError: string | null;

  // --- the open conversation ---
  activeId: number | null;
  active: Conversation | null;
  messages: ChatMessage[];
  messagesLoading: boolean;

  // --- the composer ---
  input: string;
  setInput: (value: string) => void;
  sending: boolean;
  error: string | null;
  unavailable: boolean;
  detectedAmount: number | null;

  // --- actions ---
  newChat: () => void;
  selectConversation: (id: number) => void;
  send: (text: string) => void;
  rename: (id: number, title: string) => void;
  remove: (conversation: Conversation) => void;
}

const AiChatContext = createContext<AiChatValue | null>(null);

export function useAiChat(): AiChatValue {
  const value = useContext(AiChatContext);
  if (!value) throw new Error("useAiChat must be used inside <AiChatProvider>");
  return value;
}

export function AiChatProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const confirm = useConfirm();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [seedModule, setSeedModule] = useState<InteractionModule>("Dashboard");

  // --- history ---
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  /** Whether the list has been fetched for the profile currently selected. */
  const [listLoaded, setListLoaded] = useState(false);

  // --- the open conversation ---
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  /**
   * Messages by conversation id, so switching back to one already read is
   * instant and silent. A ref rather than state: it is a cache, and nothing
   * renders differently because an entry landed in it.
   */
  const cacheRef = useRef(new Map<number, ChatMessage[]>());
  /** The conversation a fetch was started for, so a slow one cannot land late over a newer choice. */
  const wantedRef = useRef<number | null>(null);

  // --- the composer ---
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [detectedAmount, setDetectedAmount] = useState<number | null>(null);

  // Depends on the id rather than the object: BusinessProfileContext hands back
  // a new object identity on every refresh, and depending on that would clear
  // the open conversation each time one landed.
  const businessProfileId = selected?.id ?? null;

  // A thread belongs to one business, so switching business drops whatever was
  // open along with the list it came from. This is the ONLY thing that resets a
  // conversation without the owner asking — and it is a different business's
  // data, which must never be on screen under the wrong profile.
  useEffect(() => {
    setConversations([]);
    setListError(null);
    setListLoaded(false);
    setActiveId(null);
    setMessages([]);
    wantedRef.current = null;
    cacheRef.current.clear();
  }, [businessProfileId]);

  /*
   * The history list is fetched on FIRST OPEN, not on mount. This provider sits
   * in the authenticated layout, so fetching eagerly would put a request on
   * every page load for a panel most visits never open.
   *
   * `listLoaded` is what keeps reopening the drawer free: the guard is on
   * having fetched, not on the drawer being open, so toggling it cannot
   * re-request anything.
   */
  useEffect(() => {
    if (!open || businessProfileId === null || listLoaded) return;
    let cancelled = false;

    setListLoading(true);
    setListError(null);

    api
      .get<Conversation[]>("/ai/conversations", { params: { businessProfileId, limit: 50 } })
      .then(({ data }) => {
        if (cancelled) return;
        setConversations(data);
        setListLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setListError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, businessProfileId, listLoaded]);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const clearExchangeState = useCallback(() => {
    setError(null);
    setUnavailable(false);
    setDetectedAmount(null);
  }, []);

  /*
   * Note what is NOT here: nothing touching activeId, messages or the cache.
   * Opening seeds the origin for the next new conversation and may prime the
   * box, and that is the whole of it.
   */
  const openChat = useCallback((originModule: InteractionModule, initialQuestion?: string) => {
    setSeedModule(originModule);
    // Only ever pre-fills the box — the same thing clicking a starter chip
    // does. It never sends on the owner's behalf.
    if (initialQuestion) setInput(initialQuestion);
    setOpen(true);
  }, []);

  const closeChat = useCallback(() => setOpen(false), []);

  const newChat = useCallback(() => {
    setActiveId(null);
    wantedRef.current = null;
    setMessages([]);
    setMessagesLoading(false);
    setInput("");
    clearExchangeState();
  }, [clearExchangeState]);

  const selectConversation = useCallback(
    (id: number) => {
      if (id === activeId) return;

      clearExchangeState();
      setActiveId(id);
      wantedRef.current = id;

      const cached = cacheRef.current.get(id);
      if (cached) {
        setMessages(cached);
        setMessagesLoading(false);
        return;
      }

      setMessages([]);
      setMessagesLoading(true);
      api
        .get<ConversationDetail>(`/ai/conversations/${id}`)
        .then(({ data }) => {
          cacheRef.current.set(id, data.messages);
          if (wantedRef.current !== id) return;
          setMessages(data.messages);
          setMessagesLoading(false);
        })
        .catch((err) => {
          if (wantedRef.current !== id) return;
          setError(getErrorMessage(err));
          setMessagesLoading(false);
        });
    },
    [activeId, clearExchangeState],
  );

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || sending || businessProfileId === null) return;

      const creating = activeId === null;
      const previous = creating ? [] : messages;

      setInput("");
      setSending(true);
      clearExchangeState();

      try {
        const { data } = creating
          ? await api.post<ChatSendResponse>("/ai/conversations", {
              businessProfileId,
              originModule: seedModule,
              question,
            })
          : await api.post<ChatSendResponse>(`/ai/conversations/${activeId}/messages`, {
              businessProfileId,
              question,
            });

        const next = [...previous, data.userMessage, data.assistantMessage];
        cacheRef.current.set(data.conversation.id, next);
        wantedRef.current = data.conversation.id;
        setActiveId(data.conversation.id);
        setMessages(next);

        setConversations((prev) => {
          const without = prev.filter((c) => c.id !== data.conversation.id);
          // Newest activity first, which is where the server would have put it
          // too — so the row does not jump on the next reload.
          return [data.conversation, ...without];
        });

        // Both providers failed. The backend still answers with a placeholder,
        // so surface it as an outage rather than as a considered reply.
        if (data.provider === "unavailable") setUnavailable(true);
        if (data.detectedAmount !== null) setDetectedAmount(data.detectedAmount);
      } catch (err) {
        setError(getErrorMessage(err));
        // The question goes back in the box rather than being lost with the
        // failure — retyping it is the last thing someone wants to do after a
        // network error.
        setInput(question);
      } finally {
        setSending(false);
      }
    },
    [activeId, businessProfileId, clearExchangeState, messages, seedModule, sending],
  );

  const rename = useCallback(
    async (id: number, title: string) => {
      const before = conversations;
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
      try {
        await api.patch(`/ai/conversations/${id}`, { title });
        toast("Conversation renamed");
      } catch (err) {
        setConversations(before);
        setError(getErrorMessage(err));
      }
    },
    [conversations, toast],
  );

  const remove = useCallback(
    async (conversation: Conversation) => {
      const ok = await confirm({
        title: `Delete "${conversation.title}"?`,
        body: "This removes the conversation and every message in it. Your records and figures are not affected.",
        confirmLabel: "Delete conversation",
        tone: "danger",
      });
      if (!ok) return;

      try {
        await api.delete(`/ai/conversations/${conversation.id}`);
        cacheRef.current.delete(conversation.id);
        setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
        if (wantedRef.current === conversation.id) wantedRef.current = null;
        // Deleting the thread you are reading empties the panel back to the
        // welcome state; deleting any other one leaves it alone.
        if (activeId === conversation.id) {
          setActiveId(null);
          setMessages([]);
          clearExchangeState();
        }
        toast("Conversation deleted");
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [activeId, clearExchangeState, confirm, toast],
  );

  const value: AiChatValue = {
    open,
    openChat,
    closeChat,
    seedModule,
    conversations,
    listLoading,
    listError,
    activeId,
    active,
    messages,
    messagesLoading,
    input,
    setInput,
    sending,
    error,
    unavailable,
    detectedAmount,
    newChat,
    selectConversation,
    send: (text: string) => void send(text),
    rename: (id: number, title: string) => void rename(id, title),
    remove: (conversation: Conversation) => void remove(conversation),
  };

  return <AiChatContext.Provider value={value}>{children}</AiChatContext.Provider>;
}
