export interface Profile {
  id: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
  email: string;
  phoneNumber: string | null;
  status: string;
  avatarUrl: string | null;
  createdAt: string;
  /**
   * Only GET /auth/me carries this. The sibling writers — PATCH /auth/me and
   * the avatar upload — deliberately answer with the bare identity block, so
   * this is optional at the type level rather than a lie the moment a name is
   * saved. AuthContext keeps preferences in their own state for that reason;
   * nothing should read them off `profile`.
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
 * Theme is deliberately NOT here — it is a per-device choice and stays in
 * localStorage (see ThemeContext).
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
 * Owner-controlled cost-behavior classification on `ExpenseCategory` — plan
 * §5.2/§15 Phase 5. Uppercase, matching the Prisma enum `ExpenseCostBehavior`
 * exactly, the same convention `costBehaviorSchema` uses server-side
 * (backend/src/controllers/expenseCategory.controller.ts). Contrast with
 * `ReductionOpportunity.costBehavior` below, which is lowercase — that
 * response follows this file's existing lowercase convention for
 * `priority`/`confidence`/etc. instead.
 */
export type ExpenseCostBehavior = "FIXED" | "VARIABLE" | "MIXED" | "UNCLASSIFIED";

export interface ExpenseCategory {
  id: number;
  businessProfileId: number;
  name: string;
  description: string | null;
  createdAt: string;
  /** Optional everywhere — omitted/undefined reads the same as "UNCLASSIFIED". */
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
  /** Which expense record this is about, when it's about one specific
   * record (a duplicate or large-expense flag) rather than a batch summary
   * (a finished CSV import covering several rows). */
  expenseRecordId: number | null;
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
   * The page asks two different questions and only had period data to answer
   * both: "what happened lately" (everything above) and "is there anything
   * here at all" (the setup checklist, the empty state). Optional because an
   * older server will not send it.
   */
  lifetime?: {
    recordCount: number;
    /** ISO date of the most recent record, or null for a business with none. */
    latestRecordDate: string | null;
  };
}

export type DayStatus = "above" | "at" | "below";

/**
 * `DailyCoverageRow.status` once an operating schedule is configured — plan
 * §8.3. A superset of `DayStatus` rather than reusing it directly: every
 * existing `DayStatus` call site (the scenario summaries, `todaysStatus`)
 * only ever sees the original three values, and widening `DayStatus` itself
 * would force each of those to handle a `"closed"` case that can never
 * actually reach them.
 */
export type DailyRowStatus = DayStatus | "closed";

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

  // ---- Phase 2 additions (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §7.2-§7.4/§8.3) ----
  /** True once the owner has saved a weekly operating schedule for this business.
   * False (the default) means every day-count figure above is still the old
   * approximation — see `remainingOperatingDaysIsApproximated`. Optional for
   * older servers that predate schedules entirely. */
  operatingScheduleConfigured?: boolean;
  /** Exact count of open dates this month, derived from the schedule/overrides.
   * Only meaningful once `operatingScheduleConfigured` is true. */
  operatingDaysThisMonth?: number;

  // ---- Phase 3 additions (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.1-§10.3/§8.2) ----
  // All optional so older servers/cached responses keep working unchanged.
  /** `salesThisMonth`'s reviewed-and-not-flagged share. Sums with
   * `provisionalSalesThisMonth` to `salesThisMonth`. */
  confirmedSalesThisMonth?: number;
  /** `salesThisMonth`'s pending-review or possible-duplicate share. */
  provisionalSalesThisMonth?: number;
  /** Missing setup that would improve confidence but does not itself trigger
   * `needs_setup` — e.g. no operating schedule saved yet. Empty when nothing
   * to flag. */
  setupIssues?: Array<"expected_expenses_missing" | "operating_schedule_missing">;
  /** Data-quality caveats affecting the figures already shown above — never a
   * silent recalculation. Empty when nothing to flag. */
  dataWarnings?: Array<"records_pending_review" | "possible_duplicates">;
  /** Deterministic explanation of what moved the adjusted daily target since
   * the previous local day. `null` on the 1st of the month, when setup is
   * incomplete, or (per its own `primaryReason`) when nothing material moved. */
  changeSincePreviousDay?: {
    adjustedDailyTargetDelta: number;
    salesAdded: number;
    remainingOpenDaysDelta: number;
    primaryReason:
      | "sales_added"
      | "open_day_elapsed"
      | "baseline_changed"
      | "schedule_changed"
      | "data_changed"
      | "no_material_change";
  } | null;
}

/**
 * One weekday's open/closed setting — `GET`/`PUT
 * /business-profiles/:id/operating-schedule`. 1=Monday .. 7=Sunday, matching
 * the backend's `BusinessOperatingDay.weekday` convention exactly so no
 * client-side remapping is needed.
 */
export interface OperatingScheduleEntry {
  weekday: number;
  isOpen: boolean;
}

export type OperatingDayOverrideType = "OPEN" | "CLOSED";

/**
 * A single date exception — a holiday closure or a special opening —
 * `GET`/`POST`/`DELETE /business-profiles/:id/operating-overrides`. Takes
 * precedence over the weekly schedule for that one date.
 */
export interface OperatingDayOverride {
  id: number;
  businessProfileId: number;
  date: string;
  type: OperatingDayOverrideType;
  reason: string | null;
}

export interface OperatingDayOverrideInput {
  date: string;
  type: OperatingDayOverrideType;
  /** Owner-entered context only — never treated as financial evidence. Max 120 chars. */
  reason?: string;
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

/**
 * `POST /insights/recovery-scenario` — plan §13.2/§15 Phase 5. A read-only,
 * non-persisting "what if expected monthly expenses were X" scenario — the
 * ONLY valid Recovery Target hypothetical per the plan. `current` is the
 * real, currently-configured target (unchanged); `hypothetical` is what it
 * would be under the owner-supplied assumption. Neither writes anything —
 * see insights.service.ts `simulateRecoveryScenario`.
 */
/**
 * Comparisons between `current` and `hypothetical` — plan §8.4/§9.9, Phase 4.
 * Optional so an older server response (predating this field) still renders.
 */
export interface RecoveryScenarioDelta {
  /**
   * `hypothetical.expectedMonthlyExpenses - current.expectedMonthlyExpenses`.
   * No safety-buffer feature exists yet, so this is currently the same
   * quantity as the expected-monthly-expenses delta itself.
   */
  totalCoverageGoal: number;
  remainingTarget: number;
  adjustedDailyTarget: number;
  /**
   * ALWAYS `null` for now — the backend cannot yet tell whether sales
   * references are transaction-level or daily aggregates (plan §9.9/§19 #7),
   * so it deliberately never guesses. See
   * `estimatedTransactionsPerDayUnavailableReason`.
   */
  estimatedTransactionsPerDay: number | null;
  /** Why `estimatedTransactionsPerDay` is null. */
  estimatedTransactionsPerDayUnavailableReason: "transaction_provenance_unknown";
}

export interface RecoveryScenario {
  /** The explicit hypothetical the owner supplied — never derived automatically. */
  assumedExpectedMonthlyExpenses: number;
  /** Unchanged passthrough of the real, currently-configured target. */
  current: RecoveryTargets;
  /** What the target would be if `expectedMonthlyExpenses` were the assumed value. Not saved anywhere. */
  hypothetical: RecoveryTargets;
  /** Phase 4 addition — optional for older servers. */
  delta?: RecoveryScenarioDelta;
  /** Always `false` when present — confirms nothing here was persisted. Optional for older servers. */
  persisted?: false;
}

/**
 * `GET`/`PUT /business-profiles/:id/recovery-notification-preferences` — plan
 * §7.5/§10.8/§11 Phase 6. Purely owner-controlled opt-in settings for the
 * Recovery Target notification triggers; GET returns sensible defaults (all
 * enabled, 15% threshold, no quiet hours, 24h cooldown) even before the owner
 * has ever saved anything — there is nothing to "initialize" first.
 *
 * Two triggers this type represents (`openDayNoSalesAlertEnabled`,
 * `projectionShortfallAlertEnabled`) are permanently inert server-side for
 * now — missing prerequisite capabilities — so the toggle can be shown and
 * saved, but the UI must not claim they are currently doing anything.
 */
export interface RecoveryNotificationPreference {
  targetIncreaseAlertEnabled: boolean;
  /** 1-100. Only meaningful while `targetIncreaseAlertEnabled` is true. */
  targetIncreaseThresholdPercent: number;
  behindThreeDaysAlertEnabled: boolean;
  /** Inert server-side for now — see the note above. */
  openDayNoSalesAlertEnabled: boolean;
  /** Inert server-side for now — see the note above. */
  projectionShortfallAlertEnabled: boolean;
  coverageReachedAlertEnabled: boolean;
  /** "HH:MM" wall-clock, or `null`. Both-or-neither with `quietHoursEnd`. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** 1-168 (one week). */
  minHoursBetweenNotifications: number;
}

/**
 * `GET`/`PUT`/`DELETE /business-profiles/:id/recovery-plans[/:month]` — plan
 * §7.5/§10.7/§11 Phase 6.
 *
 * CRITICAL: purely a separate, owner-visible planning artifact. It has ZERO
 * effect on the real Recovery Target calculation — never imply in UI copy
 * that saving a plan changes the real target, the business profile, or any
 * recorded sales.
 */
export interface RecoveryPlan {
  /** "YYYY-MM" */
  month: string;
  bufferPercent: number | null;
  /** "YYYY-MM-DD" */
  deadline: string | null;
  ownerTargetAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryTrend {
  categoryId: number;
  categoryName: string;
  current: number;
  previous: number;
  direction: "up" | "down" | "flat";
  percentChange: number | null;
  /** Number of expense records in the current period. */
  recordCount: number;
  /** Absolute peso movement — `current - previous`. */
  change: number;
}

/** One day of the period. Days with no spending are present with total 0. */
export interface DailyExpenseTotal {
  date: string;
  total: number;
  count: number;
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

export interface ExpenseBehavior {
  periodStart: string;
  periodEnd: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
  periodDays: number;
  /** Period totals, summed server-side so every surface shows the same figure. */
  totals: { current: number; previous: number };
  dailyTotals: DailyExpenseTotal[];
  categoryTrends: CategoryTrend[];
  unusualExpenses: UnusualExpense[];
  insufficientHistoryCategories: { categoryId: number; categoryName: string; historyCount: number }[];
  /**
   * The most recent expense this business has, independent of the window above.
   *
   * Lets an empty period distinguish "you have never recorded an expense" from
   * "you have plenty, just none lately" — opposite situations that produced an
   * identical screen, and identical (wrong) advice. Optional for older servers.
   */
  latestExpenseDate?: string | null;
}

/**
 * Reduction-opportunity contract — Expense Reduction Opportunities plan §8.2.
 *
 * Copied verbatim from the approved plan (docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md).
 * This is the exact shape `GET /insights/reduction-opportunities` returns; keep
 * it in lockstep with the backend contract rather than reshaping it client-side.
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
 * The category's owner-controlled cost-behavior classification — plan
 * §5.2/§15 Phase 5. Evidence/copy only: it never changes eligibility or
 * ranking (§4.2 "review, not verdict"). Lowercase — see the note on
 * `ExpenseCostBehavior` above for why this response's casing differs from
 * `/records/categories`'.
 */
export type ReductionOpportunityCostBehavior = "fixed" | "variable" | "mixed" | "unclassified";

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
  costBehavior: ReductionOpportunityCostBehavior;
  suggestedChecks: string[];
  relatedRecordIds: number[];
  limitations: string[];
}

/**
 * `POST /insights/reduction-opportunities/feedback` — plan §15 Phase 5. A
 * lightweight, write-only "was this useful?" signal on a card that is itself
 * computed-not-persisted (§4.4). The backend upserts by
 * (businessProfileId, opportunityId, userId), so re-submitting is "change my
 * answer", never an error — there is no read-back endpoint, so clients must
 * not assume prior feedback state on load.
 */
export type ReductionOpportunityFeedbackRating = "helpful" | "not_relevant";

export interface ReductionOpportunityFeedbackInput {
  businessProfileId: number;
  opportunityId: string;
  rating: ReductionOpportunityFeedbackRating;
}

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
 * Reduction-simulation contract — plan §12.2. `POST /insights/reduction-simulation`.
 *
 * A hypothetical "what if this category's expenses were lower" read, not a
 * change to any record: nothing here is persisted, and `availableFunds` is
 * never part of this contract (see reductionOpportunity.service.ts). Copied
 * verbatim from the approved plan, same discipline as `ReductionOpportunity`
 * above — keep in lockstep with the backend rather than reshaping client-side.
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
 * The detector types the review queue can be handed.
 *
 * ML_OUTLIER is the Isolation Forest detector's own member (ADR-1/ADR-4). It
 * is listed here because the queue must render one if it ever arrives, NOT
 * because one is expected today: that detector writes SHADOW-status findings,
 * and `listFindings` excludes SHADOW server-side, so this client never sees
 * them until promotion out of shadow is a deliberate release decision.
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
  score: number | null;
  title: string;
  reasons: string[];
  status: AnomalyFindingStatus;
  detectedAt: string;
  /** The detector that produced it, e.g. "zscore-iqr". Audit view only. */
  method?: string;
  /** The detector's own version string. Audit view only. */
  detectorVersion?: string;
  metadata?: AnomalyFindingMetadata;
  feedback?: AnomalyFindingFeedback | null;
}

export interface AnomalyFindingPage {
  items: AnomalyFinding[];
  nextCursor: number | null;
}

export interface RecurringPattern {
  id: number;
  description: string;
  vendor: string | null;
  intervalDays: number;
  expectedAmount: number;
  confidence: number;
  nextExpectedDate: string;
  /**
   * No DISABLED here on purpose. The Prisma enum still carries the value, but
   * nothing on the server ever writes it and the review endpoint's schema now
   * rejects it with a 400 — so a client modelling it would be offering a
   * status the API refuses. Pausing lives on RecurringSchedule.isActive.
   */
  status: "CANDIDATE" | "CONFIRMED" | "DISMISSED";
  category: { name: string };
}

/**
 * Where a schedule sits relative to today.
 *
 * COMPUTED ON THE SERVER (recurringSchedule.service.ts `dueStateOf`) and shipped
 * in the payload. Web and mobile both group the agenda by this, and two
 * independent implementations of "is it due soon" drift the moment one is
 * edited — the same bill would then sit in "Due soon" on the phone and in
 * "Scheduled" on the laptop. Never recompute it here.
 */
export type RecurringDueState = "OVERDUE" | "DUE_SOON" | "SCHEDULED";

/**
 * An owner-declared repeating payment — "I told FinSight this repeats".
 *
 * Distinct from RecurringPattern above, which is the detector's inference —
 * "FinSight noticed this repeats". A pattern is a candidate to review; a
 * schedule is editable, pausable, and is what the watchdog actually watches.
 * Note the pattern type carries no `categoryId`, so it cannot back an edit
 * form; this one does.
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
   * A date-only value. Serialized from a `@db.Date`, so it arrives as midnight
   * UTC and MUST be rendered with `timeZone: "UTC"` or it shows the previous
   * day anywhere behind UTC. See `formatDueDate` in components/RecurringAgenda.
   */
  nextDueDate: string;
  /** Detector-maintained tracking only; the owner never sets this. */
  lastRecordedDate: string | null;
  /** False means paused — watched by nobody, but not deleted. */
  isActive: boolean;
  /** The RecurringPattern this was promoted from, if any. Provenance only. */
  sourcePatternId: number | null;
  dueState: RecurringDueState;
  createdAt: string;
  updatedAt: string;
}

export interface DailyCoverageRow {
  date: string;
  /** Null on a closed day (`isOperatingDay: false`) — there is no target to hit. */
  neededTarget: number | null;
  sales: number;
  /** Null on a closed day, alongside `neededTarget`. */
  gap: number | null;
  status: DailyRowStatus;
  /** Defaults to true when no schedule is configured (the old approximation
   * mode never had closed days). Optional for older servers. */
  isOperatingDay?: boolean;
}

/**
 * One bounded weekly checkpoint — plan §10.4, Phase 4. Checkpoints land on
 * calendar day-of-month 7/14/21/28 plus the month's final day when it isn't
 * already a multiple of 7. Derived fresh each call, never persisted — see
 * `deriveRecoveryCheckpoints` in analysis.service.ts.
 */
export type RecoveryCheckpointStatus = "ahead" | "on_pace" | "behind" | "pending";

export interface RecoveryCheckpoint {
  /** YYYY-MM-DD, business-local. */
  endDate: string;
  cumulativeTarget: number;
  /** Null for a checkpoint whose `endDate` is after today (a future/`pending` checkpoint). */
  recordedAmount: number | null;
  /** Null when `recordedAmount` is null. */
  variance: number | null;
  status: RecoveryCheckpointStatus;
}

export interface RecoveryInsight extends RecoveryTargets {
  monthStart: string;
  today: string;
  coverageDays: number;
  dailyCoverage: DailyCoverageRow[];
  /**
   * True when not one sale is recorded in the month this page reports on.
   *
   * Recovery is month-to-date and has no period selector, so a business whose
   * history was imported and stops months ago is shown zero sales against the
   * full monthly target — reading as "you are catastrophically behind". The
   * arithmetic is right; what was missing was any statement that the month
   * simply has nothing in it. Optional for older servers.
   */
  monthHasNoRecords?: boolean;
  /** The most recent sale on file, so an empty month can point at where the data is. */
  latestSaleDate?: string | null;
  /** When this response was computed — lets a client label a cached/stale result. Optional for older servers. */
  computedAt?: string;
  /** Bounded weekly checkpoints for the current month — plan §10.4, Phase 4. Optional for older servers. */
  weeklyCheckpoints?: RecoveryCheckpoint[];
}

/**
 * One confirmed-sales open day, as returned inside `RecoveryMonthEndReview`'s
 * `strongestOpenDay`/`weakestOpenDay` — plan §10.9, Phase 7. See
 * `computeMonthEndReview` in insights.service.ts: in an all-zero-sales month
 * this is still a real day (the earliest one), not `null` — `null` only
 * happens when the month had zero open days at all.
 */
export interface MonthEndOpenDaySales {
  /** YYYY-MM-DD, UTC-midnight-encoded like every other date in this app. */
  date: string;
  sales: number;
}

/**
 * `GET /insights/recovery/month-end-review` — plan §10.9, Phase 7. READ-ONLY:
 * there is no endpoint or client mutation anywhere that lets
 * `suggestedQuestionsForNextMonth` change a business profile's settings —
 * see insights.service.ts `computeMonthEndReview`'s doc comment. Any UI
 * consuming this must never add one.
 */
export type RecoveryMonthEndReview =
  | {
      /** The requested month hasn't fully elapsed yet, business-locally. */
      status: "not_yet_reviewable";
      /** YYYY-MM, echoing the requested month. */
      month: string;
    }
  | {
      status: "reviewable";
      /** YYYY-MM. */
      month: string;
      /** 0 when no baseline is configured, matching `RecoveryTargets.monthCoveragePercent`'s own guard. */
      coveragePercent: number;
      /** `salesThisMonth - expectedMonthlyExpenses`. Positive = surplus, negative = shortfall. */
      surplusOrShortfall: number;
      strongestOpenDay: MonthEndOpenDaySales | null;
      weakestOpenDay: MonthEndOpenDaySales | null;
      /** Count of open days that were either entirely missing or partially/fully provisional. */
      missingOrProvisionalDayCount: number;
      /** Total open days this month, out of which `missingOrProvisionalDayCount` is drawn. */
      openDayCount: number;
      /** The plain, un-adjusted daily target computable at month start. */
      originalDailyTarget: number;
      /** What the adjusted daily target would have read as on the month's own last day, or `null` when the month's literal last calendar day was closed. */
      finalAdjustedDailyTarget: number | null;
      /** True when `coveragePercent` lands materially away from 100% — an honest observation only, never a suggested replacement number. */
      baselineAppearsOffFromPattern: boolean;
      /** 2-4 plain, deterministic, templated strings — informational only, never an instruction or one-click "apply" action. */
      suggestedQuestionsForNextMonth: string[];
      /** True when an operating schedule was configured for this month. */
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

export type InteractionModule =
  | "Expense Insights"
  | "Spending Impact"
  | "Recovery Target"
  | "Dashboard"
  /**
   * The unified review queue's "Explain this flag" entry point. The server
   * builds its context from the owner's OPEN findings and flagged-record
   * counts (aiContext.service.ts) — bounded, already-calculated evidence, so
   * the model phrases what FinSight found rather than judging records itself.
   */
  | "Records Review";

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

/*
 * ============================================================
 * Chat conversations
 * ============================================================
 * The AIInteraction types above are NOT superseded by these. They back
 * `/ai/ask` and `/ai/history`, which mobile's AskFinSight screen still calls
 * and which this pass deliberately left untouched. The two have different
 * semantics: an AIInteraction is one question-and-answer pair in a per-module
 * log, a ChatMessage is one half of an exchange inside a named thread.
 */

/** A conversation as it appears in the history rail — no messages. */
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
 * path unchanged, so the page can show the same "AI is unreachable" banner and
 * the same parsed-amount disclosure.
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
