import { Outlet } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute";
import { BusinessProfileProvider } from "../context/BusinessProfileContext";
import { ExpenseCategoryProvider } from "../context/ExpenseCategoryContext";
import { NotificationProvider } from "../context/NotificationContext";
import { AppShell } from "./AppShell";
import { RequireBusinessProfile } from "./RequireBusinessProfile";

/**
 * Provider order matters here: notifications are scoped to the selected
 * business profile, so NotificationProvider has to sit inside
 * BusinessProfileProvider to read it.
 *
 * RequireBusinessProfile sits inside the provider for the same reason — it
 * decides on the profile list — and inside AppShell so the redirect it may
 * issue happens without the chrome flashing in first.
 */
export function AuthenticatedLayout() {
  return (
    <ProtectedRoute>
      <BusinessProfileProvider>
        <ExpenseCategoryProvider>
          <NotificationProvider>
            <AppShell>
              <RequireBusinessProfile />
            </AppShell>
          </NotificationProvider>
        </ExpenseCategoryProvider>
      </BusinessProfileProvider>
    </ProtectedRoute>
  );
}

/**
 * The wizard's shell: authenticated and profile-aware, but WITHOUT AppShell.
 *
 * Deliberately no navigation chrome. A sidebar full of Records, Insights and
 * Categories during setup offers an owner a dozen doors into an app that has
 * nothing behind any of them yet, and every one of those doors would bounce
 * them straight back here.
 */
export function OnboardingLayout() {
  return (
    <ProtectedRoute>
      <BusinessProfileProvider>
        <Outlet />
      </BusinessProfileProvider>
    </ProtectedRoute>
  );
}
