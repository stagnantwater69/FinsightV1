import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Optional result commentary. Keep the summary and required actions outside. */
export function ResultDetails({ children, label = "Result details" }: { children: ReactNode; label?: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-h-tap items-center gap-1.5 rounded-md text-xs font-semibold text-current underline decoration-current/40 underline-offset-4 hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        {expanded ? "Show less" : "Show more"}
        <ChevronDown aria-hidden className={`h-4 w-4 ${expanded ? "rotate-180" : ""}`} />
      </button>
      <div id={id} role="region" aria-label={label} hidden={!expanded} className="space-y-2 break-words text-sm leading-relaxed">
        {children}
      </div>
    </div>
  );
}
