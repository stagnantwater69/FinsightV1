import { useRef, type KeyboardEvent } from "react";
import { IconEdit, IconEye, IconRecords } from "../../components/icons";

export type ReceiptReviewMode = "review" | "results" | "compact";

const REVIEW_MODES: Array<{
  id: ReceiptReviewMode;
  label: string;
  Icon: typeof IconEye;
}> = [
  { id: "review", label: "Review", Icon: IconEye },
  { id: "results", label: "Results", Icon: IconEdit },
  { id: "compact", label: "Compact", Icon: IconRecords },
];

export function ReceiptReviewTabs({
  value,
  onChange,
}: {
  value: ReceiptReviewMode;
  onChange: (mode: ReceiptReviewMode) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveFocus(index: number) {
    const next = (index + REVIEW_MODES.length) % REVIEW_MODES.length;
    const mode = REVIEW_MODES[next]!.id;
    onChange(mode);
    tabRefs.current[next]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(REVIEW_MODES.length - 1);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Receipt review view"
      className="mb-4 grid grid-cols-3 overflow-hidden rounded-xl border border-paper-200 bg-paper-100 p-1"
    >
      {REVIEW_MODES.map(({ id, label, Icon }, index) => {
        const selected = value === id;
        return (
          <button
            key={id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={`receipt-view-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="receipt-view-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-lg px-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
              selected
                ? "bg-tint-brand text-tone-brand ring-1 ring-edge-brand"
                : "text-ink-600 hover:bg-paper hover:text-ink-900"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
