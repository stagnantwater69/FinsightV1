import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: vi.fn() }));

async function stubService(importOriginal: () => Promise<object>) {
  const actual = await importOriginal();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, typeof value === "function"
    ? vi.fn(async (...args: unknown[]) => {
      mocks.calls(name, args);
      if (name === "createReceiptCaptureBatch") return { batch: {}, replayed: false };
      if (name === "listNotificationsWithUnreadCount") return { notifications: [], unreadCount: 0 };
      return /^(list|search|getHistory)/.test(name) ? [] : {};
    }) : value]));
}

vi.mock("../../src/services/businessProfile.service", (original) => stubService(original));
vi.mock("../../src/services/expenseCategory.service", (original) => stubService(original));
vi.mock("../../src/services/expenseRecord.service", (original) => stubService(original));
vi.mock("../../src/services/salesRecord.service", (original) => stubService(original));
vi.mock("../../src/services/notification.service", (original) => stubService(original));
vi.mock("../../src/services/dashboard.service", (original) => stubService(original));
vi.mock("../../src/services/ai.service", (original) => stubService(original));
vi.mock("../../src/services/conversation.service", (original) => stubService(original));
vi.mock("../../src/services/receiptCaptureBatch.service", (original) => stubService(original));
vi.mock("../../src/services/receiptProviderConsent.service", (original) => stubService(original));
vi.mock("../../src/services/receiptScan/queue", (original) => stubService(original));
vi.mock("../../src/services/anomalyDetection/finding.service", (original) => stubService(original));

import * as business from "../../src/controllers/businessProfile.controller";
import * as categories from "../../src/controllers/expenseCategory.controller";
import * as expenses from "../../src/controllers/expenseRecord.controller";
import * as sales from "../../src/controllers/salesRecord.controller";
import * as notifications from "../../src/controllers/notification.controller";
import * as dashboard from "../../src/controllers/dashboard.controller";
import * as ai from "../../src/controllers/ai.controller";
import * as captures from "../../src/controllers/receiptCaptureBatch.controller";
import * as consent from "../../src/controllers/receiptProviderConsent.controller";
import * as receipts from "../../src/controllers/receiptScan.controller";
import * as insights from "../../src/controllers/insights.controller";
import { asyncHandler } from "../../src/lib/asyncHandler";
import { errorHandler } from "../../src/middleware/error.middleware";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 1, authId: "synthetic-owner", email: "synthetic@example.com" };
  next();
});
app.get("/business/:id", asyncHandler(business.getOne));
app.patch("/categories/:id", asyncHandler(categories.update));
app.get("/categories", asyncHandler(categories.list));
app.patch("/notifications/:id/read", asyncHandler(notifications.markRead));
app.get("/notifications", asyncHandler(notifications.list));
app.post("/expenses", asyncHandler(expenses.create));
app.post("/sales", asyncHandler(sales.create));
app.get("/dashboard", asyncHandler(dashboard.summary));
app.get("/ai/history", asyncHandler(ai.history));
app.get("/ai/conversations/:id", asyncHandler(ai.getConversation));
app.post("/captures", asyncHandler(captures.create));
app.get("/consent/:businessProfileId", asyncHandler(consent.show));
app.get("/receipts/:id", asyncHandler(receipts.show));
app.get("/findings", asyncHandler(insights.findingsSummary));
app.use(errorHandler);

beforeEach(() => mocks.calls.mockClear());

const endpoints = [
  { label: "business path", method: "get", path: (id: number) => `/business/${id}` },
  { label: "category path", method: "patch", path: (id: number) => `/categories/${id}`, body: () => ({ name: "Supplies" }) },
  { label: "category business query", method: "get", path: (id: number) => `/categories?businessProfileId=${id}` },
  { label: "notification path", method: "patch", path: (id: number) => `/notifications/${id}/read` },
  { label: "notification business query", method: "get", path: (id: number) => `/notifications?businessProfileId=${id}` },
  { label: "expense business body", method: "post", path: () => "/expenses", body: (id: number) => ({
    businessProfileId: id, categoryId: 1, date: "2026-01-01", description: "Synthetic supplies", amount: 1,
  }) },
  { label: "sales business body", method: "post", path: () => "/sales", body: (id: number) => ({
    businessProfileId: id, date: "2026-01-01", description: "Synthetic sales", amount: 1,
  }) },
  { label: "dashboard business query", method: "get", path: (id: number) => `/dashboard?businessProfileId=${id}` },
  { label: "AI history business query", method: "get", path: (id: number) => `/ai/history?businessProfileId=${id}` },
  { label: "conversation path", method: "get", path: (id: number) => `/ai/conversations/${id}` },
  { label: "capture business body", method: "post", path: () => "/captures", body: (id: number) => ({
    businessProfileId: id, clientBatchKey: "synthetic-key", expectedReceiptCount: 2,
  }) },
  { label: "provider consent path", method: "get", path: (id: number) => `/consent/${id}` },
  { label: "receipt path", method: "get", path: (id: number) => `/receipts/${id}` },
  { label: "finding business query", method: "get", path: (id: number) => `/findings?businessProfileId=${id}` },
] as const;

describe.each(endpoints)("database identifier validation: $label", (endpoint) => {
  it.each([2147483648, 9007199254740992, 0, -1, 1.5])("rejects %s before any service is called", async (id) => {
    const body = "body" in endpoint ? endpoint.body(id) : undefined;
    const result = await request(app)[endpoint.method](endpoint.path(id)).send(body);
    expect(result.status).toBe(400);
    expect(mocks.calls).not.toHaveBeenCalled();
  });

  it("accepts PostgreSQL's maximum positive INT32 identifier", async () => {
    const id = 2147483647;
    const body = "body" in endpoint ? endpoint.body(id) : undefined;
    const result = await request(app)[endpoint.method](endpoint.path(id)).send(body);
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(mocks.calls).toHaveBeenCalledTimes(1);
  });
});
