import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useTourOptional } from "../../context/TourContext";
import { useFocusTrap, useMediaQuery } from "../../lib/hooks";
import { Button } from "../Button";
import { IconArrowRight } from "../icons";
import { TOUR_STEPS, type TourStep } from "./steps";
import { TourMascot } from "./TourMascot";

/**
 * The tour's overlay: dim, spotlight, tooltip, and Fin.
 *
 * Rendered only by TourProvider while a tour is active, into a portal above
 * everything (the app's highest chrome is the skip link at z-300; the tour
 * sits just under it so the skip link still wins).
 *
 * HOW THE SPOTLIGHT WORKS. One fixed, rounded, pointer-events-none div is
 * placed over the target and given a box-shadow with a 100vmax spread —
 * everything except the hole is dimmed by the shadow, and moving one element
 * moves the whole effect. A separate transparent full-screen layer blocks
 * clicks on the page underneath; wheel scrolling still reaches the document,
 * and the rect listeners below keep the spotlight glued to the target while
 * it moves.
 *
 * MISSING TARGETS NEVER STRAND THE TOUR. A step's target is polled briefly
 * (the two Quick-add steps mount their targets a beat after the shell opens
 * the menu); if it never appears — hidden at this viewport, feature not
 * rendered, markup changed — the step is skipped in the direction of travel.
 * The step counter counts only the steps eligible right now, so a phone user
 * sees "3 of 8", not gaps in "3 of 10".
 */

/** First element matching `selector` that actually takes up space. */
function findVisible(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    // offsetParent is null for `fixed` elements (the Ask FinSight FAB), so
    // size is the visibility test that works for every target here.
    if (r.width > 2 && r.height > 2) return el;
  }
  return null;
}

/** Can this step be shown at the current viewport / DOM state? */
function isEligible(step: TourStep): boolean {
  if (!step.target) return true; // centered cards
  // Quick-add items exist only while the menu is open; the shell opens it on
  // demand, so eligibility is "the trigger exists", not "the item exists".
  const probe = step.requiresQuickAdd ? '[data-tour="quick-add"]' : step.target;
  return findVisible(probe) !== null;
}

function eligibleIndexes(): number[] {
  return TOUR_STEPS.map((s, i) => (isEligible(s) ? i : -1)).filter((i) => i >= 0);
}

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Spotlight padding around the target, and tooltip clearance past it. */
const PAD = 6;
const GAP = 14;
const EDGE = 12;

export function TourOverlay() {
  const tour = useTourOptional();
  const stepIndex = tour?.stepIndex ?? 0;
  const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;
  const isMobile = useMediaQuery("(max-width: 767px)");

  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const [missing, setMissing] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [eligible, setEligible] = useState<number[]>(() => eligibleIndexes());

  const directionRef = useRef<1 | -1>(1);
  const tooltipRef = useFocusTrap<HTMLDivElement>(true);
  const [tipStyle, setTipStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const centered = !step.target;

  // ---- focus bookkeeping: remember the opener, give focus back on close ----
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // ---- resolve the step's target, with a short retry for late mounts ----
  useEffect(() => {
    setConfirmOpen(false);
    setMissing(false);
    setTargetEl(null);
    setRect(null);
    setEligible(eligibleIndexes());
    if (!step.target) return;

    let tries = 0;
    const timer = window.setInterval(() => {
      const el = findVisible(step.target!);
      if (el) {
        window.clearInterval(timer);
        setTargetEl(el);
        el.scrollIntoView({
          block: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      } else if (++tries > 25) {
        window.clearInterval(timer);
        setMissing(true);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [stepIndex, step.target]);

  // ---- keep the spotlight glued to the target while anything moves ----
  useEffect(() => {
    if (!targetEl) return;
    const update = () => setRect(targetEl.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const ro = new ResizeObserver(update);
    ro.observe(targetEl);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro.disconnect();
    };
  }, [targetEl]);

  // ---- navigation over the *currently eligible* steps ----
  const goNext = useCallback(() => {
    directionRef.current = 1;
    const idx = eligibleIndexes().filter((i) => i > stepIndex);
    if (idx.length) tour?.setStepIndex(idx[0]!);
    else tour?.stop("completed");
  }, [stepIndex, tour]);

  const goBack = useCallback(() => {
    directionRef.current = -1;
    const idx = eligibleIndexes().filter((i) => i < stepIndex);
    if (idx.length) tour?.setStepIndex(idx[idx.length - 1]!);
  }, [stepIndex, tour]);

  // A target that never appeared: move on rather than strand the tour.
  useEffect(() => {
    if (!missing) return;
    if (directionRef.current === -1) {
      const before = eligibleIndexes().filter((i) => i < stepIndex);
      if (before.length) {
        tour?.setStepIndex(before[before.length - 1]!);
        return;
      }
    }
    goNext();
  }, [missing, stepIndex, goNext, tour]);

  // ---- keyboard: arrows navigate, Escape opens the leave confirmation ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmOpen((v) => !v);
      } else if (e.key === "ArrowRight" && !confirmOpen) {
        goNext();
      } else if (e.key === "ArrowLeft" && !confirmOpen) {
        goBack();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirmOpen, goNext, goBack]);

  // ---- preload the next step's pose so it never pops in late ----
  useEffect(() => {
    const next = TOUR_STEPS[stepIndex + 1];
    if (next) {
      const img = new Image();
      img.src = next.mascot.pose;
    }
  }, [stepIndex]);

  // ---- desktop tooltip placement: preferred side, flip if cramped, clamp ----
  useLayoutEffect(() => {
    if (isMobile || centered) return;
    const tip = tooltipRef.current;
    if (!tip || !rect) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    const fits: Record<string, boolean> = {
      right: rect.right + GAP + PAD + tw < vw - EDGE,
      left: rect.left - GAP - PAD - tw > EDGE,
      bottom: rect.bottom + GAP + PAD + th < vh - EDGE,
      top: rect.top - GAP - PAD - th > EDGE,
    };
    const order = [step.placement ?? "bottom", "bottom", "right", "top", "left"];
    const side = order.find((s) => fits[s]) ?? "bottom";

    let top: number;
    let left: number;
    if (side === "right" || side === "left") {
      top = rect.top + rect.height / 2 - th / 2;
      left = side === "right" ? rect.right + GAP + PAD : rect.left - GAP - PAD - tw;
    } else {
      left = rect.left + rect.width / 2 - tw / 2;
      top = side === "bottom" ? rect.bottom + GAP + PAD : rect.top - GAP - PAD - th;
    }
    top = Math.min(Math.max(top, EDGE), vh - th - EDGE);
    left = Math.min(Math.max(left, EDGE), vw - tw - EDGE);

    setTipStyle({ position: "fixed", top, left, visibility: "visible" });
  }, [rect, isMobile, centered, stepIndex, confirmOpen, step.placement, tooltipRef]);

  if (!tour) return null;

  const position = eligible.indexOf(stepIndex) + 1 || stepIndex + 1;
  const total = eligible.length || TOUR_STEPS.length;
  const isLast = eligible.filter((i) => i > stepIndex).length === 0;
  const titleId = "tour-step-title";
  const bodyId = "tour-step-body";

  const tooltipBox = isMobile
    ? "fixed inset-x-0 bottom-0 rounded-t-2xl border-t border-paper-200 pb-[calc(1rem+env(safe-area-inset-bottom))]"
    : "w-[21rem] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-paper-200";

  return createPortal(
    <div className="fixed inset-0 z-[200]">
      {/* Blocks interaction with the page while a step is up. For centered
          cards it also carries the dim, since there is no spotlight shadow. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={centered ? { backgroundColor: "rgb(var(--shadow) / 0.55)" } : undefined}
      />

      {/* Spotlight — the hole in the dim. transition-[...] rather than the
          banned transition-all: top/left/width/height are exactly the
          properties that move between steps, on one small fixed element. */}
      {!centered && rect ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-xl ring-2 ring-brand-400 transition-[top,left,width,height] duration-250 ease-shell"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: "0 0 0 100vmax rgb(var(--shadow) / 0.55)",
          }}
        />
      ) : null}
      {/* Target still resolving on a non-centered step: dim without a hole so
          the frame never flashes fully bright between steps. */}
      {!centered && !rect ? (
        <div aria-hidden className="absolute inset-0" style={{ backgroundColor: "rgb(var(--shadow) / 0.55)" }} />
      ) : null}

      {/* Step announcements for screen readers. */}
      <span aria-live="polite" className="sr-only">
        {`Step ${position} of ${total}: ${step.title}`}
      </span>

      <div
        className={centered && !isMobile ? "absolute inset-0 grid place-items-center p-4" : undefined}
      >
        <div
          ref={tooltipRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          style={centered || isMobile ? undefined : tipStyle}
          className={`bg-paper p-4 shadow-lg ${tooltipBox} ${
            centered && !isMobile ? "w-[24rem] max-w-full rounded-2xl border border-paper-200" : ""
          }`}
        >
          <div className="flex items-start gap-3">
            <TourMascot mascot={step.mascot} size={isMobile ? "sm" : "md"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h2 id={titleId} className="font-display text-[15px] font-bold leading-snug text-ink-900">
                  {step.title}
                </h2>
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  aria-label="Close tour"
                  className="tap -mr-1 -mt-1 h-8 w-8 min-h-0 min-w-0 shrink-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-ink-800"
                >
                  <span aria-hidden className="text-base leading-none">✕</span>
                </button>
              </div>
              <p id={bodyId} className="mt-1.5 text-[13.5px] leading-relaxed text-ink-600">
                {step.body}
              </p>
            </div>
          </div>

          {confirmOpen ? (
            <div className="mt-3 rounded-xl border border-paper-200 bg-paper-50 p-3">
              <p className="text-[13px] font-semibold text-ink-800">Leave the tour?</p>
              <p className="mt-0.5 text-[12px] text-ink-500">
                You can replay it anytime from the account menu.
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="brand" onClick={() => setConfirmOpen(false)}>
                  Keep going
                </Button>
                <Button size="sm" variant="secondary" onClick={() => tour.stop("skipped")}>
                  Skip tour
                </Button>
              </div>
            </div>
          ) : step.finalActions ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {step.finalActions.map((action) =>
                action.to ? (
                  <Link
                    key={action.label}
                    to={action.to}
                    // Navigating away IS finishing — record it before the route
                    // change unmounts the overlay. ButtonLink takes no onClick,
                    // so this is a Link wearing the secondary button classes.
                    onClick={() => tour.stop("completed")}
                    className="inline-flex min-h-tap items-center justify-center gap-2 rounded-lg border border-ink-200 bg-paper px-3 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-paper-100 active:bg-paper-200"
                  >
                    {action.label}
                  </Link>
                ) : (
                  <Button key={action.label} variant="brand" size="sm" onClick={() => tour.stop("completed")}>
                    {action.label}
                  </Button>
                ),
              )}
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-2">
              <span className="figure text-[12px] tabular-nums text-ink-400">
                {position} of {total}
              </span>
              <button
                type="button"
                onClick={() => tour.stop("skipped")}
                className="tap-inline ml-1 rounded text-[12px] font-medium text-ink-400 underline-offset-2 transition hover:text-ink-700 hover:underline"
              >
                Skip Tour
              </button>
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="secondary" onClick={goBack} disabled={position <= 1}>
                  Back
                </Button>
                <Button size="sm" variant="brand" onClick={goNext}>
                  {isLast ? "Finish" : "Next"}
                  {!isLast ? <IconArrowRight className="h-3.5 w-3.5" aria-hidden /> : null}
                </Button>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
