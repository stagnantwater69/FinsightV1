import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthenticatedLayout, OnboardingLayout } from "./components/AuthenticatedLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { Landing } from "./pages/Landing";
/*
 * Eager, unlike every other page below. This one is the fallback for "routing
 * has already gone wrong", so making it depend on a second network round trip
 * to render is the wrong trade: a chunk that fails to fetch would put the
 * silent blank page straight back, in exactly the situation this exists to
 * explain. It is a few hundred bytes of markup with no imports of its own.
 */
import { NotFound } from "./pages/NotFound";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
const RecoverPassword = lazy(() => import("./pages/RecoverPassword").then((m) => ({ default: m.RecoverPassword })));
// The two screens Supabase's auth emails link back to. Their paths are also
// registered in the Supabase dashboard under Authentication → URL
// Configuration → Redirect URLs; anything not on that list is silently
// redirected to the Site URL instead, which presents as "the link goes to the
// wrong page" rather than as an error.
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const ConfirmEmail = lazy(() => import("./pages/ConfirmEmail").then((m) => ({ default: m.ConfirmEmail })));
const Faqs = lazy(() => import("./pages/Faqs").then((m) => ({ default: m.Faqs })));
const Blogs = lazy(() => import("./pages/Blogs").then((m) => ({ default: m.Blogs })));
const Tutorials = lazy(() => import("./pages/Tutorials").then((m) => ({ default: m.Tutorials })));
const Contact = lazy(() => import("./pages/Contact").then((m) => ({ default: m.Contact })));
const Privacy = lazy(() => import("./pages/Privacy").then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import("./pages/Terms").then((m) => ({ default: m.Terms })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const AccountSettings = lazy(() => import("./pages/AccountSettings").then((m) => ({ default: m.AccountSettings })));
const BusinessProfiles = lazy(() => import("./pages/BusinessProfiles").then((m) => ({ default: m.BusinessProfiles })));
const AllBusinessProfiles = lazy(() => import("./pages/AllBusinessProfiles").then((m) => ({ default: m.AllBusinessProfiles })));
const CreateBusinessProfile = lazy(() => import("./pages/CreateBusinessProfile").then((m) => ({ default: m.CreateBusinessProfile })));
const EditBusinessProfile = lazy(() => import("./pages/EditBusinessProfile").then((m) => ({ default: m.EditBusinessProfile })));
const OperatingSchedule = lazy(() => import("./pages/OperatingSchedule").then((m) => ({ default: m.OperatingSchedule })));
const RecoveryNotificationPreferences = lazy(() =>
  import("./pages/RecoveryNotificationPreferences").then((m) => ({ default: m.RecoveryNotificationPreferences })),
);
const Records = lazy(() => import("./pages/Records").then((m) => ({ default: m.Records })));
const AddExpense = lazy(() => import("./pages/AddExpense").then((m) => ({ default: m.AddExpense })));
const AddSalesRecord = lazy(() => import("./pages/AddSalesRecord").then((m) => ({ default: m.AddSalesRecord })));
const EditExpense = lazy(() => import("./pages/EditExpense").then((m) => ({ default: m.EditExpense })));
const EditSalesRecord = lazy(() => import("./pages/EditSalesRecord").then((m) => ({ default: m.EditSalesRecord })));
const ScanReceipt = lazy(() => import("./pages/ScanReceipt").then((m) => ({ default: m.ScanReceipt })));
const ImportCsv = lazy(() => import("./pages/ImportCsv").then((m) => ({ default: m.ImportCsv })));
const FlaggedRecords = lazy(() => import("./pages/FlaggedRecords").then((m) => ({ default: m.FlaggedRecords })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const ExpenseInsight = lazy(() => import("./pages/ExpenseInsight").then((m) => ({ default: m.ExpenseInsight })));
const RecoveryInsightPage = lazy(() => import("./pages/RecoveryInsightPage").then((m) => ({ default: m.RecoveryInsightPage })));
const RecoveryMonthEndReviewPage = lazy(() =>
  import("./pages/RecoveryMonthEndReview").then((m) => ({ default: m.RecoveryMonthEndReviewPage })),
);
const SpendingImpact = lazy(() => import("./pages/SpendingImpact").then((m) => ({ default: m.SpendingImpact })));
const AddRecurringSchedule = lazy(() => import("./pages/RecurringScheduleForm").then((m) => ({ default: m.AddRecurringSchedule })));
const EditRecurringSchedule = lazy(() => import("./pages/RecurringScheduleForm").then((m) => ({ default: m.EditRecurringSchedule })));
const Categories = lazy(() => import("./pages/Categories").then((m) => ({ default: m.Categories })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Onboarding = lazy(() => import("./pages/Onboarding").then((m) => ({ default: m.Onboarding })));

/**
 * `/` serves the public landing page to visitors and skips straight to the
 * dashboard for anyone already signed in — so returning users never have to
 * click past a marketing page to reach their own numbers.
 *
 * Rendered while auth is still resolving as `null` rather than a spinner: the
 * check is a local token read and resolves in a frame or two, and flashing a
 * loader there would be more jarring than a brief blank.
 */
function LandingOrDashboard() {
  const { profile, loading } = useAuth();
  if (loading) return null;
  return profile ? <Navigate to="/dashboard" replace /> : <Landing />;
}

/**
 * Shown while a lazily-loaded route's chunk is in flight.
 *
 * Deliberately empty rather than a spinner. On a fast connection the chunk
 * arrives within a frame or two and a spinner would be a flash of anxiety for
 * nothing; the app already renders its own skeletons once a page mounts. An
 * element with the viewport's height is still returned so the footer does not
 * jump up and back down — that would be a layout shift, which is the thing
 * this whole change is trying to avoid.
 */
function RouteFallback() {
  return <div className="min-h-screen" aria-busy="true" />;
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
              {/*
                CODE SPLITTING — the reason this Suspense exists.

                Every page used to be imported eagerly, so the build emitted a
                single 1.19 MB bundle and a visitor who only wanted the landing
                page downloaded the dashboard, the charting library, the
                receipt scanner and the CSV importer before anything painted.
                On the 3G connection a lot of these owners are actually on,
                that is the difference between a page and a wait.

                Landing, Login and Register stay eager: they are the entry
                points, and making the first paint wait on a second round trip
                would trade one problem for another. Everything behind auth is
                fetched when its route is first visited.
              */}
              <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<LandingOrDashboard />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/recover-password" element={<RecoverPassword />} />
                <Route path="/auth/reset-password" element={<ResetPassword />} />
                <Route path="/auth/confirm" element={<ConfirmEmail />} />

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
