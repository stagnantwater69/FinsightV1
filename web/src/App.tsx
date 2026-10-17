import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthenticatedLayout, OnboardingLayout } from "./components/AuthenticatedLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { landingRouteTarget } from "./lib/landingRoute";
import * as route from "./lib/routeLoaders";
/*
 * Eager, unlike every other page below. This one is the fallback for "routing
 * has already gone wrong", so making it depend on a second network round trip
 * to render is the wrong trade: a chunk that fails to fetch would put the
 * silent blank page straight back, in exactly the situation this exists to
 * explain. It is a few hundred bytes of markup with no imports of its own.
 */
import { NotFound } from "./pages/NotFound";
const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Register = lazy(() => import("./pages/Register").then((m) => ({ default: m.Register })));
const RecoverPassword = lazy(() => route.loadRecoverPasswordRoute().then((m) => ({ default: m.RecoverPassword })));
// The two screens Supabase's auth emails link back to. Their paths are also
// registered in the Supabase dashboard under Authentication → URL
// Configuration → Redirect URLs; anything not on that list is silently
// redirected to the Site URL instead, which presents as "the link goes to the
// wrong page" rather than as an error.
const ResetPassword = lazy(() => route.loadResetPasswordRoute().then((m) => ({ default: m.ResetPassword })));
const GoogleCallback = lazy(() => import("./pages/GoogleCallback").then((m) => ({ default: m.GoogleCallback })));
const ConfirmEmail = lazy(() => route.loadConfirmEmailRoute().then((m) => ({ default: m.ConfirmEmail })));
const Faqs = lazy(() => route.loadFaqsRoute().then((m) => ({ default: m.Faqs })));
const Blogs = lazy(() => route.loadBlogsRoute().then((m) => ({ default: m.Blogs })));
const Tutorials = lazy(() => route.loadTutorialsRoute().then((m) => ({ default: m.Tutorials })));
const Contact = lazy(() => route.loadContactRoute().then((m) => ({ default: m.Contact })));
const Privacy = lazy(() => route.loadPrivacyRoute().then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => route.loadTermsRoute().then((m) => ({ default: m.Terms })));
const Profile = lazy(() => route.loadProfileRoute().then((m) => ({ default: m.Profile })));
const AccountSettings = lazy(() => route.loadAccountSettingsRoute().then((m) => ({ default: m.AccountSettings })));
const BusinessProfiles = lazy(() => route.loadBusinessProfilesRoute().then((m) => ({ default: m.BusinessProfiles })));
const AllBusinessProfiles = lazy(() => route.loadAllBusinessProfilesRoute().then((m) => ({ default: m.AllBusinessProfiles })));
const CreateBusinessProfile = lazy(() => route.loadCreateBusinessProfileRoute().then((m) => ({ default: m.CreateBusinessProfile })));
const EditBusinessProfile = lazy(() => route.loadEditBusinessProfileRoute().then((m) => ({ default: m.EditBusinessProfile })));
const OperatingSchedule = lazy(() => route.loadOperatingScheduleRoute().then((m) => ({ default: m.OperatingSchedule })));
const RecoveryNotificationPreferences = lazy(() => route.loadRecoveryNotificationPreferencesRoute().then((m) => ({ default: m.RecoveryNotificationPreferences })));
const Records = lazy(() => route.loadRecordsRoute().then((m) => ({ default: m.Records })));
const AddExpense = lazy(() => route.loadAddExpenseRoute().then((m) => ({ default: m.AddExpense })));
const AddSalesRecord = lazy(() => route.loadAddSalesRecordRoute().then((m) => ({ default: m.AddSalesRecord })));
const EditExpense = lazy(() => route.loadEditExpenseRoute().then((m) => ({ default: m.EditExpense })));
const EditSalesRecord = lazy(() => route.loadEditSalesRecordRoute().then((m) => ({ default: m.EditSalesRecord })));
const ScanReceipt = lazy(() => route.loadScanReceiptRoute().then((m) => ({ default: m.ScanReceipt })));
const ImportCsv = lazy(() => route.loadImportCsvRoute().then((m) => ({ default: m.ImportCsv })));
const FlaggedRecords = lazy(() => route.loadFlaggedRecordsRoute().then((m) => ({ default: m.FlaggedRecords })));
const Dashboard = lazy(() => route.loadDashboardRoute().then((m) => ({ default: m.Dashboard })));
const ExpenseInsight = lazy(() => route.loadExpenseInsightRoute().then((m) => ({ default: m.ExpenseInsight })));
const RecoveryInsightPage = lazy(() => route.loadRecoveryInsightRoute().then((m) => ({ default: m.RecoveryInsightPage })));
const RecoveryMonthEndReviewPage = lazy(() => route.loadRecoveryMonthEndReviewRoute().then((m) => ({ default: m.RecoveryMonthEndReviewPage })));
const SpendingImpact = lazy(() => route.loadSpendingImpactRoute().then((m) => ({ default: m.SpendingImpact })));
const AddRecurringSchedule = lazy(() => route.loadRecurringScheduleRoute().then((m) => ({ default: m.AddRecurringSchedule })));
const EditRecurringSchedule = lazy(() => route.loadRecurringScheduleRoute().then((m) => ({ default: m.EditRecurringSchedule })));
const Categories = lazy(() => route.loadCategoriesRoute().then((m) => ({ default: m.Categories })));
const Notifications = lazy(() => route.loadNotificationsRoute().then((m) => ({ default: m.Notifications })));
const Onboarding = lazy(() => route.loadOnboardingRoute().then((m) => ({ default: m.Onboarding })));

/**
 * `/` serves the public landing page to visitors and skips straight to the
 * dashboard for anyone already signed in — so returning users never have to
 * click past a marketing page to reach their own numbers.
 *
 * EXCEPT when the URL names a section of the landing page (QA register
 * FUN-014). The public header's "Features" link points at `/#features`, and a
 * signed-in visitor who clicked it was redirected to the dashboard — the one
 * place the features section is not. A bare `/` is "take me to my numbers";
 * `/#features` is an explicit request for a specific piece of the marketing
 * page, and the redirect was answering a question nobody asked. Sending them
 * on to the dashboard would also silently discard the hash, so there is no
 * "redirect and then scroll" version of this that works.
 *
 * Rendered while auth is still resolving as `null` rather than a spinner: the
 * check is a local token read and resolves in a frame or two, and flashing a
 * loader there would be more jarring than a brief blank.
 */
function LandingOrDashboard() {
  const { profile, loading } = useAuth();
  const { hash } = useLocation();
  if (loading) return null;
  const target = landingRouteTarget({ hash, signedIn: !!profile });
  return target === "dashboard" ? <Navigate to="/dashboard" replace /> : <Landing />;
}

/*
 * Public pages are small and arrive in a moment; a blank page reads better
 * than a text loader flashing first. The words stay for screen readers.
 */
function RouteFallback() {
  return (
    <div className="min-h-screen bg-paper-50" aria-busy="true">
      <p role="status" aria-live="polite" className="sr-only">
        Loading page…
      </p>
    </div>
  );
}

function App() {
  return (
    // Outermost, so a throw anywhere — including in a provider or the router
    // itself — shows an error rather than emptying the page.
    <ErrorBoundary>
      <BrowserRouter>
        {/* Outside AuthProvider: the theme applies to the landing, login and
          register screens too, and it must not wait on an auth check to be
          applied. */}
        <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <ConfirmProvider>
              {/* Public entry pages load on demand so signed-in visits skip their code. */}
              <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<LandingOrDashboard />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/recover-password" element={<RecoverPassword />} />
                <Route path="/auth/reset-password" element={<ResetPassword />} />
                <Route path="/auth/confirm" element={<ConfirmEmail />} />
                <Route path="/verify-email" element={<ConfirmEmail />} />
                <Route path="/auth/google/callback" element={<GoogleCallback />} />

                {/* Public help-centre pages. Outside AuthenticatedLayout —
                    they are reachable signed out, and each renders its own
                    PublicLayout chrome. */}
                <Route path="/faqs" element={<Faqs />} />
                <Route path="/blogs" element={<Blogs />} />
                <Route path="/tutorials" element={<Tutorials />} />
                <Route path="/contact" element={<Contact />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/terms" element={<Terms />} />

                {/* Its own layout, without the app chrome — see OnboardingLayout. */}
                <Route element={<OnboardingLayout />}>
                  <Route path="/onboarding" element={<Onboarding />} />
                </Route>

                <Route element={<AuthenticatedLayout />}>
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/account-settings" element={<AccountSettings />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/business-profiles" element={<BusinessProfiles />} />
                  <Route path="/business-profiles/all" element={<AllBusinessProfiles />} />
                  <Route path="/business-profiles/new" element={<CreateBusinessProfile />} />
                  <Route path="/business-profiles/:id/edit" element={<EditBusinessProfile />} />
                  <Route path="/business-profiles/:id/operating-schedule" element={<OperatingSchedule />} />
                  <Route
                    path="/business-profiles/:id/recovery-notifications"
                    element={<RecoveryNotificationPreferences />}
                  />

                  <Route path="/records" element={<Records />} />
                  <Route path="/records/categories" element={<Categories />} />
                  <Route path="/records/expenses/new" element={<AddExpense />} />
                  <Route path="/records/expenses/:id/edit" element={<EditExpense />} />
                  <Route path="/records/sales/new" element={<AddSalesRecord />} />
                  <Route path="/records/sales/:id/edit" element={<EditSalesRecord />} />
                  <Route path="/records/receipts/new" element={<ScanReceipt />} />
                  <Route path="/records/csv-imports/new" element={<ImportCsv />} />
                  <Route path="/records/flagged" element={<FlaggedRecords />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  {/* Ask FinSight has no route of its own: it is a drawer over
                      whatever page you are on, mounted once by
                      AuthenticatedLayout. Its conversation survives navigation
                      because the state lives in AiChatContext, not in a page. */}
                  <Route path="/insights/expense-behavior" element={<ExpenseInsight />} />
                  <Route path="/insights/recovery" element={<RecoveryInsightPage />} />
                  <Route path="/insights/recovery/month-end-review" element={<RecoveryMonthEndReviewPage />} />
                  <Route path="/insights/spending-impact" element={<SpendingImpact />} />
                  {/* The agenda itself lives on Expense insight; these are the
                      declare/edit forms behind it. */}
                  <Route path="/insights/recurring-schedules/new" element={<AddRecurringSchedule />} />
                  <Route path="/insights/recurring-schedules/:id/edit" element={<EditRecurringSchedule />} />
                </Route>

                {/*
                  Catch-all, and it must stay LAST and OUTSIDE the layouts
                  above. `<Routes>` renders null when nothing matches, so
                  without this an unmatched path was a silent blank page —
                  no chrome, no message, no console error, indistinguishable
                  from a crashed bundle. See pages/NotFound.tsx.
                */}
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
            </ConfirmProvider>
          </ToastProvider>
        </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
