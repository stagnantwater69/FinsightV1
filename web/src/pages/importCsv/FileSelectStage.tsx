import { useEffect, useRef, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { FileInput, FormError } from "../../components/Field";
import { IconArrowRight } from "../../components/icons";
import { SkeletonLine } from "../../components/Skeleton";
import { Card, PageHead } from "../../components/ui";
import { CsvFileSummary, CsvImportBreadcrumbs, CsvImportStepper } from "./CsvImportStepper";

export function FileSelectStage({
  file,
  totalRows,
  previewError,
  previewing,
  onSelectFile,
  onSubmit,
}: {
  file: File | null;
  totalRows?: number;
  previewError: string | null;
  previewing: boolean;
  onSelectFile: (next: File | null) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const heading = useRef<HTMLDivElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  function removeSelectedFile() {
    onSelectFile(null);
    window.setTimeout(() => document.getElementById("csv-file")?.focus(), 0);
  }

  return (
    <div>
      <CsvImportBreadcrumbs />
      <div ref={heading} tabIndex={-1} className="outline-none">
        <PageHead
          title="Import CSV records"
          subtitle="Bring in a batch of expenses or sales from a spreadsheet export."
        />
      </div>

      <div className="mx-auto w-full max-w-5xl space-y-5 2xl:max-w-6xl">
        <CsvImportStepper current={1} />

        <Card as="form" onSubmit={onSubmit} className="p-4 sm:p-5">
          <FileInput
            id="csv-file"
            accept=".csv,text/csv"
            maxBytes={5 * 1024 * 1024}
            file={file}
            disabled={previewing}
            onSelect={onSelectFile}
            presentation="hero"
            chooseLabel="Choose CSV file"
            showSelectionSummary={false}
          />

          <p className="mt-3 text-center text-xs leading-relaxed text-ink-500">
            CSV files up to 5MB. The first row must contain column headings.
          </p>

          {file ? (
            <div className="mt-4">
              <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                Selected file: {file.name}
              </p>
              <CsvFileSummary
                file={file}
                totalRows={totalRows}
                onChange={removeSelectedFile}
                disabled={previewing}
                actionLabel="Remove file"
              />
            </div>
          ) : null}

          <p className="mt-4 text-sm text-ink-600">
            Not sure what to include?{" "}
            <a
              href="/sample-import.csv"
              download
              className="tap-inline font-semibold text-tone-brand underline underline-offset-4"
            >
              Download an example CSV
            </a>
          </p>

          {previewError ? <div className="mt-4"><FormError>{previewError}</FormError></div> : null}

          {previewing ? (
            <div aria-busy="true" aria-live="polite" className="mt-4 space-y-3 rounded-xl bg-paper-100 p-4">
              <p className="text-xs font-medium text-ink-600">Reading your file...</p>
              <SkeletonLine className="w-1/3" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-2/3" />
            </div>
          ) : null}

          <Button type="submit" variant="primary" fullWidth disabled={previewing || !file} className="mt-5">
            {previewing ? "Reading file..." : totalRows === undefined ? "Preview file" : "Continue to column mapping"}
          </Button>
        </Card>

        <section aria-labelledby="csv-next-title" className="rounded-2xl bg-tint-brand px-5 py-5 sm:px-6">
          <h2 id="csv-next-title" className="text-base font-semibold text-ink-900">What happens next?</h2>
          <p className="mt-1 text-sm text-ink-600">FinSight will guide you through the checks before anything is saved.</p>
          <ol className="mt-4 grid gap-5 md:grid-cols-3 md:gap-8">
            {[
              ["Upload", "Choose one CSV file from your spreadsheet or point-of-sale export."],
              ["Map columns", "Match your date, description, amount, and optional details."],
              ["Review and import", "Check skipped rows and possible duplicates before saving."],
            ].map(([label, detail], index) => (
              <li key={label} className="relative flex gap-3">
                <span aria-hidden className="figure flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink-900">{label}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-600">{detail}</p>
                </div>
                {index < 2 ? (
                  <IconArrowRight className="absolute -right-6 top-1.5 hidden h-4 w-4 text-tone-brand md:block" />
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
