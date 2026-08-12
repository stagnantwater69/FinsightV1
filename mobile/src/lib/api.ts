import { API_BASE_URL, supabase } from "./supabase";

/**
 * The single HTTP client for the mobile app.
 *
 * It talks to the SAME backend as the web app — same /api/v1 routes, same
 * validation, same ownership rules. No business logic is reimplemented here;
 * every figure the app displays is computed server-side, which is what keeps
 * the two clients from ever disagreeing about a number.
 *
 * Deliberately fetch-based rather than axios: axios adds a dependency for
 * features (interceptors, transforms) that amount to a few lines here.
 *
 * TWO TRANSPORTS, and the split is not arbitrary. JSON goes over `fetch`;
 * file uploads go over XMLHttpRequest, because Expo's `fetch` cannot send a
 * React Native `{ uri }` form part at all. See `uploadRequest`.
 */

export class ApiError extends Error {
  status: number;
  /**
   * Per-field messages, when the server rejected specific fields.
   *
   * The API answers a failed `zod` parse with
   * `{ error: "Validation failed", details: flatten() }`. That was being
   * collapsed into one sentence — "Please check the highlighted fields and
   * try again" — while nothing on screen was highlighted, which sends the
   * owner hunting for a marker the app never drew. Carried here so a form can
   * put each message under the field it belongs to.
   *
   * Empty for every other kind of failure, so a caller can read it without
   * first asking what went wrong.
   */
  fieldErrors: Record<string, string>;

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/** Pulls `details.fieldErrors` out of a rejected response body. */
function fieldErrorsFrom(body: unknown): Record<string, string> {
  const details = (body as { details?: { fieldErrors?: Record<string, string[]> } } | undefined)?.details;
  if (!details?.fieldErrors) return {};
  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(details.fieldErrors)) {
    // The first only: zod can report several for one field, and stacking them
    // under an input turns a correction into a reading task.
    const first = messages?.[0];
    if (typeof first === "string" && first) out[field] = first;
  }
  return out;
}

/** The field messages on an error, or `{}` for anything else. */
export function getFieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? err.fieldErrors : {};
}

/**
 * Endpoints where a 401 means "those credentials are wrong", not "your
 * session ended".
 *
 * THE BUG THIS FIXES. `toError` used to rewrite the message on EVERY 401 to
 * "Your session has expired. Please log in again." — including the 401 that
 * `POST /auth/login` returns for a bad password. On the login screen that
 * sentence is nonsense: there is no session yet. Worse, it hid the two
 * messages the server actually sends, which are the only things that say what
 * to do:
 *
 *   - "Invalid email or password"
 *   - "No FinSight profile for this account" — the account exists in Supabase
 *     Auth but its FinSight profile row does not, or the two point at
 *     different ids. Nothing the owner types will fix that, and being told
 *     their session expired sends them round the same loop for ever.
 *
 * Mirrors web's own CREDENTIAL_ENDPOINTS list, which has always had this
 * right — this is the client that drifted.
 */
const CREDENTIAL_ENDPOINTS = ["/auth/login", "/auth/register", "/auth/change-password", "/auth/recover-password"];

function isCredentialCheck(path: string): boolean {
  return CREDENTIAL_ENDPOINTS.some((endpoint) => path.startsWith(endpoint));
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>) {
  const url = new URL(API_BASE_URL.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Turns a failure into something an owner can act on.
 *
 * A mobile app fails in ways a browser tab mostly doesn't — no signal, a
 * captive-portal wifi, a backend that isn't reachable from the phone's network
 * even though it is from the laptop. "Network request failed" is true and
 * useless, so those get a message that says what to check.
 */
async function toError(res: Response, path: string): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let fieldErrors: Record<string, string> = {};
  try {
    const body = await res.json();
    fieldErrors = fieldErrorsFrom(body);
    if (typeof body?.error === "string") message = body.error;
    if (Object.keys(fieldErrors).length > 0) {
      // The fields carry their own messages now, so the form-level line no
      // longer has to stand in for them.
      message = "Some details need fixing.";
    }
  } catch {
    // Non-JSON body — keep the status-based message.
  }
  // Only on a request that HAD a session to lose. See CREDENTIAL_ENDPOINTS.
  if (res.status === 401 && !isCredentialCheck(path)) {
    message = "Your session has expired. Please log in again.";
  }
  if (res.status >= 500) message = "FinSight's server had a problem with that. Please try again in a moment.";
  return new ApiError(res.status, message, fieldErrors);
}

function networkError(err: unknown): ApiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ApiError(
    0,
    `Couldn't reach FinSight. Check your internet connection, and if you're on a phone make sure it can ` +
      `reach the server address in your settings (${API_BASE_URL}). [${detail}]`
  );
}

async function request<T>(method: string, path: string, opts: {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * A specific token to authenticate with, instead of the stored session.
   *
   * Needed by exactly two callers: confirming an email address and finishing a
   * password reset. Both are driven by a token that arrived in a deep link and
   * that must NOT become the app's session — the whole point of handling those
   * links deliberately is that a link in an inbox does not sign anyone in. So
   * the token is passed for the one request that needs it and is never stored.
   */
  authToken?: string;
} = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers: {
        ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : await authHeader()),
        "Content-Type": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw networkError(err);
  }

  if (!res.ok) throw await toError(res, path);
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Uploads go through XMLHttpRequest, not `fetch`. This is not a stylistic
 * preference — `fetch` cannot send them at all.
 *
 * WHAT BREAKS. Expo installs its own WinterCG `fetch` over the global, and
 * that implementation builds the multipart body in JavaScript. Its converter
 * handles a string, a `Blob`, or something with `bytes()`, and its own source
 * says the rest out loud: *"`uri` is not supported for React Native's
 * FormData."* Everything in this app appends the React Native way —
 * `{ uri, name, type }`, the shape ImagePicker, expo-camera, the image
 * manipulator and DocumentPicker all hand back — so every upload died on
 * `Unsupported FormDataPart implementation`: receipt scans, the readability
 * check, edge detection, profile photos, CSV imports.
 *
 * WHY XHR IS THE RIGHT ANSWER RATHER THAN A WORKAROUND. React Native's own
 * networking understands `{ uri }` parts natively and streams the file from
 * disk. Expo's converter would first read every byte into the JS heap: a
 * long receipt is up to eight photographs at quality 0.9, which is tens of
 * megabytes marshalled through the bridge for a request that never needed to
 * hold any of it in memory. Converting the files to Blobs to satisfy `fetch`
 * would have bought the crash back for a slower upload.
 *
 * Only uploads move. Every JSON call above stays on `fetch`, where none of
 * this applies.
 */
function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void (async () => {
      const headers = await authHeader();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", buildUrl(path));
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      // Content-Type is deliberately unset: XHR derives it from the FormData
      // along with the multipart boundary, and setting it by hand produces a
      // body the server cannot split.

      xhr.onload = () => {
        const status = xhr.status;
        const text = xhr.responseText;

        if (status >= 200 && status < 300) {
          try {
            resolve((text ? JSON.parse(text) : undefined) as T);
          } catch {
            reject(new ApiError(status, "FinSight sent back a response that could not be read."));
          }
          return;
        }

        /*
         * The same messages `toError` produces, reached the same way — from
         * the body's `error` field first, then the status. Kept in step with
         * it by hand because that one reads a `Response` and this has an
         * XHR; a shared helper taking both would be more indirection than
         * the six lines it saves.
         */
        let message = `Request failed (${status})`;
        let fieldErrors: Record<string, string> = {};
        try {
          const body = JSON.parse(text);
          fieldErrors = fieldErrorsFrom(body);
          if (typeof body?.error === "string") message = body.error;
          if (Object.keys(fieldErrors).length > 0) message = "Some details need fixing.";
        } catch {
          // Non-JSON body — keep the status-based message.
        }
        if (status === 401 && !isCredentialCheck(path)) {
          message = "Your session has expired. Please log in again.";
        }
        if (status >= 500) message = "FinSight's server had a problem with that. Please try again in a moment.";
        reject(new ApiError(status, message, fieldErrors));
      };

      // XHR reports every transport failure as a bare event with no reason
      // attached, so this is the one place the detail in networkError cannot
      // come from an exception.
      xhr.onerror = () => reject(networkError(new Error("Network request failed")));
      xhr.ontimeout = () => reject(networkError(new Error("The upload timed out")));
      xhr.onabort = () => reject(networkError(new Error("The upload was cancelled")));

      xhr.send(formData);
    })().catch(reject);
  });
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    request<T>("GET", path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  /** POST authenticated by a one-off token from an auth deep link — see `authToken`. */
  postWithToken: <T>(path: string, authToken: string, body?: unknown) =>
    request<T>("POST", path, { body, authToken }),
  // `query` is exposed here because some PATCH endpoints are scoped by one
  // rather than by a path id — /notifications/read-all takes the business
  // profile that way. `request` already supported it.
  patch: <T>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ) => request<T>("PATCH", path, { body, query }),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
  upload: <T>(path: string, formData: FormData) => uploadRequest<T>(path, formData),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}
