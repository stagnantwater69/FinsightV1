import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { List } from "lucide-react";
import { useAiChat } from "../context/AiChatContext";
import { useFocusTrap } from "../lib/hooks";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { IconArrowUp, IconPlus } from "./icons";
import { ChatHistoryOverlay } from "./aiChat/ChatHistoryOverlay";
import { ChatMessages, MODULE_COPY } from "./aiChat/ChatMessages";

/** Roughly seven lines of the composer's 20px line height, plus its padding. */
const COMPOSER_MAX_PX = 164;

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

  const inputRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The composer grows with the question. A single-line box scrolled the start
   * of a long question out of sight, so an owner writing three sentences could
   * not re-read what they had typed before sending it.
   *
   * Height is measured from the content on every change, which keeps a pasted
   * question and a typed one the same size. Past COMPOSER_MAX_PX the textarea
   * scrolls instead of growing, so the composer can never push the
   * conversation off the screen.
   */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [input, open]);

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
        className={`fixed inset-0 z-50 flex flex-col bg-paper shadow-lg transition-transform duration-300 ease-shell sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-md ${
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
              className="tap h-11 w-11 shrink-0 rounded-lg bg-white/10 text-white transition hover:bg-white/25"
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
              className="tap h-11 w-11 shrink-0 rounded-lg bg-white/10 text-white transition hover:bg-white/25"
            >
              <IconPlus className="mx-auto h-[18px] w-[18px]" />
            </button>
            <button
              type="button"
              onClick={closeChat}
              aria-label="Close Ask FinSight"
              className="tap h-11 w-11 shrink-0 rounded-lg bg-white/15 text-lg leading-none transition hover:bg-white/25"
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

        {/*
          One box, not a field beside a button. The composer is a single
          surface that the question and the way to send it both live inside, so
          the drawer ends in one shape rather than two competing round ones.
          The border belongs to the box and lights on `focus-within`, which is
          what keeps the focus ring honest now that the textarea itself has no
          edge of its own.
        */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="border-t border-paper-200 px-4 py-3"
        >
          {/*
            The focus indicator belongs to the BOX, not to the textarea inside
            it. index.css rings every :focus-visible element globally, which
            drew a hard rectangle around the textarea inside the rounded pill:
            two focus shapes, and the inner one the wrong shape entirely.
            `has-[:focus-visible]` moves the app's standard ring onto the pill,
            where it follows the rounded edge.

            What it gets instead is its own edge, drawn as border + a ring at
            offset 0 so the two sit flush and read as one 2px teal outline
            rather than a ring floating off a border. Browsers treat a text
            field as focus-visible even when it was CLICKED, so whatever is
            used here fires on click as well as on Tab: it has to be something
            that looks deliberate at every focus, not only at a keyboard one.
          */}
          <div className="flex items-end gap-2 rounded-3xl border border-ink-200 bg-paper p-1 pl-4 transition-colors focus-within:border-brand-600 focus-within:ring-1 focus-within:ring-brand-600 focus-within:ring-offset-0">
            <label className="sr-only" htmlFor="ai-chat-question">
              Ask about your numbers
            </label>
            <textarea
              id="ai-chat-question"
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, because that is what every chat does and the send
                // button is one tab away for anyone who wants it. Shift+Enter is
                // the escape hatch for a deliberate line break. `isComposing`
                // guards IME input, where Enter commits the candidate word and
                // must not also fire off a half-typed question.
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                send(input);
              }}
              placeholder="Ask about your numbers…"
              maxLength={FIELD_LIMITS.aiQuestion}
              aria-describedby="ai-chat-question-hint"
              className="scroll-none min-h-tap flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-3 text-sm leading-5 text-ink-900 outline-none placeholder:text-ink-400 focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <p id="ai-chat-question-hint" className="sr-only">
              Press Enter to send, Shift plus Enter for a new line.
            </p>
            {/*
              Off until there is something to send. An always-brand button in
              an empty composer promises an action that would do nothing, and
              `disabled` alone is invisible on a phone where there is no hover
              to discover it with. The colour IS the affordance here, so it
              carries a real contrast step rather than a dimmed brand fill:
              ink-200 on paper reads as "not yet", and the icon stays legible.

              Bottom-aligned rather than centred: at one line there is nothing
              to tell them apart, and at six the button belongs beside the last
              line being written, not floating halfway up the question.
            */}
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="tap shrink-0 rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700 active:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400 disabled:hover:bg-ink-200"
              aria-label="Send"
            >
              {/* Up, not right: the question travels up into the thread above it. */}
              <IconArrowUp className="h-5 w-5" />
            </button>
          </div>
        </form>
      </aside>
    </>,
    document.body,
  );
}
