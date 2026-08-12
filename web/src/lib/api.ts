import axios, { isAxiosError, type InternalAxiosRequestConfig } from "axios";
import { supabase } from "./supabaseClient";

const baseURL = import.meta.env.VITE_API_BASE_URL as string;

export const api = axios.create({ baseURL });

api.interceptors.request.use(async (config) => {
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
