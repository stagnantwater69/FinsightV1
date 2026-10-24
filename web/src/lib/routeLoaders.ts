/** Named loaders let intent prefetch and React.lazy share one module request. */
export const loadRecoverPasswordRoute = () => import("../pages/RecoverPassword");
export const loadResetPasswordRoute = () => import("../pages/ResetPassword");
export const loadConfirmEmailRoute = () => import("../pages/ConfirmEmail");
export const loadFaqsRoute = () => import("../pages/Faqs");
export const loadBlogsRoute = () => import("../pages/Blogs");
export const loadTutorialsRoute = () => import("../pages/Tutorials");
export const loadContactRoute = () => import("../pages/Contact");
export const loadPrivacyRoute = () => import("../pages/Privacy");
export const loadTermsRoute = () => import("../pages/Terms");
export const loadProfileRoute = () => import("../pages/Profile");
export const loadAccountSettingsRoute = () => import("../pages/AccountSettings");
export const loadBusinessProfilesRoute = () => import("../pages/BusinessProfiles");
export const loadAllBusinessProfilesRoute = () => import("../pages/AllBusinessProfiles");
export const loadCreateBusinessProfileRoute = () => import("../pages/CreateBusinessProfile");
export const loadEditBusinessProfileRoute = () => import("../pages/EditBusinessProfile");
export const loadOperatingScheduleRoute = () => import("../pages/OperatingSchedule");
export const loadRecoveryNotificationPreferencesRoute = () => import("../pages/RecoveryNotificationPreferences");
export const loadRecordsRoute = () => import("../pages/Records");
export const loadAddExpenseRoute = () => import("../pages/AddExpense");
export const loadAddSalesRecordRoute = () => import("../pages/AddSalesRecord");
export const loadEditExpenseRoute = () => import("../pages/EditExpense");
export const loadEditSalesRecordRoute = () => import("../pages/EditSalesRecord");
export const loadScanReceiptRoute = () => import("../pages/ScanReceipt");
export const loadImportCsvRoute = () => import("../pages/ImportCsv");
export const loadFlaggedRecordsRoute = () => import("../pages/FlaggedRecords");
export const loadDashboardRoute = () => import("../pages/Dashboard");
export const loadExpenseInsightRoute = () => import("../pages/ExpenseInsight");
export const loadRecoveryInsightRoute = () => import("../pages/RecoveryInsightPage");
export const loadRecoveryMonthEndReviewRoute = () => import("../pages/RecoveryMonthEndReview");
export const loadSpendingImpactRoute = () => import("../pages/SpendingImpact");
export const loadRecurringScheduleRoute = () => import("../pages/RecurringScheduleForm");
export const loadCategoriesRoute = () => import("../pages/Categories");
export const loadNotificationsRoute = () => import("../pages/Notifications");
export const loadOnboardingRoute = () => import("../pages/Onboarding");

type RouteModuleLoader = () => Promise<unknown>;

interface ConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

const prefetched = new Map<RouteModuleLoader, Promise<unknown>>();

const protectedRouteLoaders: Array<{
  matches: (pathname: string) => boolean;
  load: RouteModuleLoader;
}> = [
  { matches: (path) => path === "/dashboard", load: loadDashboardRoute },
  { matches: (path) => path === "/records", load: loadRecordsRoute },
  { matches: (path) => path === "/records/categories", load: loadCategoriesRoute },
  { matches: (path) => path === "/records/expenses/new", load: loadAddExpenseRoute },
  { matches: (path) => /^\/records\/expenses\/[^/]+\/edit$/.test(path), load: loadEditExpenseRoute },
  { matches: (path) => path === "/records/sales/new", load: loadAddSalesRecordRoute },
  { matches: (path) => /^\/records\/sales\/[^/]+\/edit$/.test(path), load: loadEditSalesRecordRoute },
  { matches: (path) => path === "/records/receipts/new", load: loadScanReceiptRoute },
  { matches: (path) => path === "/records/csv-imports/new", load: loadImportCsvRoute },
  { matches: (path) => path === "/records/flagged", load: loadFlaggedRecordsRoute },
  { matches: (path) => path === "/insights/expense-behavior", load: loadExpenseInsightRoute },
  { matches: (path) => path === "/insights/spending-impact", load: loadSpendingImpactRoute },
  { matches: (path) => path === "/insights/recovery/month-end-review", load: loadRecoveryMonthEndReviewRoute },
  { matches: (path) => path === "/insights/recovery", load: loadRecoveryInsightRoute },
  { matches: (path) => /^\/insights\/recurring-schedules\/(new|[^/]+\/edit)$/.test(path), load: loadRecurringScheduleRoute },
  { matches: (path) => path === "/profile", load: loadProfileRoute },
  { matches: (path) => path === "/account-settings", load: loadAccountSettingsRoute },
  { matches: (path) => path === "/notifications", load: loadNotificationsRoute },
  { matches: (path) => path === "/business-profiles", load: loadBusinessProfilesRoute },
  { matches: (path) => path === "/business-profiles/all", load: loadAllBusinessProfilesRoute },
  { matches: (path) => path === "/business-profiles/new", load: loadCreateBusinessProfileRoute },
  { matches: (path) => /^\/business-profiles\/[^/]+\/edit$/.test(path), load: loadEditBusinessProfileRoute },
  { matches: (path) => /^\/business-profiles\/[^/]+\/operating-schedule$/.test(path), load: loadOperatingScheduleRoute },
  {
    matches: (path) => /^\/business-profiles\/[^/]+\/recovery-notifications$/.test(path),
    load: loadRecoveryNotificationPreferencesRoute,
  },
];

export function connectionAllowsRoutePrefetch(connection?: ConnectionHint | null): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

export function currentConnection(): ConnectionHint | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: ConnectionHint }).connection;
}

export function routeLoaderFor(pathname: string): RouteModuleLoader | undefined {
  const cleanPath = pathname.split(/[?#]/, 1)[0] || "/";
  return protectedRouteLoaders.find((route) => route.matches(cleanPath))?.load;
}

/** Warm one destination; shared by link intent and the primary-tab warm-up. */
export function prefetchRoute(pathname: string, connection: ConnectionHint | undefined = currentConnection()): Promise<void> {
  if (!connectionAllowsRoutePrefetch(connection)) return Promise.resolve();
  const load = routeLoaderFor(pathname);
  if (!load) return Promise.resolve();

  let request = prefetched.get(load);
  if (!request) {
    request = load();
    prefetched.set(load, request);
  }
  const activeRequest = request;
  return activeRequest.then(
    () => undefined,
    () => {
      if (prefetched.get(load) === activeRequest) prefetched.delete(load);
    },
  );
}

/*
 * The tabs in the sidebar and bottom bar, plus the two quick actions. Warmed
 * once the signed-in app is idle, so switching to them never waits on a code
 * download — which on the dev server is dozens of module requests, and on a
 * deployed build is a round trip on the owner's connection. The rest of the
 * protected app (edit forms, settings sub-pages) is still left to link intent.
 */
const PRIMARY_ROUTES = [
  "/dashboard",
  "/records",
  "/insights/expense-behavior",
  "/insights/spending-impact",
  "/insights/recovery",
  "/business-profiles",
  "/profile",
  "/notifications",
  "/records/categories",
  "/records/receipts/new",
  "/records/csv-imports/new",
];

/** Warms the primary tabs one after another, honouring save-data and 2G. */
export async function prefetchPrimaryRoutes(connection: ConnectionHint | undefined = currentConnection()): Promise<void> {
  if (!connectionAllowsRoutePrefetch(connection)) return;
  // Sequential, not all at once: the page the owner is on keeps priority.
  for (const path of PRIMARY_ROUTES) await prefetchRoute(path, connection);
}

/** Test and session-reset hook; loaded browser modules themselves remain cached. */
export function clearRoutePrefetchRegistry() {
  prefetched.clear();
}
