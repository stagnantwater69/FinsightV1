import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, errorHandler } from "../../src/middleware/error.middleware";
import { rateLimits, SHARED_BUDGETS } from "../../src/middleware/rateLimit.middleware";

// The shared budgets bound the provider bill for every owner together, so a
// request that was refused before any model call must not spend one.
const app = express();
app.use(express.json());
app.post("/billed", rateLimits(SHARED_BUDGETS.CATEGORY_SUGGESTIONS), (req, res) => {
  const { outcome } = z.object({ outcome: z.enum(["ok", "missing", "deleted-after-call"]) }).parse(req.body);
  if (outcome === "missing") throw new ApiError(404, "Business profile not found");
  if (outcome === "deleted-after-call") {
    throw new ApiError(409, "The conversation was deleted.", { code: "CHAT_SEND_CONVERSATION_DELETED" });
  }
  res.json({ ok: true });
});
app.use(errorHandler);

async function remainingAfterOk(): Promise<number> {
  const response = await request(app).post("/billed").send({ outcome: "ok" });
  expect(response.status).toBe(200);
  return Number(response.headers["ratelimit-remaining"]);
}

describe("shared daily budgets", () => {
  it("refund a request refused by validation or a missing owned record", async () => {
    const before = await remainingAfterOk();

    expect((await request(app).post("/billed").send({ outcome: "nope" })).status).toBe(400);
    expect((await request(app).post("/billed").send({ outcome: "missing" })).status).toBe(404);

    expect(await remainingAfterOk()).toBe(before - 1);
  });

  it("keep the charge for a failure that can follow the model call", async () => {
    const before = await remainingAfterOk();

    expect((await request(app).post("/billed").send({ outcome: "deleted-after-call" })).status).toBe(409);

    expect(await remainingAfterOk()).toBe(before - 2);
  });
});
