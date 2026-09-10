import axios, { isAxiosError, type InternalAxiosRequestConfig } from "axios";
import { supabase } from "./supabaseClient";

const baseURL = import.meta.env.VITE_API_BASE_URL as string;

/*
 * A CEILING, not a deadline.
 *
 * Without one, axios waits forever: a request the server never answers — a
 * dropped connection, a proxy that quietly stops forwarding — leaves a spinner
 * on screen for the rest of the session with nothing to explain it.
 *
 * Deliberately generous rather than snappy. The slowest things this app does
 * are real work, not stalls: a receipt goes through OCR and sometimes a vision
 * model, a CSV import parses megabytes, Ask FinSight waits on a language model.
 * A tidy-looking 10 or 15 seconds would cancel those mid-flight and report a
 * working feature as broken, which is a worse failure than the one this is
 * fixing. Ninety seconds is past anything the app legitimately does and well
 * short of forever.
 */
export const api = axios.create({ baseURL, timeout: 90_000 });

/*
 * The session token, EXCEPT where the caller brought its own.
 *
 * Password recovery and email confirmation act on a one-off token that came
 * out of a link, not on the browser's session — see ResetPassword.tsx and
 * ConfirmEmail.tsx, which pass it as a per-request `Authorization` header.
 * This used to overwrite that header unconditionally, so an owner who was
 * still signed in somewhere had their link token replaced by the session one
 * and the request acted on (or was rejected for) the wrong identity.
 *
 * A caller-set header therefore always wins: it is the more specific
 * instruction, and it is only ever set deliberately.
 */
api.interceptors.request.use(async (config) => {
  // Read through `get()` where axios gave us an AxiosHeaders (it matches
  // case-insensitively), and fall back to the plain-object shape a hand-built
  // config or a test double can still be carrying.
  const headers = config.headers as unknown as {
    get?: (name: string) => unknown;
    Authorization?: unknown;
    authorization?: unknown;
  };
  const alreadySet =
    typeof headers?.get === "function"
      ? headers.get("Authorization")
      : (headers?.Authorization ?? headers?.authorization);
  if (alreadySet) return config;

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/*
 * Endpoints where a 401 means "those credentials were wrong", not "your
 * session ended".
 *
 * The distinction matters because the two cases need opposite handling: a
 * mistyped password on the login form should leave the user on the form with
 * an error under it, while an expired token on any other call should end the
 * session. Without this list, one wrong password on the change-password panel
 * would log the owner out of the app they are already signed in to.
 */
const CREDENTIAL_ENDPOINTS = ["/auth/login", "/auth/register", "/auth/change-password", "/auth/me"];

function isCredentialCheck(config?: InternalAxiosRequestConfig): boolean {
  const url = config?.url ?? "";
  // DELETE /auth/me re-verifies the password to delete the account; GET/PATCH
  // on the same path are ordinary session-backed reads and writes.
  if (url.startsWith("/auth/me")) return config?.method?.toLowerCase() === "delete";
  return CREDENTIAL_ENDPOINTS.some((path) => url.startsWith(path));
}

type SessionExpiredHandler = () => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;

/**
 * Registered once by AuthProvider so the interceptor — which lives outside
 * React and has no access to router or context — can hand the expiry back to
 * the app to deal with in-band. Redirecting from here with `window.location`
 * would work but would throw away the SPA and reload everything.
 */
export function setSessionExpiredHandler(handler: SessionExpiredHandler | null) {
  sessionExpiredHandler = handler;
}

/*
 * Without this, every caller fell through to getErrorMessage(), which returns
 * the backend's own `error` string — so an expired token put the literal words
 * "Missing bearer token" on screen in front of a shop owner.
 */
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (!isAxiosError(error)) return Promise.reject(error);

    if (error.response?.status === 401 && !isCredentialCheck(error.config)) {
      sessionExpiredHandler?.();
    }

    /*
     * A suspended or pending account, told apart from an ordinary permission
     * refusal by the CODE rather than by the status or the wording.
     *
     * requireAuth answers 403 for these — not 401, because "sign in again"
     * would be a lie and would loop the login screen against a refusal. But
     * plenty of legitimate 403s mean "not yours", and ending the session on
     * those would sign people out for clicking the wrong record. Matching the
     * code keeps the two apart without depending on prose that will be reworded.
     */
    if (error.response?.status === 403) {
      const code = (error.response.data as { code?: string } | undefined)?.code;
      if (code === "ACCOUNT_NOT_ACTIVE") sessionExpiredHandler?.();
    }

    return Promise.reject(error);
  }
);
