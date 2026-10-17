import { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "./Button";

export function useListDisclosure({
  total,
  limit = 6,
  resetKey = "",
}: {
  total: number;
  limit?: number;
  resetKey?: string;
}) {
  const contentId = useId();
  const [state, setState] = useState({ resetKey, expanded: false });
  if (state.resetKey !== resetKey) {
    setState({ resetKey, expanded: false });
  }
  const expanded = state.resetKey === resetKey && state.expanded;

  return {
    expanded,
    limit,
    contentId,
    visibleCount: expanded ? total : Math.min(total, limit),
    toggle: () => setState({ resetKey, expanded: !expanded }),
  };
}

export function ListDisclosureControl({
  disclosure,
  total,
  itemLabel,
  className = "",
}: {
  disclosure: ReturnType<typeof useListDisclosure>;
  total: number;
  itemLabel: string;
  className?: string;
}) {
  if (total <= disclosure.limit) return null;
  const Icon = disclosure.expanded ? ChevronUp : ChevronDown;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-paper-200 pt-2 ${className}`}
    >
      <p className="text-xs text-ink-600">
        {disclosure.expanded
          ? `All ${total} ${itemLabel} available`
          : `Showing ${disclosure.visibleCount} of ${total} ${itemLabel}`}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.contentId}
        onClick={disclosure.toggle}
        className="text-tone-brand"
      >
        {disclosure.expanded ? "Show less" : `Show all ${total} ${itemLabel}`}
        <Icon aria-hidden className="size-4 shrink-0" />
      </Button>
    </div>
  );
}
