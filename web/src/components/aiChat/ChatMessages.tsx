import { useEffect, useRef, type ReactNode } from "react";
import { SkeletonBubble } from "../Skeleton";
import { formatMoney } from "../Money";
import type { ChatMessage, InteractionModule } from "../../lib/types";

/**
 * The scrolling half of the chat page: welcome state, bubbles, starter chips
 * and the two banners.
 *
 * Everything visual here is lifted from the old AskFinSightDrawer unchanged —
 * the two mascot sizes, the bubble radii and colours, the chip pill. The
 * drawer is gone but its visual language is not being redesigned in the same
 * pass that moves it, so a change of layout cannot be mistaken for a change of
 * behaviour.
 */

interface ModuleCopy {
  title: string;
  scope: string;
  greeting: string;
  starters: string[];
}

/**
 * The per-module copy, carried over verbatim from the drawer.
 *
 * It survives the drawer because it is product writing, not scaffolding: each
 * scope line states what FinSight can and cannot answer for that screen, and
 * each starter set was written against what that screen's server-side context
 * actually contains. A conversation is no longer bound to a module, so this
 * now keys off the ORIGIN module — where the question started — and only
 * governs the welcome state.
 */
export const MODULE_COPY: Record<InteractionModule, ModuleCopy> = {
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
    this is opened from a card the owner is already looking at, and what
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
  onStarter: (question: string) => void;
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
}: Props) {
  const copy = MODULE_COPY[originModule];
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, sending]);

  const welcome = messages.length === 0 && !loading;

  return (
    <div ref={bodyRef} className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {/*
          The opening line gets Fin at full size rather than the 24px avatar
          every later reply carries — this is the "ready to listen" moment in
          docs/mascot-scenario-library.md, and it is the one point on the page
          with room for the whole scene (head, question bubble, sparkles).
          Deliberately NOT a <Bubble>: stacking the small avatar under the
          large mascot would put Fin on screen twice, saying the same thing.
        */}
        {welcome ? (
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

            {/* The chips prime the box; they never send. Same pill as the
                drawer's, so the affordance is recognisably the same one. */}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {copy.starters.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStarter(s)}
                  className="min-h-tap rounded-full border border-brand-200 px-3 text-xs text-tone-brand transition hover:bg-tint-brand"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {loading ? <p className="text-center text-xs text-ink-400">Loading this conversation…</p> : null}

        {messages.map((m) => (
          <Bubble key={m.id} from={m.role === "user" ? "user" : "ai"}>
            {m.content}
          </Bubble>
        ))}

        {sending ? <SkeletonBubble /> : null}

        {/*
          Both providers failed. The backend still returns a placeholder answer
          with a 2xx, so this says so out loud rather than letting it read like
          a real, considered response.
        */}
        {unavailable ? (
          <p className="rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">
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
          <p className="rounded-lg bg-tint-neutral p-3 text-xs text-tone-neutral">
            FinSight read <span className="figure">{formatMoney(detectedAmount)}</span> from your question and used that
            figure in its calculation.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Bubble({ from, children }: { from: "ai" | "user"; children: ReactNode }) {
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

      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-paper-200 bg-paper px-3.5 py-2.5 text-sm text-ink-700">
        {children}
      </p>
    </div>
  );
}
