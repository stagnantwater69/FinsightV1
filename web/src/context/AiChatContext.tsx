import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { apiPage } from "../lib/apiPage";
import { captureServerStateAccount } from "../lib/serverStateCache";
import { readPendingChatSend, removePendingChatSend, storePendingChatSend, type PendingChatSend } from "../lib/chatSendRecovery";
import { randomId } from "../lib/uuid";
import { isAxiosError } from "axios";
import { useBusinessProfiles } from "./BusinessProfileContext";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import type {
  ChatFocus,
  ChatMessage,
  ChatSendResponse,
  ChatSendStatus,
  Conversation,
  ConversationDetail,
  ConversationPage,
  InteractionModule,
  ReductionOpportunity,
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
 * Sends carry {businessProfileId, question} and, for the one message that
 * consumes it, an optional `reductionOpportunity` block (see
 * `pendingReductionOpportunityRef` below, and `askSchema.reductionOpportunity`
 * on the backend). It is the SAME structured object the reduction-opportunity
 * card already showed the owner — never free-form prose — and it only steers
 * wording; the server still rebuilds the module context from current data on
 * every message and threads the conversation's own recent turns into it.
 * Posting a full context snapshot captured when the drawer opened, and
 * trusting it as authoritative, is exactly the staleness bug this still
 * avoids — the same reasoning the first drawer carried, unchanged.
 */

interface AiChatValue {
  // --- the drawer, as a view ---
  open: boolean;
  /**
   * Open it from a module, optionally priming the box with a ready question
   * and/or the selected reduction opportunity for the first message that
   * sends it (see `pendingReductionOpportunityRef`).
   */
  openChat: (
    originModule: InteractionModule,
    initialQuestion?: string,
    reductionOpportunity?: ReductionOpportunity,
    focus?: ChatFocus,
  ) => void;
  closeChat: () => void;

  /** Where the next NEW conversation will say it started. */
  seedModule: InteractionModule;

  // --- history ---
  conversations: Conversation[];
  listLoading: boolean;
  listError: string | null;
  listNextCursor: string | null;
  listLoadingMore: boolean;
  reloadConversations: () => void;
  loadOlderConversations: () => void;

  // --- the open conversation ---
  activeId: number | null;
  active: Conversation | null;
  messages: ChatMessage[];
  messagesLoading: boolean;
  messagesLoadingOlder: boolean;
  messagesNextCursor: string | null;
  reloadMessages: () => void;
  loadOlderMessages: () => void;

  // --- the composer ---
  input: string;
  setInput: (value: string) => void;
  sending: boolean;
  error: string | null;
  unavailable: boolean;
  detectedAmount: number | null;
  pendingQuestion: string | null;
  recoveryMessage: string | null;
  checkingSend: boolean;
  canRetrySend: boolean;
  checkSendStatus: () => void;
  retrySend: () => void;

  // --- actions ---
  newChat: () => void;
  selectConversation: (id: number) => void;
  send: (text: string) => void;
  rename: (id: number, title: string) => void;
  remove: (conversation: Conversation) => void;
  /** Thumbs up/down on one reply; pressing the same thumb again clears it. */
  rate: (messageId: number, feedback: "up" | "down" | null) => void;
}

const AiChatContext = createContext<AiChatValue | null>(null);
const THREAD_CACHE_LIMIT = 20;
const THREAD_CACHE_MESSAGE_LIMIT = 200;
const CHAT_FRESH_TIME_MS = 30_000;
interface CachedThread { messages: ChatMessage[]; nextCursor: string | null; updatedAt: number }
interface PendingSendState extends PendingChatSend {
  hasDispatched: boolean;
  previous: ChatMessage[];
  nextCursor: string | null;
  selectionRevision: number;
  clearedDraftRevision: number;
}

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
  const [listNextCursor, setListNextCursor] = useState<string | null>(null);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const listRequestRef = useRef<AbortController | null>(null);
  const listUpdatedAtRef = useRef(0);
  const listSeenCursorsRef = useRef(new Set<string>());

  // --- the open conversation ---
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesNextCursor, setMessagesNextCursor] = useState<string | null>(null);
  const [messagesLoadingOlder, setMessagesLoadingOlder] = useState(false);
  const messageRequestRef = useRef<AbortController | null>(null);
  const messageSeenCursorsRef = useRef(new Map<number, Set<string>>());
  const selectionRevisionRef = useRef(0);
  const sendPendingRef = useRef(false);
  const renameVersionsRef = useRef(new Map<number, number>());
  const renameRequestsRef = useRef(new Map<number, Promise<void>>());
  const confirmedTitlesRef = useRef(new Map<number, string>());
  const feedbackVersionsRef = useRef(new Map<number, number>());
  const confirmedFeedbackRef = useRef(new Map<number, "up" | "down" | null>());
  const feedbackRequestsRef = useRef(new Map<number, Promise<void>>());
  const deletedThreadIdsRef = useRef(new Set<number>());

  /** Fresh threads reopen immediately; stale entries are shown while revalidating. */
  const cacheRef = useRef(new Map<number, CachedThread>());
  const cacheThread = useCallback((id: number, threadMessages: ChatMessage[], nextCursor: string | null) => {
    cacheRef.current.delete(id);
    if (deletedThreadIdsRef.current.has(id) || threadMessages.length > THREAD_CACHE_MESSAGE_LIMIT) return;
    cacheRef.current.set(id, { messages: threadMessages, nextCursor, updatedAt: Date.now() });
    while (cacheRef.current.size > THREAD_CACHE_LIMIT) {
      const oldest = cacheRef.current.keys().next().value;
      if (oldest !== undefined) {
        cacheRef.current.delete(oldest);
        messageSeenCursorsRef.current.delete(oldest);
      }
    }
  }, []);
  /** The conversation a fetch was started for, so a slow one cannot land late over a newer choice. */
  const wantedRef = useRef<number | null>(null);

  /**
   * The selected reduction opportunity, set by `openChat`, consumed by the
   * very NEXT `send()` and cleared immediately after — so it can never
   * attach itself to a second message an owner sends later in the same
   * conversation. A ref rather than state: nothing renders differently while
   * it is armed, it is just a hand-off between two calls.
   */
  const pendingReductionOpportunityRef = useRef<ReductionOpportunity | null>(null);
  /**
   * The flag or record "Explain this flag" was pressed on. Same one-shot
   * hand-off as the reduction opportunity: it rides on the next send only.
   * The server stores it on the conversation, so later messages in that thread
   * stay about the same flag without the client resending it.
   */
  const pendingFocusRef = useRef<ChatFocus | null>(null);

  // --- the composer ---
  const [input, setInputState] = useState("");
  const draftRevisionRef = useRef(0);
  const setInput = useCallback((value: string) => {
    draftRevisionRef.current += 1;
    setInputState(value);
  }, []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [detectedAmount, setDetectedAmount] = useState<number | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [checkingSend, setCheckingSend] = useState(false);
  const [canRetrySend, setCanRetrySend] = useState(false);
  const pendingSendRef = useRef<PendingSendState | null>(null);
  const statusRequestRef = useRef<AbortController | null>(null);

  // Depends on the id rather than the object: BusinessProfileContext hands back
  // a new object identity on every refresh, and depending on that would clear
  // the open conversation each time one landed.
  const businessProfileId = selected?.id ?? null;
  const mountedRef = useRef(true);
  const identityRef = useRef({ businessProfileId });
  if (identityRef.current.businessProfileId !== businessProfileId) {
    identityRef.current = { businessProfileId };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current?.abort();
      messageRequestRef.current?.abort();
      statusRequestRef.current?.abort();
    };
  }, []);

  const isCurrentIdentity = useCallback(
    (identity: { businessProfileId: number | null }) =>
      mountedRef.current && identityRef.current === identity,
    [],
  );

  // A thread belongs to one business, so switching business drops whatever was
  // open along with the list it came from. This is the ONLY thing that resets a
  // conversation without the owner asking — and it is a different business's
  // data, which must never be on screen under the wrong profile.
  useEffect(() => {
    setOpen(false);
    setSeedModule("Dashboard");
    setConversations([]);
    setListLoading(false);
    setListError(null);
    setListLoaded(false);
    setListNextCursor(null);
    setListLoadingMore(false);
    listUpdatedAtRef.current = 0;
    listSeenCursorsRef.current.clear();
    messageSeenCursorsRef.current.clear();
    listRequestRef.current?.abort();
    messageRequestRef.current?.abort();
    selectionRevisionRef.current += 1;
    sendPendingRef.current = false;
    statusRequestRef.current?.abort();
    statusRequestRef.current = null;
    const restored = businessProfileId === null ? null : readPendingChatSend(businessProfileId);
    pendingSendRef.current = restored ? { ...restored, hasDispatched: true, previous: [], nextCursor: null, selectionRevision: -1, clearedDraftRevision: -1 } : null;
    setPendingQuestion(restored?.body.question ?? null);
    setRecoveryMessage(restored ? "A previous answer has not been confirmed. Check its status before sending another question." : null);
    setCheckingSend(false);
    setCanRetrySend(false);
    setActiveId(null);
    setMessages([]);
    setMessagesLoading(false);
    setMessagesNextCursor(null);
    setMessagesLoadingOlder(false);
    setInput("");
    setSending(false);
    setError(null);
    setUnavailable(false);
    setDetectedAmount(null);
    wantedRef.current = null;
    cacheRef.current.clear();
    pendingReductionOpportunityRef.current = null;
    pendingFocusRef.current = null;
    renameVersionsRef.current.clear();
    renameRequestsRef.current.clear();
    confirmedTitlesRef.current.clear();
    feedbackVersionsRef.current.clear();
    confirmedFeedbackRef.current.clear();
    feedbackRequestsRef.current.clear();
    deletedThreadIdsRef.current.clear();
  }, [businessProfileId, setInput]);

  /*
   * The history list is fetched on FIRST OPEN, not on mount. This provider sits
   * in the authenticated layout, so fetching eagerly would put a request on
   * every page load for a panel most visits never open.
   *
   * `listLoaded` is what keeps reopening the drawer free: the guard is on
   * having fetched, not on the drawer being open, so toggling it cannot
   * re-request anything.
   */
  const loadConversations = useCallback(async (cursor: string | null = null) => {
    if (businessProfileId === null) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    const identity = identityRef.current;
    const renameVersionsAtRequest = new Map(renameVersionsRef.current);
    if (cursor === null) setListLoading(true);
    else setListLoadingMore(true);
    setListError(null);
    try {
      const { data } = await api.get<ConversationPage | Conversation[]>("/ai/conversations", {
        params: { businessProfileId, pageSize: 50, ...(cursor ? { cursor } : {}) }, signal: controller.signal,
      });
      if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
      const page = apiPage(data);
      if (cursor !== null && page.nextCursor !== null && (page.nextCursor === cursor || listSeenCursorsRef.current.has(page.nextCursor))) {
        throw new Error("FinSight couldn't load more conversations because the next page repeated. Your loaded conversations are kept; try again.");
      }
      if (cursor === null) listSeenCursorsRef.current.clear();
      if (page.nextCursor !== null) listSeenCursorsRef.current.add(page.nextCursor);
      for (const conversation of page.items) {
        if (!deletedThreadIdsRef.current.has(conversation.id) && !renameRequestsRef.current.has(conversation.id)
          && renameVersionsRef.current.get(conversation.id) === renameVersionsAtRequest.get(conversation.id)) confirmedTitlesRef.current.set(conversation.id, conversation.title);
      }
      setConversations((current) => {
        const items = page.items.filter((item) => !deletedThreadIdsRef.current.has(item.id)).map((item) => {
          const renamedSinceRequest = renameVersionsRef.current.get(item.id) !== renameVersionsAtRequest.get(item.id);
          const newerTitle = current.find((conversation) => conversation.id === item.id)?.title ?? confirmedTitlesRef.current.get(item.id);
          return newerTitle && (renamedSinceRequest || renameRequestsRef.current.has(item.id)) ? { ...item, title: newerTitle } : item;
        });
        return cursor === null ? items : [...current.filter((item) => !deletedThreadIdsRef.current.has(item.id)), ...items.filter((item) => !current.some((existing) => existing.id === item.id))];
      });
      setListNextCursor(page.nextCursor);
      listUpdatedAtRef.current = Date.now();
        setListLoaded(true);
    } catch (err) {
      if (!controller.signal.aborted && isCurrentIdentity(identity)) setListError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted && isCurrentIdentity(identity)) {
        setListLoading(false);
        setListLoadingMore(false);
      }
    }
  }, [businessProfileId, isCurrentIdentity]);

  useEffect(() => {
    if (open && (!listLoaded || Date.now() - listUpdatedAtRef.current >= CHAT_FRESH_TIME_MS)) void loadConversations();
  }, [open, listLoaded, loadConversations]);

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
  const openChat = useCallback(
    (
      originModule: InteractionModule,
      initialQuestion?: string,
      reductionOpportunity?: ReductionOpportunity,
      focus?: ChatFocus,
    ) => {
      setSeedModule(originModule);
      // Only ever pre-fills the box — the same thing clicking a starter chip
      // does. It never sends on the owner's behalf.
      if (initialQuestion) setInput(initialQuestion);
      // Armed for whichever message goes out next, from whichever
      // conversation (new or already open) is current when that happens.
      pendingReductionOpportunityRef.current = reductionOpportunity ?? null;
      pendingFocusRef.current = focus ?? null;
      // A question about one specific flag belongs in a thread of its own:
      // continuing whatever was open would answer it with the old thread's
      // focus and history. Without a focus, opening never disturbs the
      // open conversation.
      if (focus) {
        selectionRevisionRef.current += 1;
        messageRequestRef.current?.abort();
        setActiveId(null);
        wantedRef.current = null;
        setMessages([]);
        setMessagesLoading(false);
        setMessagesNextCursor(null);
        setMessagesLoadingOlder(false);
        setError(null);
        setUnavailable(false);
        setDetectedAmount(null);
      }
      setOpen(true);
    },
    [setInput],
  );

  const closeChat = useCallback(() => setOpen(false), []);

  const newChat = useCallback(() => {
    selectionRevisionRef.current += 1;
    messageRequestRef.current?.abort();
    setActiveId(null);
    wantedRef.current = null;
    setMessages([]);
    setMessagesLoading(false);
    setMessagesNextCursor(null);
    setMessagesLoadingOlder(false);
    setInput("");
    pendingReductionOpportunityRef.current = null;
    pendingFocusRef.current = null;
    clearExchangeState();
  }, [clearExchangeState, setInput]);

  const loadMessages = useCallback(async (id: number, cursor: string | null = null) => {
    if (deletedThreadIdsRef.current.has(id)) return;
    messageRequestRef.current?.abort();
    const controller = new AbortController();
    messageRequestRef.current = controller;
    const identity = identityRef.current;
    const selectionRevision = selectionRevisionRef.current;
    const feedbackVersionsAtRequest = new Map(feedbackVersionsRef.current);
    const feedbackPendingAtRequest = new Set(feedbackRequestsRef.current.keys());
    const isCurrent = () => !controller.signal.aborted && isCurrentIdentity(identity) && !deletedThreadIdsRef.current.has(id) && wantedRef.current === id && selectionRevisionRef.current === selectionRevision;
    if (cursor === null) setMessagesLoading(true);
    else setMessagesLoadingOlder(true);
    setError(null);
    try {
      const { data } = await api.get<ConversationDetail>(`/ai/conversations/${id}`, {
        params: { pageSize: 50, ...(cursor ? { cursor } : {}) }, signal: controller.signal,
      });
      if (!isCurrent()) return;
      const nextCursor = data.nextCursor ?? null;
      const seenCursors = messageSeenCursorsRef.current.get(id) ?? new Set<string>();
      if (cursor !== null && nextCursor !== null && (nextCursor === cursor || seenCursors.has(nextCursor))) {
        throw new Error("FinSight couldn't load older messages because the next page repeated. Your loaded messages are kept; try again.");
      }
      if (cursor === null) seenCursors.clear();
      if (nextCursor !== null) seenCursors.add(nextCursor);
      messageSeenCursorsRef.current.set(id, seenCursors);
      const hasNewerFeedback = (messageId: number) => feedbackPendingAtRequest.has(messageId)
        || feedbackRequestsRef.current.has(messageId)
        || feedbackVersionsRef.current.get(messageId) !== feedbackVersionsAtRequest.get(messageId);
      for (const message of data.messages) {
        if (!hasNewerFeedback(message.id)) confirmedFeedbackRef.current.set(message.id, message.feedback ?? null);
      }
      setMessages((current) => {
        if (deletedThreadIdsRef.current.has(id)) return current;
        const items = data.messages.map((message) => {
          if (!hasNewerFeedback(message.id)) return message;
          const newer = current.find((item) => item.id === message.id) ?? cacheRef.current.get(id)?.messages.find((item) => item.id === message.id);
          return { ...message, feedback: newer ? newer.feedback ?? null : confirmedFeedbackRef.current.get(message.id) ?? null };
        });
        const next = cursor === null ? items : [...items.filter((item) => !current.some((existing) => existing.id === item.id)), ...current];
        cacheThread(id, next, nextCursor);
        return next;
      });
      setMessagesNextCursor(nextCursor);
      setConversations((current) => deletedThreadIdsRef.current.has(id) || current.some((conversation) => conversation.id === id) ? current : [...current, data]);
    } catch (err) {
      if (isCurrent()) setError(getErrorMessage(err));
    } finally {
      if (isCurrent()) {
        setMessagesLoading(false);
        setMessagesLoadingOlder(false);
      }
    }
  }, [cacheThread, isCurrentIdentity]);

  const selectConversation = useCallback((id: number) => {
    if (deletedThreadIdsRef.current.has(id)) return;
    if (id === activeId && !error) return;
    selectionRevisionRef.current += 1;
    messageRequestRef.current?.abort();
    clearExchangeState();
    setActiveId(id);
    wantedRef.current = id;
    setMessagesLoadingOlder(false);
    const cached = cacheRef.current.get(id);
    if (cached) {
      cacheRef.current.delete(id);
      cacheRef.current.set(id, cached);
      setMessages(cached.messages);
      setMessagesNextCursor(cached.nextCursor);
      setMessagesLoading(false);
      if (Date.now() - cached.updatedAt < CHAT_FRESH_TIME_MS && !error) return;
    } else {
      setMessages([]);
      setMessagesNextCursor(null);
    }
    void loadMessages(id);
  }, [activeId, clearExchangeState, error, loadMessages]);

  const clearPendingSend = useCallback((request: PendingSendState) => {
    removePendingChatSend(request);
    if (pendingSendRef.current?.body.idempotencyKey !== request.body.idempotencyKey) return;
    pendingSendRef.current = null;
    setPendingQuestion(null);
    setCanRetrySend(false);
  }, []);

  const publishSend = useCallback((request: PendingSendState, data: ChatSendResponse) => {
    if (data.userMessage?.content !== request.body.question || data.userMessage.role !== "user"
      || data.assistantMessage?.role !== "assistant"
      || request.conversationId !== null && data.conversation?.id !== request.conversationId) {
      setRecoveryMessage("The returned answer does not match the original question or conversation. Your question is kept; check its status again.");
      return;
    }
    if (deletedThreadIdsRef.current.has(data.conversation.id) || request.conversationId !== null && deletedThreadIdsRef.current.has(request.conversationId)) {
      clearPendingSend(request);
      setRecoveryMessage("The conversation for this question was deleted. Start a new chat to ask again.");
      return;
    }
    const cached = cacheRef.current.get(data.conversation.id);
    const currentMessages = wantedRef.current === data.conversation.id ? messagesRef.current : [];
    // Send results replay the commit snapshot, which predates later feedback.
    const additions = [data.userMessage, data.assistantMessage].map((message) => {
      const current = currentMessages.find((item) => item.id === message.id)
        ?? cached?.messages.find((item) => item.id === message.id);
      return current ? { ...message, feedback: current.feedback ?? null } : message;
    });
    const next = [...(cached?.messages ?? request.previous).filter((item) => !additions.some((addition) => addition.id === item.id)), ...additions];
    const nextCursor = cached?.nextCursor ?? request.nextCursor;
    cacheThread(data.conversation.id, next, nextCursor);
    const stillSelected = wantedRef.current === data.conversation.id || (selectionRevisionRef.current === request.selectionRevision && wantedRef.current === request.conversationId);
    if (stillSelected) {
      messageRequestRef.current?.abort();
      wantedRef.current = data.conversation.id;
      setActiveId(data.conversation.id);
      setMessages(next);
      setMessagesNextCursor(nextCursor);
      setMessagesLoading(false);
      setMessagesLoadingOlder(false);
      setError(null);
      setUnavailable(data.provider === "unavailable");
      setDetectedAmount(data.detectedAmount);
    }
    setConversations((current) => {
      if (deletedThreadIdsRef.current.has(data.conversation.id)) return current;
      const currentTitle = current.find((conversation) => conversation.id === data.conversation.id)?.title;
      const conversation = renameVersionsRef.current.has(data.conversation.id) && currentTitle ? { ...data.conversation, title: currentTitle } : data.conversation;
      return [conversation, ...current.filter((existing) => existing.id !== conversation.id)];
    });
    if (draftRevisionRef.current === request.clearedDraftRevision) setInput("");
    clearPendingSend(request);
    setRecoveryMessage(null);
    if (!stillSelected) toast(`Answer saved in "${data.conversation.title}".`);
  }, [cacheThread, clearPendingSend, setInput, toast]);

  const dispatchSend = useCallback(async (request: PendingSendState) => {
    if (sendPendingRef.current) return;
    const identity = identityRef.current;
    const hadPriorAttempt = request.hasDispatched;
    request.hasDispatched = true;
    sendPendingRef.current = true;
    setSending(true);
    setCanRetrySend(false);
    setRecoveryMessage(null);
    try {
      const path = request.conversationId === null ? "/ai/conversations" : `/ai/conversations/${request.conversationId}/messages`;
      const { data } = await api.post<ChatSendResponse>(path, request.body);
      if (!isCurrentIdentity(identity)) return;
      publishSend(request, data);
    } catch (err) {
      if (!isCurrentIdentity(identity)) return;
      if (request.conversationId !== null && deletedThreadIdsRef.current.has(request.conversationId)) {
        clearPendingSend(request);
        setRecoveryMessage("The conversation for this question was deleted. Start a new chat to ask again.");
        return;
      }
      const failureCode = isAxiosError(err) ? (err.response?.data as { code?: string } | undefined)?.code : undefined;
      const rejectedBeforeClaim = isAxiosError(err) && [400, 422, 429].includes(err.response?.status ?? 0);
      if (rejectedBeforeClaim && !hadPriorAttempt) {
        clearPendingSend(request);
        setRecoveryMessage(null);
        if (selectionRevisionRef.current === request.selectionRevision) {
          setError(getErrorMessage(err));
          if (draftRevisionRef.current === request.clearedDraftRevision) setInput(request.body.question);
        }
        return;
      }
      setRecoveryMessage(failureCode === "CHAT_SEND_IN_PROGRESS"
        ? "FinSight is still processing this question. Check its status again before sending another question."
        : "The answer has not been confirmed. Check its status to recover it safely.");
      if (selectionRevisionRef.current === request.selectionRevision) {
        setError(getErrorMessage(err));
        if (draftRevisionRef.current === request.clearedDraftRevision) {
          setInput(request.body.question);
          request.clearedDraftRevision = draftRevisionRef.current;
        }
      }
    } finally {
      if (isCurrentIdentity(identity)) { sendPendingRef.current = false; setSending(false); }
    }
  }, [clearPendingSend, isCurrentIdentity, publishSend, setInput]);

  const send = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || sendPendingRef.current || businessProfileId === null) return;
    if (pendingSendRef.current) {
      setRecoveryMessage("Check the previous answer's status before sending another question.");
      return;
    }
    const body: PendingChatSend["body"] = {
      businessProfileId, idempotencyKey: randomId(), question,
      ...(activeId === null ? { originModule: seedModule } : {}),
      ...(pendingReductionOpportunityRef.current ? { reductionOpportunity: pendingReductionOpportunityRef.current } : {}),
      ...(pendingFocusRef.current ? { focus: pendingFocusRef.current } : {}),
    };
    const request: PendingSendState = {
      hasDispatched: false,
      ownerId: captureServerStateAccount()?.userId ?? null, conversationId: activeId,
      body: structuredClone(body), previous: activeId === null ? [] : messages,
      nextCursor: messagesNextCursor, selectionRevision: selectionRevisionRef.current, clearedDraftRevision: draftRevisionRef.current,
    };
    try { storePendingChatSend(request); } catch {
      setError("FinSight couldn't save this question for safe recovery. Your question is still here. Try again.");
      return;
    }
    pendingSendRef.current = request;
    setPendingQuestion(question);
    pendingReductionOpportunityRef.current = null;
    pendingFocusRef.current = null;
    setInput("");
    request.clearedDraftRevision = draftRevisionRef.current;
    clearExchangeState();
    await dispatchSend(request);
  }, [activeId, businessProfileId, clearExchangeState, dispatchSend, messages, messagesNextCursor, seedModule, setInput]);

  const checkSendStatus = useCallback(async () => {
    const request = pendingSendRef.current;
    if (!request || sendPendingRef.current || statusRequestRef.current) return;
    const identity = identityRef.current;
    const controller = new AbortController();
    statusRequestRef.current = controller;
    setCheckingSend(true);
    setCanRetrySend(false);
    try {
      const { data } = await api.get<ChatSendStatus>(`/ai/send-requests/${encodeURIComponent(request.body.idempotencyKey)}`, {
        params: { businessProfileId: request.body.businessProfileId }, signal: controller.signal,
      });
      if (controller.signal.aborted || !isCurrentIdentity(identity) || pendingSendRef.current !== request) return;
      if (data.status === "COMPLETE" && data.result) publishSend(request, data.result);
      else if (data.status === "FAILED" || data.status === "DELETED") {
        if (data.status === "DELETED" && request.conversationId !== null) {
          const id = request.conversationId;
          deletedThreadIdsRef.current.add(id);
          cacheRef.current.delete(id);
          messageSeenCursorsRef.current.delete(id);
          setConversations((current) => current.filter((conversation) => conversation.id !== id));
          if (wantedRef.current === id) {
            wantedRef.current = null;
            selectionRevisionRef.current += 1;
            messageRequestRef.current?.abort();
            setActiveId(null);
            setMessages([]);
            setMessagesNextCursor(null);
            setMessagesLoading(false);
            setMessagesLoadingOlder(false);
          }
        }
        clearPendingSend(request);
        setRecoveryMessage(data.status === "DELETED" ? "The conversation for this question was deleted. Start a new chat to ask again." : `This question failed. ${data.error?.message ?? "You can edit it and send a new question."}`);
      } else setRecoveryMessage("FinSight is still processing this question. Its outcome is not confirmed; check again later.");
    } catch (err) {
      if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
      if (isAxiosError(err) && err.response?.status === 404) {
        setCanRetrySend(true);
        setRecoveryMessage("No saved answer was found. You can retry this same question safely, keeping its original request.");
      } else setRecoveryMessage(`Couldn't check the answer status. ${getErrorMessage(err)} Your original question is kept for recovery.`);
    } finally {
      if (statusRequestRef.current === controller) statusRequestRef.current = null;
      if (!controller.signal.aborted && isCurrentIdentity(identity)) setCheckingSend(false);
    }
  }, [clearPendingSend, isCurrentIdentity, publishSend]);

  const rename = useCallback(
    async (id: number, title: string) => {
      const identity = identityRef.current;
      if (deletedThreadIdsRef.current.has(id)) return;
      const before = conversations.find((conversation) => conversation.id === id)?.title;
      if (!confirmedTitlesRef.current.has(id) && before !== undefined) confirmedTitlesRef.current.set(id, before);
      const version = (renameVersionsRef.current.get(id) ?? 0) + 1;
      renameVersionsRef.current.set(id, version);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
      const preceding = renameRequestsRef.current.get(id) ?? Promise.resolve();
      const request = preceding.then(async () => {
        if (!isCurrentIdentity(identity) || deletedThreadIdsRef.current.has(id)) return;
        try {
          await api.patch(`/ai/conversations/${id}`, { title });
          if (!isCurrentIdentity(identity) || deletedThreadIdsRef.current.has(id)) return;
          confirmedTitlesRef.current.set(id, title);
          if (renameVersionsRef.current.get(id) !== version) return;
          toast("Conversation renamed");
        } catch (err) {
          if (!isCurrentIdentity(identity) || deletedThreadIdsRef.current.has(id) || renameVersionsRef.current.get(id) !== version) return;
          const confirmedTitle = confirmedTitlesRef.current.get(id);
          setConversations((current) => current.map((conversation) =>
            conversation.id === id && conversation.title === title && confirmedTitle !== undefined
              ? { ...conversation, title: confirmedTitle }
              : conversation));
          setError(getErrorMessage(err));
        }
      });
      renameRequestsRef.current.set(id, request);
      await request;
      if (renameRequestsRef.current.get(id) === request) renameRequestsRef.current.delete(id);
    },
    [conversations, isCurrentIdentity, toast],
  );

  const remove = useCallback(
    async (conversation: Conversation) => {
      const identity = identityRef.current;
      const ok = await confirm({
        title: `Delete "${conversation.title}"?`,
        body: "This removes the conversation and every message in it. Your records and figures are not affected.",
        confirmLabel: "Delete conversation",
        tone: "danger",
      });
      if (!ok || !isCurrentIdentity(identity)) return;

      try {
        await api.delete(`/ai/conversations/${conversation.id}`);
        if (!isCurrentIdentity(identity)) return;
        deletedThreadIdsRef.current.add(conversation.id);
        cacheRef.current.delete(conversation.id);
        messageSeenCursorsRef.current.delete(conversation.id);
        confirmedTitlesRef.current.delete(conversation.id);
        const pending = pendingSendRef.current;
        if (pending?.conversationId === conversation.id) {
          clearPendingSend(pending);
          setRecoveryMessage("The conversation for this question was deleted. Start a new chat to ask again.");
        }
        setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
        const deletingSelected = wantedRef.current === conversation.id;
        // Deleting the thread you are reading empties the panel back to the
        // welcome state; deleting any other one leaves it alone.
        if (deletingSelected) {
          wantedRef.current = null;
          selectionRevisionRef.current += 1;
          messageRequestRef.current?.abort();
          setActiveId(null);
          setMessages([]);
          setMessagesNextCursor(null);
          setMessagesLoading(false);
          setMessagesLoadingOlder(false);
          clearExchangeState();
        }
        toast("Conversation deleted");
      } catch (err) {
        if (!isCurrentIdentity(identity)) return;
        setError(getErrorMessage(err));
      }
    },
    [clearExchangeState, clearPendingSend, confirm, isCurrentIdentity, toast],
  );

  const rate = useCallback(
    async (messageId: number, feedback: "up" | "down" | null) => {
      if (activeId === null) return;
      const identity = identityRef.current;
      const conversationId = activeId;
      if (deletedThreadIdsRef.current.has(conversationId)) return;
      const apply = (list: ChatMessage[], value: "up" | "down" | null) =>
        list.map((m) => (m.id === messageId ? { ...m, feedback: value } : m));
      const before = messages.find((m) => m.id === messageId)?.feedback ?? null;
      if (!confirmedFeedbackRef.current.has(messageId)) confirmedFeedbackRef.current.set(messageId, before);
      const version = (feedbackVersionsRef.current.get(messageId) ?? 0) + 1;
      feedbackVersionsRef.current.set(messageId, version);

      // Optimistic: a thumb that waits on the network feels broken.
      setMessages((prev) => apply(prev, feedback));
      const cached = cacheRef.current.get(conversationId);
      if (cached) cacheRef.current.set(conversationId, { ...cached, messages: apply(cached.messages, feedback) });
      const preceding = feedbackRequestsRef.current.get(messageId) ?? Promise.resolve();
      const request = preceding.then(async () => {
        if (!isCurrentIdentity(identity) || deletedThreadIdsRef.current.has(conversationId)) return;
        try {
          await api.put(`/ai/conversations/${conversationId}/messages/${messageId}/feedback`, { feedback });
          if (isCurrentIdentity(identity) && !deletedThreadIdsRef.current.has(conversationId)) confirmedFeedbackRef.current.set(messageId, feedback);
        } catch (err) {
          if (!isCurrentIdentity(identity) || deletedThreadIdsRef.current.has(conversationId) || feedbackVersionsRef.current.get(messageId) !== version) return;
          const confirmedFeedback = confirmedFeedbackRef.current.get(messageId) ?? null;
          if (wantedRef.current === conversationId) setMessages((prev) => apply(prev, confirmedFeedback));
          const again = cacheRef.current.get(conversationId);
          if (again) cacheRef.current.set(conversationId, { ...again, messages: apply(again.messages, confirmedFeedback) });
          if (wantedRef.current === conversationId) setError(getErrorMessage(err));
        }
      });
      feedbackRequestsRef.current.set(messageId, request);
      await request;
      if (feedbackRequestsRef.current.get(messageId) === request) feedbackRequestsRef.current.delete(messageId);
    },
    [activeId, isCurrentIdentity, messages],
  );

  const value: AiChatValue = {
    open,
    openChat,
    closeChat,
    seedModule,
    conversations,
    listLoading,
    listError,
    listNextCursor,
    listLoadingMore,
    reloadConversations: () => void loadConversations(),
    loadOlderConversations: () => { if (listNextCursor && !listLoadingMore) void loadConversations(listNextCursor); },
    activeId,
    active,
    messages,
    messagesLoading,
    messagesLoadingOlder,
    messagesNextCursor,
    reloadMessages: () => { if (activeId !== null) void loadMessages(activeId); },
    loadOlderMessages: () => { if (activeId !== null && messagesNextCursor && !messagesLoadingOlder) void loadMessages(activeId, messagesNextCursor); },
    input,
    setInput,
    sending,
    error,
    unavailable,
    detectedAmount,
    pendingQuestion,
    recoveryMessage,
    checkingSend,
    canRetrySend,
    checkSendStatus: () => void checkSendStatus(),
    retrySend: () => { const pending = pendingSendRef.current; if (pending && canRetrySend && !checkingSend) void dispatchSend(pending); },
    newChat,
    selectConversation,
    send: (text: string) => void send(text),
    rename: (id: number, title: string) => void rename(id, title),
    remove: (conversation: Conversation) => void remove(conversation),
    rate: (messageId: number, feedback: "up" | "down" | null) => void rate(messageId, feedback),
  };

  return <AiChatContext.Provider value={value}>{children}</AiChatContext.Provider>;
}
