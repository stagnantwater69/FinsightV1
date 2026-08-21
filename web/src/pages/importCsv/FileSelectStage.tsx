import type { FormEvent } from "react";
import { FormPage } from "../../components/ui";
import { Button } from "../../components/Button";
import { Field, FileInput, FormError } from "../../components/Field";
import { SkeletonLine } from "../../components/Skeleton";

/** Stage 1 of the flow — choosing a file, before any preview exists. */
export function FileSelectStage({
  file,
  previewError,
  previewing,
  onSelectFile,
  onSubmit,
}: {
  file: File | null;
  previewError: string | null;
  previewing: boolean;
  onSelectFile: (next: File | null) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <FormPage
      eyebrow="Records"
      title="Import CSV records"
      subtitle="Bring in a batch of expenses or sales from a spreadsheet export."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="CSV file" htmlFor="file" required>
          <FileInput
            accept=".csv,text/csv"
            maxBytes={5 * 1024 * 1024}
            file={file}
            onSelect={onSelectFile}
            hintText="A .csv export from your spreadsheet, up to 5MB. The first row should be your column headings."
          />
        </Field>
        <p className="text-xs text-ink-500">
          Not sure what to include?{" "}
          <a href="/sample-import.csv" download className="font-medium text-brand-700 hover:text-brand-800">
            Download an example CSV
          </a>
        </p>
        {previewError ? <FormError>{previewError}</FormError> : null}

        {/* Parsing a real export can take a moment — commit to the shape of
            the mapping table that's about to appear rather than leaving the
            button label as the only signal, same reasoning as ScanReceipt's
            read skeleton. */}
        {previewing ? (
          <div aria-busy="true" aria-live="polite" className="space-y-3 rounded-xl bg-paper-100 p-4">
            <span className="sr-only">Reading your file…</span>
            <p className="text-xs font-medium text-ink-500">Reading your file…</p>
            <SkeletonLine className="w-1/3" />
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-2/3" />
          </div>
        ) : null}

        <Button type="submit" variant="primary" fullWidth disabled={previewing || !file}>
          {previewing ? "Reading file…" : "Preview"}
        </Button>
      </form>
    </FormPage>
  );
}
