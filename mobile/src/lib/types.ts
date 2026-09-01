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
  /**
   * Only GET /auth/me carries this. The sibling writers — PATCH /auth/me and
   * the avatar upload — answer with the bare identity block, so this is
   * optional at the type level rather than a lie the moment a name is saved.
   * AuthContext keeps preferences in their own state for that reason; nothing
   * should read them off `profile`.
   */
  preferences?: UserPreferences;
}

/** The four tour states the server accepts (TOUR_STATUSES in auth.controller.ts). */
export type TourStatus = "not_started" | "in_progress" | "completed" | "skipped";

/**
 * Account-level preferences, stored on the user row and shared across devices.
 *
 * `tourStatus`/`tourStep` are nullable and that null is load-bearing: it means
 * "the server has never been told anything about this account's tour", which is
 * what lets a client push locally stored progress up exactly once instead of
 * having a server default overwrite a tour someone already finished. See
 * lib/tourStorage.ts.
 *
 * Appearance is deliberately NOT here — it is a per-device choice and stays in
 * the keystore (see lib/themeStore.ts).
 */
export interface UserPreferences {
  showDashboardMascotMessage: boolean;
  tourStatus: TourStatus | null;
  tourStep: number | null;
  tourAlwaysShow: boolean;
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

/**
 * Owner-controlled cost-behavior classification — Expense Reduction
 * Opportunities plan §5.2/§15 Phase 5. Uppercase, mirroring the Prisma enum
 * `ExpenseCostBehavior` exactly (see
 * backend/src/controllers/expenseCategory.controller.ts's `costBehaviorSchema`).
 * This is the CATEGORY-record casing; the reduction-opportunity response
 * below uses a separate, lowercase `ExpenseCostBehaviorApi` for the same
 * four values — that casing difference is the backend's own convention, not
 * a mistake here.
 */
export type ExpenseCostBehavior = "FIXED" | "VARIABLE" | "MIXED" | "UNCLASSIFIED";

export interface ExpenseCategory {
  id: number;
  businessProfileId: number;
  name: string;
  description: string | null;
  createdAt: string;
  /**
   * Always present on the server's response — the column defaults new and
   * existing rows to `UNCLASSIFIED` — but optional here so any fixture or
   * test double built before this field existed still type-checks.
   */
  costBehavior?: ExpenseCostBehavior;
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

/**
 * A daily-coverage row's status once an operating schedule exists — Recovery
 * Target Improvement Plan §8.3/§10.5. Adds `"closed"` alongside the original
 * three: a configured closed day is neither above, at, nor below a target,
 * because it never had one.
 */
export type DailyCoverageStatus = DayStatus | "closed";

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
  /** True when there's no expected-monthly-expenses baseline configured yet —
   * every other figure is still arithmetically valid but meaningless, since a
   * zero baseline is missing setup, not a covered target. Optional for older servers. */
  needsSetup?: boolean;

  // ---- Phase 1 additions (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §8.1/§8.2/§9.4/§9.7) ----
  // All optional so older servers/clients keep working unchanged; a later task
  // updates the UI to actually read these.
  /** Explicit status, authoritative over `onTrack`/`needsSetup` once present. */
  status?: RecoveryStatus;
  confidence?: RecoveryConfidence;
  /** Cumulative target allocated to the open days elapsed so far this month. */
  expectedSalesToDate?: number;
  /** Recorded sales minus expected-to-date — positive means ahead of pace. */
  paceVarianceAmount?: number;
  /** Stepping-stone toward the plan's eventual v2 contract — this Phase 1 slice is not yet that full shape. */
  contractVersion?: 1;
  /** IANA timezone identifier the calculation was anchored to. */
  timezone?: string;
  /** YYYY-MM-DD, business-local calendar day this calculation was anchored to. */
  asOfDate?: string;

  // ---- Phase 2 additions (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.2/§8.2) ----
  // Both optional, and both absent/false-shaped on an older server or a
  // profile that has never set up a schedule — approximation mode continues
  // exactly as before in that case (`remainingOperatingDaysIsApproximated`
  // stays true).
  /** True once the owner has configured a weekly operating schedule for this business. */
  operatingScheduleConfigured?: boolean;
  /** Exact count of open days this month, derived from the schedule/overrides — only meaningful when `operatingScheduleConfigured` is true. */
  operatingDaysThisMonth?: number;

  // ---- Phase 3 additions (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §8.2/§9.6/§10.3/§10.5) ----
  // All optional; sum of the two below equals the existing, unchanged `salesThisMonth`.
  /** `salesThisMonth` restricted to reviewStatus "Reviewed" + duplicateStatus "Not a Duplicate". */
  confirmedSalesThisMonth?: number;
  /** `salesThisMonth - confirmedSalesThisMonth` — needs-review OR flagged-duplicate amounts. */
  provisionalSalesThisMonth?: number;
  /** Present when `provisionalSalesThisMonth > 0`; empty array when nothing to warn about. */
  dataWarnings?: Array<"records_pending_review" | "possible_duplicates">;
  /** Direct-action eligibility flags; empty array when nothing missing. */
  setupIssues?: Array<"expected_expenses_missing" | "operating_schedule_missing">;
  /**
   * "Why your target changed" (§10.3) — day-over-day diff of this business's
   * own previous computed target. `null` on the 1st of the month or when
   * setup is incomplete (nothing meaningful to compare against).
   */
  changeSincePreviousDay?: RecoveryChangeSincePreviousDay | null;
}

/** §8.2/§10.3 "Why your target changed" delta shape. */
export interface RecoveryChangeSincePreviousDay {
  /** Peso change in `adjustedDailyTarget` since yesterday; negative means the target got easier. */
  adjustedDailyTargetDelta: number;
  /** Peso change in `salesThisMonth` since yesterday. */
  salesAdded: number;
  remainingOpenDaysDelta: number;
  primaryReason:
    | "sales_added"
    | "open_day_elapsed"
    | "baseline_changed"
    | "schedule_changed"
    | "data_changed"
    | "no_material_change";
}

export type RecoveryStatus =
  | "needs_setup"
  | "no_current_month_data"
  | "data_incomplete"
  | "ahead"
  | "on_pace"
  | "behind"
  | "covered";

export type RecoveryConfidence = "unavailable" | "limited" | "moderate" | "strong";

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

/**
 * Reduction-opportunity contract — Expense Reduction Opportunities plan §8.2.
 *
 * Copied verbatim from the approved plan (docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md).
 * This is the exact shape `GET /insights/reduction-opportunities` returns; keep
 * it in lockstep with the backend contract rather than reshaping it client-side.
 * MIRRORS web/src/lib/types.ts — same fields, same names.
 */
export type ReductionOpportunityType =
  | "CATEGORY_PRESSURE"
  | "FREQUENT_PURCHASE_ACCUMULATION"
  | "RECORD_REVIEW_FIRST";

export interface ReductionOpportunityEvidence {
  currentAmount: number;
  previousAmount: number | null;
  changeAmount: number | null;
  changePercent: number | null;
  expenseSharePercent: number;
  recordCount: number;
  unusualRecordCount: number;
  possibleDuplicateCount: number;
}

/**
 * The category's owner-controlled cost-behavior classification, as returned
 * on the opportunity itself — Phase 5, plan §5.2/§15. LOWERCASE: this is the
 * API-response convention for this endpoint specifically (see
 * `ExpenseCostBehaviorApi` in backend/src/services/reductionOpportunity.service.ts),
 * distinct from the uppercase `ExpenseCostBehavior` a category record itself
 * carries.
 */
export type ExpenseCostBehaviorApi = "fixed" | "variable" | "mixed" | "unclassified";

export interface ReductionOpportunity {
  id: string;
  type: ReductionOpportunityType;
  categoryId: number;
  categoryName: string;
  priority: "high" | "medium" | "low";
  confidence: "strong" | "moderate" | "limited";
  observation: string;
  rationale: string;
  evidence: ReductionOpportunityEvidence;
  /** Never changes eligibility or ranking — evidence/copy only. See ReductionOpportunitiesSection.tsx. */
  costBehavior: ExpenseCostBehaviorApi;
  suggestedChecks: string[];
  relatedRecordIds: number[];
  limitations: string[];
}

/**
 * "Helpful" / "Not relevant" feedback on one card — plan §15 Phase 5.
 * `POST /insights/reduction-opportunities/feedback`. Write-only: resubmitting
 * for the same opportunity is "changing your answer" (the server upserts),
 * so the client never fetches prior feedback before showing the buttons.
 */
export type ReductionOpportunityFeedbackRating = "helpful" | "not_relevant";

export interface ReductionOpportunityFeedbackResult {
  opportunityId: string;
  rating: ReductionOpportunityFeedbackRating;
  createdAt: string;
}

export interface ReductionOpportunityResponse {
  period: {
    days: number;
    start: string;
    end: string;
  };
  dataQuality: {
    status: "sufficient" | "limited" | "insufficient";
    currentRecordCount: number;
    previousRecordCount: number;
    message: string | null;
  };
  opportunities: ReductionOpportunity[];
  detectorVersion: string;
}

/**
 * Reduction-simulation contract — plan §12.2. PHASE 4.
 *
 * `POST /insights/reduction-simulation`. Copied verbatim from the approved
 * plan, same as the opportunity types above — keep in lockstep with the
 * backend contract (backend/src/services/reductionOpportunity.service.ts).
 * MIRRORS web/src/lib/types.ts — same fields, same names.
 *
 * Never carries `availableFunds` anywhere in this shape or in what the client
 * sends: the server derives every baseline figure from the owner's own
 * expense records for the category and period, and this simulation does not
 * touch available funds at all — see §12.1.
 */
export type ReductionSpec = { kind: "percent"; value: number } | { kind: "amount"; value: number };

export interface ReductionSimulationInput {
  businessProfileId: number;
  categoryId: number;
  periodDays: number;
  endDate?: string;
  reduction: ReductionSpec;
}

export interface ReductionSimulation {
  categoryId: number;
  categoryName: string;
  period: { days: number; start: string; end: string };
  categoryExpenses: { before: number; after: number };
  totalExpenses: { before: number; after: number };
  hypotheticalReduction: number;
  requestedReductionPercent: number;
  assumptions: string[];
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
  /** Null on a closed day — see `DailyCoverageStatus`/§8.3. */
  neededTarget: number | null;
  sales: number;
  /** Null on a closed day, same reasoning as `neededTarget`. */
  gap: number | null;
  status: DailyCoverageStatus;
  /** Whether this date is actually open, once a schedule exists. Defaults true when unconfigured (approximation mode). */
  isOperatingDay?: boolean;
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
  /** When this response was computed — lets a client label a cached/stale result. Optional for older servers. */
  computedAt?: string;
  /**
   * Phase 4 addition (plan §10.4) — bounded, month-scoped weekly checkpoints.
   * Optional for older servers.
   */
  weeklyCheckpoints?: RecoveryCheckpoint[];
}

/**
 * The Recovery Target hypothetical scenario — plan §13.2/§15 Phase 5.
 * `POST /insights/recovery-scenario`. `current` is the unchanged, real
 * target (the same shape `loadRecoveryTargets` always returns);
 * `hypothetical` is what the target would be if `expectedMonthlyExpenses`
 * were `assumedExpectedMonthlyExpenses` instead — never persisted, never
 * derived automatically from anything else (not from a reduction
 * simulation, not from actual category spending).
 */
/**
 * Phase 4 addition (plan §10.7/§11 Phase 4) — the server-computed
 * hypothetical-minus-current differences for `RecoveryScenario`, so no
 * client re-derives (and risks disagreeing with) the same subtraction.
 * `estimatedTransactionsPerDay` is ALWAYS `null` today: whether sales
 * references are transaction-level or daily-aggregate imports is an
 * explicitly unresolved plan question (§19 #7), so the server deliberately
 * never guesses rather than showing a misleading number. Optional on the
 * TypeScript side only for older-server tolerance; a Phase-4 server always
 * sends it.
 */
export interface RecoveryScenarioDelta {
  totalCoverageGoal: number;
  remainingTarget: number;
  adjustedDailyTarget: number;
  estimatedTransactionsPerDay: number | null;
  estimatedTransactionsPerDayUnavailableReason: "transaction_provenance_unknown";
}

export interface RecoveryScenario {
  assumedExpectedMonthlyExpenses: number;
  current: RecoveryTargets;
  hypothetical: RecoveryTargets;
  /** Phase 4 addition — see `RecoveryScenarioDelta`. Optional for older servers. */
  delta?: RecoveryScenarioDelta;
  /** Always `false` when present — confirms nothing here was persisted. Optional for older servers. */
  persisted?: false;
}

export type RecoveryCheckpointStatus = "ahead" | "on_pace" | "behind" | "pending";

/**
 * Phase 4 addition (plan §10.4/§11 Phase 4) — one weekly checkpoint on
 * `RecoveryInsight.weeklyCheckpoints`. Checkpoints land on calendar
 * day-of-month 7/14/21/28 plus the month's final day when that isn't
 * already a multiple of 7.
 */
export interface RecoveryCheckpoint {
  /** YYYY-MM-DD, business-local. */
  endDate: string;
  cumulativeTarget: number;
  /** Null when `endDate` is still in the future (a `"pending"` checkpoint). */
  recordedAmount: number | null;
  /** Null exactly when `recordedAmount` is null. */
  variance: number | null;
  status: RecoveryCheckpointStatus;
}

/**
 * Recovery Target notification preferences — plan §7.5/§10.8/§11 Phase 6.
 * `GET`/`PUT /business-profiles/:id/recovery-notification-preferences`.
 *
 * `openDayNoSalesAlertEnabled` and `projectionShortfallAlertEnabled` are
 * settable but currently INERT server-side — their trigger prerequisites
 * (operating-hours data, a shortfall projection) don't exist yet, so a
 * client must never claim they are actively doing anything today.
 */
export interface RecoveryNotificationPreference {
  targetIncreaseAlertEnabled: boolean;
  /** 1-100. */
  targetIncreaseThresholdPercent: number;
  behindThreeDaysAlertEnabled: boolean;
  /** Coming soon — always inert today; see the interface note above. */
  openDayNoSalesAlertEnabled: boolean;
  /** Coming soon — always inert today; see the interface note above. */
  projectionShortfallAlertEnabled: boolean;
  coverageReachedAlertEnabled: boolean;
  /** 24-hour "HH:MM", or null. Set together with `quietHoursEnd` or not at all. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** 1-168 (one week). */
  minHoursBetweenNotifications: number;
}

/**
 * A saved Recovery Plan — plan §7.5/§10.7/§11 Phase 6.
 * `GET`/`PUT`/`DELETE /business-profiles/:id/recovery-plans[/:month]`.
 *
 * CRITICAL: purely a separate, owner-visible planning artifact. It has zero
 * effect on the real Recovery Target calculation — never read by
 * `RecoveryInsight`/`RecoveryScenario`, and UI copy must never imply saving
 * one changes the real target, the business profile, or recorded sales.
 */
export interface RecoveryPlan {
  /** "YYYY-MM". */
  month: string;
  bufferPercent: number | null;
  /** "YYYY-MM-DD", or null. */
  deadline: string | null;
  ownerTargetAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Recovery Target month-end review — plan §10.9/§11 Phase 7.
 * `GET /insights/recovery/month-end-review?businessProfileId=<id>&month=YYYY-MM`.
 *
 * `status: "not_yet_reviewable"` covers both the current in-progress month
 * and any future month — the server never computes a partial/misleading
 * summary for either. Everything else is only present once `status` is
 * `"reviewable"`.
 *
 * CRITICAL: `suggestedQuestionsForNextMonth` are informational strings only.
 * There is no apply/accept mechanism anywhere in this feature — a client
 * must never let tapping a suggestion change `expectedMonthlyExpenses`,
 * `operatingDays`, or any other setting. The only acceptable call-to-action
 * is a plain link to the business-profile edit screen.
 */
export type RecoveryMonthEndReview =
  | { status: "not_yet_reviewable"; month: string }
  | {
      status: "reviewable";
      /** "YYYY-MM". */
      month: string;
      coveragePercent: number;
      /** Positive = surplus, negative = shortfall. */
      surplusOrShortfall: number;
      /** Null only when there were truly zero open days this month. */
      strongestOpenDay: { date: string; sales: number } | null;
      weakestOpenDay: { date: string; sales: number } | null;
      /** Combined missing + provisional day count, out of `openDayCount`. */
      missingOrProvisionalDayCount: number;
      openDayCount: number;
      originalDailyTarget: number;
      /** Null for the one edge case with no meaningful per-day rate — see the backend's own doc comment on `computeMonthEndReview`. */
      finalAdjustedDailyTarget: number | null;
      /** An honest signal only — never a suggested replacement number. */
      baselineAppearsOffFromPattern: boolean;
      /** 2-4 plain, deterministic strings, already fully composed server-side. Read-only — never wire a per-question action that mutates a setting. */
      suggestedQuestionsForNextMonth: string[];
      operatingScheduleConfigured: boolean;
    };

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
