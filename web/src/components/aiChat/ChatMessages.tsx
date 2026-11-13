import { useEffect, useRef, useState } from "react";
import { formatMoney } from "../Money";
import { ChatMarkdown } from "./ChatMarkdown";
import { Button } from "../Button";
import { AnswerExtras } from "./AnswerExtras";
import { FinAvatar } from "./FinAvatar";
import { IconArrowUp, IconChevronDown, IconEdit } from "../icons";
import type { ChatMessage, InteractionModule } from "../../lib/types";

/**
 * The scrolling half of the chat: welcome state, the thread, and the banners.
 * Suggested follow-ups are not here; they live in one row above the composer
 * (see AskFinSightDrawer), so they sit where the next question is typed.
 */

interface ModuleCopy {
  title: string;
  greeting: string;
  starters: string[];
}

/**
 * The per-module copy.
 *
 * It is product writing, not scaffolding: each starter set was written
 * against what that screen's server-side context actually contains. It keys
 * off the ORIGIN module, where the question started, and governs the welcome
 * state and the fallback suggestions.
 */
export const MODULE_COPY: Record<InteractionModule, ModuleCopy> = {
  Dashboard: {
    title: "Ask FinSight about your dashboard",
    greeting:
      "I can explain what's on your dashboard right now — your expenses, sales, alerts, and recovery pace. What would you like to know?",
    starters: ["Summarise this month for me", "What needs my attention?", "How can I reduce my expenses?"],
  },
  "Expense Insights": {
    title: "Ask FinSight about your expenses",
    starters: ["Why did my expenses increase?", "Which category is highest?", "How can I reduce my expenses?"],
    greeting: "I can help you understand your expense behaviour. What would you like to know?",
  },
  "Spending Impact": {
    title: "Ask FinSight about spending",
    starters: ["What if I spend ₱11,000 on a fridge?", "How much of my funds would that use?", "Is this a large expense for me?"],
    greeting:
      'Describe a planned expense in your own words and I\'ll run the real numbers. For example: "What if I spend ₱11,000 on a fridge?"',
  },
  /*
    The review queue's "Explain this flag" entry point. The starters are
    questions about FinSight's own reasoning rather than about the money —
    this is opened from a card the owner is already looking at, and what
    they want is why it is there. The server's context for this module is the
    open findings and flagged counts, so every answer is phrasing evidence
    that already exists rather than judging a record.
  */
  "Records Review": {
    title: "Ask FinSight about this flag",
    starters: [
      "Why was this flagged?",
      "What does FinSight compare against?",
      "How do I stop this being flagged again?",
    ],
    greeting:
      "I can explain why something is in your review queue and what FinSight compared it against. What would you like to know?",
  },
  "Recovery Target": {
    title: "Ask FinSight about recovery",
    starters: ["How much more sales do I need?", "Did I reach today's target?", "What is my adjusted daily target?"],
    greeting:
      "I can compare your recorded sales against your needed target and show how much is still needed. What would you like to check?",
  },
};

/** How far above the newest message the owner must be before "Jump to latest" shows. */
const AWAY_FROM_LATEST_PX = 240;

interface Props {
  /** Governs the welcome copy only — the origin module, not a binding. */
  originModule: InteractionModule;
  messages: ChatMessage[];
  /** A conversation's messages are in flight. */
  loading: boolean;
  /** An answer is in flight. */
  sending: boolean;
  /** Both providers failed on the last send. */
  unavailable: boolean;
  /** The amount the server parsed out of the last question, if any. */
  detectedAmount: number | null;
  error: string | null;
  /** A welcome card was pressed. The drawer sends it straight away. */
  onStarter: (question: string) => void;
  /** The newest question was edited in place and sent again. */
  onEdit?: (question: string) => void;
  onRate?: (messageId: number, feedback: "up" | "down" | null) => void;
  /** A link under a reply is leaving for another page. */
  onNavigate?: () => void;
  nextCursor?: string | null;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  onReload?: () => void;
}

export function ChatMessages({
  originModule,
  messages,
  loading,
  sending,
  unavailable,
  detectedAmount,
  error,
  onStarter,
  onEdit,
  onRate = () => undefined,
  onNavigate = () => undefined,
  nextCursor,
  loadingOlder = false,
  onLoadOlder,
  onReload,
}: Props) {
  const copy = MODULE_COPY[originModule];
  const bodyRef = useRef<HTMLDivElement>(null);
  const olderScrollRef = useRef<{ height: number; top: number } | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);

  /*
   * The reply that arrived while this view was watching. Only it gets the
   * reveal: replaying the entrance on every reply of a reopened conversation
   * would animate history, which is not news.
   */
  const [revealId, setRevealId] = useState<number | null>(null);
  const wasSending = useRef(sending);
  useEffect(() => {
    const last = messages.at(-1);
    if (wasSending.current && !sending && last?.role === "assistant") setRevealId(last.id);
    wasSending.current = sending;
  }, [sending, messages]);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const previous = olderScrollRef.current;
    if (previous) {
      node.scrollTo({ top: node.scrollHeight - previous.height + previous.top });
      olderScrollRef.current = null;
    } else node.scrollTo({ top: node.scrollHeight });
  }, [messages, sending]);
  useEffect(() => { if (!loadingOlder) olderScrollRef.current = null; }, [loadingOlder]);

  const welcome = messages.length === 0 && !loading;
  const lastUserId = messages.findLast((m) => m.role === "user")?.id;

  return (
    <>
      <div
        ref={bodyRef}
        onScroll={(e) => {
          const node = e.currentTarget;
          setAwayFromLatest(node.scrollHeight - node.scrollTop - node.clientHeight > AWAY_FROM_LATEST_PX);
        }}
        className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {nextCursor && onLoadOlder ? <Button type="button" variant="secondary" disabled={loadingOlder || loading} onClick={() => {
            const node = bodyRef.current;
            if (node) olderScrollRef.current = { height: node.scrollHeight, top: node.scrollTop };
            onLoadOlder();
          }}>{loadingOlder ? "Loading older messages…" : "Older messages"}</Button> : null}

          {/* Fin at full size once, for the "ready to listen" moment; every reply after carries the small badge. */}
          {welcome ? (
            <div className="flex flex-col">
              <div className="surface-ai-glow flex flex-col items-center rounded-3xl px-2 pb-2 pt-6 text-center">
                <FinAvatar size="lg" />
                <h3 className="mt-5 font-display text-2xl font-bold tracking-tight text-ink-900">Make sense of your numbers.</h3>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-600">{copy.greeting}</p>
              </div>

              <p className="mb-2 mt-6 px-1 text-xs font-semibold text-ink-500">Tap a question and Fin answers it</p>
              <div className="flex flex-col gap-2">
                {copy.starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onStarter(s)}
                    className="group flex min-h-tap items-center gap-3 rounded-2xl border border-paper-200 bg-paper px-4 py-3 text-left text-sm font-medium text-ink-900 shadow-sm transition hover:border-brand-200 hover:shadow-md"
                  >
                    <span className="flex-1">{s}</span>
                    {/* An up arrow, the composer's own send mark: pressing this asks it. */}
                    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tint-brand text-tone-brand transition-colors group-hover:bg-brand-600 group-hover:text-white">
                      <IconArrowUp className="h-4 w-4" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {loading ? <p role="status" className="text-center text-xs text-ink-500">Loading this conversation…</p> : null}

          {messages.map((m, index) => {
            if (m.role === "user") {
              const editable = onEdit && m.id === lastUserId && !sending;
              if (editable && editing?.id === m.id) {
                const draft = editing.text.trim();
                const submitEdit = () => {
                  if (!draft) return;
                  setEditing(null);
                  onEdit(draft);
                };
                return (
                  <form
                    key={m.id}
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitEdit();
                    }}
                    className="ml-auto flex w-full max-w-[85%] flex-col gap-2 rounded-[22px] border border-edge-brand bg-paper p-3 shadow-md"
                  >
                    <textarea
                      autoFocus
                      aria-label="Edit your question"
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                        else if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitEdit();
                        }
                      }}
                      className="w-full resize-none bg-transparent px-1 text-[15px] leading-6 text-ink-900 outline-none focus-visible:ring-0"
                    />
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" disabled={!draft} aria-label="Send edited question">
                        Send
                      </Button>
                    </div>
                  </form>
                );
              }
              return (
                <div key={m.id} className="flex items-center justify-end gap-1">
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => setEditing({ id: m.id, text: m.content })}
                      aria-label="Edit this question"
                      className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink-500 transition hover:bg-paper-100 hover:text-ink-800"
                    >
                      <IconEdit className="h-4 w-4" />
                    </button>
                  ) : null}
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-[22px] rounded-br-md bg-brand-800 px-4 py-3 text-[15px] leading-6 text-white shadow-md">
                    {m.content}
                  </p>
                </div>
              );
            }
            // The newest reply, while nothing newer is being written, is the
            // one whose actions are still current.
            const latest = index === messages.length - 1 && !sending;
            return (
              <div key={m.id} className="flex items-start gap-3">
                <FinAvatar />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <p className="text-sm font-semibold leading-8 text-ink-900">Fin</p>
                  <div className={`-mt-2 text-[15px] leading-7 text-ink-700 ${m.id === revealId ? "chat-reveal" : ""}`}>
                    <ChatMarkdown text={m.content} />
                  </div>
                  {m.metadata ? (
                    <AnswerExtras
                      metadata={m.metadata}
                      content={m.content}
                      latest={latest}
                      feedback={m.feedback ?? null}
                      onRate={(value) => onRate(m.id, value)}
                      onNavigate={onNavigate}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}

          {sending ? (
            <div aria-hidden className="flex animate-fade-up items-center gap-3">
              <FinAvatar thinking />
              <div className="flex items-center gap-2.5 rounded-2xl rounded-tl-md border border-paper-200 bg-paper px-4 py-2.5 text-sm text-ink-600 shadow-sm">
                <span className="flex gap-1">
                  {[0, 150, 300].map((delay) => (
                    <span key={delay} className="h-1.5 w-1.5 rounded-full bg-brand-600 motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms` }} />
                  ))}
                </span>
                Working from your records…
              </div>
            </div>
          ) : null}
          <p role="status" aria-live="polite" className="sr-only">{sending ? "FinSight is preparing an answer." : messages.length > 0 ? "Conversation updated." : ""}</p>

          {/*
            Both providers failed. The backend still returns a placeholder answer
            with a 2xx, so this says so out loud rather than letting it read like
            a real, considered response.
          */}
          {unavailable ? (
            <p className="rounded-xl bg-tint-danger p-3 text-xs text-tone-danger">
              FinSight's AI assistant is unreachable right now, so the message above is a placeholder rather than a real
              answer. Your numbers on the rest of the app are unaffected — they're calculated by FinSight, not by AI.
            </p>
          ) : null}

          {/*
            What the server read as an amount out of a plainly-worded question.
            Shown because the figure drives a real calculation: if it misread
            "11,000" the owner should be able to see that before trusting the
            answer built on it.
          */}
          {detectedAmount !== null ? (
            <p className="rounded-xl bg-tint-neutral p-3 text-xs text-tone-neutral">
              FinSight read <span className="figure">{formatMoney(detectedAmount)}</span> from your question and used that
              figure in its calculation.
            </p>
          ) : null}

          {error ? (
            <div className="rounded-xl bg-tint-danger p-3">
              <p role="alert" className="text-xs text-tone-danger">{error}</p>
              {onReload ? <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={loading || loadingOlder} onClick={onReload}>Reload conversation</Button> : null}
            </div>
          ) : null}
        </div>
      </div>

      {awayFromLatest ? (
        <button
          type="button"
          onClick={() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" })}
          className="tap absolute bottom-3 left-1/2 flex -translate-x-1/2 animate-fade-up items-center gap-1.5 rounded-full border border-paper-200 bg-paper px-4 text-xs font-semibold text-ink-700 shadow-md transition hover:text-ink-900"
        >
          <IconChevronDown className="h-4 w-4" />
          Jump to latest
        </button>
      ) : null}
    </>
  );
}
