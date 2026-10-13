import axios, { AxiosError, isAxiosError, type InternalAxiosRequestConfig } from "axios";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import { invalidateServerState, type ServerStateInvalidation } from "./serverStateCache";

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

  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    config.sessionToken = token;
  } else if (error && isAuthRetryableFetchError(error)) {
    /*
     * The access token had expired and the refresh could not reach Supabase —
     * typically the first request after a laptop wakes or a hidden tab comes
     * back. The refresh token is still stored and still good. Sending the
     * request anyway, with no token, earned a 401 that signed the owner out
     * and deleted that refresh token; this fails it as the connection problem
     * it is.
     */
    throw new AxiosError("Could not refresh the session", AxiosError.ERR_NETWORK, config);
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

type SessionRecovery = { kind: "refreshed"; token: string } | { kind: "unreachable" } | { kind: "refused" };

let recovering: Promise<SessionRecovery> | null = null;

/**
 * What a 401 on a session-backed request should lead to.
 *
 * A 401 is not proof the session is over: the access token may simply have
 * expired between the read and the request, or another request may already
 * have refreshed it. So the stored refresh token gets one chance, and the
 * owner is signed out only when Supabase REFUSES it — which is also what a
 * revoked session ("log out everywhere", a password change) produces, so
 * revocation still ends the session here.
 *
 * Shared across concurrent 401s: a page that fires several requests at once
 * must not spend the refresh token once per request.
 */
async function recoverSession(rejectedToken: string): Promise<SessionRecovery> {
  const { data } = await supabase.auth.getSession();
  const current = data.session?.access_token;
  if (current && current !== rejectedToken) return { kind: "refreshed", token: current };

  recovering ??= supabase.auth
    .refreshSession()
    .then(
      ({ data: refreshed, error }): SessionRecovery => {
        if (refreshed.session) return { kind: "refreshed", token: refreshed.session.access_token };
        return error && isAuthRetryableFetchError(error) ? { kind: "unreachable" } : { kind: "refused" };
      },
      (err: unknown): SessionRecovery =>
        isAuthRetryableFetchError(err) ? { kind: "unreachable" } : { kind: "refused" },
    )
    .finally(() => {
      recovering = null;
    });
  return recovering;
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function businessProfileIdFrom(...values: unknown[]): number | string | undefined {
  for (const value of values) {
    const payload = objectPayload(value);
    const candidate = payload?.businessProfileId;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim()) {
      const numeric = Number(candidate);
      return Number.isSafeInteger(numeric) ? numeric : candidate;
    }
  }
  return undefined;
}

function mutationInvalidation(
  config: InternalAxiosRequestConfig,
  responseData: unknown,
): ServerStateInvalidation | null {
  const method = config.method?.toLowerCase() ?? "get";
  if (method === "get" || method === "head" || method === "options") return null;
  const url = (config.url ?? "").split("?", 1)[0]!;
  const pathBusinessId = url.match(/^\/business-profiles\/(\d+)(?:\/|$)/)?.[1];
  const businessProfileId = businessProfileIdFrom(
    config.serverStateScope,
    config.params,
    config.data,
    responseData,
    pathBusinessId ? { businessProfileId: pathBusinessId } : null,
  );
  const withBusiness = (target: ServerStateInvalidation): ServerStateInvalidation =>
    businessProfileId === undefined ? target : { ...target, businessProfileId };

  const csvImportConfirm = url === "/records/csv-imports/confirm";
  const csvProcessingStatus = objectPayload(responseData)?.processingStatus;
  const csvWorkerPending =
    csvImportConfirm && (csvProcessingStatus === "PENDING" || csvProcessingStatus === "PROCESSING");
  const commitsLedger =
    /^\/records\/(expenses|sales)(?:\/|$)/.test(url) ||
    url === "/records/duplicates/resolve" ||
    (csvImportConfirm && !csvWorkerPending) ||
    /^\/records\/receipts\/[^/]+\/confirm$/.test(url);
  if (commitsLedger) {
    return withBusiness({ tags: ["financial", "record-months", "notifications"] });
  }

  if (url.startsWith("/records/categories") || url.startsWith("/expense-categories")) {
    return withBusiness({ tags: ["financial"] });
  }
  if (url.startsWith("/insights/findings")) {
    return withBusiness({
      resourcePrefixes: ["/insights/findings", "/insights/expense-overview", "/dashboard/summary"],
    });
  }
  if (url.startsWith("/insights/recurring-")) {
    return withBusiness({
      resourcePrefixes: [
        "/insights/recurring-",
        "/insights/findings",
        "/dashboard/summary",
        "/notifications",
      ],
    });
  }
  if (/^\/notifications\/(?:\d+\/read|read-all)$/.test(url)) {
    return withBusiness({ resourcePrefix: "/dashboard/summary" });
  }
  if (url.startsWith("/business-profiles/")) {
    return withBusiness({ tags: ["financial"] });
  }

  // Preview/staging, receipt extraction, simulations, and write-only feedback
  // do not change a committed ledger or any cached read model.
  return null;
}

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
  (response) => {
    const invalidation = mutationInvalidation(response.config, response.data);
    if (invalidation) invalidateServerState(invalidation);
    return response;
  },
  async (error: unknown) => {
    if (!isAxiosError(error)) return Promise.reject(error);

    if (error.response?.status === 401 && !isCredentialCheck(error.config)) {
      const config = error.config;
      // Only a request sent with the stored session can be recovered, and only
      // once. A caller-set link token's 401 is about that link.
      if (config?.sessionToken && !config.sessionRetried) {
        const recovery = await recoverSession(config.sessionToken);
        if (recovery.kind === "refreshed") {
          config.sessionRetried = true;
          config.sessionToken = recovery.token;
          config.headers.Authorization = `Bearer ${recovery.token}`;
          return api.request(config);
        }
        if (recovery.kind === "unreachable") {
          return Promise.reject(
            new AxiosError("Could not refresh the session", AxiosError.ERR_NETWORK, config, error.request),
          );
        }
      }
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
