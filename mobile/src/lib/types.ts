/**
 * API response types.
 *
 * Hand-kept in sync with web/src/lib/types.ts — both clients consume the same
 * endpoints, so the shapes must not diverge. There is no shared codegen, so
 * "in sync" means a human copied a change across; `node
 * scripts/check-type-parity.mjs` (from the repo root) is the tripwire that
 * catches an exported type/interface existing on one side and not the other.
 * It does not check field-level shape, so review the diff on both files when
 * you touch either one. A handful of types are platform-only (e.g. the
 * cashflow types below, which back a mobile-only chart) and are listed in
 * that script's EXEMPT set with the reason.
 */

export interface Profile {
  id: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string;
  phoneNumber: string | null;
  status: string;
  /** A public URL for the owner's photo, or null if they haven't set one. */
  avatarUrl: string | null;
  createdAt: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  [key: string]: unknown;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  phoneNumber?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface UpdateProfileInput {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  phoneNumber?: string | null;
}

export interface BusinessProfile {
  id: number;
  name: string;
  type: string;
  availableFunds: number;
  expectedMonthlyExpenses: number;
  operatingDays: number;
  largeExpenseThresholdPercent: number;
  /** A public URL for the business logo, or null if none was uploaded. */
  logoUrl: string | null;
  createdAt: string;
  /** Null when active. Archiving hides a business without deleting anything. */
  archivedAt: string | null;
  isArchived: boolean;
  /** Expense + sales reference records combined. */
  recordCount: number;
}

export interface BusinessProfileInput {
  name: string;
  type: string;
  availableFunds: number;
  expectedMonthlyExpenses: number;
  operatingDays: number;
  largeExpenseThresholdPercent: number;
}

export interface ExpenseCategory {
  id: number;
  businessProfileId: number;
  name: string;
  description: string | null;
  createdAt: string;
}

export type ReviewStatus = "Reviewed" | "Needs Review";
export type DuplicateStatus = "Not a Duplicate" | "Flagged";

export interface RecordItem {
  id: number;
  type: "expense" | "sales";
  businessProfileId: number;
  categoryId?: number;
  receiptScanId?: number | null;
  importBatchId?: number | null;
  duplicateOfRecordId: number | null;
  date: string;
  description: string;
  vendor?: string | null;
  amount: number;
  /**
   * The part of `amount` that is this record's share of receipt-level tax,
   * service charge or discount rather than the price of its own items.
   * Signed — negative for a discount. Null when the receipt reconciled
   * exactly, and on records predating the column.
   */
  allocatedCharges?: number | null;
  source: string;
  reviewStatus: ReviewStatus;
  duplicateStatus: DuplicateStatus;
  largeExpenseFlag?: boolean;
  createdAt: string;
}

/** One line read off a receipt (or typed in by the owner) on a saved record. */
export interface RecordOriginItem {
  id: number;
  lineNumber: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  categoryId: number | null;
  categoryName: string | null;
  /** True when the owner typed this line in rather than FinSight reading it. */
  addedByOwner: boolean;
  /**
   * True when AI read this line off the receipt photograph because OCR could
   * read no text. Distinct from an OCR-read line, and kept on the saved
   * record so the distinction outlives the confirm screen.
   */
  extractedByVision?: boolean;
}

/**
 * Where a record came from, returned only by the single-record endpoint.
 *
 * `null` for a hand-typed record — there is nothing behind it but what the
 * owner entered, and showing an empty "where this came from" panel would be
 * noise on the common case.
 */
export type RecordOrigin =
  | {
      kind: "receipt_scan";
      scanId: number;
      scannedAt: string;
      extractedVendor: string | null;
      /** A short-lived signed link. Null when it couldn't be minted. */
      imageUrl: string | null;
      items: RecordOriginItem[];
      itemsSubtotal: number;
      siblings: {
        id: number;
        description: string;
        amount: number;
        categoryId: number;
        categoryName: string;
      }[];
    }
  | {
      kind: "csv_import";
      batchId: number;
      title: string;
      uploadDate: string;
      fileReference: string;
      /** A short-lived signed download link. Null when it couldn't be minted. */
      fileUrl: string | null;
      status: string;
      rowCount: number;
    };

/** A single record fetched on its own, which carries its provenance. */
export interface RecordDetail extends RecordItem {
  origin: RecordOrigin | null;
}

/** A past CSV import, for the "which import" picker on the Records filters. */
export interface ImportBatchSummary {
  id: number;
  title: string;
  uploadDate: string;
  status: string;
}

/** The shape GET /records/csv-imports/batches/:batchId/preview returns. */
export interface CsvBatchPreview {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
}

// ============================================================
// CSV import lifecycle (ADR-3)
// ============================================================

/** The date conventions the owner may state. "month-name" is detected only —
 *  a month spelled out cannot be ambiguous, so it is never a choice. */
export type CsvDateFormat = "iso" | "dmy" | "mdy" | "month-name";
export type CsvConfirmDateFormat = "iso" | "dmy" | "mdy";

/** How far the server has got WRITING an import — separate from the owner-facing
 *  review `status`, exactly as receipt scans separate the two. */
export type CsvProcessingStatus = "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";

/** GET /records/csv-imports/batches/:batchId/status. Safe to poll — not rate limited. */
export interface CsvImportStatus {
  batchId: number;
  status: string;
  processingStatus: CsvProcessingStatus;
  totalRows: number;
  processedRows: number;
  importedRows: number;
  skippedRows: number;
  flaggedRows: number;
  /** Which stage failed, when it did: "upload" | "validate" | "insert" | … */
  failureStage: string | null;
  /**
   * Everything the synchronous response reports that isn't an Int column,
   * accumulated across chunks by the worker so a resumed import still adds up.
   */
  resultSummary: {
    importedExpenses?: number;
    importedSales?: number;
    largeExpenseFlagged?: number;
    uncategorised?: number;
    skipped?: { row: number; reason: string }[];
    skippedTruncated?: boolean;
  } | null;
}

export interface ExpenseRecordInput {
  businessProfileId: number;
  categoryId: number;
  date: string;
  description: string;
  vendor?: string;
  amount: number;
}

export interface SalesRecordInput {
  businessProfileId: number;
  date: string;
  description: string;
  amount: number;
}

export type RecordSource = "MANUAL_ENTRY" | "CSV_UPLOAD" | "RECEIPT_SCAN";

export const RECORD_SOURCE_LABELS: Record<RecordSource, string> = {
  MANUAL_ENTRY: "Manual Entry",
  CSV_UPLOAD: "CSV Upload",
  RECEIPT_SCAN: "Receipt Scan",
};

export interface RecordFilters {
  businessProfileId: number;
  type?: "expense" | "sales" | "all";
  categoryId?: number;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  source?: RecordSource;
}

export interface Notification {
  id: number;
  businessProfileId: number;
  message: string;
  type: string;
  dateCreated: string;
  readStatus: boolean;
}

export interface DashboardSummary {
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  overview: {
    availableFunds: number;
    totalExpenses: number;
    totalSalesReference: number;
  };
  expenseCategoryBreakdown: {
    categoryId: number;
    categoryName: string;
    total: number;
    percent: number;
  }[];
  recoveryStatus: RecoveryTargets;
  recordsNeedingReview: number;
  alerts: Notification[];
  /**
   * What this business has EVER recorded, outside the period selector.
   *
   * The screen asks two different questions and only had period data to answer
   * both: "what happened lately" and "is there anything here at all". Optional
   * because an older server will not send it.
   */
  lifetime?: {
    recordCount: number;
    /** ISO date of the most recent record, or null for a business with none. */
    latestRecordDate: string | null;
  };
}

export type CashflowGranularity = "daily" | "monthly";

/** One day's or one month's money in vs money out — a row of the cashflow chart. */
export interface CashflowPoint {
  date: string;
  sales: number;
  expenses: number;
}

export interface DashboardCashflow {
  granularity: CashflowGranularity;
  points: CashflowPoint[];
}

export type DayStatus = "above" | "at" | "below";

// Month-to-date recovery tracker. Shared verbatim by the Dashboard summary
// and the Insights Recovery Target screen — both read the same computed
// object from the backend, so they can't disagree.
export interface RecoveryTargets {
  expectedMonthlyExpenses: number;
  operatingDays: number;
  dailyNeededTarget: number;
  salesThisMonth: number;
  remainingTarget: number;
  daysInMonth: number;
  calendarDaysLeftInMonth: number;
  remainingOperatingDays: number;
  remainingOperatingDaysIsApproximated: boolean;
  adjustedDailyTarget: number;
  todaysTarget: number;
  todaysSales: number;
  todaysGap: number;
  todaysStatus: DayStatus;
  monthCoveragePercent: number;
  onTrack: boolean;
}

export interface CategoryTrend {
  categoryId: number;
  categoryName: string;
  current: number;
  previous: number;
  direction: "up" | "down" | "flat";
  percentChange: number | null;
}

export interface UnusualExpense {
  id: number;
  description: string;
  amount: number;
  date: string;
  categoryId: number;
  categoryName: string;
  zScore: number;
  categoryMean: number;
  categoryStdDev: number;
}

/** One day's expense total, for the spending trend. */
export interface DailyExpenseTotal {
  date: string;
  total: number;
  count: number;
}

export interface ExpenseBehavior {
  periodStart: string;
  periodEnd: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
  /**
   * Daily totals across the period. The endpoint has always returned these —
   * mobile's copy of the type simply never declared them, so the data arrived
   * and was thrown away. Web has charted them all along.
   */
  dailyTotals: DailyExpenseTotal[];
  /**
   * Period totals, summed SERVER-SIDE so every surface shows the same figure.
   *
   * Declared here for the same reason `dailyTotals` was: the endpoint has
   * always returned it and web has always used it, and mobile's copy of the
   * type simply never said so — which meant the figure arrived on every
   * request and was discarded, while the screen had nothing to headline.
   */
  totals: { current: number; previous: number };
  categoryTrends: CategoryTrend[];
  unusualExpenses: UnusualExpense[];
  insufficientHistoryCategories: { categoryId: number; categoryName: string; historyCount: number }[];
  /**
   * The most recent expense this business has, independent of the window above.
   *
   * Lets an empty period tell "you have never recorded an expense" apart from
   * "you have plenty, just none lately" — opposite situations that produced an
   * identical screen and identical, wrong advice. Optional for older servers.
   */
  latestExpenseDate?: string | null;
}

export type AnomalyFindingStatus = "OPEN" | "CONFIRMED" | "DISMISSED" | "RESOLVED" | "SUPERSEDED";
export type AnomalyFindingFeedback = "CONFIRMED_UNUSUAL" | "EXPECTED_TRANSACTION" | "DUPLICATE" | "INCORRECT_MATCH" | "NO_LONGER_RELEVANT";

/**
 * The detector types a finding card can be handed.
 *
 * ML_OUTLIER is the Isolation Forest detector's own member (ADR-1/ADR-4). It
 * is listed because the card must render one if it ever arrives, NOT because
 * one is expected today: that detector writes SHADOW-status findings and
 * `listFindings` excludes SHADOW server-side, so this client never sees them
 * until promotion out of shadow is a deliberate release decision.
 */
export type AnomalyFindingType =
  | "AMOUNT_OUTLIER"
  | "POSSIBLE_DUPLICATE"
  | "VELOCITY_ANOMALY"
  | "RECURRING_CHANGE"
  | "TREND_CHANGE"
  | "BEHAVIORAL_NOVELTY"
  | "ML_OUTLIER";

/** Whatever the detector recorded as evidence. Shapes differ per detector, so
 *  the queue reads it defensively and never requires a particular key. */
export type AnomalyFindingMetadata = Record<string, unknown> | null;

export interface AnomalyFinding {
  id: number;
  expenseRecordId: number | null;
  type: AnomalyFindingType;
  severity: "LOW" | "MEDIUM" | "HIGH";
  /**
   * The detector's own raw number. NEVER the primary cue on screen — ADR-4
   * forbids showing a model score as the explanation; it only ever breaks a
   * tie inside `findingSignalStrength`.
   */
  score: number | null;
  title: string;
  reasons: string[];
  status: AnomalyFindingStatus;
  detectedAt: string;
  /** What the owner already said about it, when they have said something. */
  feedback?: AnomalyFindingFeedback | null;
}

export interface AnomalyFindingPage { items: AnomalyFinding[]; nextCursor: number | null; }

export interface RecurringPattern {
  id: number; description: string; vendor: string | null; intervalDays: number;
  expectedAmount: number; confidence: number; nextExpectedDate: string;
  status: "CANDIDATE" | "CONFIRMED" | "DISMISSED" | "DISABLED";
  category: { name: string };
}

/**
 * Where a schedule sits relative to today, as the SERVER computed it.
 *
 * Never derived on the client. Web and mobile both group the agenda by this,
 * and two independent implementations of "is it due soon" drift the moment one
 * of them is edited — the same bill would then sit under "Due soon" on the
 * phone and under "Later" on the laptop. One rule, one place, shipped in the
 * payload.
 */
export type RecurringDueState = "OVERDUE" | "DUE_SOON" | "SCHEDULED";

/**
 * A repeating payment the OWNER declared, as opposed to `RecurringPattern`
 * above, which is one FinSight noticed and is only ever a candidate to review.
 *
 * The distinction is the whole point of the two shapes existing: a pattern is
 * an inference and carries `confidence`; a schedule is a fact, is editable,
 * and is what the watchdog actually watches.
 */
export interface RecurringSchedule {
  id: number;
  businessProfileId: number;
  categoryId: number;
  categoryName: string;
  /** What the owner calls this payment. */
  label: string;
  vendor: string | null;
  intervalDays: number;
  expectedAmount: number;
  /** A fraction of the amount, 0..1 — how far it may move before it is a change. */
  amountTolerance: number;
  /**
   * A date-only value. Serialized from a `@db.Date`, so it arrives as
   * midnight UTC and MUST be rendered with `timeZone: "UTC"` or it shows the
   * previous day anywhere behind UTC. See lib/recurringAgenda.ts.
   */
  nextDueDate: string;
  /** Detector-maintained tracking only; the owner never sets this. */
  lastRecordedDate: string | null;
  /** False means paused — watched by nobody, but not deleted. */
  isActive: boolean;
  /** The pattern this was promoted from, when it came from one. Provenance only. */
  sourcePatternId: number | null;
  dueState: RecurringDueState;
  createdAt: string;
  updatedAt: string;
}

export interface DailyCoverageRow {
  date: string;
  neededTarget: number;
  sales: number;
  gap: number;
  status: DayStatus;
}

export interface RecoveryInsight extends RecoveryTargets {
  monthStart: string;
  today: string;
  coverageDays: number;
  dailyCoverage: DailyCoverageRow[];
  /**
   * True when not one sale is recorded in the month this screen reports on.
   *
   * Recovery is month-to-date with no period selector, so imported history that
   * stops months ago shows zero sales against the full monthly target — reading
   * as "you are catastrophically behind" for a month the owner never traded in.
   * Optional for older servers.
   */
  monthHasNoRecords?: boolean;
  /** The most recent sale on file, so an empty month can point at where the data is. */
  latestSaleDate?: string | null;
}

export type ImpactBand = "Low Impact" | "Noticeable Impact" | "High Impact";

export interface SpendingImpact {
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  plannedAmount: number;
  thresholdPercent: number;
  thresholdAmount: number;
  percentOfFunds: number;
  impactBand: ImpactBand;
  exceedsFunds: boolean;
  funds: { before: number; after: number };
  periodExpenses: { before: number; after: number };
  availableFunds: number;
  resultingFunds: number;
}

/**
 * Spending Impact's read of the ITEM, alongside its read of the money.
 *
 * `kind` is the bookkeeping question in the owner's language rather than an
 * accountant's: something the business keeps and uses, or something used up
 * that has to be bought again. `questions` are for the owner to answer — the
 * server refuses any answer that crosses from asking into advising, so a card
 * that renders is a card that only describes and asks. See
 * backend/src/services/ai.service.ts.
 */
export type PurchaseKind = "asset" | "running-cost" | "mixed" | "unclear";

export interface PurchaseReview {
  kind: PurchaseKind;
  kindReason: string;
  businessUse: string;
  ongoingCosts: string | null;
  /**
   * What to CHECK about the price — never what the price should be. The server
   * drops anything that names a figure or calls the amount fair, cheap or
   * steep: FinSight has no price feed, and the "is this normal for me" half is
   * answered by `PurchasePriceContext` below, from the owner's own records.
   */
  priceCheck: string | null;
  questions: string[];
}

/**
 * The planned amount against what this owner has actually paid.
 *
 * Every figure here is arithmetic over their own expense records — no model
 * sees them and no model produces them, which is why this half of the answer
 * still stands when the AI is unreachable.
 */
export type PriceComparison = "no-history" | "no-amount" | "below" | "in-line" | "above" | "far-above";

export interface SimilarPurchase {
  description: string;
  amount: number;
  date: string;
  categoryName: string;
}

export interface PurchasePriceContext {
  categoryId: number | null;
  categoryName: string | null;
  recordCount: number;
  /** The median, which one outlier cannot drag around. */
  typicalAmount: number | null;
  smallestAmount: number | null;
  largestAmount: number | null;
  multipleOfTypical: number | null;
  comparison: PriceComparison;
  similar: SimilarPurchase[];
  windowDays: number;
}

export type InteractionModule = "Expense Insights" | "Spending Impact" | "Recovery Target" | "Dashboard";

export interface AIInteraction {
  id: number;
  module: InteractionModule;
  question: string;
  answer: string;
  timestamp: string;
}

export interface AskResponse extends AIInteraction {
  provider: "gemini" | "openrouter" | "unavailable";
  detectedAmount: number | null;
}

/**
 * Named conversations, which is what Ask FinSight actually talks to now.
 *
 * The two above describe the OLD per-module log — `/ai/ask` and `/ai/history`,
 * which the backend still serves and which nothing in the sheet calls any
 * more. Where an AIInteraction was one row in an implicit append-only log, a
 * ChatMessage is one half of an exchange inside a named thread.
 */

/** A conversation as it appears in the history list — no messages. */
export interface Conversation {
  id: number;
  title: string;
  /** Where the thread started. Metadata only — a conversation is not bound to it. */
  originModule: InteractionModule;
  createdAt: string;
  lastMessageAt: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** `GET /ai/conversations/:id` — the conversation plus its messages, oldest first. */
export interface ConversationDetail extends Conversation {
  messages: ChatMessage[];
}

/**
 * The shared response of both send routes — `POST /ai/conversations` (which
 * lazily creates the thread) and `POST /ai/conversations/:id/messages`.
 *
 * `provider` and `detectedAmount` are carried through from the existing ask
 * path unchanged, so the sheet can show the same "AI is unreachable" banner and
 * the same parsed-amount disclosure it always did.
 */
export interface ChatSendResponse {
  conversation: Conversation;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  provider: "gemini" | "openrouter" | "unavailable";
  detectedAmount: number | null;
}

export interface CategorySuggestion {
  categoryId: number;
  categoryName: string;
}
