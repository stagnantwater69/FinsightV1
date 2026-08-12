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

export type AnomalyFindingStatus = "OPEN" | "CONFIRMED" | "DISMISSED" | "RESOLVED" | "SUPERSEDED";
export type AnomalyFindingFeedback = "CONFIRMED_UNUSUAL" | "EXPECTED_TRANSACTION" | "DUPLICATE" | "INCORRECT_MATCH" | "NO_LONGER_RELEVANT";

export interface AnomalyFinding {
  id: number;
  expenseRecordId: number | null;
  type: "AMOUNT_OUTLIER" | "POSSIBLE_DUPLICATE" | "VELOCITY_ANOMALY" | "RECURRING_CHANGE" | "TREND_CHANGE" | "BEHAVIORAL_NOVELTY";
  severity: "LOW" | "MEDIUM" | "HIGH";
  score: number | null;
  title: string;
  reasons: string[];
  status: AnomalyFindingStatus;
  detectedAt: string;
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
  status: "CANDIDATE" | "CONFIRMED" | "DISMISSED" | "DISABLED";
  category: { name: string };
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

export interface CategorySuggestion {
  categoryId: number;
  categoryName: string;
}
