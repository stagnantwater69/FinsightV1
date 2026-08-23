import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { IconSidebar } from "../components/icons";
import { ChatHistoryRail, useChatRail } from "../components/aiChat/ChatHistoryRail";
import { ChatMessages, MODULE_COPY } from "../components/aiChat/ChatMessages";
import type { AskFinSightNavState } from "../components/AskFinSightButton";
import type {
  ChatMessage,
  ChatSendResponse,
  Conversation,
  ConversationDetail,
  InteractionModule,
} from "../lib/types";

/**
 * Ask FinSight, as a page.
 *
 * ---------------------------------------------------------------------
 * What replaced what
 * ---------------------------------------------------------------------
 * This was a per-module drawer whose "conversation" was an implicit query:
 * the last N AIInteraction rows for (user, business, module). There was no
 * thread, no title, and no second line of enquiry — asking about rent and
 * asking about a flagged receipt shared one append-only log, and navigating
 * away reset the local state that displayed it.
 *
 * A conversation is now a real record with an id, and this page owns exactly
 * three pieces of state about it: which one is active, its messages, and a
 * cache of the ones already fetched.
 *
 * ---------------------------------------------------------------------
 * Lazy creation
 * ---------------------------------------------------------------------
 * "New chat" persists NOTHING. It sets the active conversation to null and
 * empties the message list; only the first send calls POST /ai/conversations,
 * and the id that comes back becomes active. So an owner who opens the page,
 * reads the greeting and leaves has an untouched history — which is the whole
 * reason a rail of empty "New chat" rows never appears here.
 *
 * ---------------------------------------------------------------------
 * The rail cannot touch a conversation
 * ---------------------------------------------------------------------
 * `useChatRail` returns view state only. Collapsing the rail, opening the
 * mobile overlay and closing it again all go through it, and none of them can
 * reach `activeId`, `messages` or the cache, because those are not in scope
 * for it. The old drawer's defining bug was that its open/closed flag WAS its
 * conversation lifecycle; keeping the two in separate hooks is what stops that
 * being re-introduced by accident.
 *
 * ---------------------------------------------------------------------
 * Context is still rebuilt server-side
 * ---------------------------------------------------------------------
 * Sends carry {businessProfileId, question} and nothing else. The server
 * rebuilds the module context from fresh data on every message and threads the
 * conversation's own recent turns into it. Posting a context snapshot captured
 * when the page opened is exactly the staleness bug this avoids — the same
 * reasoning the drawer carried, unchanged.
 */

export function AiChat() {
  const { selected } = useBusinessProfiles();
  const location = useLocation();
  const confirm = useConfirm();
  const toast = useToast();
  const rail = useChatRail();

  // --- history ---
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

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
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Where the next NEW conversation will say it started, and whose welcome
   * copy is showing. Once a conversation exists its own stored originModule
   * governs — see `welcomeModule` below.
   */
  const [seedModule, setSeedModule] = useState<InteractionModule>("Dashboard");

  /*
   * Keyed on location.key, not on mount, so a second "Ask FinSight about
   * this" from another screen swaps in the new question rather than leaving
   * the previous one in the box. Arriving from the nav with no state at all
   * leaves the Dashboard default in place.
   */
  useEffect(() => {
    const state = location.state as AskFinSightNavState | null;
    if (!state) return;
    if (state.originModule) setSeedModule(state.originModule);
    if (state.initialQuestion) setInput(state.initialQuestion);
  }, [location.key, location.state]);

  // The history list. Re-fetched when the business profile changes, and the
  // open conversation is dropped with it — a thread belongs to one business.
  //
  // Depends on the id rather than the object: BusinessProfileContext hands
  // back a new object identity on every refresh, and depending on that would
  // clear the open conversation each time one landed.
  const businessProfileId = selected?.id ?? null;

  useEffect(() => {
    if (businessProfileId === null) return;
    let cancelled = false;

    setListLoading(true);
    setListError(null);
    setActiveId(null);
    setMessages([]);
    cacheRef.current.clear();

    api
      .get<Conversation[]>("/ai/conversations", { params: { businessProfileId, limit: 50 } })
      .then(({ data }) => {
        if (!cancelled) setConversations(data);
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
  }, [businessProfileId]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  // A conversation's own origin governs its welcome copy; a blank page uses
  // whatever screen sent the owner here.
  const welcomeModule = active?.originModule ?? seedModule;
  const copy = MODULE_COPY[welcomeModule];

  function clearExchangeState() {
    setError(null);
    setUnavailable(false);
    setDetectedAmount(null);
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setInput("");
    clearExchangeState();
    rail.closeMobile();
    inputRef.current?.focus();
  }

  async function selectConversation(id: number) {
    rail.closeMobile();
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
    try {
      const { data } = await api.get<ConversationDetail>(`/ai/conversations/${id}`);
      cacheRef.current.set(id, data.messages);
      if (wantedRef.current !== id) return;
      setMessages(data.messages);
    } catch (err) {
      if (wantedRef.current === id) setError(getErrorMessage(err));
    } finally {
      if (wantedRef.current === id) setMessagesLoading(false);
    }
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || sending || !selected) return;

    const creating = activeId === null;
    const previous = creating ? [] : messages;

    setInput("");
    setSending(true);
    clearExchangeState();

    try {
      const { data } = creating
        ? await api.post<ChatSendResponse>("/ai/conversations", {
            businessProfileId: selected.id,
            originModule: seedModule,
            question,
          })
        : await api.post<ChatSendResponse>(`/ai/conversations/${activeId}/messages`, {
            businessProfileId: selected.id,
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
  }

  async function rename(id: number, title: string) {
    const before = conversations;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await api.patch(`/ai/conversations/${id}`, { title });
      toast("Conversation renamed");
    } catch (err) {
      setConversations(before);
      setError(getErrorMessage(err));
    }
  }

  async function remove(conversation: Conversation) {
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
      if (activeId === conversation.id) {
        setActiveId(null);
        setMessages([]);
        clearExchangeState();
      }
      toast("Conversation deleted");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (!selected) return null;

  return (
    <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-sm lg:h-[calc(100vh-var(--topbar-h)-4.5rem)]">
      <div className="flex min-h-0 flex-1">
        <ChatHistoryRail
          rail={rail}
          conversations={conversations}
          activeId={activeId}
          loading={listLoading}
          error={listError}
          onNewChat={newChat}
          onSelect={selectConversation}
          onRename={rename}
          onDelete={remove}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* ---- the message column's own header ---- */}
          <header className="flex items-start gap-2 border-b border-paper-200 px-3 py-3 sm:px-5">
            {/* Below lg this opens the overlay; from lg up it is the way back
                out of a collapsed rail, and disappears once the rail is
                showing its own collapse control. */}
            <button
              type="button"
              onClick={rail.openMobile}
              aria-label="Open chat history"
              aria-expanded={false}
              className="tap h-9 w-9 min-h-0 min-w-0 shrink-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-ink-700 lg:hidden"
            >
              <IconSidebar className="h-[18px] w-[18px]" />
            </button>
            {rail.collapsed ? (
              <button
                type="button"
                onClick={rail.toggleCollapsed}
                aria-label="Open chat history"
                aria-expanded={false}
                className="tap hidden h-9 w-9 min-h-0 min-w-0 shrink-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-ink-700 lg:inline-flex"
              >
                <IconSidebar className="h-[18px] w-[18px]" />
              </button>
            ) : null}

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold text-ink-900">{active ? active.title : copy.title}</h1>
              {/* The scope line is the drawer's own product copy. It states
                  what FinSight can answer from this screen's context, which is
                  the honest framing the whole feature depends on. */}
              <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-500">{copy.scope}</p>
            </div>
          </header>

          <ChatMessages
            originModule={welcomeModule}
            messages={messages}
            loading={messagesLoading}
            sending={sending}
            unavailable={unavailable}
            detectedAmount={detectedAmount}
            error={error}
            onStarter={(question) => {
              setInput(question);
              inputRef.current?.focus();
            }}
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-t border-paper-200 px-4 py-3 sm:px-6"
          >
            <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
              <label className="sr-only" htmlFor="ai-chat-question">
                Ask about your numbers
              </label>
              <input
                id="ai-chat-question"
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your numbers…"
                maxLength={FIELD_LIMITS.aiQuestion}
                className="min-h-tap flex-1 rounded-full border border-ink-200 bg-paper px-4 text-sm text-ink-900 placeholder:text-ink-400"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="tap shrink-0 rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-50"
                aria-label="Send"
              >
                →
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
