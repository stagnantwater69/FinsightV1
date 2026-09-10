/**
 * The brand lettering only; surrounding layouts own mascot size and color.
 *
 * Sora rather than a display serif: Cinzel's Roman serifs and high stroke
 * contrast thin out badly at the 16px the sidebar renders this at, where the
 * light strokes half-disappear into the dark rail. Sora at 800 holds its
 * weight at that size, and it is already the app's display face, so the mark
 * and the headings under it now belong to the same family.
 *
 * DELIBERATE EXCEPTION to the "Sora at 18px and above only" rule: that rule
 * is about running heading text, where Sora's width hurts readability. This
 * is a tracked, uppercase, 800-weight brand mark of eight letters — a shape
 * to recognise, not a line to read.
 *
 * `sightClassName` is optional and paints the second half of the mark only —
 * the two-tone "Fin/Sight" treatment the sidebar has always used. It is a
 * prop rather than a fixed colour because the rail is the one surface whose
 * own background flips per theme, so its colours have to come from the
 * caller's themed tokens; the marketing and auth layouts pass nothing and
 * stay single-tone.
 */
export function Wordmark({
  className = "",
  sightClassName,
}: {
  className?: string;
  sightClassName?: string;
}) {
  return (
    <span className={`font-display font-extrabold uppercase tracking-[0.08em] whitespace-nowrap ${className}`}>
      Fin{sightClassName ? <span className={sightClassName}>Sight</span> : "Sight"}
    </span>
  );
}
