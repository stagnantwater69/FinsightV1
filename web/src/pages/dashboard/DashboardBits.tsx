import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { IconTile } from "../../components/IconTile";

/**
 * The dashboard's small shared pieces: the shared icon tile, a panel title
 * that carries one, and one link treatment (label + chevron) used the same
 * way everywhere, so the page reads as one system.
 */

export { IconTile };

/** A panel title with its icon. The icon is decoration; the name is the text. */
export function PanelTitle({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <IconTile icon={icon} size="sm" />
      <span>{children}</span>
    </span>
  );
}

const LINK_CLASS = "tap-inline group inline-flex items-center gap-0.5 text-xs link-action";

/** A navigation link: the destination's name and a chevron that nudges on hover. */
export function ArrowLink({ to, children, className = "" }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`${LINK_CLASS} ${className}`}>
      {children}
      <ChevronRight
        aria-hidden
        className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </Link>
  );
}
