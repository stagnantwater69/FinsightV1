import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { List } from "lucide-react";
import { useAiChat } from "../context/AiChatContext";
import { useFocusTrap } from "../lib/hooks";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { IconPlus } from "./icons";
import { ChatHistoryOverlay } from "./aiChat/ChatHistoryOverlay";
import { ChatMessages, MODULE_COPY } from "./aiChat/ChatMessages";

/**
 * Ask FinSight, as a narrow right-side drawer over whatever page you are on.
 *
 * It holds NO conversation state. Everything it draws — the thread, the
 * history list, the composer's contents — comes from AiChatContext, which sits
 * in the authenticated layout and outlives both this component's open flag and
 * every route change under it. That is the whole point: the first version of
 * this drawer refetched on open and dropped its thread on close, and pressing
 * Escape cost an owner their line of enquiry.
 *
 * Rendered via a portal straight into <body>, NOT in place in the page's own
 * JSX tree. Every page renders inside <main>, and <main> carries
 * `animate-fade-up` (tailwind.config.js) — a `transform`-based entrance
 * animation with `fill-mode: both`, which never gets removed. An element that
 * is the target of a transform animation establishes a new containing block for
 * its `position: fixed` descendants for as long as that animation is in effect
 * — including the held end state under `both`/`forwards` fill mode, regardless
 * of the actual resolved transform value. Left in place, this "fixed, full
 * viewport height" panel gets trapped inside <main>'s own box instead of the
 * real viewport: it stops covering the topbar (a sibling of <main>, sitting
 * above it) and stretches to <main>'s content length instead of 100vh — which
 * is exactly the "long and awkward" panel this was built to fix. Portalling to
 * <body> sidesteps the whole category of bug: nothing this renders inside can
 * ever again depend on what CSS an ancestor happens to apply.
 *
 * Mounted once, by AuthenticatedLayout, beside AppShell rather than by each
 * page — four instances would be four open flags, and the pages that trigger it
 * would each need to remember to render it.
 */
export function AskFinSightDrawer() {
  const chat = useAiChat();
  const {
    open,
    closeChat,
    seedModule,
    active,
    conversations,
    listLoading,
    listError,
    activeId,
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
    send,
    rename,
    remove,
  } = chat;

  /**
   * Purely a view flag, and deliberately the ONLY state this component owns.
   * It reaches nothing that fetches, so putting history up and taking it down
   * again cannot start, clear or reload a conversation.
   */
  const [historyOpen, setHistoryOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // A conversation's own origin governs its welcome copy; a blank panel uses
  // whatever screen the owner opened it from.
  const copy = MODULE_COPY[active?.originModule ?? seedModule];

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // History is a mode, not a preference: a drawer reopened later should show
  // the conversation, not the list it was last browsing.
  useEffect(() => {
    if (!open) setHistoryOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Escape peels one layer at a time. Closing the whole drawer from inside
      // the history list would be one keypress too many — the owner asked to
      // leave the list, not the conversation.
      if (historyOpen) setHistoryOpen(false);
      else closeChat();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, historyOpen, closeChat]);

  const trapRef = useFocusTrap<HTMLElement>(open);

  function chooseConversation(id: number) {
    selectConversation(id);
    // The list has done its job; the width goes back to the messages.
    setHistoryOpen(false);
  }

  function startNewChat() {
    newChat();
    setHistoryOpen(false);
    inputRef.current?.focus();
  }

  return createPortal(
    <>
      <div
        aria-hidden
        onClick={closeChat}
        className={`fixed inset-0 z-40 bg-ink-900/40 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      {/*
        The drawer stays mounted and slides out of view rather than unmounting,
        so the transition has something to animate. Two consequences had to be
        handled explicitly:

        `inert` when closed — otherwise every control in here (the question box,
        the send button, the suggestion chips) stayed in the tab order while
        parked off-screen, so Tab from the page walked into a panel nobody could
        see.

        A focus trap when open — it declares aria-modal="true", and a modal that
        lets Tab wander out into the page behind it is lying about being one.
      */}
      <aside
        ref={trapRef}
        inert={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Ask FinSight"
        className={`fixed inset-0 z-50 flex flex-col bg-paper shadow-2xl transition-transform duration-300 ease-shell sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-md ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="bg-brand-800 px-4 py-3 text-white">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-label="Chat history"
              aria-expanded={historyOpen}
              className="tap h-9 w-9 min-h-0 min-w-0 shrink-0 rounded-lg bg-white/10 text-white transition hover:bg-white/25"
            >
              <List aria-hidden size={18} className="mx-auto" />
            </button>

            <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
              {active ? active.title : copy.title}
            </h2>

            <button
              type="button"
              onClick={startNewChat}
              aria-label="New chat"
              className="tap h-9 w-9 min-h-0 min-w-0 shrink-0 rounded-lg bg-white/10 text-white transition hover:bg-white/25"
            >
              <IconPlus className="mx-auto h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={closeChat}
              aria-label="Close Ask FinSight"
              className="tap h-9 w-9 min-h-0 min-w-0 shrink-0 rounded-lg bg-white/15 text-lg leading-none transition hover:bg-white/25"
            >
              ×
            </button>
          </div>
          {/* The scope line is the drawer's own product copy. It states what
              FinSight can answer from the screen the question started on, which
              is the honest framing the whole feature depends on. */}
          <p className="mt-2 rounded-lg bg-white/10 px-3 py-2 text-xs leading-relaxed text-brand-50">{copy.scope}</p>
        </header>

        {/* The positioning context for the history overlay: it covers the
            messages and nothing else, so the composer stays put and the panel
            never appears to have swapped into a different screen. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatMessages
            originModule={active?.originModule ?? seedModule}
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

          {historyOpen ? (
            <ChatHistoryOverlay
              conversations={conversations}
              activeId={activeId}
              loading={listLoading}
              error={listError}
              onSelect={chooseConversation}
              onRename={rename}
              onDelete={remove}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2 border-t border-paper-200 px-4 py-3"
        >
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
        </form>
      </aside>
    </>,
    document.body,
  );
}
