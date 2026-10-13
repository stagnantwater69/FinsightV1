import { useEffect, useRef, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { FileInput, FormError } from "../../components/Field";
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
        <PageHead title="Import CSV" subtitle="Expenses or sales from a spreadsheet or POS export." />
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
            CSV up to 5 MB, with column headings in the first row.
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
            <a
              href="/sample-import.csv"
              download
              className="tap-inline font-semibold text-tone-brand underline underline-offset-4"
            >
              Download example CSV
            </a>
          </p>

          {previewError ? <div className="mt-4"><FormError>{previewError}</FormError></div> : null}

          {previewing ? (
            <div aria-busy="true" aria-live="polite" className="mt-4 space-y-3 rounded-xl bg-paper-100 p-4">
              <p className="text-xs font-medium text-ink-600">Reading your file…</p>
              <SkeletonLine className="w-1/3" />
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-2/3" />
            </div>
          ) : null}

          <Button type="submit" variant="primary" fullWidth disabled={previewing || !file} className="mt-5">
            {previewing ? "Reading file…" : totalRows === undefined ? "Upload and review" : "Continue to review"}
          </Button>
        </Card>

      </div>
    </div>
  );
}
