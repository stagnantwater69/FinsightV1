import { createContext, useContext } from "react";
import type { AuthContextValue } from "./AuthContext";

// Kept out of AuthContext.tsx so that file exports only its provider and
// `useAuth`, which is what React Fast Refresh needs to hot-swap it.
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Null outside the provider, for page chrome that renders in isolated tests too. */
export function useAuthOptional() {
  return useContext(AuthContext) ?? null;
}
