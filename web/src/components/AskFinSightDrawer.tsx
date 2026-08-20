import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { SkeletonBubble } from "./Skeleton";
import type { AIInteraction, AskResponse, InteractionModule } from "../lib/types";
import { useFocusTrap } from "../lib/hooks";
import { FIELD_LIMITS } from "../lib/fieldLimits";

// One drawer component, parameterized by module, used from all four
// trigger points (Dashboard + the three Insights screens). It sends only
// {businessProfileId, module, question} — no context — because the server
// rebuilds the context from fresh data on every message. Passing a context
// snapshot captured when the drawer opened is exactly the staleness bug
// this avoids.
//
// Rendered via a portal straight into <body>, NOT in place in the page's own
// JSX tree. Every page renders this inside <main>, and <main> carries
// `animate-fade-up` (tailwind.config.js) — a `transform`-based entrance
// animation with `fill-mode: both`, which never gets removed. An element
// that is the target of a transform animation establishes a new containing
// block for its `position: fixed` descendants for as long as that animation
// is in effect — including the held end state under `both`/`forwards` fill
// mode, regardless of the actual resolved transform value. Left in place,
// the drawer's "fixed, full viewport height" panel gets trapped inside
// <main>'s own box instead of the real viewport: it stops covering the
// topbar (a sibling of <main>, sitting above it) and stretches to <main>'s
// content length instead of 100vh — which is exactly the "long and awkward"
// panel this was built to fix. Portalling to <body> sidesteps the whole
// category of bug: nothing this renders inside can ever again depend on
// what CSS an ancestor happens to apply.

interface ModuleCopy {
  title: string;
  scope: string;
  greeting: string;
  starters: string[];
}

const MODULE_COPY: Record<InteractionModule, ModuleCopy> = {
  Dashboard: {
    title: "Ask FinSight about your dashboard",
    scope: "Scoped to your Dashboard — I can walk through your totals, what needs review, and your recovery pace.",
    greeting:
      "I can explain what's on your dashboard right now — your expenses, sales reference, alerts, and recovery pace. What would you like to know?",
    starters: ["Summarise this month for me", "What needs my attention?", "How can I reduce my expenses?"],
  },
  "Expense Insights": {
    title: "Ask FinSight about your expenses",
    scope: "Scoped to Expense Insights — I can explain category shares, increases, and which records look unusual.",
    starters: ["Why did my expenses increase?", "Which category is highest?", "How can I reduce my expenses?"],
    greeting: "I can help you understand your expense behaviour. What would you like to know?",
  },
  "Spending Impact": {
    title: "Ask FinSight about spending",
    scope:
      "Scoped to Spending Impact — describe a planned expense in your own words and FinSight calculates the real impact. The numbers are computed, not estimated by AI.",
    starters: ["What if I spend ₱11,000 on a fridge?", "How much of my funds would that use?", "Is this a large expense for me?"],
    greeting:
      'Describe a planned expense in your own words and I\'ll run the real numbers. For example: "What if I spend ₱11,000 on a fridge?"',
  },
  /*
    The review queue's "Explain this flag" entry point. The starters are
    questions about FinSight's own reasoning rather than about the money —
    this drawer opens from a card the owner is already looking at, and what
    they want is why it is there. The server's context for this module is the
    open findings and flagged counts, so every answer is phrasing evidence
    that already exists rather than judging a record.
  */
  "Records Review": {
    title: "Ask FinSight about this flag",
    scope:
      "Scoped to Needs review — I can explain the comparison behind a flag. A flag is never a claim that something is wrong.",
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
    scope: "Scoped to Recovery Target — I can explain today's gap and how the remaining target spreads across your remaining operating days.",
    starters: ["How much more sales do I need?", "Did I reach today's target?", "What is my adjusted daily target?"],
    greeting:
      "I can compare your recorded sales reference against your needed target and show how much is still needed. What would you like to check?",
  },
};

interface Props {
  businessProfileId: number;
  module: InteractionModule;
  open: boolean;
  onClose: () => void;
  /**
   * Primes the input with a ready-made question built from whatever the
   * caller's own "FinSight explanation" card just said — e.g. naming the
   * exact category that rose, not a generic "why did my expenses increase?".
   * Only ever pre-fills the box (the same thing clicking a starter chip
   * does); it never sends on the caller's behalf, so the owner still reads
   * the question and decides before anything reaches the AI.
   */
  initialQuestion?: string;
}

export function AskFinSightDrawer({ businessProfileId, module, open, onClose, initialQuestion }: Props) {
  const copy = MODULE_COPY[module];
  const [messages, setMessages] = useState<AIInteraction[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load this module's prior conversation when the drawer opens, so a
  // reopened drawer continues where it left off rather than looking empty
  // while the backend still threads the earlier turns into its answers.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingHistory(true);
    setError(null);
    api
      .get<AIInteraction[]>("/ai/history", { params: { businessProfileId, module, limit: 20 } })
      .then(({ data }) => {
        if (!cancelled) setMessages(data);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [open, businessProfileId, module]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, sending]);

  // Re-runs whenever a fresh question arrives too, not just on open — so
  // clicking a second "expand on this" while the drawer is already sitting
  // open still swaps in the new context instead of leaving the old one.
  useEffect(() => {
    if (open && initialQuestion) setInput(initialQuestion);
  }, [open, initialQuestion]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const trapRef = useFocusTrap<HTMLElement>(open);

  async function send(text: string) {
    const question = text.trim();
    if (!question || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    setUnavailable(false);
    try {
      const { data } = await api.post<AskResponse>("/ai/ask", { businessProfileId, module, question });
      setMessages((prev) => [...prev, data]);
      // Both providers failed. The backend still returns 201 with a
      // placeholder answer, so surface it as an outage rather than letting
      // it read like a real, considered response.
      if (data.provider === "unavailable") setUnavailable(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onClose}
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
        aria-label={copy.title}
        className={`fixed inset-0 z-50 flex flex-col bg-paper shadow-2xl transition-transform duration-300 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-md ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="bg-brand-800 px-5 py-4 text-white">
          <div className="flex items-start justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <span aria-hidden>✦</span> {copy.title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Ask FinSight"
              className="tap rounded-lg bg-white/15 text-lg leading-none hover:bg-white/25"
            >
              ×
            </button>
          </div>
          <p className="mt-2 rounded-lg bg-white/10 px-3 py-2 text-xs leading-relaxed text-brand-50">{copy.scope}</p>
        </header>

        <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto bg-paper-50 p-4">
          {/*
            The opening line gets Fin at full size rather than the 24px avatar
            every later reply carries — this is the "ready to listen" moment in
            docs/mascot-scenario-library.md, and it is the one point in the
            drawer with room for the whole scene (head, question bubble,
            sparkles). Deliberately NOT a <Bubble>: stacking the small avatar
            under the large mascot would put Fin on screen twice, saying the
            same thing.
          */}
          <div className="flex flex-col items-center pb-1 text-center">
            <img
              src="/mascot/ask-fin.webp"
              alt=""
              aria-hidden
              width={104}
              height={83}
              className="h-[83px] w-[104px] select-none"
              draggable={false}
            />
            <p className="mt-2 max-w-[90%] text-sm leading-relaxed text-ink-700">{copy.greeting}</p>
          </div>

          {loadingHistory ? <p className="text-center text-xs text-ink-400">Loading earlier messages…</p> : null}

          {messages.map((m) => (
            <div key={m.id} className="space-y-3">
              <Bubble from="user">{m.question}</Bubble>
              <Bubble from="ai">{m.answer}</Bubble>
            </div>
          ))}

          {sending ? <SkeletonBubble /> : null}

          {unavailable ? (
            <p className="rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">
              FinSight's AI assistant is unreachable right now, so the message above is a placeholder rather than a real
              answer. Your numbers on the screens behind this drawer are unaffected — they're calculated by FinSight, not
              by AI.
            </p>
          ) : null}
          {error ? <p className="rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">{error}</p> : null}
        </div>

        {messages.length === 0 && !loadingHistory ? (
          <div className="flex flex-wrap gap-2 border-t border-paper-200 px-4 py-3">
            {copy.starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setInput(s)}
                className="min-h-tap rounded-full border border-brand-200 px-3 text-xs text-tone-brand hover:bg-tint-brand"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2 border-t border-paper-200 px-4 py-3"
        >
          <input
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
            className="tap shrink-0 rounded-full bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            aria-label="Send"
          >
            →
          </button>
        </form>
      </aside>
    </>,
    document.body
  );
}

function Bubble({ from, children }: { from: "ai" | "user"; children: React.ReactNode }) {
  if (from === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand-600 px-3.5 py-2.5 text-sm text-white">
          {children}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      {/*
        Fin's face rather than a ✦, so the column of replies reads as coming
        from someone. The head is cropped away from the question bubble and
        sparkle marks it ships with (see scripts/convert-mascot-assets.py):
        the whole scene at this size leaves the face about fourteen pixels
        wide, which is a smudge rather than a character.
      */}
      <img
        src="/mascot/ask-fin-avatar.webp"
        alt=""
        aria-hidden
        width={24}
        height={24}
        className="mt-0.5 h-6 w-6 shrink-0 select-none"
        draggable={false}
      />

      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-paper px-3.5 py-2.5 text-sm text-ink-700 border border-paper-200">
        {children}
      </p>
    </div>
  );
}

/**
 * The trigger that opens the drawer, as a floating mascot — matching
 * mobile/src/components/AskFinSightFab.tsx.
 *
 * WHY IT LEFT THE HEADER. It used to be a small `✦ Ask FinSight` chip in each
 * page's action row, where it competed with the period selector for the same
 * glance and scrolled out of reach the moment an owner moved down the page.
 * The question someone wants to ask is usually prompted by something they have
 * just scrolled PAST, so the trigger has to still be there when they think of
 * it. That is the same reasoning mobile's FAB was built on, and it is why this
 * is a port rather than a second design.
 *
 * NO BUTTON CHROME. The art is a transparent cutout — head, glasses, question
 * bubble — with its own soft shadow painted in, so there is nothing for a
 * container to hide. Filling a teal pill behind it was tried and measured
 * worse: the owl's dark outline has too little separation from `brand-600`,
 * and the face turns to a smudge below about 24px. The button here is a
 * transparent hit-box sized to the touch target; everything visible is the
 * artwork.
 *
 * IT IS PORTALLED TO <body>, AND HAS TO BE. `position: fixed` is relative to
 * the viewport only while no ancestor establishes a containing block, and
 * AppShell's <main> carries `animate-fade-up` — a page transition on
 * `transform` with `fill-mode: both`. Filling forwards leaves the computed
 * transform as `matrix(1, 0, 0, 1, 0, 0)`: an identity matrix, but NOT `none`,
 * which is enough to make <main> the containing block. Rendered in place the
 * owl therefore pinned to the bottom of the PAGE and only appeared once the
 * owner scrolled to the end — the opposite of a trigger that is meant to be
 * permanently in reach. The drawer below portals for its own reasons; this
 * one is not cosmetic.
 */
export function AskFinSightButton({ onClick }: { onClick: () => void }) {
  return (
    <>
      {/*
        The FAB is fixed, so it is out of flow and would sit on top of whatever
        a page happens to end with. This is mobile's FAB_CLEARANCE idea as a
        spacer instead of an exported constant: it rides along with the trigger,
        so a page cannot render one without the other and no call site has to
        remember a magic number. <main> already reserves pb-24 / lg:pb-12 for
        the bottom nav; these make up the difference to the owl's full height.
      */}
      <div aria-hidden className="h-14 lg:h-12" />

      {createPortal(
        <button
          type="button"
          data-tour="ask-finsight"
          onClick={onClick}
          aria-label="Ask FinSight"
          /*
           * bottom-20 clears the fixed bottom nav (AppShell renders it under
           * `lg:hidden`, roughly 56px plus the safe-area inset); from `lg` up
           * there is no bar, so it drops back to the page's own margin.
           *
           * z-30 matches that nav and sits UNDER the drawer's own overlay
           * (z-40), so opening the drawer covers the trigger instead of
           * leaving it floating over the panel it just opened.
           */
          className="fixed bottom-20 right-4 z-30 transition-transform duration-150 ease-shell hover:scale-105 active:scale-95 lg:bottom-6 lg:right-6"
        >
          <img
            src="/mascot/ask-fin.webp"
            alt=""
            aria-hidden
            width={76}
            height={60}
            // Height follows the art's own 1.26 aspect rather than being
            // forced square — the composition is wider than it is tall, and
            // padding it out would only render it smaller.
            //
            // No CSS shadow: the soft one under the owl and the bubble is
            // painted into the art already, and a second would double it.
            className="h-[60px] w-[76px] animate-bob select-none"
            draggable={false}
          />
        </button>,
        document.body,
      )}
    </>
  );
}
