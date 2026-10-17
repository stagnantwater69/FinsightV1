import type { LucideIcon } from "lucide-react";

/**
 * The one icon treatment for the dashboard and the insight pages: a rounded
 * square in the brand teal with the glyph centred in it. Same shape, same
 * colour, everywhere, so an icon reads as "this is what the card is about"
 * and never as a second, competing status signal; status lives in the pill
 * or the text beside it.
 *
 * A flat brand tint with the teal glyph on it, in every theme: no gradient,
 * no shadow. The tint token is deep enough in the light themes to read on
 * white, and dark resolves it to a deep wash that carries the glyph.
 */
const SIZES = {
  sm: { box: "h-7 w-7 rounded-lg", glyph: "h-3.5 w-3.5" },
  md: { box: "h-9 w-9 rounded-lg", glyph: "h-[1.125rem] w-[1.125rem]" },
  lg: { box: "h-12 w-12 rounded-xl", glyph: "h-6 w-6" },
} as const;

export function IconTile({
  icon: Icon,
  size = "md",
  className = "",
}: {
  icon: LucideIcon;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center bg-tint-brand text-tone-brand ${s.box} ${className}`}
    >
      <Icon className={s.glyph} />
    </span>
  );
}
