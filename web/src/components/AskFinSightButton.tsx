import { useCallback } from "react";
import { createPortal } from "react-dom";
import { useAiChat } from "../context/AiChatContext";
import type { InteractionModule } from "../lib/types";

/**
 * What a page hands Ask FinSight when it opens the drawer.
 *
 * Both fields seed only the NEXT conversation to be created: once a thread
 * exists, its own stored originModule governs, and the question has already
 * been typed into the box. Nothing here is a persisted setting, and neither
 * field can disturb a conversation already open — see AiChatContext.
 */
export interface AskFinSightNavState {
  originModule: InteractionModule;
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

/**
 * `ask(question?)` — open Ask FinSight over this page, from this module.
 *
 * A hook rather than five copies of the same `openChat` call, so a sixth call
 * site cannot get the argument order slightly wrong and silently open on the
 * generic Dashboard welcome with an empty box.
 */
export function useAskFinSight(originModule: InteractionModule) {
  const { openChat } = useAiChat();
  return useCallback(
    (initialQuestion?: string) => {
      openChat(originModule, initialQuestion);
    },
    [openChat, originModule],
  );
}

/**
 * The trigger that opens Ask FinSight, as a floating mascot — matching
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
 * permanently in reach. The drawer it opens portals for its own, separate
 * reason; this one is not cosmetic either.
 */
export function AskFinSightButton({ originModule, initialQuestion }: AskFinSightNavState) {
  const ask = useAskFinSight(originModule);

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
          onClick={() => ask(initialQuestion)}
          aria-label="Ask FinSight"
          /*
           * bottom-20 clears the fixed bottom nav (AppShell renders it under
           * `lg:hidden`, roughly 56px plus the safe-area inset); from `lg` up
           * there is no bar, so it drops back to the page's own margin.
           *
           * z-30 matches that nav and stays below the modal layer (z-40+), so
           * an overlay opened over the page covers the trigger rather than
           * leaving it floating on top of the panel.
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
