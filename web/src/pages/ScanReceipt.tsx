import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { CategorySelect } from "../components/CategorySelect";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import type { CategorySuggestion } from "../lib/types";
/*
 * The payload builder and the plan type both come from lib/receiptConfirm, so
 * this screen and the request it sends cannot disagree about either. "shrink"
 * is the escape hatch for the case where OCR misread the TOTAL rather than
 * missing an item — there the items are the trustworthy figure.
 */
import { buildReceiptConfirmPayload, type GapPlan } from "../lib/receiptConfirm";
import { everyLineIsReady, groupByCategory, sumCentavos, toReviewLines } from "../lib/receiptReview";
/*
 * The confidence BAND, not the raw percentage, is what the owner is shown —
 * ADR-4. One mapping for the whole product replaces the three inconsistent
 * cutoffs this screen used to carry (80/60 for the page, 75 per item).
 */
import { BAND_COPY, confidenceBand, scanConfidenceBand } from "../lib/confidenceBands";
import {
  fieldsNeedingAttention,
  warningHeadline,
  warningPageSuffix,
  warningTone,
  type FieldEvidence,
  type ReceiptField,
  type ReceiptWarning,
} from "../lib/receiptWarnings";
import { Callout, Card, PageHead, FormPage, Pill } from "../components/ui";
import { Button } from "../components/Button";
import { Field, FormError, MoneyInput, TextInput } from "../components/Field";
import { Money } from "../components/Money";
import { SkeletonLine } from "../components/Skeleton";
import { useToast } from "../components/Toast";

interface ScanResult {
  id: number;
  extractedDate: string | null;
  extractedVendor: string | null;
  extractedDescription: string | null;
  extractedAmount: number | null;
  /** The lines FinSight read off the receipt. Empty on a total-only receipt. */
  items: ScannedItem[];
  /**
   * True when FinSight could not read the receipt's text at all and had AI
   * interpret the photograph instead. These values are a machine's reading of
   * a picture rather than of text, and the screen says so — see the callout.
   */
  visionAssisted?: boolean;
  /**
   * How readable the photograph itself was. Present only on the upload
   * response — it answers "should you take another one?", which is only worth
   * answering while the owner is still holding the receipt.
   */
  captureQuality?: { sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null;
  /** How sure OCR was about this page, 0-100. Null when not measured. */
  ocrConfidence?: number | null;
  /** The line most likely misread, when the items don't add up. */
  suspectItemId?: number | null;
  /**
   * True when the photograph appears to hold more than one receipt.
   *
   * Advisory only. FinSight cannot tell which items belong to which receipt,
   * so it says what it noticed and leaves the decision with the owner.
   */
  looksLikeMultipleReceipts?: boolean;
  /**
   * Every page's own quality reading, in the order they were photographed.
   * Present only on the upload response, for the same reason captureQuality
   * is — it answers "should you retake one of these?", which stops mattering
   * once the scan is confirmed or abandoned.
   */
  pageQualities?: ({ sharpness: number; brightness: number; tooBlurredToTrust: boolean } | null)[];
  /**
   * 1-indexed page numbers that read as the same page photographed twice.
   * Empty on a single-page scan — there is nothing adjacent to compare.
   */
  duplicatePages?: number[];
  /**
   * How far the server has got READING this scan: "Processing" | "Complete" |
   * "Failed". Distinct from confirmationStatus, which is the owner's own
   * decision afterwards. The upload responds before the read finishes, so
   * this is what pollUntilRead waits on.
   */
  processingStatus?: "Processing" | "Complete" | "Failed";
  /** Why the read failed. Present only when processingStatus is "Failed". */
  processingError?: string | null;
  /**
   * Machine-readable warnings the pipeline recorded, each carrying the
   * server's own actionable guidance sentence.
   *
   * These REPLACE the hardcoded prose this screen used to keep per boolean.
   * Web and mobile each wrote their own wording for the same signals and the
   * two had already drifted; the sentence is now the server's, and rendering
   * anything else here re-creates that bug. See lib/receiptWarnings.ts.
   */
  warnings?: ReceiptWarning[];
  /**
   * Where each extracted value was read from — page, the visible line, and
   * which engine read it. Null for scans read before evidence was recorded,
   * and nulls inside an entry where the origin could not be located. Never
   * invented.
   */
  fieldEvidence?: Record<string, FieldEvidence> | null;
}

interface ScannedItem {
  id: number;
  lineNumber: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  /** FinSight's automatic assignment; the owner may change it. */
  categoryId: number | null;
  /** True for a line the owner typed in, false for one OCR read. */
  addedByOwner?: boolean;
  /**
   * True for a line AI read off the photograph because OCR found none.
   *
   * Kept distinct from an OCR-read line for the same reason addedByOwner is:
   * this screen tells the owner FinSight *read* these items, and that claim
   * must not quietly stretch to cover one a model inferred from a picture.
   */
  extractedByVision?: boolean;
  /**
   * A category FinSight thinks this item needs but the business doesn't have.
   *
   * Only ever an offer. Nothing is created until the owner accepts it — a
   * category appearing in their books that they never asked for is exactly
   * what the categoriser's grounding rules exist to prevent.
   */
  suggestedCategoryName?: string | null;
  /** How sure OCR was about THIS amount, 0-100, or null if not measured. */
  amountConfidence?: number | null;
  /** Which page and printed line this item was read from, and by what. */
  evidence?: FieldEvidence | null;
}

/**
 * A line the owner is adding because OCR missed it.
 *
 * Held client-side until Confirm, like every other answer on this screen —
 * nothing is written until the owner accepts the whole receipt.
 */
interface AddedItem {
  /** Local only, for React keys and edits. Server ids don't exist yet. */
  key: string;
  name: string;
  amount: number | "";
  categoryId: number | "";
}

/**
 * One choice in the "what is this difference" question.
 *
 * A real radio rather than a styled button, so arrow keys move between the
 * options and a screen reader announces "2 of 3" — this is a single decision
 * with mutually exclusive answers, which is exactly what radios are.
 */
function GapOption({
  name,
  checked,
  onChange,
  label,
  detail,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border p-2 transition ${
        checked ? "border-brand-500 bg-paper-50" : "border-paper-200 hover:border-paper-300"
      }`}
    >
      <span className="flex items-start gap-2">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onChange}
          className="mt-0.5 shrink-0 accent-brand-700"
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-ink-800">{label}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{detail}</span>
        </span>
      </span>
      {children}
    </label>
  );
}

/**
 * Where a field's current value came from.
 *
 * This is the mechanism behind UAT item 29 ("it was clear I could correct the
 * scanned details before saving"). Previously every field was an ordinary
 * input: a vendor OCR failed to read looked exactly like a vendor the owner had
 * deliberately cleared, and nothing on screen distinguished a value FinSight
 * guessed from one the owner typed. The only signal was a single 12px line
 * above the whole form.
 */
type Origin = "read" | "derived" | "missing" | "edited";

function originOf(current: string, extracted: string | null): Origin {
  if (extracted === null || extracted === "") return current === "" ? "missing" : "edited";
  return current === extracted ? "read" : "edited";
}

const ORIGIN_CHIP: Partial<Record<Origin, { label: string; tone: string }>> = {
  read: { label: "Read from receipt", tone: "bg-tint-info text-tone-info ring-edge-info" },
  derived: { label: "Suggested from the vendor", tone: "bg-tint-info text-tone-info ring-edge-info" },
  missing: { label: "Not found — please enter", tone: "bg-tint-accent text-tone-accent ring-edge-accent" },
};

function OriginChip({ origin }: { origin: Origin }) {
  const spec = ORIGIN_CHIP[origin];
  if (!spec) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${spec.tone}`}
    >
      <span aria-hidden>{origin === "missing" ? "⚠" : "✦"}</span>
      {spec.label}
    </span>
  );
}

/**
 * A field whose value FinSight guessed.
 *
 * The wash marks it as provisional and clears the moment the owner edits it,
 * so "FinSight said this" and "I said this" never look the same.
 *
 * `!bg-*` is deliberate: the base control class sets `bg-paper`, and two
 * background utilities in one class attribute resolve by stylesheet order, not
 * by the order they are written here. The important modifier is what makes the
 * override deterministic.
 */
function provisionalClass(origin: Origin): string {
  if (origin === "read" || origin === "derived") return "!bg-tint-info";
  if (origin === "missing") return "!bg-tint-accent";
  return "";
}

/** One category's share of a receipt. `""` is the not-yet-entered state. */
interface Split {
  categoryId: number | "";
  amount: number | "";
}

function ScannedField({
  label,
  htmlFor,
  origin,
  required,
  optional,
  attention,
  evidence,
  children,
}: {
  label: string;
  htmlFor: string;
  origin: Origin;
  required?: boolean;
  optional?: boolean;
  /** True when the band said this is one of the values to look at. */
  attention?: boolean;
  /** Where this value was read from, when the server could locate it. */
  evidence?: FieldEvidence | null;
  children: ReactNode;
}) {
  return (
    <Field
      label={label}
      htmlFor={htmlFor}
      required={required}
      optional={optional}
      labelAction={<OriginChip origin={origin} />}
      hint={
        attention || evidence ? (
          <>
            {attention ? (
              <span className="font-medium text-tone-accent">Check this one against the receipt. </span>
            ) : null}
            <EvidenceNote evidence={evidence} />
          </>
        ) : undefined
      }
    >
      {children}
    </Field>
  );
}

/**
 * The exact fields to look at, so "Check a few fields" can name them.
 *
 * Three sources, in the order they are trusted: a warning that NAMES a field
 * (the server said so, and its guidance says what to do), an extracted value
 * that came back empty (there is nothing to compare against the paper), and —
 * for the single-total flow only — a page reading bad enough that the amount
 * itself is in doubt. Per-item confidence is handled on the item rows, where
 * the owner is already looking at that line.
 *
 * Module-level rather than inline so the focus effect and the render agree by
 * construction: the field that gets focus is the same one the callout names.
 */
function attentionFieldsFor(scan: ScanResult | null): ReceiptField[] {
  if (!scan) return [];
  const named = new Set<ReceiptField>(fieldsNeedingAttention(scan.warnings ?? []));
  if (!scan.extractedDate) named.add("date");
  if (scan.extractedAmount === null || scan.extractedAmount === undefined) named.add("amount");
  if (scanConfidenceBand(scan) === "review" && (scan.items?.length ?? 0) <= 1) named.add("amount");
  const order: ReceiptField[] = ["date", "description", "vendor", "amount"];
  return order.filter((f) => named.has(f));
}

/** Human names for the extracted fields, used wherever one is named in prose. */
const FIELD_LABELS: Record<ReceiptField, string> = {
  date: "Date",
  description: "Description",
  vendor: "Vendor",
  amount: "Amount",
};

/**
 * Where a value came from, quoted.
 *
 * "Read from page 2: 'TOTAL 1,220.00'" is the difference between asking the
 * owner to trust a number and showing them the line it came off. It is also
 * the honest way to mark a model's contribution: a value an AI interpreted
 * says so, in the same place, in the same shape.
 *
 * Renders nothing rather than something vague when the origin could not be
 * located — an invented provenance would be worse than none.
 */
function EvidenceNote({ evidence }: { evidence?: FieldEvidence | null }) {
  if (!evidence || (!evidence.sourceText && evidence.pageNumber === null)) return null;
  const where =
    evidence.pageNumber === null ? "Read from the receipt" : `Read from page ${evidence.pageNumber}`;
  const how = evidence.source === "vision" ? " by AI, from the photo" : "";
  return (
    <span className="block text-ink-400">
      {where}
      {how}
      {evidence.sourceText ? (
        <>
          : <span className="figure text-ink-500">“{evidence.sourceText}”</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * The stages of a read, in the order they happen.
 *
 * Each one corresponds to something the client can actually OBSERVE:
 *
 *   uploading    — the multipart POST is in flight.
 *   reading      — the server accepted the photos and is running OCR; this is
 *                  what `processingStatus: "Processing"` means, and it is what
 *                  the poll is waiting on.
 *   checking     — the read came back Complete. The arithmetic reconciliation
 *                  and warnings are already in that response, so this stage is
 *                  the client resolving them against the owner's categories.
 *   categorising — the category list is being refreshed so every item's
 *                  assigned category has an option to render into.
 *
 * There is no fifth "checking duplicates" stage because duplicate detection
 * happens after the record is SAVED, not during the read — showing it here
 * would be describing work that is not being done.
 */
const SCAN_STAGES = ["uploading", "reading", "checking", "categorising"] as const;
type ScanStage = (typeof SCAN_STAGES)[number];

const STAGE_LABELS: Record<ScanStage, string> = {
  uploading: "Uploading",
  reading: "Reading text",
  checking: "Checking totals",
  categorising: "Categorising",
};

/**
 * The wait, told honestly.
 *
 * A list of named stages with a done/doing/waiting state each, rather than a
 * bar. The owner can see which part is slow, and nothing on screen claims to
 * know how much longer it will take — because nothing here does.
 */
function ScanProgress({ stage }: { stage: ScanStage }) {
  const current = SCAN_STAGES.indexOf(stage);
  return (
    <div aria-busy="true" className="space-y-3 rounded-xl bg-paper-100 p-4">
      <p aria-live="polite" className="text-xs font-medium text-ink-600">
        {STAGE_LABELS[stage]}…
      </p>
      <ol className="space-y-1.5">
        {SCAN_STAGES.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                  done
                    ? "bg-tint-brand text-tone-brand ring-1 ring-edge-brand"
                    : active
                      ? "bg-brand-600 text-white motion-safe:animate-pulse"
                      : "bg-paper-200 text-ink-400"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={done ? "text-ink-500" : active ? "font-medium text-ink-800" : "text-ink-400"}>
                {STAGE_LABELS[s]}
              </span>
              <span className="sr-only">
                {done ? " — done" : active ? " — in progress" : " — waiting"}
              </span>
            </li>
          );
        })}
      </ol>
      <SkeletonLine className="w-2/3" />
      <SkeletonLine className="w-full" />
    </div>
  );
}

const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Matches the server's own MAX_PAGES (receiptScan.service.ts) — kept in the
 * comment rather than imported, since the client has no access to backend
 * source; the server is still the one place that actually enforces it. */
const MAX_RECEIPT_FILES = 8;

/**
 * How often, and for how long, to ask whether a scan has finished reading.
 *
 * 1.5s is short enough that a fast read feels immediate and long enough that
 * a slow one does not flood the server — the endpoint being polled runs two
 * indexed queries and no OCR, so this is cheap, but it is still a request per
 * interval per scanning owner.
 *
 * The ceiling is generous because the work behind it genuinely is slow: up to
 * MAX_RECEIPT_FILES pages of Tesseract, sometimes a vision-model round trip,
 * then the categoriser. It exists to end a wait that will never finish (a
 * server restart mid-read strands a scan on "Processing"), not to cut short
 * one that is merely taking its time.
 */
const SCAN_POLL_INTERVAL_MS = 1500;
const SCAN_POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * One picked photo, shown as a thumbnail with its own object URL.
 *
 * The URL is scoped to this component's lifetime rather than built once for
 * the whole list — a file removed from the middle of the array would
 * otherwise leave its revoke tied to a different file after React re-keys
 * the list, which is exactly the kind of leak useEffect's cleanup exists to
 * catch.
 */
function PickedFileThumb({
  file,
  index,
  total,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  file: File;
  index: number;
  total: number;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <li className="relative w-24 shrink-0">
      <div className="aspect-[3/4] overflow-hidden rounded-lg border border-paper-200 bg-paper-100">
        {url ? (
          <img src={url} alt={`Page ${index + 1}`} className="h-full w-full object-cover" />
        ) : null}
      </div>
      <span className="absolute left-1 top-1 rounded-full bg-paper/90 px-1.5 py-0.5 text-[10px] font-semibold text-ink-700">
        {index + 1}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove page ${index + 1}`}
        className="tap absolute right-1 top-1 flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded-full bg-paper/90 text-xs font-bold text-ink-600 hover:bg-tint-danger hover:text-tone-danger"
      >
        ×
      </button>
      {/*
        Reorder by button rather than drag-and-drop. Drag reordering on a
        touch screen needs a library this app does not otherwise depend on,
        and up/down buttons are fully keyboard- and screen-reader-operable
        for free — a real constraint, not a corner cut silently.
      */}
      <div className="mt-1 flex justify-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          aria-label={`Move page ${index + 1} earlier`}
          className="tap-inline flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded text-xs text-ink-500 hover:bg-paper-100 disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          aria-label={`Move page ${index + 1} later`}
          className="tap-inline flex h-6 w-6 min-h-0 min-w-0 items-center justify-center rounded text-xs text-ink-500 hover:bg-paper-100 disabled:opacity-30"
        >
          ↓
        </button>
      </div>
    </li>
  );
}

/**
 * Picks one or several receipt photos.
 *
 * A generalisation of Field.tsx's FileInput to more than one file, kept as
 * its own component rather than added to that one: FileInput's contract
 * (`file: File | null`) is depended on by ImportCsv's single-file picker too,
 * and multi-select is a genuinely different shape, not an option on the same
 * one.
 *
 * Selecting again REPLACES the set, matching the native `<input multiple>`
 * behaviour a second file-dialog invocation already has — there is no
 * incremental "add more" interaction beyond what the OS picker itself offers
 * when the owner selects several files in one dialog.
 */
function MultiFileInput({
  id,
  files,
  onChange,
  hintText,
}: {
  id: string;
  files: File[];
  onChange: (files: File[]) => void;
  hintText?: string;
}) {
  const [rejected, setRejected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function accepts(f: File): boolean {
    return ACCEPTED_TYPES.split(",").includes(f.type.toLowerCase());
  }

  /**
   * ADDS the newly picked photos to what is already selected, rather than
   * replacing it.
   *
   * A native `<input multiple>` hands back a fresh FileList on every
   * invocation with no memory of a previous one — that is what made this
   * button silently discard page 1 the moment it was used to add page 2. The
   * remove (×) on each thumbnail is the deliberate way to drop a photo;
   * picking again should only ever add to the set it already has.
   */
  function take(list: FileList | File[] | null) {
    setRejected(null);
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const combined = [...files, ...incoming];

    if (combined.length > MAX_RECEIPT_FILES) {
      setRejected(
        `A receipt can have at most ${MAX_RECEIPT_FILES} photos — you already have ${files.length} and picked ` +
          `${incoming.length} more.`,
      );
      return;
    }
    const badType = incoming.find((f) => !accepts(f));
    if (badType) {
      setRejected(`${badType.name} isn't a photo this accepts. Expected JPEG, PNG or WEBP.`);
      return;
    }
    const tooBig = incoming.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      const limit = Math.round(MAX_FILE_BYTES / (1024 * 1024));
      setRejected(`${tooBig.name} is over ${limit}MB — try a smaller photo.`);
      return;
    }
    onChange(combined);
  }

  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
  }

  return (
    <div>
      <label
        htmlFor={id}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
        className={`flex min-h-tap cursor-pointer flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm transition-colors ${
          dragging
            ? "border-edge-brand bg-tint-brand text-tone-brand"
            : "border-ink-200 bg-paper-100 text-ink-600 hover:border-edge-brand hover:bg-tint-brand"
        }`}
      >
        <span aria-hidden className="text-base">
          ⇪
        </span>
        <span className="font-medium">{files.length > 0 ? "Add more photos" : "Choose photos"}</span>
        <span className="text-ink-400">or drag them here</span>
      </label>

      <input
        id={id}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        className="sr-only"
        onChange={(e) => take(e.target.files)}
      />

      {hintText ? <p className="mt-1.5 text-xs text-ink-500">{hintText}</p> : null}

      {rejected ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-tone-danger">
          <span aria-hidden className="mt-px shrink-0">
            ⚠
          </span>
          <span className="min-w-0">{rejected}</span>
        </p>
      ) : null}

      {files.length > 0 ? (
        <ul className="scroll-slim mt-3 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <PickedFileThumb
              key={`${f.name}-${f.lastModified}-${i}`}
              file={f}
              index={i}
              total={files.length}
              onRemove={() => removeAt(i)}
              onMoveUp={() => move(i, -1)}
              onMoveDown={() => move(i, 1)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ScanReceipt() {
  const { selected } = useBusinessProfiles();
  const { categories, refresh: refreshCategories, createCategory } = useExpenseCategories();
  const navigate = useNavigate();
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  /**
   * Which stage of the read is actually happening right now.
   *
   * Four honest stages replacing one flat "Reading your receipt…". Every
   * transition below is tied to a real event — the upload responding, the
   * server's own processingStatus turning Complete, the category list coming
   * back — and NOT to a timer. There is deliberately no determinate bar: the
   * server reports no percentage, so any bar drawn here would be an animation
   * pretending to be a measurement, which is the specific thing ADR-4's
   * "never fake determinate progress" rule forbids.
   */
  const [scanStage, setScanStage] = useState<ScanStage>("uploading");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);

  /**
   * Photos picked at the file-choosing stage, before scanning starts.
   *
   * Separate from `file` above, which is the photo of whichever receipt is
   * CURRENTLY being scanned or reviewed. `pickedFiles` is spent the moment
   * scanning starts — into the pages of one upload, or into the queue below —
   * and is never touched again until the owner returns to pick more.
   */
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  /**
   * How to treat more than one picked photo. Meaningless with one photo.
   *
   * Defaults to "separate" deliberately: a mis-click here still produces N
   * correctable records, whereas defaulting to "one" and being wrong would
   * silently merge unrelated receipts into a single one. Wrong-but-visible
   * beats wrong-but-hidden in bookkeeping.
   */
  const [combineChoice, setCombineChoice] = useState<"separate" | "one">("separate");
  /**
   * Photos still waiting to be scanned as their OWN receipt, when the owner
   * chose "separate receipts" for more than one photo. `handleConfirm` pops
   * the next one off this list instead of returning to an empty picker, so a
   * batch of receipts is reviewed one after another without extra clicks.
   */
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  /** 1-based "which receipt is this" for a queued batch; 0 outside one. */
  const [queuePosition, setQueuePosition] = useState(0);
  const [queueTotal, setQueueTotal] = useState(0);
  /**
   * Receipts already confirmed earlier in this batch, so the owner reviewing
   * receipt 2 of 3 has a way to check receipt 1 again.
   *
   * WHY THIS EXISTS: confirming a receipt saves it and immediately advances
   * to the next one — by design, so a batch reviews as a sequence rather than
   * bouncing back to an empty picker between each. But that meant a receipt,
   * once confirmed, was simply gone from the screen with no way back to it
   * short of leaving the batch entirely to search Records. This is what
   * "confirmed" actually left behind: which position it was, and the record
   * ids Confirm created, so a link to it can be shown without abandoning the
   * receipt currently being reviewed.
   */
  const [queueHistory, setQueueHistory] = useState<{ position: number; recordIds: number[] }[]>([]);

  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * How the receipt's total is divided between categories.
   *
   * One entry is the ordinary case and behaves exactly as the single Category
   * field used to — its amount is the receipt total, so it needs no amount
   * input of its own. A second entry turns on the split editor, because a
   * receipt that covers two categories can no longer be described by one.
   */
  const [splits, setSplits] = useState<Split[]>([{ categoryId: "", amount: "" }]);
  const isSplit = splits.length > 1;

  /**
   * The owner's category for each extracted item, keyed by item id.
   *
   * Seeded from what FinSight assigned automatically, then owned by the
   * owner — every row is editable and nothing is written until Confirm.
   */
  const [itemCategories, setItemCategories] = useState<Record<number, number | "">>({});
  /** True while any row still differs from nothing — used only for labelling. */
  const [itemsWereAutoCategorised, setItemsWereAutoCategorised] = useState(false);
  /** The proposed category currently being created, so its row can show progress. */
  const [creatingCategoryFor, setCreatingCategoryFor] = useState<string | null>(null);
  /**
   * The category the AI proposed for a receipt with no itemised lines.
   *
   * Held as the id rather than a boolean so the "AI-suggested" chip can be
   * derived by comparing it against the field's current value — the same way
   * `originOf` distinguishes a read value from an edited one everywhere else
   * on this screen. Change the category and the chip goes away on its own,
   * because it is no longer true.
   */
  const [suggestedCategoryId, setSuggestedCategoryId] = useState<number | null>(null);

  /** Lines the owner added because OCR missed them. */
  const [addedItems, setAddedItems] = useState<AddedItem[]>([]);
  /** The extracted line currently being deleted, so its row can show progress. */
  const [removingItemId, setRemovingItemId] = useState<number | null>(null);
  /** Their choice for whatever difference remains after any added lines. */
  const [gapPlan, setGapPlan] = useState<GapPlan>(null);
  /** The category for the "put it all in one category" plan. */
  const [gapCategoryId, setGapCategoryId] = useState<number | "">("");

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const zoomRef = useRef<HTMLDialogElement>(null);

  /**
   * The scan this screen is currently showing.
   *
   * The category suggestion below is fired off after the review screen has
   * already rendered, so its answer can arrive after the owner has hit Rescan
   * and moved on to a different receipt. This is what stops a stale answer
   * landing on the new one.
   */
  const latestScanId = useRef<number | null>(null);

  /**
   * Scans a SINGLE photo, keyed so the same request is never made twice for
   * the same File.
   *
   * WHY THIS EXISTS — the bug it fixes, and the feature it enables, turned
   * out to be the same root cause. "Separate receipts" used to scan receipt
   * 1 immediately and leave receipt 2 sitting untouched in `fileQueue` —
   * OCR and the categoriser only ran on it once receipt 1 was confirmed.
   * That was slow (every receipt after the first waited for the one before
   * it), and it was FRAGILE: the file was popped out of `fileQueue` before
   * that later scan ran, so if it failed for any reason — a network blip, a
   * cold backend — the photo was gone from every piece of state at once,
   * and the only way forward was to pick it again from the device. That is
   * the exact "I have to upload the second receipt again" report.
   *
   * The fix is to start scanning EVERY receipt in the batch the moment the
   * owner submits, not one at a time as each is reached — seeded from
   * handleStartScanning below. This cache is what makes that safe to do
   * without ever asking twice: a caller reaching a receipt whose scan is
   * already finished gets the answer instantly: one still running is
   * awaited in place (the ordinary "Reading your receipt…" screen just
   * waits a little longer); one already asked for is never asked again.
   */
  const scanPromises = useRef<Map<File, Promise<ScanResult>>>(new Map());

  /**
   * The receipt preview.
   *
   * Built from the local File rather than the stored image, so it appears
   * instantly and costs no request — the server does return the uploaded
   * image's path, but fetching it back to show the user the picture they just
   * picked would be absurd. The object URL is revoked when the file changes or
   * the page unmounts; without that, every rescan leaks a blob.
   */
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * Focus lands on the first field that needs a decision.
   *
   * "Check a few fields" that leaves the keyboard at the top of the form makes
   * the owner hunt for what it meant. Only ever moves focus when there IS
   * something to check — a clean read leaves focus alone, because taking it
   * for no reason is its own accessibility problem. Keyed on the scan id, so
   * it happens once per receipt rather than on every keystroke.
   */
  useEffect(() => {
    if (!scan) return;
    const first = attentionFieldsFor(scan)[0];
    if (!first) return;
    // The Field wrapper puts its `htmlFor` straight onto the control, so the
    // field's own name is the element id.
    const el = document.getElementById(first);
    if (el instanceof HTMLElement) el.focus({ preventScroll: false });
  }, [scan]);

  if (!selected) return null;

  function ensureScanned(file: File): Promise<ScanResult> {
    const existing = scanPromises.current.get(file);
    if (existing) return existing;

    const promise = (async () => {
      const formData = new FormData();
      formData.append("files", file);
      formData.append("businessProfileId", String(selected!.id));
      const { data } = await api.post<ScanResult>("/records/receipts", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // The photos are on the server. Whether OCR has started is the server's
      // business; what the client knows is that the upload is over.
      setScanStage("reading");
      return pollUntilRead(data);
    })();
    scanPromises.current.set(file, promise);
    return promise;
  }

  /**
   * Waits for a scan the server has accepted but not yet finished reading.
   *
   * The upload now returns as soon as the photographs are stored (202), with
   * OCR, the vision rescue and the categoriser running behind it — so the
   * response carries an id and a status rather than the extracted figures.
   * This polls until that read reaches a terminal state and resolves with the
   * finished scan, so everything upstream keeps its old shape: `ensureScanned`
   * still returns `Promise<ScanResult>`, and every caller of it — the promise
   * cache, `scanFiles`, `handleConfirm`'s queue advance — is unchanged. The
   * one function that knew how to fetch a scan is still the only one that
   * does.
   *
   * Rejects on a failed read rather than resolving with a half-empty scan:
   * the caller's existing error path then shows the reason and leaves the
   * owner on the picker, which is the same outcome any other failed scan has.
   */
  async function pollUntilRead(initial: ScanResult, mayRetry = true): Promise<ScanResult> {
    if (initial.processingStatus && initial.processingStatus !== "Processing") {
      if (initial.processingStatus === "Failed") {
        if (mayRetry) {
          const { data: retried } = await api.post<ScanResult>(`/records/receipts/${initial.id}/retry`);
          return pollUntilRead(retried, false);
        }
        throw new Error(initial.processingError ?? "This receipt could not be read. Try scanning it again.");
      }
      return initial;
    }

    const deadline = Date.now() + SCAN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
      const { data } = await api.get<ScanResult>(`/records/receipts/${initial.id}`);
      if (data.processingStatus === "Failed") {
        if (mayRetry) {
          const { data: retried } = await api.post<ScanResult>(`/records/receipts/${initial.id}/retry`);
          return pollUntilRead(retried, false);
        }
        throw new Error(data.processingError ?? "This receipt could not be read. Try scanning it again.");
      }
      if (data.processingStatus === "Complete") return data;
    }
    /*
     * A scan that never finishes is a real possibility, not a hypothetical:
     * the durable worker may be recovering from a provider outage. Giving up
     * visibly is better than polling forever behind a spinner; the server
     * keeps the queued scan and can still finish it after this screen stops.
     */
    throw new Error("This receipt is taking longer than expected to read. Try scanning it again.");
  }

  /**
   * Sends one or more photos to the server as a SINGLE scan and populates the
   * review screen from the answer. A single photo is simply a one-element
   * page list — there is no separate code path for the common case.
   *
   * `representativeFile` drives the preview and the zoom dialog: page 1 for a
   * multi-page receipt, the only file otherwise. Showing every page here is
   * Phase 4 work (docs/multi-page-receipts-plan.md) — for now the photo the
   * owner sees during review is always the receipt's first.
   *
   * Rethrows on failure, unlike most of this screen's handlers — the queue
   * advance in handleConfirm needs to know a scan failed so it can retry
   * rather than silently treating a rejected background prefetch as success.
   * scanError is still set before the throw, so every OTHER caller — which
   * does not care why, only that the picker should show the message — needs
   * no change at all.
   */
  async function scanFiles(filesToSend: File[], representativeFile: File) {
    setFile(representativeFile);
    setScanning(true);
    setScanStage("uploading");
    setScanError(null);
    try {
      // A single photo — the common case, and every "separate receipts"
      // queue entry — is routed through the shared cache above, so a page
      // already scanning in the background is awaited instead of re-asked
      // for. A multi-page "one long receipt" upload has no single File to
      // key a cache entry on and nothing else prefetches it, so it keeps its
      // own direct request exactly as before.
      const data =
        filesToSend.length === 1
          ? await ensureScanned(filesToSend[0]!)
          : await (async () => {
              const formData = new FormData();
              // "files" — plural — even for one photo: the server has one
              // upload route for both shapes, and it reads this field name
              // for either.
              filesToSend.forEach((f) => formData.append("files", f));
              formData.append("businessProfileId", String(selected!.id));
              const res = await api.post<ScanResult>("/records/receipts", formData, {
                headers: { "Content-Type": "multipart/form-data" },
              });
              setScanStage("reading");
              // Polled here too, not only in ensureScanned: this branch is a
              // multi-page receipt, which is the SLOWEST read there is (up to
              // MAX_RECEIPT_FILES pages of OCR). It has no single File to key
              // the promise cache on, which is the only reason it bypasses
              // that path — the waiting is identical.
              return pollUntilRead(res.data);
            })();
      /*
       * Reload the category list BEFORE showing the review table.
       *
       * The scan can create a category server-side: an item nothing fits
       * lands in a standing "Uncategorized" that is made on first need. The
       * client's list was fetched before that existed, so the <select> for
       * such an item had no matching <option> — and a <select> whose value
       * matches no option falls back to the first selectable one. That made
       * EVERY row display the same category (the business's first), which
       * looked exactly like the AI having assigned one category to the whole
       * receipt while the database in fact held the right per-item values.
       */
      /*
       * The read came back. The reconciliation and the warnings are already
       * IN that response, so "checking totals" is the client resolving them —
       * and "categorising" is the category refresh below, which exists
       * precisely because the read may have created a category.
       *
       * Both are genuinely fast on a small receipt, and neither is padded to
       * be visible. A stage that took no time simply does not paint, which is
       * the honest outcome; the alternative — a bar timed to look busy — is
       * what ADR-4 rules out.
       */
      setScanStage("checking");
      await refreshCategories();
      setScanStage("categorising");

      latestScanId.current = data.id;
      setScan(data);
      setDate(data.extractedDate ? data.extractedDate.slice(0, 10) : "");
      setDescription(data.extractedDescription ?? "");
      setVendor(data.extractedVendor ?? "");
      setAmount(data.extractedAmount ?? "");
      // Seed the per-item categories from what FinSight assigned. Every one
      // stays editable — this is a starting point, not a decision.
      setItemCategories(Object.fromEntries(data.items.map((i) => [i.id, i.categoryId ?? ""])));
      setItemsWereAutoCategorised(data.items.some((i) => i.categoryId !== null));

      /*
       * A receipt FinSight could not itemise still deserves a starting point.
       *
       * The per-item categoriser has nothing to work with here — there are no
       * item lines — but the same classifier the Spending Impact screen uses
       * can read "Purchase from Cebu Hardware" and propose a category from
       * the business's own list. Deliberately NOT awaited: the review screen
       * is already on screen and usable, so a slow or unreachable model costs
       * the owner nothing. The field fills in a moment later, or never, and
       * they pick one themselves exactly as before.
       */
      if (data.items.length <= 1) {
        void suggestCategoryForReceipt(data);
      }
    } catch (err) {
      setScanError(getErrorMessage(err));
      throw err;
    } finally {
      setScanning(false);
    }
  }

  /**
   * Turns the picked photos into a scanning plan and starts it.
   *
   * One photo, or "one long receipt" chosen for several: every photo becomes
   * a page of ONE upload. "Separate receipts" instead: the first photo scans
   * now, and the rest wait in `fileQueue` — handleConfirm advances through
   * them one at a time, so a batch of receipts is reviewed in sequence
   * without the owner returning to this screen between each one.
   */
  async function handleStartScanning(e: FormEvent) {
    e.preventDefault();
    if (pickedFiles.length === 0) return;

    if (pickedFiles.length === 1 || combineChoice === "one") {
      const toScan = pickedFiles;
      setPickedFiles([]);
      // scanFiles already recorded the failure in scanError before
      // rethrowing; the picker's existing error display reacts to that
      // state directly, so this caller has nothing further to do with the
      // rejection beyond not letting it go unhandled.
      await scanFiles(toScan, toScan[0]!).catch(() => {});
      return;
    }

    const [first, ...rest] = pickedFiles;
    setPickedFiles([]);
    setFileQueue(rest);
    setQueuePosition(1);
    setQueueTotal(pickedFiles.length);

    /*
     * Every OTHER receipt in the batch starts scanning now too, not once
     * confirming receipt 1 reaches it — this is the actual fix: OCR and the
     * categoriser run for every photo in the batch, concurrently, instead of
     * only the first.
     *
     * Errors are swallowed here on purpose. A background prefetch failing is
     * surfaced properly, with a retry, at the moment the owner actually
     * reaches that receipt (handleConfirm's queue advance) — not as an alert
     * about a receipt they have not been asked to look at yet.
     */
    rest.forEach((f) => {
      ensureScanned(f).catch(() => {});
    });

    await scanFiles([first!], first!).catch(() => {});
  }

  /**
   * Fills the single Category field with the classifier's best guess.
   *
   * Silent on every failure path. A missing suggestion is indistinguishable
   * from never having asked, and the owner choosing a category themselves is
   * the ordinary flow this only tries to shortcut — an error about something
   * they never requested would be noise.
   */
  async function suggestCategoryForReceipt(data: ScanResult) {
    /*
     * "Receipt purchase" is the backend's literal fallback for a receipt
     * whose vendor it could not read, so it describes nothing and would only
     * invite the classifier to guess from the word "purchase".
     */
    const description =
      data.extractedDescription && data.extractedDescription !== "Receipt purchase"
        ? data.extractedDescription
        : data.extractedVendor;
    if (!description) return;

    try {
      const { data: result } = await api.post<{ suggestion: CategorySuggestion | null }>(
        "/ai/suggest-category",
        { businessProfileId: selected!.id, description },
      );
      // A late answer for a receipt the owner has already moved on from is
      // dropped rather than applied to whatever is on screen now.
      if (!result.suggestion || latestScanId.current !== data.id) return;

      const suggestion = result.suggestion;
      // Only ever fills a field the owner has left alone. They may have
      // chosen a category while this was in flight, and a guess must never
      // overwrite a decision.
      setSplits((prev) =>
        prev.length === 1 && prev[0]!.categoryId === ""
          ? [{ ...prev[0]!, categoryId: suggestion.categoryId }]
          : prev,
      );
      setSuggestedCategoryId(suggestion.categoryId);
    } catch {
      // Nothing to say and nothing to do: the field stays empty and the owner
      // fills it in, which is what would have happened anyway.
    }
  }

  /**
   * Accepts a category FinSight proposed for items nothing existing fitted.
   *
   * Creates it, then files every UNPLACED row FinSight proposed it for — not
   * only the row that was clicked. A grocery run proposes "Packaging" on all
   * four packaging lines, and making the owner create it once and then assign
   * it three more times by hand would be busywork on a decision they have
   * just made. Rows they have already placed themselves are left alone, and
   * every row stays editable afterwards.
   */
  async function acceptSuggestedCategory(name: string) {
    setCreatingCategoryFor(name);
    setConfirmError(null);
    try {
      const created = await createCategory({ name });
      setItemCategories((prev) => {
        const next = { ...prev };
        for (const item of items) {
          const isUnplaced = next[item.id] === "" || next[item.id] === undefined || next[item.id] === uncategorisedId;
          if (isUnplaced && item.suggestedCategoryName?.toLowerCase() === name.toLowerCase()) {
            next[item.id] = created.id;
          }
        }
        return next;
      });
      toast(`Category "${created.name}" created`);
    } catch {
      setConfirmError(`Couldn't create the category "${name}". Try again, or pick one from the list.`);
    } finally {
      setCreatingCategoryFor(null);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (!scan || amount === "" || !readyToConfirm) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      // Two shapes, one endpoint — both built in lib/receiptConfirm, where
      // they are tested against the server's real schema. This request is the
      // one that silently broke against it on mobile.
      const records = await api.post(
        `/records/receipts/${scan.id}/confirm`,
        buildReceiptConfirmPayload({
          date,
          description,
          vendor,
          amount: Number(amount),
          isItemised,
          itemAssignments: items.map((i) => ({ itemId: i.id, categoryId: Number(itemCategories[i.id]) })),
          additionalItems: addedItems.map((a) => ({
            name: a.name.trim(),
            amount: Number(a.amount),
            categoryId: Number(a.categoryId),
          })),
          itemsTotal: itemsTotalCentavos / 100,
          gapPlan,
          gapCategoryId: gapCategoryId === "" ? null : gapCategoryId,
          splits: splits.map((s) => ({
            categoryId: Number(s.categoryId),
            amount: Number(isSplit ? s.amount : amount),
          })),
        }),
      );
      const saved = records.data as { id: number }[];
      toast(saved.length === 1 ? "Expense saved from receipt" : `${saved.length} expenses saved from receipt`);

      /*
       * Advancing a queued "separate receipts" batch, rather than always
       * navigating away.
       *
       * handleRescan already clears every field this scan populated; reusing
       * it here is what keeps that reset logic in one place instead of a
       * second copy that could drift from it.
       */
      if (fileQueue.length > 0) {
        // Recorded before the fields it describes are cleared — this is the
        // only trace of receipt N that survives resetReviewFields, and it is
        // what lets receipt N+1's screen show "Receipt 1 — view it".
        setQueueHistory((prev) => [...prev, { position: queuePosition, recordIds: saved.map((r) => r.id) }]);
        const [next, ...rest] = fileQueue;
        resetReviewFields();
        setFileQueue(rest);
        setQueuePosition((p) => p + 1);
        try {
          // The common path: receipt N+1 has been scanning in the background
          // since the batch started, so this is usually just picking up an
          // already-finished (or already in-flight) result — not starting
          // its OCR from zero.
          await scanFiles([next!], next!);
        } catch {
          /*
           * The background prefetch failed. One automatic retry against a
           * FRESH request — not the same rejected promise — covers the
           * ordinary transient cause (a network blip, a cold backend) without
           * making the owner notice and act.
           *
           * Caught HERE rather than left to the outer try/catch below: that
           * one sets confirmError, which describes "saving receipt N failed"
           * — a claim that would be false. Receipt N saved; it is receipt
           * N+1's read that stumbled, and scanFiles already recorded that
           * under scanError, which the picker screen already shows.
           *
           * A failure that survives the retry leaves the owner on the picker
           * with the reason visible — the same outcome any other failed scan
           * has always had, not a new dead end.
           */
          scanPromises.current.delete(next!);
          await scanFiles([next!], next!).catch(() => {});
        }
        return;
      }
      if (queueTotal > 0) {
        setQueuePosition(0);
        setQueueTotal(0);
      }
      navigate("/records");
    } catch (err) {
      setConfirmError(getErrorMessage(err));
    } finally {
      setConfirming(false);
    }
  }

  /**
   * Clears everything one scan populated, without touching `fileQueue`.
   *
   * Shared by handleRescan (the button — an explicit "start over", which also
   * abandons any queued batch, below) and handleConfirm's queue advance
   * (which resets the review fields for the NEXT queued receipt and must
   * NOT clear the queue it is about to consume from). Keeping the two
   * separate is what stops handleConfirm's `setQueuePosition((p) => p + 1)`
   * from racing a `setQueuePosition(0)` in the same state-update batch — both
   * queued in the same render would apply in call order, not in the order
   * that makes sense, and the position would come out wrong by one.
   */
  function resetReviewFields() {
    // Any category suggestion still in flight is for the receipt being left
    // behind, so it must not land on the next one.
    latestScanId.current = null;
    setScan(null);
    setSplits([{ categoryId: "", amount: "" }]);
    setItemCategories({});
    setItemsWereAutoCategorised(false);
    setSuggestedCategoryId(null);
    setCreatingCategoryFor(null);
    setAddedItems([]);
    setGapPlan(null);
    setGapCategoryId("");
    setDate("");
    setDescription("");
    setVendor("");
    setAmount("");
    setConfirmError(null);
    setScanError(null);
  }

  /**
   * Back to the file picker, without dragging the last scan's answers along.
   *
   * This used to only null `scan`, which left every extracted value and the
   * chosen category sitting in state. Re-submitting the same file then produced
   * a second ReceiptScan row and a second stored image server-side while the
   * first was orphaned in "Pending". The image is deliberately kept — the
   * common case is rescanning the same photo — but everything derived from the
   * previous read is cleared.
   *
   * Also abandons any queued "separate receipts" batch. Rescan is a
   * deliberate "start over", and leaving a stale "2 of 4" behind with no way
   * to act on it would be worse than dropping the rest of the batch.
   */
  function handleRescan() {
    resetReviewFields();
    setFileQueue([]);
    setQueuePosition(0);
    setQueueTotal(0);
    setQueueHistory([]);
  }

  // OCR never reads a description. The backend synthesises one from the vendor
  // ("Purchase from X") and falls back to the literal "Receipt purchase" when
  // it found no vendor — which means a null check would call that fallback a
  // successful read. Treating it as "not found" is the honest reading, and it
  // is what prompts the owner to write something meaningful.
  const descriptionOrigin: Origin =
    scan?.extractedDescription === "Receipt purchase"
      ? description === ""
        ? "missing"
        : "edited"
      : description === scan?.extractedDescription
        ? "derived"
        : "edited";

  /*
    Reconciliation, in centavos.

    Mirrors the server's check (receiptScan.service) exactly, so the button
    enables precisely when the request would be accepted — computed in whole
    centavos for the same reason: 1200.10 + 800.20 is not 2000.30 in binary
    floating point, and an owner whose split is right must never be told it
    isn't.
  */
  const totalCentavos = amount === "" ? 0 : Math.round(amount * 100);
  const allocatedCentavos = isSplit
    ? splits.reduce((sum, s) => sum + (s.amount === "" ? 0 : Math.round(s.amount * 100)), 0)
    : totalCentavos;
  const unallocatedCentavos = totalCentavos - allocatedCentavos;
  const everySplitHasCategory = splits.every((s) => s.categoryId !== "");
  const splitsAreComplete = everySplitHasCategory && (!isSplit || unallocatedCentavos === 0);

  function updateSplit(index: number, patch: Partial<Split>) {
    setSplits((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addSplit() {
    setSplits((prev): Split[] => {
      // Turning one category into two: the first row inherits the total it
      // already implicitly had, and the new row starts on whatever is left.
      const seeded: Split[] = prev.length === 1 ? [{ ...prev[0]!, amount }] : prev;
      return [...seeded, { categoryId: "", amount: "" }];
    });
  }

  function removeSplit(index: number) {
    setSplits((prev): Split[] => {
      const next = prev.filter((_, i) => i !== index);
      // Back to a single category — drop its amount so it re-inherits the total.
      return next.length === 1 ? [{ ...next[0]!, amount: "" }] : next;
    });
  }

  /*
   * The itemised path.
   *
   * A receipt with more than one extractable line is reviewed item by item;
   * anything less keeps the single-category flow exactly as it was. One item
   * is not a "split" — showing a grouping UI for it would be ceremony around
   * a decision the single Category dropdown already makes.
   */
  const items = scan?.items ?? [];
  const isItemised = items.length > 1;
  /** True when the item lines came from AI reading the photo, not from OCR text. */
  const itemsAreFromPhoto = items.some((i) => i.extractedByVision);

  /**
   * The one confidence cue this screen shows, resolved from the page reading,
   * every item amount and whether a model was involved. See
   * lib/confidenceBands.ts for why the cutoffs are what they are.
   */
  const receiptBand = scanConfidenceBand(scan ?? {});
  const attentionFields = attentionFieldsFor(scan);

  /**
   * Items grouped by the category the owner currently has them in, with a
   * subtotal each. Recomputed on every render, so moving one row between
   * categories updates both subtotals immediately — there is no separate
   * state to fall out of step with the rows.
   */
  /**
   * Extracted lines and owner-added lines, in one list.
   *
   * Everything downstream — the subtotals, the gap, whether Confirm is
   * enabled — works off this rather than off `items`, so an added line counts
   * the moment it is complete instead of only after saving.
   */
  // All of the review arithmetic lives in lib/receiptReview, where it can be
  // tested on its own — it decides how this receipt's money is split across
  // categories and whether Confirm is allowed.
  const reviewLines = toReviewLines(items, itemCategories, addedItems);
  const itemGroups = groupByCategory(reviewLines);
  const itemsTotalCentavos = sumCentavos(reviewLines);
  const everyItemHasCategory = everyLineIsReady(items, itemCategories, addedItems);

  const itemGapCentavos = totalCentavos - itemsTotalCentavos;

  /*
    A gap is normal, not an error.

    Item prices and the total legitimately disagree: a VAT-exclusive register
    adds tax on top of the printed lines, a discount takes money off, and OCR
    sometimes just misses a line. So the screen asks how to account for the
    difference rather than disabling Confirm until the owner makes the
    arithmetic work — which, on a VAT-exclusive receipt, they never could.

    The one thing that never happens is the total changing on its own. It is
    what the owner confirmed against the photo and what actually left their
    pocket; only the explicit "OCR misread the total" plan touches it.
  */
  const gapNeedsAPlan = itemGapCentavos !== 0;
  // A discount can't become its own expense record — that would be a negative
  // expense, which nothing downstream understands. Server enforces this too.
  const canFileGapInOneCategory = itemGapCentavos > 0;
  const gapPlanIsResolved =
    !gapNeedsAPlan ||
    gapPlan === "proportional" ||
    gapPlan === "shrink" ||
    (gapPlan === "category" && canFileGapInOneCategory && gapCategoryId !== "");

  const itemsAreComplete = everyItemHasCategory && gapPlanIsResolved;

  const readyToConfirm = isItemised ? itemsAreComplete : splitsAreComplete;

  /*
   * The amount actually sent is derived in lib/receiptConfirm, not here.
   *
   * A duplicate of that rule used to sit at this spot, left behind when the
   * payload shapes moved into the builder. It was unreferenced — so it was
   * dead weight that still had to be kept in step with the real rule, and it
   * failed the production build under noUnusedLocals. The builder is the one
   * place that decides, and it is tested against the server's schema.
   */

  function addAddedItem() {
    setAddedItems((prev) => [
      ...prev,
      { key: `added-${Date.now()}-${prev.length}`, name: "", amount: "", categoryId: "" },
    ]);
  }

  function updateAddedItem(key: string, patch: Partial<Omit<AddedItem, "key">>) {
    setAddedItems((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }

  function removeAddedItem(key: string) {
    setAddedItems((prev) => prev.filter((a) => a.key !== key));
  }

  /**
   * Drops a line OCR read that was never a purchase.
   *
   * Deleted on the server rather than hidden here, because confirmation
   * requires every STORED item to carry a category — a row this screen merely
   * stopped showing would still be on the scan, and would block Confirm with
   * a message about an item the owner can no longer see.
   *
   * The response is the scan as it now stands, so the table re-renders from
   * the server's list rather than a local guess at it. Removing a line widens
   * the gap against the total, which the reconciliation question below picks
   * up on the next render — that is the intended consequence, not a side
   * effect to suppress.
   */
  async function removeScannedItem(itemId: number) {
    if (!scan) return;
    setRemovingItemId(itemId);
    setConfirmError(null);
    try {
      const { data } = await api.delete<ScanResult>(`/records/receipts/${scan.id}/items/${itemId}`);
      setScan(data);
      setItemCategories((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    } catch (err) {
      setConfirmError(getErrorMessage(err));
    } finally {
      setRemovingItemId(null);
    }
  }

  /** Category id -> its name, for the subtotal lines. */
  function categoryName(id: number | ""): string {
    return categories.find((c) => c.id === id)?.name ?? "Category";
  }

  /**
   * The standing "nothing fitted this" category, if this business has one.
   *
   * Created server-side on demand during a scan, so it may not exist at all,
   * and matched case-insensitively because an owner who already had their own
   * "Uncategorized" keeps it — the same rule the server follows.
   */
  const uncategorisedId = categories.find((c) => c.name.toLowerCase() === "uncategorized")?.id ?? null;

  /**
   * The new category FinSight proposed for a row, when it is still worth
   * offering.
   *
   * Withheld once the owner has placed the row themselves: the suggestion
   * answers "nothing here fits this", which stops being true the moment they
   * say what does. Withheld too once the category exists — which happens as
   * soon as it is accepted for a sibling row — because the offer would then
   * be to create a duplicate.
   */
  function suggestedNewCategoryFor(item: ScannedItem): string | null {
    const name = item.suggestedCategoryName;
    if (!name) return null;
    const current = itemCategories[item.id];
    const isUnplaced = current === "" || current === undefined || current === uncategorisedId;
    if (!isUnplaced) return null;
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return null;
    return name;
  }

  const receiptPreview = previewUrl ? (
    <>
      <button
        type="button"
        onClick={() => zoomRef.current?.showModal()}
        className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-paper-200 bg-paper-100"
      >
        <img
          src={previewUrl}
          alt="The receipt you uploaded"
          className="mx-auto max-h-[70vh] w-full object-contain"
        />
      </button>
      <p className="mt-2 text-center text-xs text-ink-400">Tap the photo to enlarge it.</p>

      <dialog
        ref={zoomRef}
        onClick={() => zoomRef.current?.close()}
        className="confirm-dialog max-h-[92vh] w-[min(60rem,calc(100vw-2rem))] rounded-2xl border border-paper-200 bg-paper p-2"
      >
        <img src={previewUrl} alt="The receipt you uploaded, enlarged" className="w-full object-contain" />
        <p className="py-2 text-center text-xs text-ink-500">Tap anywhere to close.</p>
      </dialog>
    </>
  ) : null;

  // ---- stage 1: choose a photo ------------------------------------------
  if (!scan) {
    return (
      <FormPage eyebrow="Records" title="Scan a receipt">
        <form onSubmit={handleStartScanning} className="space-y-4">
          <Field label="Receipt photo" htmlFor="receipt-files" required>
            <MultiFileInput
              id="receipt-files"
              files={pickedFiles}
              onChange={setPickedFiles}
              hintText="JPEG, PNG or WEBP, up to 8MB each. A flat, well-lit photo reads best. Add more than one only if this receipt did not fit in a single photo, or you're scanning several receipts at once."
            />
          </Field>

          {/*
            The disambiguation only appears once there is something to
            disambiguate. One photo has nothing to ask about — asking anyway
            would put a question in front of every owner for the sake of the
            minority with a long receipt.
          */}
          {pickedFiles.length > 1 ? (
            <div className="space-y-2 rounded-xl border border-paper-200 bg-paper-50 p-3">
              <p className="text-xs font-medium text-ink-700">
                You added {pickedFiles.length} photos. What are they?
              </p>
              <GapOption
                name="combine-choice"
                checked={combineChoice === "separate"}
                onChange={() => setCombineChoice("separate")}
                label={`${pickedFiles.length} separate receipts`}
                detail="Each photo becomes its own expense. Scanned and reviewed one after another."
              />
              <GapOption
                name="combine-choice"
                checked={combineChoice === "one"}
                onChange={() => setCombineChoice("one")}
                label={`One long receipt (${pickedFiles.length} pages)`}
                detail="These photos continue from each other — one receipt too long for a single photo."
              />
            </div>
          ) : null}

          {scanError ? <FormError>{scanError}</FormError> : null}

          {/*
            The OCR wait is the app's slowest interaction and it cannot be made
            fast, so the interface says which PART of it is happening instead of
            one flat "Reading your receipt…". Each stage is driven by a real
            event — see ScanProgress — and there is no percentage anywhere,
            because the server reports none.
          */}
          {scanning ? <ScanProgress stage={scanStage} /> : null}

          <Button type="submit" variant="primary" fullWidth disabled={scanning || pickedFiles.length === 0}>
            {scanning
              ? "Reading receipt…"
              : pickedFiles.length > 1 && combineChoice === "separate"
                ? `Scan ${pickedFiles.length} receipts`
                : "Scan receipt"}
          </Button>
        </form>
      </FormPage>
    );
  }

  // ---- stage 2: check what it read --------------------------------------
  //
  // Deliberately NOT inside FormPage: the whole job of this screen is letting
  // the owner read the receipt and the extracted values at the same time, and
  // FormPage's single measure column cannot hold both side by side.
  return (
    <div>
      <PageHead
        eyebrow="Records"
        title="Check what FinSight read"
        subtitle="Compare each value against the photo before saving."
      />

      {/*
        The batch progress row — a plain-text "Receipt 2 of 4" in the subtitle
        was easy to miss, and gave no way to actually SEE receipt 1 again once
        it scrolled past. Each earlier receipt is now a real link.

        Opens in a NEW TAB rather than navigating in place: this app is a
        single-page client, and an in-app navigation to a saved record would
        unmount this screen — losing fileQueue, queuePosition and everything
        else this in-progress batch is holding. A new tab leaves the batch
        exactly where it was.
      */}
      {queueTotal > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="list" aria-label="Receipts in this batch">
          {Array.from({ length: queueTotal }, (_, i) => i + 1).map((n) => {
            const history = queueHistory.find((h) => h.position === n);
            if (n === queuePosition) {
              return (
                <span
                  key={n}
                  role="listitem"
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Receipt {n} · Reviewing now
                </span>
              );
            }
            if (history && history.recordIds[0] !== undefined) {
              return (
                <a
                  key={n}
                  role="listitem"
                  href={`/records/expenses/${history.recordIds[0]}/edit`}
                  target="_blank"
                  rel="noreferrer"
                  className="tap-inline inline-flex items-center gap-1.5 rounded-full bg-tint-brand px-3 py-1.5 text-xs font-medium text-tone-brand ring-1 ring-edge-brand transition hover:bg-tint-brand/70"
                >
                  <span aria-hidden>✓</span>
                  Receipt {n} · Saved — view it
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              );
            }
            return (
              <span
                key={n}
                role="listitem"
                className="inline-flex items-center gap-1.5 rounded-full bg-paper-100 px-3 py-1.5 text-xs text-ink-400"
              >
                Receipt {n} · Not yet
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <form onSubmit={handleConfirm} className="space-y-4">
            {/*
              THE PRIMARY CUE IS A BAND, NOT A PERCENTAGE.

              This used to read "FinSight's reading confidence for this photo:
              87%". A percentage is a grade, and a grade invites the owner to
              accept it — 87 sounds like a pass. It also disagreed with itself:
              the page number was coloured on 80/60 while the per-item badges
              below used 75, so a green header could sit above amber items.

              lib/confidenceBands.ts now owns the single mapping (ADR-4), and
              what the owner reads is an instruction: Looks clear / Check a few
              fields / Review carefully. The band is TEXT, not a hue, so it
              survives greyscale and colourblindness. The raw figure stays in
              the title attribute, where it is evidence rather than a grade.
            */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Pill tone={BAND_COPY[receiptBand].tone === "ok" ? "ok" : BAND_COPY[receiptBand].tone === "warn" ? "warn" : "danger"}>
                {BAND_COPY[receiptBand].label}
              </Pill>
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-500">
                {BAND_COPY[receiptBand].detail}
              </p>
            </div>

            {/*
              WHICH fields, not just "some fields".

              "Check a few fields" is only useful if the screen says which, so
              the warnings that name a field, the low-confidence item amounts
              and the missing values are resolved into one list — and the first
              of them takes focus when the review screen appears, so the
              keyboard lands on the thing that needs a decision.
            */}
            {receiptBand !== "clear" && attentionFields.length > 0 ? (
              <Callout tone="warn">
                <b className="font-semibold">
                  Check {attentionFields.map((f) => FIELD_LABELS[f]).join(", ").toLowerCase()} before
                  saving.
                </b>{" "}
                {attentionFields.length === 1
                  ? "FinSight was least sure about this one."
                  : "These are the values FinSight was least sure about."}
              </Callout>
            ) : null}

            {/*
              THE WARNINGS, IN THE SERVER'S OWN WORDS.

              What stood here before was a prose ladder: one hardcoded
              paragraph per boolean (blurry page, duplicate page, two receipts
              in one photo, vision-assisted, vision-assisted-but-only-the-
              names). Mobile kept its own copy of the same ladder and the two
              had already drifted, so the same receipt could be described
              differently on the two clients.

              The pipeline now emits CODES and the server owns one guidance
              sentence per code (backend/src/lib/receiptWarnings.ts). This
              renders `warning.guidance` verbatim. Writing a sentence here
              instead — however small — puts the drift straight back.
            */}
            {(scan.warnings ?? []).map((warning, i) => (
              <Callout key={`${warning.code}-${warning.pageNumber ?? "x"}-${i}`} tone={warningTone(warning.code)}>
                <b className="font-semibold">
                  {warningHeadline(warning.code)}
                  {warningPageSuffix(warning)}.
                </b>{" "}
                {warning.guidance}
                {warning.detail ? (
                  <span className="mt-1 block text-[11px] opacity-80">{warning.detail}</span>
                ) : null}
              </Callout>
            ))}

            {/*
              The standing reminder, which is not a warning about THIS receipt
              and so is not part of the list above. It stays because the design
              assumes owners know they can correct these values, and item 29
              exists because they did not.
            */}
            <Callout tone="warn">
              <b className="font-semibold">Check these against your receipt before saving.</b>{" "}
              FinSight often misreads creased, faded or thermal-printed receipts. Anything you change here
              is what gets saved.
            </Callout>

            <ScannedField
              label="Date"
              htmlFor="date"
              required
              attention={attentionFields.includes("date")}
              evidence={scan.fieldEvidence?.date}
              origin={originOf(date, scan.extractedDate ? scan.extractedDate.slice(0, 10) : null)}
            >
              <TextInput
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={provisionalClass(
                  originOf(date, scan.extractedDate ? scan.extractedDate.slice(0, 10) : null),
                )}
              />
            </ScannedField>

            <ScannedField
              label="Description"
              htmlFor="description"
              required
              attention={attentionFields.includes("description")}
              origin={descriptionOrigin}
            >
              <TextInput
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What did you buy?"
                className={provisionalClass(descriptionOrigin)}
              />
            </ScannedField>

            <ScannedField
              label="Vendor"
              htmlFor="vendor"
              optional
              attention={attentionFields.includes("vendor")}
              evidence={scan.fieldEvidence?.vendor}
              origin={originOf(vendor, scan.extractedVendor)}
            >
              <TextInput
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className={provisionalClass(originOf(vendor, scan.extractedVendor))}
              />
            </ScannedField>

            <ScannedField
              label="Amount"
              htmlFor="amount"
              required
              attention={attentionFields.includes("amount")}
              evidence={scan.fieldEvidence?.amount}
              origin={originOf(String(amount), scan.extractedAmount === null ? null : String(scan.extractedAmount))}
            >
              <MoneyInput
                min={0.01}
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
                className={provisionalClass(
                  originOf(
                    String(amount),
                    scan.extractedAmount === null ? null : String(scan.extractedAmount),
                  ),
                )}
              />
            </ScannedField>

            {/*
              Two review modes.

              A receipt whose lines FinSight could read is reviewed ITEM BY
              ITEM — that is the whole point of the feature, and it is what
              lets "buns" and "patty" land in Ingredients while "rice cooker"
              lands in Equipment without the owner deciding anything up front.

              A receipt with one line or none keeps exactly the flow it had:
              one Category dropdown, optionally split by hand. Showing a
              grouping UI for a single item would be ceremony around a
              decision the dropdown already makes.
            */}
            {isItemised ? (
              <fieldset>
                <legend className="text-sm font-medium text-ink-700">
                  Items on this receipt
                  <span className="ml-1 text-tone-danger" title="Required">
                    <span aria-hidden>*</span>
                    <span className="sr-only">(required)</span>
                  </span>
                </legend>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  {/*
                    "read" is the wrong verb for a line a model inferred from a
                    photograph, so it is not used for one. Same sentence,
                    honest verb.
                  */}
                  {itemsWereAutoCategorised ? (
                    <>
                      FinSight {itemsAreFromPhoto ? "found" : "read"} {items.length} items and put each
                      one in a category. Check them against the photo — change any that are wrong.
                    </>
                  ) : (
                    <>
                      FinSight {itemsAreFromPhoto ? "found" : "read"} {items.length} items but couldn't
                      categorise them. Put each one in a category below.
                    </>
                  )}
                </p>

                <div className="mt-2 overflow-x-auto rounded-xl border border-paper-200">
                  <table className="w-full min-w-[30rem] text-left text-sm">
                    <caption className="sr-only">
                      Each item read from the receipt, with the category it will be filed under
                    </caption>
                    <thead>
                      <tr className="border-b border-paper-200 bg-paper-100">
                        <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                          Item
                        </th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                          Qty
                        </th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                          Price
                        </th>
                        <th scope="col" className="w-48 px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-500">
                          Category
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="border-t border-paper-200 align-middle">
                          <td className="px-3 py-2 text-ink-800">
                            {item.name}
                            {/*
                              When the items do not add up, the server names
                              the line it is least sure of. Pointing beats
                              asking the owner to re-read all nine — and it
                              never changes the figure, because the right
                              value is not something the engine knows.
                            */}
                            {scan.suspectItemId === item.id ? (
                              <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                                <span aria-hidden>⚠</span>
                                Check this one first
                              </span>
                            ) : null}
                            {/*
                              Marked per row, not just once at the top, because
                              the row is where the owner decides. A line a model
                              inferred from a photograph should look different
                              from one read off text at the moment it is checked.
                            */}
                            {item.extractedByVision ? (
                              <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-tint-accent px-1.5 py-0.5 text-[10px] font-medium text-tone-accent ring-1 ring-edge-accent align-middle">
                                <span aria-hidden>✦</span>
                                AI read this from the photo
                              </span>
                            ) : null}
                            {/*
                              The printed line this row came off, quoted. It is
                              the cheapest possible way to check a row: the
                              owner compares two strings instead of hunting the
                              paper for a number.
                            */}
                            {item.evidence ? (
                              <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-400">
                                <EvidenceNote evidence={item.evidence} />
                              </span>
                            ) : null}
                          </td>
                          <td className="figure px-3 py-2 text-right text-ink-600">
                            {item.quantity ?? "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {/* decimals: an item price is a real cent value.
                                The default whole-peso rendering reads faster in
                                summaries but here it turned 3.19 into "PHP 3",
                                which made three correct prices look like they
                                did not add up to their own correct subtotal. */}
                            <Money value={item.amount} decimals />
                            {/*
                              The engine's own doubt about THIS figure. Shown
                              only when it is low enough to act on — a
                              percentage beside every correct price would be
                              noise, and noise is what stops people checking.
                            */}
                            {/*
                              The engine's own doubt about THIS figure, as a
                              band rather than "72% sure". Same mapping as the
                              header cue (lib/confidenceBands.ts) — before
                              this, the page used 80/60 and the item badge used
                              75, so a receipt could read "clear" above a row
                              the same engine was unsure of. The raw figure
                              stays in the title, as evidence.
                            */}
                            {confidenceBand({
                              confidence: item.amountConfidence,
                              visionAssisted: item.extractedByVision,
                            }) !== "clear" && typeof item.amountConfidence === "number" ? (
                              <span
                                className="mt-0.5 block text-[10px] font-medium text-tone-accent"
                                title={`FinSight's own confidence reading this amount: ${item.amountConfidence}%`}
                              >
                                {BAND_COPY[
                                  confidenceBand({
                                    confidence: item.amountConfidence,
                                    visionAssisted: item.extractedByVision,
                                  })
                                ].label}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <div className="min-w-0 flex-1">
                                <label htmlFor={`item-category-${item.id}`} className="sr-only">
                                  Category for {item.name}
                                </label>
                                <CategorySelect
                                  id={`item-category-${item.id}`}
                                  value={itemCategories[item.id] ?? ""}
                                  onChange={(categoryId) =>
                                    setItemCategories((prev) => ({ ...prev, [item.id]: categoryId }))
                                  }
                                />
                              </div>
                              {/*
                                Removing a line OCR should never have read.
                                Named by the item rather than by position, so
                                the announcement says what is being removed
                                instead of "remove item 4".
                              */}
                              <button
                                type="button"
                                onClick={() => removeScannedItem(item.id)}
                                disabled={removingItemId === item.id}
                                className="tap-inline shrink-0 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-500 transition hover:text-tone-danger disabled:opacity-50"
                              >
                                <span aria-hidden>×</span>
                                <span className="sr-only">
                                  Remove {item.name} — this was not a purchase
                                </span>
                              </button>
                            </div>

                            {/*
                              A category FinSight thinks is missing.

                              Shown only where it is still useful — see
                              suggestedNewCategoryFor. Phrased as an offer
                              rather than an assignment, because nothing is
                              created until the owner says so; the whole
                              reason this is a suggestion and not a decision
                              is that inventing categories in someone's books
                              is not FinSight's call to make.
                            */}
                            {suggestedNewCategoryFor(item) ? (
                              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
                                <span aria-hidden className="text-tone-accent">
                                  ✦
                                </span>{" "}
                                Nothing fits this. FinSight suggests a new category,{" "}
                                <b className="font-semibold text-ink-700">{item.suggestedCategoryName}</b>.{" "}
                                <button
                                  type="button"
                                  onClick={() => acceptSuggestedCategory(item.suggestedCategoryName!)}
                                  disabled={creatingCategoryFor !== null}
                                  className="tap-inline font-medium text-brand-700 underline transition hover:text-brand-800 disabled:opacity-50"
                                >
                                  {creatingCategoryFor === item.suggestedCategoryName
                                    ? "Creating…"
                                    : "Create it"}
                                  <span className="sr-only"> and file {item.name} under it</span>
                                </button>
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ))}

                      {/*
                        Lines the owner is adding because OCR missed them.

                        Kept visually distinct from the extracted rows: the
                        panel above claims FinSight READ these items off the
                        receipt, and that claim must not quietly extend to a
                        row a human typed. The same distinction is stored
                        server-side (ReceiptScanItem.addedByOwner) so it
                        survives onto the saved record.
                      */}
                      {addedItems.map((added, i) => (
                        <tr key={added.key} className="border-t border-paper-200 bg-paper-50 align-middle">
                          <td className="px-3 py-2">
                            <label htmlFor={`added-name-${added.key}`} className="sr-only">
                              Name for added item {i + 1}
                            </label>
                            <TextInput
                              id={`added-name-${added.key}`}
                              placeholder="Item name"
                              value={added.name}
                              onChange={(e) => updateAddedItem(added.key, { name: e.target.value })}
                            />
                          </td>
                          <td className="px-3 py-2 text-right text-ink-400">—</td>
                          <td className="px-3 py-2">
                            <label htmlFor={`added-amount-${added.key}`} className="sr-only">
                              Amount for added item {i + 1}
                            </label>
                            <MoneyInput
                              id={`added-amount-${added.key}`}
                              min={0.01}
                              value={added.amount}
                              onChange={(e) =>
                                updateAddedItem(added.key, {
                                  amount: e.target.value === "" ? "" : Number(e.target.value),
                                })
                              }
                            />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <div className="min-w-0 flex-1">
                                <label htmlFor={`added-category-${added.key}`} className="sr-only">
                                  Category for added item {i + 1}
                                </label>
                                <CategorySelect
                                  id={`added-category-${added.key}`}
                                  value={added.categoryId}
                                  onChange={(categoryId) => updateAddedItem(added.key, { categoryId })}
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAddedItem(added.key)}
                                className="tap-inline shrink-0 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-500 transition hover:text-tone-danger"
                              >
                                <span aria-hidden>×</span>
                                <span className="sr-only">Remove added item {i + 1}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/*
                  The live per-category subtotals. Derived from the rows on
                  every render rather than held in their own state, so moving
                  one item between categories cannot leave a stale figure
                  behind — both affected subtotals change in the same paint.
                */}
                <div className="mt-3 rounded-xl bg-paper-100 p-3">
                  <p className="text-xs font-semibold text-ink-600">What gets saved</p>
                  <ul className="mt-1.5 space-y-1">
                    {itemGroups.map((group) => (
                      <li
                        key={String(group.categoryId)}
                        className="flex items-baseline justify-between gap-3 text-sm"
                      >
                        <span className="min-w-0 truncate text-ink-700">
                          {group.categoryId === "" ? (
                            <span className="text-tone-accent">Not categorised yet</span>
                          ) : (
                            categoryName(group.categoryId)
                          )}
                          <span className="ml-1.5 text-xs text-ink-400">
                            ({group.count} item{group.count === 1 ? "" : "s"})
                          </span>
                        </span>
                        <span className="figure shrink-0 font-medium text-ink-900">
                          <Money value={group.subtotal} decimals />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p
                    aria-live="polite"
                    className={`mt-2 flex items-center gap-1.5 border-t border-paper-200 pt-2 text-xs font-medium ${
                      itemsAreComplete ? "text-tone-brand" : "text-tone-accent"
                    }`}
                  >
                    <span aria-hidden>{itemsAreComplete ? "✓" : "⚠"}</span>
                    {!everyItemHasCategory ? (
                      <>Every item needs a category before this can be saved.</>
                    ) : itemGapCentavos === 0 ? (
                      <>
                        {itemGroups.length} record{itemGroups.length === 1 ? "" : "s"} will be saved, adding
                        up to the receipt total.
                      </>
                    ) : gapPlan === "shrink" ? (
                      <>
                        The receipt will be saved as <Money value={itemsTotalCentavos / 100} decimals /> —
                        the items' own total — instead of the amount above.
                      </>
                    ) : gapPlanIsResolved ? (
                      <>
                        {itemGroups.length + (gapPlan === "category" ? 1 : 0)} record
                        {itemGroups.length + (gapPlan === "category" ? 1 : 0) === 1 ? "" : "s"} will be saved,
                        adding up to the receipt total of{" "}
                        <Money value={totalCentavos / 100} decimals />.
                      </>
                    ) : itemGapCentavos > 0 ? (
                      <>
                        The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
                        <Money value={itemGapCentavos / 100} decimals /> less than the receipt total above.
                      </>
                    ) : (
                      <>
                        The items come to <Money value={itemsTotalCentavos / 100} decimals />, which is{" "}
                        <Money value={-itemGapCentavos / 100} decimals /> more than the receipt total above.
                      </>
                    )}
                  </p>

                  {gapPlan === "proportional" && gapNeedsAPlan ? (
                    <p className="mt-1 text-xs text-ink-500">
                      Each category above will carry its share of the{" "}
                      <Money value={Math.abs(itemGapCentavos) / 100} decimals bare /> when saved.
                    </p>
                  ) : null}
                </div>

                {/*
                  Accounting for the difference.

                  A gap is normal rather than a mistake: a VAT-exclusive
                  register adds tax on top of the printed lines, a discount
                  takes money off, and OCR sometimes just misses one. The old
                  screen offered a single way out — set the receipt total down
                  to the items — which balances the arithmetic by DELETING
                  money the owner really spent. On a receipt totalling 1,120
                  with 1,000 of items, that filed a 1,000 expense.

                  So the owner is asked what the difference actually is. The
                  total they confirmed against the photo is the anchor and
                  never moves on its own; only the last option, for a total
                  OCR misread, changes it, and then only to figures read off
                  the receipt.
                */}
                {everyItemHasCategory && gapNeedsAPlan ? (
                  <fieldset className="mt-3 rounded-xl border border-tone-accent/30 bg-tone-accent/5 p-3">
                    <legend className="px-1 text-xs font-semibold text-ink-700">
                      {itemGapCentavos > 0 ? (
                        <>
                          What is the missing <Money value={itemGapCentavos / 100} decimals bare />?
                        </>
                      ) : (
                        <>
                          What is the extra <Money value={-itemGapCentavos / 100} decimals bare />?
                        </>
                      )}
                    </legend>

                    <p className="mt-1 text-xs leading-relaxed text-ink-500">
                      {itemGapCentavos > 0
                        ? "Receipts often add tax or a service charge on top of the item prices, and sometimes a line just doesn't scan."
                        : "A discount or a voided line usually explains this."}
                    </p>

                    <div className="mt-2 space-y-1.5">
                      <GapOption
                        name="gap-plan"
                        checked={gapPlan === "proportional"}
                        onChange={() => setGapPlan("proportional")}
                        label={itemGapCentavos > 0 ? "Tax or a service charge" : "A discount on the whole receipt"}
                        detail="Split across the categories above, in proportion to what each one came to. Keeps every category's spending accurate."
                      />

                      {canFileGapInOneCategory ? (
                        <GapOption
                          name="gap-plan"
                          checked={gapPlan === "category"}
                          onChange={() => setGapPlan("category")}
                          label="A separate charge to track on its own"
                          detail="Saved as its own expense record under one category."
                        >
                          {gapPlan === "category" ? (
                            <div className="mt-1.5">
                              <label htmlFor="gap-category" className="sr-only">
                                Category for the remaining amount
                              </label>
                              <CategorySelect id="gap-category" value={gapCategoryId} onChange={setGapCategoryId} />
                            </div>
                          ) : null}
                        </GapOption>
                      ) : null}

                      <GapOption
                        name="gap-plan"
                        checked={gapPlan === "shrink"}
                        onChange={() => setGapPlan("shrink")}
                        label="FinSight misread the receipt total"
                        detail={
                          <>
                            Save <Money value={itemsTotalCentavos / 100} decimals bare /> — the items' own
                            total — instead of the amount above.
                          </>
                        }
                      />
                    </div>

                    {/*
                      A missing line is not a category question, so it sits
                      apart from the radios: adding it changes the gap rather
                      than explaining it, and often closes it entirely.
                    */}
                    <button
                      type="button"
                      onClick={addAddedItem}
                      className="tap-inline mt-2.5 border-t border-tone-accent/20 pt-2 text-xs font-medium text-brand-700 transition hover:text-brand-800"
                    >
                      + An item is missing — add it to the list
                    </button>
                  </fieldset>
                ) : null}
              </fieldset>
            ) : !isSplit ? (
              <Field
                label="Category"
                htmlFor="category"
                required
                /*
                  Says plainly that this one was written by the AI.
                  Derived by comparing the field against what was suggested
                  rather than held as a flag, so it disappears by itself the
                  moment the owner picks something else — at which point the
                  value is theirs and calling it AI-suggested would be wrong.
                */
                labelAction={
                  suggestedCategoryId !== null && splits[0]!.categoryId === suggestedCategoryId ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-tint-info px-2 py-0.5 text-[11px] font-medium text-tone-info ring-1 ring-edge-info">
                      <span aria-hidden>✦</span>
                      AI-suggested — check it
                    </span>
                  ) : null
                }
                hint="One receipt often covers more than one kind of spending — split it if this one does."
              >
                <CategorySelect
                  id="category"
                  value={splits[0]!.categoryId}
                  onChange={(id) => updateSplit(0, { categoryId: id })}
                />
              </Field>
            ) : (
              <fieldset>
                <legend className="text-sm font-medium text-ink-700">
                  Split across categories
                  <span className="ml-1 text-tone-danger" title="Required">
                    <span aria-hidden>*</span>
                    <span className="sr-only">(required)</span>
                  </span>
                </legend>
                <p className="mt-1 text-xs leading-relaxed text-ink-500">
                  Every peso on the receipt has to land in a category, so the parts add up to the total
                  you confirmed above.
                </p>

                <ul className="mt-2 space-y-2">
                  {splits.map((split, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <label htmlFor={`split-category-${i}`} className="sr-only">
                          Category for part {i + 1}
                        </label>
                        <CategorySelect
                          id={`split-category-${i}`}
                          value={split.categoryId}
                          onChange={(id) => updateSplit(i, { categoryId: id })}
                        />
                      </div>
                      <div className="w-36 shrink-0">
                        <label htmlFor={`split-amount-${i}`} className="sr-only">
                          Amount for part {i + 1}
                        </label>
                        <MoneyInput
                          id={`split-amount-${i}`}
                          min={0.01}
                          required
                          value={split.amount}
                          onChange={(e) =>
                            updateSplit(i, { amount: e.target.value === "" ? "" : Number(e.target.value) })
                          }
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSplit(i)}
                        aria-label={`Remove part ${i + 1}`}
                        className="tap mt-0.5 h-11 w-9 min-h-0 min-w-0 shrink-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-tone-danger"
                      >
                        <span aria-hidden>×</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <p
                  aria-live="polite"
                  className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${
                    unallocatedCentavos === 0 ? "text-tone-brand" : "text-tone-accent"
                  }`}
                >
                  <span aria-hidden>{unallocatedCentavos === 0 ? "✓" : "⚠"}</span>
                  {unallocatedCentavos === 0 ? (
                    <>The parts add up to the receipt total.</>
                  ) : unallocatedCentavos > 0 ? (
                    <>
                      <Money value={unallocatedCentavos / 100} /> of the total isn't assigned yet.
                    </>
                  ) : (
                    <>
                      The parts are <Money value={-unallocatedCentavos / 100} /> over the receipt total.
                    </>
                  )}
                </p>
              </fieldset>
            )}

            {/* Splitting by hand is for receipts FinSight could NOT itemise. */}
            {!isItemised ? (
              <button
                type="button"
                onClick={addSplit}
                className="tap-inline text-sm font-medium text-brand-700 transition hover:text-brand-800"
              >
                + Add another category
              </button>
            ) : null}

            {isItemised && itemsWereAutoCategorised ? (
              <Callout tone="info">
                <b className="font-semibold">FinSight chose these categories</b> by reading the item names.
                It gets item lines wrong more often than it gets a total wrong, so check each row against
                the photo before saving. Anything you change here is what gets saved.
              </Callout>
            ) : null}

            {confirmError ? <FormError>{confirmError}</FormError> : null}

            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="primary"
                disabled={confirming || !readyToConfirm}
                className="flex-1"
              >
                {confirming
                  ? "Saving…"
                  : (() => {
                      // The label promises the number of RECORDS, which on the
                      // itemised path is the number of category groups — not
                      // the number of items. Fourteen groceries in two
                      // categories save as two expenses, and the button has to
                      // say so or the Records table is a surprise.
                      const n = isItemised ? itemGroups.length : isSplit ? splits.length : 1;
                      return n === 1 ? "Confirm & save expense" : `Confirm & save ${n} expenses`;
                    })()}
              </Button>
              <Button type="button" variant="secondary" onClick={handleRescan}>
                Rescan
              </Button>
            </div>
          </form>
        </Card>

        <Card className="p-4 lg:sticky lg:top-24 lg:self-start">
          {receiptPreview ?? (
            <p className="py-8 text-center text-sm text-ink-400">
              The photo isn't available to show here, but the values below are the ones FinSight read from
              it.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
