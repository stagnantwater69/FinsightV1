import { Link } from "react-router-dom";

/**
 * The foot of a preview panel whose full list lives on its own page.
 *
 * Callers render it only when the preview leaves something out: a panel that
 * already shows everything has nothing to link to.
 */
export function SeeAllFooter({
  shown,
  total,
  noun,
  to,
}: {
  shown: number;
  total: number;
  /** Plural, lower case: "findings", "unusual expenses". */
  noun: string;
  to: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-paper-200 pt-3">
      <span className="text-xs text-ink-500">
        Showing {shown} of {total} {noun}
      </span>
      <Link to={to} className="tap-inline text-sm link-action">
        See all {total}
        <span className="sr-only"> {noun}</span>
      </Link>
    </div>
  );
}
