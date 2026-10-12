/**
 * Did Supabase Auth fail to ANSWER, as opposed to answering "no"?
 *
 * Callers use this to keep a transport failure from being read as a verdict on
 * a credential: a handoff code survives it, and `requireAuth` answers 503
 * instead of the 401 that makes both clients sign the owner out. It fails
 * closed — anything not recognisably a transport failure is treated as a
 * verdict, and access is still refused either way.
 *
 * supabase-js answers a refused token with a 4xx `AuthApiError`. A connection
 * it could not make becomes `AuthRetryableFetchError` with status 0, and it
 * wraps a 5xx in the same class — the service saying it could not decide
 * either.
 */
export function isAuthUnreachable(error: { status?: number; name?: string } | null): boolean {
  if (!error) return false;
  if (error.name === "AuthRetryableFetchError") return true;
  return error.status !== undefined && (error.status === 0 || error.status >= 500);
}
