import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { IconCheck, IconCsvFile } from "../../components/icons";

export type CsvImportStep = 1 | 2 | 3;

const STEPS = [
  { number: 1 as const, label: "Upload file", detail: "Choose your CSV" },
  { number: 2 as const, label: "Map columns", detail: "Match your data" },
  { number: 3 as const, label: "Review and import", detail: "Check before saving" },
];

export function CsvImportBreadcrumbs() {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-xs text-ink-500">
      <ol className="flex flex-wrap items-center gap-2">
        <li>
          <Link to="/records" className="tap-inline font-semibold text-tone-brand underline-offset-4 hover:underline">
            Records
          </Link>
        </li>
        <li aria-hidden className="text-ink-400">/</li>
        <li aria-current="page" className="font-medium text-ink-700">Import CSV records</li>
      </ol>
    </nav>
  );
}

export function CsvImportStepper({ current }: { current: CsvImportStep }) {
  const activeStep = STEPS[current - 1];
  return (
    <div>
      <p className="sr-only" aria-live="polite">Step {current} of 3: {activeStep.label}</p>
      <ol aria-label="CSV import progress" className="flex w-full items-start">
      {STEPS.map((step, index) => {
        const complete = step.number < current;
        const active = step.number === current;
        return (
          <li
            key={step.number}
            aria-current={active ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center text-center sm:flex-row sm:items-start sm:text-left"
          >
            <span
              aria-hidden
              className={`relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-4 ring-paper-50 ${
                complete || active
                  ? "bg-brand-700 text-white"
                  : "bg-paper-200 text-ink-600"
              }`}
            >
              {complete ? <IconCheck className="h-4 w-4" /> : step.number}
            </span>
            <span className="mt-2 min-w-0 px-1 sm:ml-3 sm:mt-0 sm:px-0">
              <span className={`block text-xs font-semibold sm:text-sm ${active ? "text-ink-900" : "text-ink-700"}`}>
                {step.label}
              </span>
              <span className="mt-0.5 hidden text-xs text-ink-500 md:block">{step.detail}</span>
            </span>
            {index < STEPS.length - 1 ? (
              <span
                aria-hidden
                className={`absolute left-[calc(50%+1.25rem)] right-[calc(-50%+1.25rem)] top-4 h-px sm:left-[calc(2.25rem+0.75rem)] sm:right-3 ${
                  complete ? "bg-brand-500" : "bg-paper-200"
                }`}
              />
            ) : null}
          </li>
        );
      })}
      </ol>
    </div>
  );
}

export function CsvFileSummary({
  file,
  totalRows,
  onChange,
  disabled = false,
  actionLabel = "Change file",
}: {
  file: File;
  totalRows?: number;
  onChange: () => void;
  disabled?: boolean;
  actionLabel?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-paper-200 bg-paper px-4 py-3 shadow-sm">
      <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
        <IconCsvFile className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900" title={file.name}>
          {file.name}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          {totalRows === undefined
            ? formatBytes(file.size)
            : `${totalRows.toLocaleString()} row${totalRows === 1 ? "" : "s"} · ${formatBytes(file.size)}`}
        </p>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={onChange} disabled={disabled}>
        {actionLabel}
      </Button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
