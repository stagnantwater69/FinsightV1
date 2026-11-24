import type { LucideIcon } from "lucide-react";

/**
 * The one icon treatment for the dashboard and the insight pages: a plain
 * glyph in the secondary ink colour. No tinted tile, circle or brand colour
 * behind it — the icon labels the card; status lives in the pill or text.
 */
const SIZES = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
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
  return <Icon aria-hidden strokeWidth={1.75} className={`shrink-0 text-ink-500 ${SIZES[size]} ${className}`} />;
}
