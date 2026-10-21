import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubEvent, scrubText } from "./errorScrub";

const sentry = vi.hoisted(() => ({ start: vi.fn(), capture: vi.fn() }));
vi.mock("./sentry", () => sentry);

async function load(dsn: string) {
  vi.stubEnv("VITE_SENTRY_DSN", dsn);
  vi.resetModules();
  return import("./errorReporting");
}

/** Lets the dynamic import and its .then chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("web error reporting", () => {
  it("never loads the SDK without a DSN", async () => {
    const { startErrorReporting, reportError } = await load("");
    startErrorReporting();
    reportError(new Error("boom"));
    await settle();
    expect(sentry.start).not.toHaveBeenCalled();
    expect(sentry.capture).not.toHaveBeenCalled();
  });

  it("starts once and reports with tags when a DSN is set", async () => {
    const { startErrorReporting, reportError } = await load("https://key@o0.ingest.sentry.io/1");
    startErrorReporting();
    const error = new Error("boom");
    reportError(error, { boundary: "app" });
    await settle();
    expect(sentry.start).toHaveBeenCalledTimes(1);
    expect(sentry.start).toHaveBeenCalledWith("https://key@o0.ingest.sentry.io/1");
    expect(sentry.capture).toHaveBeenCalledWith(error, { boundary: "app" });
  });

  it("reports an error raised before startErrorReporting ran", async () => {
    const { reportError } = await load("https://key@o0.ingest.sentry.io/1");
    reportError(new Error("early"));
    await settle();
    expect(sentry.start).toHaveBeenCalledTimes(1);
    expect(sentry.capture).toHaveBeenCalledTimes(1);
  });
});

describe("web error scrubbing", () => {
  it("drops the request, user and breadcrumbs, and redacts emails and tokens", () => {
    const event = scrubEvent({
      request: { url: "https://app.example.ph/reset-password?code=12345678&email=owner@example.ph" },
      user: { id: "7" },
      breadcrumbs: [{ category: "navigation" }],
      message: "verify failed for owner@example.ph",
      exception: { values: [{ type: "Error", value: "Bearer eyJabc.def.ghi rejected" }] },
    });
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(event.message).toBe("verify failed for [email]");
    expect(event.exception?.values?.[0]?.value).toBe("Bearer [token] rejected");
  });

  it("matches the backend's redaction of plain text", () => {
    expect(scrubText("db postgresql://u:secret@host:5432/db")).toBe("db [connection-string]");
  });
});
