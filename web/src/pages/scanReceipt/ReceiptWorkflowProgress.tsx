import { IconCheck } from "../../components/icons";

export function ReceiptWorkflowProgress({ current }: { current: "upload" | "review" | "save" }) {
  const steps = [
    { id: "upload", label: "Upload" },
    { id: "review", label: "Review" },
    { id: "save", label: "Save" },
  ] as const;
  const currentIndex = steps.findIndex((step) => step.id === current);

  return (
    <nav aria-label="Receipt scan progress" className="mb-5">
      <ol className="grid grid-cols-3" role="list">
        {steps.map((step, index) => {
          const complete = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li key={step.id} className="relative flex min-w-0 flex-col items-center gap-1.5 text-center">
              {index > 0 ? (
                <span
                  aria-hidden
                  className={`absolute right-1/2 top-[1.125rem] h-px w-full -translate-y-1/2 ${
                    index <= currentIndex ? "bg-brand-500" : "bg-paper-200"
                  }`}
                />
              ) : null}
              <span
                aria-hidden
                className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ring-4 ring-paper ${
                  complete || active
                    ? "bg-brand-700 text-white"
                    : "bg-paper-200 text-ink-600"
                }`}
              >
                {complete ? <IconCheck className="h-4 w-4" /> : index + 1}
              </span>
              <span
                aria-current={active ? "step" : undefined}
                className={`truncate text-xs font-semibold ${active ? "text-tone-brand" : "text-ink-600"}`}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
