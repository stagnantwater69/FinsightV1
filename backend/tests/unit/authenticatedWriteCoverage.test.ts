import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/controllers/auth.controller");
vi.mock("../../src/controllers/businessProfile.controller");
vi.mock("../../src/controllers/businessOperatingSchedule.controller");
vi.mock("../../src/controllers/recoveryNotificationPreference.controller");
vi.mock("../../src/controllers/recoveryPlan.controller");
vi.mock("../../src/controllers/expenseCategory.controller");
vi.mock("../../src/controllers/expenseRecord.controller");
vi.mock("../../src/controllers/salesRecord.controller");
vi.mock("../../src/controllers/records.controller");
vi.mock("../../src/controllers/notification.controller");
vi.mock("../../src/controllers/ai.controller");
vi.mock("../../src/controllers/insights.controller");
vi.mock("../../src/controllers/receiptScan.controller");
vi.mock("../../src/controllers/receiptProviderConsent.controller");
vi.mock("../../src/controllers/receiptCaptureBatch.controller");
vi.mock("../../src/controllers/csvImport.controller");
vi.mock("../../src/controllers/dashboard.controller");
vi.mock("../../src/services/recurringSchedule.service", () => ({ assertRecurringSchedulesEnabled: () => undefined }));
vi.mock("../../src/middleware/auth.middleware", () => ({ requireAuth: (req: Request, res: Response, next: NextFunction) => {
  const user = req.get("x-test-user");
  if (!user) return res.sendStatus(401);
  req.user = { id: Number(user), authId: "synthetic-owner", email: "synthetic@example.com" };
  next();
} }));
vi.mock("../../src/middleware/upload.middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    uploadPhoto: { single: () => pass }, uploadCsv: { single: () => pass },
    uploadReceiptImage: { single: () => pass }, uploadReceiptEvidence: { fields: () => pass },
    prepareReceiptUploadTemporaryFiles: pass,
  };
});

import * as auth from "../../src/controllers/auth.controller";
import * as business from "../../src/controllers/businessProfile.controller";
import * as operating from "../../src/controllers/businessOperatingSchedule.controller";
import * as preference from "../../src/controllers/recoveryNotificationPreference.controller";
import * as plans from "../../src/controllers/recoveryPlan.controller";
import * as category from "../../src/controllers/expenseCategory.controller";
import * as expenses from "../../src/controllers/expenseRecord.controller";
import * as sales from "../../src/controllers/salesRecord.controller";
import * as records from "../../src/controllers/records.controller";
import * as notifications from "../../src/controllers/notification.controller";
import * as ai from "../../src/controllers/ai.controller";
import * as insights from "../../src/controllers/insights.controller";
import * as receipts from "../../src/controllers/receiptScan.controller";
import * as consent from "../../src/controllers/receiptProviderConsent.controller";
import * as captures from "../../src/controllers/receiptCaptureBatch.controller";
import * as csv from "../../src/controllers/csvImport.controller";
import * as dashboard from "../../src/controllers/dashboard.controller";
import { authRouter } from "../../src/routes/auth.routes";
import { businessProfileRouter } from "../../src/routes/businessProfile.routes";
import { expenseCategoryRouter } from "../../src/routes/expenseCategory.routes";
import { expenseRecordRouter } from "../../src/routes/expenseRecord.routes";
import { salesRecordRouter } from "../../src/routes/salesRecord.routes";
import { recordsRouter } from "../../src/routes/records.routes";
import { notificationRouter } from "../../src/routes/notification.routes";
import { aiRouter } from "../../src/routes/ai.routes";
import { insightsRouter } from "../../src/routes/insights.routes";
import { receiptRouter } from "../../src/routes/receipt.routes";
import { receiptCaptureBatchRouter } from "../../src/routes/receiptCaptureBatch.routes";
import { csvImportRouter } from "../../src/routes/csvImport.routes";
import { dashboardRouter } from "../../src/routes/dashboard.routes";
import { LIMITS, limitAuthenticatedWrites, rateLimit, resetRateLimits, type RateLimitOptions } from "../../src/middleware/rateLimit.middleware";
import { app as application } from "../../src/app";
import { env } from "../../src/config/env";

const controllerModules = [auth, business, operating, preference, plans, category, expenses, sales, records, notifications, ai, insights, receipts, consent, captures, csv, dashboard];
const handled = vi.fn((_req: Request, res: Response) => res.sendStatus(204));
const app = express();
app.use(express.json());
for (const [path, router] of [
  ["/auth", authRouter], ["/business", businessProfileRouter], ["/categories", expenseCategoryRouter],
  ["/expenses", expenseRecordRouter], ["/sales", salesRecordRouter], ["/records", recordsRouter],
  ["/notifications", notificationRouter], ["/ai", aiRouter], ["/insights", insightsRouter],
  ["/receipts", receiptRouter], ["/captures", receiptCaptureBatchRouter], ["/csv", csvImportRouter], ["/dashboard", dashboardRouter],
] as const) app.use(path, router);

beforeEach(() => {
  resetRateLimits();
  handled.mockClear();
  for (const module of controllerModules) {
    for (const value of Object.values(module)) {
      if (vi.isMockFunction(value)) value.mockImplementation(handled);
    }
  }
});

describe("paid-operation quotas and browser retry contract", () => {
  function useAllowance(options: RateLimitOptions) {
    const limiter = rateLimit(options);
    for (let count = 0; count < options.limit; count += 1) {
      const next = vi.fn();
      limiter({ method: "POST", user: { id: 1 }, headers: {} } as Request, {
        locals: {}, setHeader: () => undefined,
      } as unknown as Response, next);
      expect(next).toHaveBeenCalledExactlyOnceWith();
    }
  }

  it.each(["/receipts", "/receipts/1/retry"])("shares the same hourly upload allowance with %s", async (path) => {
    useAllowance(LIMITS.SCAN_RECEIPT_HOURLY);
    const result = await request(app).post(path).set("x-test-user", "1").send({});
    expect(result.status).toBe(429);
    expect(result.body.retryAfterSeconds).toBe(Number(result.headers["retry-after"]));
    expect(result.body.retryAfterSeconds).toBeGreaterThan(60);
    expect(handled).not.toHaveBeenCalled();
  });

  it("blocks a category suggestion after 1000 calls in the hour even when the burst bucket is fresh", async () => {
    expect(LIMITS.SUGGEST_CATEGORY_HOURLY.limit).toBe(1000);
    expect(LIMITS.SUGGEST_CATEGORY_HOURLY.windowMs).toBe(3_600_000);
    useAllowance(LIMITS.SUGGEST_CATEGORY_HOURLY);
    const result = await request(app).post("/ai/suggest-category").set("x-test-user", "1").send({});
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: expect.any(Number) });
    expect(handled).not.toHaveBeenCalled();
  });

  it("exposes retry timing and rate headers to the allowed browser origin", async () => {
    prime();
    const origin = env.CORS_ORIGIN.split(",")[0]!.trim();
    const result = await request(application).post("/api/v1/records/expenses")
      .set("x-test-user", "1").set("Origin", origin).send({});
    expect(result.status).toBe(429);
    expect(result.headers["access-control-allow-origin"]).toBe(origin);
    const exposed = result.headers["access-control-expose-headers"]!.split(",").map((header: string) => header.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining([
      "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "server-timing",
    ]));
    expect(result.body.retryAfterSeconds).toBe(Number(result.headers["retry-after"]));
    expect(result.headers["ratelimit-limit"]).toBe("120");
    expect(result.headers["ratelimit-remaining"]).toBe("0");
  });
});

function prime(userId = 1) {
  for (let count = 0; count < 120; count += 1) {
    const next = vi.fn();
    limitAuthenticatedWrites({ method: "PATCH", user: { id: userId }, headers: {} } as Request, {
      locals: {}, setHeader: () => undefined,
    } as unknown as Response, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
  }
}

const writes = [
  ["post", "/auth/logout-all"], ["patch", "/auth/me"], ["patch", "/auth/me/preferences"],
  ["post", "/business"], ["patch", "/business/1"], ["put", "/business/1/expense-records-completeness"],
  ["post", "/business/1/logo"], ["post", "/business/1/archive"], ["post", "/business/1/restore"],
  ["put", "/business/1/operating-schedule"], ["post", "/business/1/operating-overrides"], ["delete", "/business/1/operating-overrides/2"],
  ["put", "/business/1/recovery-notification-preferences"], ["put", "/business/1/recovery-plans/2026-10"], ["delete", "/business/1/recovery-plans/2026-10"],
  ["post", "/categories"], ["patch", "/categories/1"],
  ["post", "/expenses"], ["patch", "/expenses/1"], ["delete", "/expenses/1"],
  ["post", "/sales"], ["patch", "/sales/1"], ["delete", "/sales/1"], ["post", "/records/duplicates/resolve"],
  ["patch", "/notifications/1/read"], ["patch", "/notifications/read-all"],
  ["post", "/ai/ask"], ["post", "/ai/purchase-review"], ["post", "/ai/suggest-category"], ["post", "/ai/conversations"],
  ["patch", "/ai/conversations/1"], ["delete", "/ai/conversations/1"], ["put", "/ai/conversations/1/messages/2/feedback"], ["post", "/ai/conversations/1/messages"],
  ["post", "/insights/reduction-simulation"], ["post", "/insights/reduction-opportunities/feedback"], ["post", "/insights/recovery-scenario"],
  ["patch", "/insights/findings/1/review"], ["patch", "/insights/recurring-patterns/1"], ["post", "/insights/recurring-patterns/1/confirm"],
  ["post", "/insights/recurring-schedules"], ["patch", "/insights/recurring-schedules/1"], ["delete", "/insights/recurring-schedules/1"],
  ["put", "/receipts/provider-consent/1"], ["delete", "/receipts/provider-consent/1"], ["post", "/receipts"],
  ["post", "/receipts/quality-check"], ["post", "/receipts/detect-edges"], ["post", "/receipts/transform"], ["post", "/receipts/1/retry"],
  ["patch", "/receipts/1/items/2"], ["delete", "/receipts/1/items/2"], ["post", "/receipts/1/confirm"], ["delete", "/receipts/1/images"], ["delete", "/receipts/1"],
  ["post", "/captures"], ["post", "/csv/preview"], ["post", "/csv/confirm"], ["delete", "/csv/stages/staged-id"],
] as const;

describe("authenticated write router coverage", () => {
  it.each(writes)("blocks %s %s before its controller after the shared allowance is used", async (method, path) => {
    prime();
    const result = await request(app)[method](path).set("x-test-user", "1").send({});
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: expect.any(Number) });
    expect(result.body.retryAfterSeconds).toBe(Number(result.headers["retry-after"]));
    expect(handled).not.toHaveBeenCalled();
  });

  it.each(["/expenses/1", "/categories?businessProfileId=1", "/notifications", "/ai/history", "/receipts/1", "/csv/batches/1/status", "/dashboard/summary"])(
    "keeps GET %s available after the write allowance is used", async (path) => {
      prime();
      expect((await request(app).get(path).set("x-test-user", "1")).status).toBe(204);
      expect(handled).toHaveBeenCalledTimes(1);
    },
  );

  it("gives another authenticated owner their own allowance", async () => {
    prime();
    expect((await request(app).post("/expenses").set("x-test-user", "2").send({})).status).toBe(204);
  });

  it("requires authentication before attempting a mutation", async () => {
    expect((await request(app).patch("/categories/1").send({})).status).toBe(401);
    expect(handled).not.toHaveBeenCalled();
  });

  it("allows exactly 120 mutations while GET and HEAD do not consume the allowance", () => {
    expect(LIMITS.AUTHENTICATED_WRITE.limit).toBe(120);
    const res = { locals: {}, setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (let count = 0; count < 121; count += 1) {
        const next = vi.fn();
        limitAuthenticatedWrites({ method, user: { id: 1 } } as Request, res as unknown as Response, next);
        expect(next).toHaveBeenCalledExactlyOnceWith();
      }
    }
    prime();
    const next = vi.fn();
    limitAuthenticatedWrites({ method: "DELETE", user: { id: 1 }, headers: {} } as Request, res as unknown as Response, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });
});
