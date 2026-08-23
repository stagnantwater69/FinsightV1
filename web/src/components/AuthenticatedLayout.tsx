import { Outlet } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute";
import { BusinessProfileProvider } from "../context/BusinessProfileContext";
import { ExpenseCategoryProvider } from "../context/ExpenseCategoryContext";
import { NotificationProvider } from "../context/NotificationContext";
import { TourProvider } from "../context/TourContext";
import { AiChatProvider } from "../context/AiChatContext";
import { AppShell } from "./AppShell";
import { AskFinSightDrawer } from "./AskFinSightDrawer";
import { RequireBusinessProfile } from "./RequireBusinessProfile";

/**
 * Provider order matters here: notifications are scoped to the selected
 * business profile, so NotificationProvider has to sit inside
 * BusinessProfileProvider to read it.
 *
 * AiChatProvider sits inside BusinessProfileProvider for the same reason — a
 * conversation belongs to one business — and OUTSIDE AppShell, so the shell's
 * own GlobalSearch can open the drawer, and so the whole conversation survives
 * every route change beneath it. Ask FinSight losing its thread on navigation
 * is the exact bug this placement exists to prevent; moving it inside a page
 * or inside RequireBusinessProfile would reintroduce it.
 *
 * RequireBusinessProfile sits inside the profile provider because it decides on
 * the profile list, and inside AppShell so the redirect it may issue happens
 * without the chrome flashing in first.
 */
export function AuthenticatedLayout() {
  return (
    <ProtectedRoute>
      <BusinessProfileProvider>
        <ExpenseCategoryProvider>
          <NotificationProvider>
            {/* TourProvider wraps AppShell so the shell can hold its Quick-add
                menu open for the tour steps that highlight items inside it. */}
            <TourProvider>
              <AiChatProvider>
                <AppShell>
                  <RequireBusinessProfile />
                </AppShell>
                {/* One instance for the whole authenticated app, not one per
                    page: the drawer portals to <body> anyway, and four copies
                    would be four open flags racing each other. */}
                <AskFinSightDrawer />
              </AiChatProvider>
            </TourProvider>
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
