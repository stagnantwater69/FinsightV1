import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The landing page's structural vocabulary.
 *
 * This is the approved emerald/mint/cream card design: warm cream and pale
 * mint section surfaces, rounded white cards with hairline borders and the
 * soft green-tinted shadow scale, a small uppercase green eyebrow above each
 * section heading, and gold reserved for primary calls to action.
 *
 * Colours come from the `landing-*` token group in tailwind.config.js — a
 * named, deliberate exception to the app's teal brand scale, scoped to the
 * public landing surface only. Nothing here should reach for `brand-*`,
 * default Tailwind hues, or raw hex.
 */

/** The page measure — the spec's 1180–1280px content container. */
export const MEASURE = "mx-auto w-full max-w-[1240px] px-5 sm:px-8";

/**
 * Reveals its children once, when they first reach the viewport.
 *
 * One IntersectionObserver per element and disconnected on first fire, so a
 * long page does not keep dozens of live observers running while someone
 * scrolls. Elements start visible when IO is unavailable, so anything above
 * the fold — or in a browser without IO — is simply there.
 */
export function useRevealed<T extends Element>() {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      // Fires a little before the edge, so the motion is finishing as the
      // element arrives rather than starting once it is already being read.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, revealed };
}

/** Content that rises 14px as it arrives. `delay` staggers siblings. */
export function Rise({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, revealed } = useRevealed<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`${revealed ? "animate-rise" : "opacity-0"} ${className}`}
      style={revealed && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/** The small uppercase green kicker above a section heading. */
export function Eyebrow({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "mint" | "gold" }) {
  const color =
    tone === "mint" ? "text-landing-mint" : tone === "gold" ? "text-landing-gold" : "text-landing-green";
  return (
    <span className={`block text-[11px] font-bold uppercase tracking-[0.16em] ${color}`}>{children}</span>
  );
}

/**
 * A section head: eyebrow, heading, optional lede. Left-aligned on a shared
 * axis, matching the approved design.
 */
export function SectionHead({
  eyebrow,
  title,
  lede,
  id,
  tone = "light",
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  id?: string;
  /** `dark` flips the text for the deep-emerald sections. */
  tone?: "light" | "dark";
}) {
  return (
    <div>
      <Rise>
        <Eyebrow tone={tone === "dark" ? "mint" : "green"}>{eyebrow}</Eyebrow>
      </Rise>
      <Rise delay={60}>
        <h2
          id={id}
          className={`mt-3 max-w-[24ch] font-display text-[clamp(1.75rem,3.6vw,2.5rem)] font-extrabold leading-[1.1] tracking-[-0.025em] ${
            tone === "dark" ? "text-white" : "text-landing-charcoal"
          }`}
        >
          {title}
        </h2>
      </Rise>
      {lede ? (
        <Rise delay={120}>
          <p
            className={`mt-4 max-w-[62ch] text-[15px] leading-relaxed sm:text-base ${
              tone === "dark" ? "text-landing-mint-light/85" : "text-landing-muted"
            }`}
          >
            {lede}
          </p>
        </Rise>
      ) : null}
    </div>
  );
}

/**
 * The two CTA styles — one gold primary, one quiet secondary — shared by the
 * header, hero and closing banner so the page has exactly one of each.
 * Gold always carries charcoal ink: white on #F5AD19 fails contrast.
 */
export const CTA_PRIMARY =
  "inline-flex min-h-tap items-center justify-center gap-2 rounded-xl bg-landing-gold px-5 py-3 text-[15px] font-bold text-landing-charcoal shadow-sm transition duration-150 ease-shell hover:bg-accent-300 active:bg-accent-500";

export const CTA_SECONDARY =
  "inline-flex min-h-tap items-center justify-center gap-2 rounded-xl border border-landing-mint-light bg-white px-5 py-3 text-[15px] font-semibold text-landing-charcoal transition duration-150 ease-shell hover:border-landing-mint hover:bg-landing-mint-pale active:bg-landing-mint-light";

/**
 * The rounded card — the page's one surface primitive. A hairline border, a
 * white ground, and the green-tinted `shadow-sm`; `hover` adds the sanctioned
 * 2px lift with a step up the shadow scale.
 */
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-landing-mint-light/70 bg-white shadow-sm ${
        hover ? "transition duration-200 ease-shell hover:-translate-y-0.5 hover:shadow-md" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
