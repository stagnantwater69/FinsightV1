import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Every file upload must go over XMLHttpRequest, never `fetch`.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Expo installs its own WinterCG
 * `fetch` over the global, and that implementation builds the multipart body
 * in JavaScript from a string, a `Blob`, or something with `bytes()`. Its own
 * source states the gap outright: *"`uri` is not supported for React Native's
 * FormData."* Every upload in this app appends `{ uri, name, type }` — the
 * shape ImagePicker, expo-camera, the image manipulator and DocumentPicker
 * all return — so routing any of them through `fetch` fails with
 * `Unsupported FormDataPart implementation`.
 *
 * That is not a subtle failure, but it IS an invisible one at review time:
 * `api.upload` reading `request("POST", path, { formData })` looks perfectly
 * correct, and it took a device to find out otherwise. It broke receipt
 * scanning, the readability check, edge detection, profile photos and CSV
 * import in one go.
 *
 * Checked by reading the source rather than by calling anything, because
 * lib/api.ts imports the Supabase client, which imports react-native — this
 * runner cannot load it. Same approach as navigationTargets.test.ts, and for
 * the same reason.
 */

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry)) return [];
    return [{ path, text: readFileSync(path, "utf8") }];
  });
}

const apiSource = readFileSync(join(SRC, "lib", "api.ts"), "utf8");

/** Just the body of the function that actually performs an upload. */
function uploadRequestBody(): string {
  const start = apiSource.indexOf("function uploadRequest");
  expect(start, "lib/api.ts no longer defines uploadRequest").toBeGreaterThan(-1);
  const end = apiSource.indexOf("\nexport const api", start);
  return apiSource.slice(start, end === -1 ? undefined : end);
}

describe("the upload transport", () => {
  it("sends uploads with XMLHttpRequest", () => {
    const body = uploadRequestBody();
    expect(body).toContain("new XMLHttpRequest()");
    expect(body).toContain("xhr.send(formData)");
  });

  /** THE REGRESSION. Expo's fetch cannot send a `{ uri }` part at all. */
  it("never hands a FormData to fetch", () => {
    expect(uploadRequestBody()).not.toContain("fetch(");
  });

  it("routes api.upload through it rather than through the JSON path", () => {
    expect(apiSource).toMatch(/upload:\s*<T>\([^)]*\)\s*=>\s*uploadRequest<T>/);
  });

  /**
   * `request` is the JSON transport and must stay that way — a `formData`
   * option on it is an invitation to send one over `fetch` again.
   */
  it("leaves no FormData option on the JSON transport", () => {
    const start = apiSource.indexOf("async function request");
    const end = apiSource.indexOf("function uploadRequest", start);
    expect(apiSource.slice(start, end)).not.toContain("formData");
  });

  /**
   * Content-Type must be left unset on an upload: XHR derives it from the
   * FormData together with the multipart boundary, and setting it by hand
   * produces a body the server cannot split into parts.
   */
  it("does not set Content-Type by hand on an upload", () => {
    expect(uploadRequestBody()).not.toMatch(/setRequestHeader\(\s*["']Content-Type["']/i);
  });
});

/**
 * A 401 on a login attempt is not an expired session.
 *
 * `toError` rewrote the message on EVERY 401 to "Your session has expired",
 * which on the login screen is nonsense — there is no session yet — and which
 * hid the two answers the server actually gives: "Invalid email or password",
 * and "No FinSight profile for this account" (the auth user exists but its
 * FinSight row does not). The second is unfixable by retyping a password, so
 * an owner told their session expired retries for ever.
 *
 * Checked by reading source, like the transport rules above: lib/api.ts
 * imports the Supabase client and cannot be loaded by this runner.
 */
describe("401 handling", () => {
  it("keeps the server's message on the credential endpoints", () => {
    expect(apiSource).toContain("/auth/login");
    // The rewrite must be conditional, not applied to every 401.
    expect(apiSource).toMatch(/status === 401 && !isCredentialCheck\(path\)/);
    expect(apiSource).not.toMatch(/if \(res\.status === 401\) message =/);
    expect(apiSource).not.toMatch(/if \(status === 401\) message =/);
  });

  /** Both transports answer the same way; only one of them used to. */
  it("applies the same rule on the upload path", () => {
    const matches = apiSource.match(/status === 401 && !isCredentialCheck\(path\)/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe("the call sites", () => {
  /**
   * Nothing may build its own request around a FormData. One transport means
   * one place to get this right — and one place that this suite guards.
   */
  it("send every FormData through api.upload", () => {
    const offenders = sourceFiles(SRC)
      .filter(({ path, text }) => !path.endsWith(join("lib", "api.ts")) && text.includes("new FormData()"))
      .filter(({ text }) => text.includes("fetch(") || text.includes("XMLHttpRequest"));

    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  /**
   * The React Native file-part shape, which is the whole reason for the XHR
   * transport. If a call site ever switches to a Blob it can go back to
   * `fetch` — but then this test should be the thing that gets updated, not
   * the thing that silently still passes.
   */
  it("append files the React Native way", () => {
    const withFormData = sourceFiles(SRC).filter(
      ({ path, text }) => !path.endsWith(join("lib", "api.ts")) && text.includes("new FormData()"),
    );
    expect(withFormData.length).toBeGreaterThan(0);

    for (const { path, text } of withFormData) {
      expect(text, `${path} appends a file part without a uri`).toMatch(/\.append\(\s*["'][^"']+["']\s*,\s*\{[^}]*uri/s);
    }
  });
});
