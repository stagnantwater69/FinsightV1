import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { profile, loading, sessionExpired } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-ink-500">Loading…</div>;
  }

  if (!profile) {
    // The flag rides along in route state so /login can explain why the user
    // is suddenly looking at it, rather than appearing to have logged them out
    // for no reason.
    return <Navigate to="/login" replace state={{ sessionExpired }} />;
  }

  return <>{children}</>;
}
