/**
 * API response types.
 *
 * Copied verbatim from web/src/lib/types.ts — both clients consume the same
 * endpoints, so the shapes must not diverge. If you change one, change the
 * other; the two files are intentionally identical below this banner.
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
  source: string;
  reviewStatus: ReviewStatus;
  duplicateStatus: DuplicateStatus;
  largeExpenseFlag?: boolean;
  createdAt: string;
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
