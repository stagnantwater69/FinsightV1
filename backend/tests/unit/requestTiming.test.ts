import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { recordSpan, requestTiming, timeSpan } from "../../src/lib/requestTiming";

describe("requestTiming", () => {
  it("reports recorded spans and the total in Server-Timing", async () => {
    const app = express();
    app.use(express.json());
    app.use(requestTiming);
    app.post("/work", async (_req, res) => {
      await timeSpan("auth", () => new Promise((resolve) => setTimeout(resolve, 5)));
      recordSpan("ratelimit", 2);
      recordSpan("ratelimit", 3);
      res.json({ ok: true });
    });

    const res = await request(app).post("/work").send({ a: 1 }).expect(200);
    const header = res.headers["server-timing"] as string;

    expect(header).toMatch(/auth;dur=\d+\.\d/);
    expect(header).toContain("ratelimit;dur=5.0");
    expect(header).toMatch(/total;dur=\d+\.\d$/);
  });

  it("ignores spans recorded outside a request", () => {
    expect(() => recordSpan("auth", 1)).not.toThrow();
  });
});

describe("requestTiming with a handler-owned header", () => {
  it("leaves a Server-Timing header the handler set itself untouched", async () => {
    const app = express();
    app.use(requestTiming);
    app.get("/owned", async (_req, res) => {
      recordSpan("auth", 3);
      res.setHeader("Server-Timing", "total;dur=1.0");
      res.json({ ok: true });
    });

    const res = await request(app).get("/owned").expect(200);
    expect(res.headers["server-timing"]).toBe("total;dur=1.0");
  });
});
