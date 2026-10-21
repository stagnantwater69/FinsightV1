import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface InitOptions {
  beforeBreadcrumb: () => unknown;
  beforeSend: (event: Record<string, unknown>) => unknown;
}

const sentry = vi.hoisted(() => {
  const scope = { setLevel: vi.fn(), setTag: vi.fn() };
  return {
    scope,
    init: vi.fn((_options: InitOptions) => undefined),
    captureException: vi.fn(),
    withScope: vi.fn((callback: (s: typeof scope) => void) => callback(scope)),
    flush: vi.fn(async () => true),
    linkedErrorsIntegration: vi.fn(() => ({ name: "LinkedErrors" })),
    dedupeIntegration: vi.fn(() => ({ name: "Dedupe" })),
    nodeContextIntegration: vi.fn(() => ({ name: "Context" })),
  };
});
vi.mock("@sentry/node", () => sentry);

const env = vi.hoisted(() => ({ SENTRY_DSN: "", NODE_ENV: "production" }));
vi.mock("../../src/config/env", () => ({ env }));

vi.mock("../../src/config/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

async function load() {
  vi.resetModules();
  const reporting = await import("../../src/config/errorReporting");
  const middleware = await import("../../src/middleware/error.middleware");
  return { ...reporting, ...middleware };
}

function responseStub() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json, setHeader: vi.fn() } as unknown as Response;
}

beforeEach(() => {
  env.SENTRY_DSN = "";
  env.NODE_ENV = "production";
});
afterEach(() => vi.clearAllMocks());

describe("error reporting", () => {
  it("does nothing at all without a DSN", async () => {
    const { startErrorReporting, reportError, flushErrorReporting } = await load();
    startErrorReporting("api");
    reportError(new Error("boom"));
    await flushErrorReporting();
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("stays off under test even with a DSN", async () => {
    env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    env.NODE_ENV = "test";
    const { startErrorReporting } = await load();
    startErrorReporting("api");
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("starts without default integrations, collected data or breadcrumbs, and scrubs every event", async () => {
    env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    const { startErrorReporting } = await load();
    startErrorReporting("worker");
    const options = sentry.init.mock.calls[0]?.[0];
    if (!options) throw new Error("Sentry.init was not called");
    expect(options).toMatchObject({
      dsn: env.SENTRY_DSN,
      environment: "production",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
      defaultIntegrations: false,
      initialScope: { tags: { service: "worker" } },
    });
    expect(options.beforeBreadcrumb()).toBeNull();
    const event = options.beforeSend({ request: { data: "secret" }, message: "for owner@example.ph" });
    expect(event).toEqual({ message: "for [email]" });
  });

  it("reports an unhandled 500 with the request id and route pattern, never the URL", async () => {
    env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    const { startErrorReporting, errorHandler } = await load();
    startErrorReporting("api");
    const error = new Error("boom");
    const request = {
      id: "req-42",
      method: "PATCH",
      headers: {},
      path: "/api/v1/records/expenses/913",
      baseUrl: "/api/v1/records/expenses",
      route: { path: "/:id" },
    } as unknown as Request;

    errorHandler(error, request, responseStub(), vi.fn() as NextFunction);

    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.scope.setLevel).toHaveBeenCalledWith("error");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("requestId", "req-42");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("method", "PATCH");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("route", "/api/v1/records/expenses/:id");
    expect(JSON.stringify(sentry.scope.setTag.mock.calls)).not.toContain("913");
  });

  it("does not report a client error", async () => {
    env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    const { startErrorReporting, errorHandler, ApiError } = await load();
    startErrorReporting("api");
    errorHandler(
      new ApiError(404, "Not found"),
      { method: "GET", path: "/x", baseUrl: "", headers: {} } as unknown as Request,
      responseStub(),
      vi.fn() as NextFunction,
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
