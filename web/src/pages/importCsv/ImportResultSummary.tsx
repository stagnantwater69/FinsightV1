import { Link } from "react-router-dom";
import { Callout, FormPage } from "../../components/ui";
import { ButtonLink } from "../../components/Button";
import { Celebration } from "../../components/Confirmation";
import type { ImportResult } from "./types";

/**
 * The finished-import screen — stage 3 of the flow.
 *
 * Split out of the page component unchanged: this is purely a summary view
 * over a completed `ImportResult`, with no state of its own.
 */
export function ImportResultSummary({
  result,
  fromOnboarding,
}: {
  result: ImportResult;
  fromOnboarding: boolean;
}) {
  const flaggedTotal = result.flagged + (result.largeExpenseFlagged ?? 0);
  // The COUNT, not the length of the list: a worker-run import caps the list
  // of skipped rows it persists, so `skipped.length` under-reports a large
  // file and "0 skipped" over a file that skipped 400 rows would be a lie.
  const skippedTotal = result.skippedCount ?? result.skipped.length;
  const clean = skippedTotal === 0 && flaggedTotal === 0 && result.duplicateOfBatchId === undefined;

  return (
    <FormPage eyebrow="Records" title="Import complete">
      {/*
        Confirmation.tsx names CSV import as one of the three moments that
        earns a designed ending — a lot of work landing at once — and it was
        the one that never got it. A clean import is a genuine payoff; an
        import with rows to review is not, so that case keeps the calm
        summary instead of being congratulated.
      */}
      {clean ? (
        <Celebration title={`${result.imported} record${result.imported === 1 ? "" : "s"} imported`}>
          Every row in <strong className="text-ink-800">{result.title}</strong> went in cleanly — nothing
          was skipped and nothing needs review.
        </Celebration>
      ) : null}

      <dl className={`space-y-2 text-sm ${clean ? "mt-6" : ""}`}>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-500">Rows in file</dt>
          <dd className="figure font-medium text-ink-900">{result.totalRows}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-500">Imported</dt>
          <dd className="figure font-medium text-ink-900">{result.imported}</dd>
        </div>
        {/*
          Broken out only when the file actually held both. A single-type
          import already said what it was on the previous screen, and
          repeating "0 sales" there would be noise.
        */}
        {result.importedExpenses !== undefined &&
        result.importedSales !== undefined &&
        result.importedExpenses > 0 &&
        result.importedSales > 0 ? (
          <>
            <div className="flex justify-between gap-3 pl-4">
              <dt className="text-ink-500">— as expenses</dt>
              <dd className="figure font-medium text-ink-900">{result.importedExpenses}</dd>
            </div>
            <div className="flex justify-between gap-3 pl-4">
              <dt className="text-ink-500">— as sales</dt>
              <dd className="figure font-medium text-ink-900">{result.importedSales}</dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-ink-500">Skipped</dt>
          <dd className="figure font-medium text-ink-900">{skippedTotal}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-500">Flagged as possible duplicates</dt>
          <dd className="figure font-medium text-ink-900">{result.flagged}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-500">Flagged as large expenses</dt>
          <dd className="figure font-medium text-ink-900">{result.largeExpenseFlagged ?? 0}</dd>
        </div>
      </dl>

      {/*
        THE SAME FILE, IMPORTED TWICE.

        The server hashes the file's bytes and tells us when a previous
        COMPLETE import of this profile carried identical content. It is a
        warning and never a block — re-importing a corrected export is
        legitimate — but importing the same file twice by accident is the
        single most common way an owner doubles a month of records, and the
        only cheap moment to notice is now.

        The duplicate detector will also have flagged the rows individually;
        this says the thing those individual flags are all about.
      */}
      {result.duplicateOfBatchId !== undefined ? (
        <div className="mt-4">
          <Callout tone="warn">
            <b className="font-semibold">This file was imported before.</b> An earlier import of this
            business had byte-for-byte the same contents, so these records are probably a second copy
            of ones you already have.{" "}
            <Link
              to="/records/flagged"
              className="tap-inline font-semibold text-tone-accent underline underline-offset-2"
            >
              Review the duplicates →
            </Link>
          </Callout>
        </div>
      ) : null}

      {/*
        The flag counts used to be dead numbers. A count of things needing
        review, with no way to reach them, is worse than no count — it tells
        the owner there is a problem and then leaves them to find it.
      */}
      {flaggedTotal > 0 ? (
        <div className="mt-4">
          <Callout tone="warn">
            <b className="font-semibold">
              {flaggedTotal} record{flaggedTotal === 1 ? "" : "s"} need a second look.
            </b>{" "}
            FinSight flags a record when it matches one you already have, or when it's large for your
            business.{" "}
            <Link
              to="/records/flagged"
              className="tap-inline font-semibold text-tone-accent underline underline-offset-2"
            >
              Review them now →
            </Link>
          </Callout>
        </div>
      ) : null}

      {/*
        Said here rather than left to be discovered: these rows imported
        successfully, so nothing is wrong — but an expense with no category is
        missing from every category breakdown until it has one, and the owner
        would otherwise have no reason to go looking.
      */}
      {result.uncategorised ? (
        <div className="mt-4">
          <Callout tone="info">
            <b className="font-semibold">
              {result.uncategorised} expense{result.uncategorised === 1 ? "" : "s"} had no category
              and went into "Uncategorised".
            </b>{" "}
            They're imported and counted — sorting them into real categories is what makes them
            show up in your spending breakdown.{" "}
            <Link
              to="/records"
              className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
            >
              Sort them now →
            </Link>
          </Callout>
        </div>
      ) : null}

      {skippedTotal > 0 ? (
        <div className="mt-4 rounded-lg bg-tint-danger p-3 text-xs text-tone-danger ring-1 ring-edge-danger">
          <p className="mb-1 font-medium">
            These rows couldn't be read and were not imported. Fix them in your spreadsheet and import
            again:
          </p>
          <ul className="list-inside list-disc space-y-0.5">
            {result.skipped.map((s) => (
              <li key={s.row}>
                Row {s.row}: {s.reason}
              </li>
            ))}
          </ul>
          {/* A worker-run import caps the list it keeps. Saying so is the
              difference between "these are the skipped rows" and "these are
              some of them". */}
          {result.skipped.length < skippedTotal ? (
            <p className="mt-1.5 font-medium">
              Showing {result.skipped.length} of {skippedTotal} skipped rows.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {fromOnboarding ? (
          <ButtonLink to="/dashboard" variant={clean ? "primary" : "brand"}>
            Go to my dashboard
          </ButtonLink>
        ) : (
          /*
           * Straight to THIS import's records, not to all of them.
           *
           * It used to link to a bare /records, which dropped the owner into
           * every record they have ever had at the one moment they want to
           * look at the few hundred that just arrived — and left them to
           * rediscover the two filters (Source, then Which import) that
           * narrow it. The page already reads both from the URL, so the link
           * only has to say so.
           */
          <ButtonLink
            to={`/records?source=CSV_UPLOAD&importBatchId=${result.batchId}`}
            variant={clean ? "primary" : "brand"}
          >
            See these {result.imported} records
          </ButtonLink>
        )}
        <ButtonLink
          to="/records/csv-imports/new"
          state={fromOnboarding ? { fromOnboarding: true } : undefined}
          variant="secondary"
        >
          Import another file
        </ButtonLink>
      </div>
    </FormPage>
  );
}
