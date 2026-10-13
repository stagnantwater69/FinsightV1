import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { SkeletonLine, SkeletonPanel } from "./Skeleton";

/**
 * While the session is being confirmed. A skeleton of the page area rather
 * than a "Loading…" line, so a refresh does not show a text loader before the
 * page's own skeleton.
 */
function SessionFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="min-h-screen bg-paper-50 px-4 py-8 sm:px-8">
      <span className="sr-only">Loading…</span>
      <div className="mx-auto max-w-5xl space-y-6" aria-hidden>
        <div className="space-y-3">
          <div className="skeleton h-7 w-48" />
          <SkeletonLine className="w-72 max-w-full" />
        </div>
        <SkeletonPanel lines={6} />
      </div>
    </div>
  );
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { profile, loading, sessionExpired } = useAuth();

  if (loading) return <SessionFallback />;

  if (!profile) {
    // The flag rides along in route state so /login can explain why the user
    // is suddenly looking at it, rather than appearing to have logged them out
    // for no reason.
    return <Navigate to="/login" replace state={{ sessionExpired }} />;
  }

  return <>{children}</>;
}
