import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";

const logError = vi.fn();
const logWarn = vi.fn();
vi.mock("../../src/config/logger", () => ({ logger: { error: logError, warn: logWarn } }));

const { errorHandler } = await import("../../src/middleware/error.middleware");

function fakeReq(): Request {
  return { method: "POST", path: "/api/v1/auth/change-password", headers: {} } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & typeof res;
}

function run(err: unknown) {
  const res = fakeRes();
  errorHandler(err, fakeReq(), res, vi.fn() as unknown as NextFunction);
  return res;
}

/** Everything this handler handed to pino, flattened to one searchable string. */
function everythingLogged(): string {
  return [...logError.mock.calls, ...logWarn.mock.calls]
    .map((args) => args.map((arg) => JSON.stringify(arg, Object.getOwnPropertyNames(Object(arg)))).join(" "))
    .join("\n");
}

const SECRET = "sup3r-s3cret-passw0rd";

beforeEach(() => {
  logError.mockClear();
  logWarn.mockClear();
});

/**
 * THE DEFECT THIS PINS (API-001). body-parser attaches the raw, unparsed
 * request text to the SyntaxError it throws, and V8's JSON.parse message
 * quotes a slice of that text too. The handler used to log the error object
 * wholesale, so ONE malformed body posted to /auth/change-password wrote the
 * caller's plaintext password into the log — where pino's key-based redact
 * list could not reach it, because a raw JSON string has no `password` key.
 */
describe("errorHandler on a body that never parsed", () => {
  it("answers 400 without putting the raw body anywhere near the log", () => {
    const err = Object.assign(new SyntaxError(`Unexpected token } in JSON at position 40`), {
      type: "entity.parse.failed",
      status: 400,
      body: `{"currentPassword":"${SECRET}",}`,
    });

    const res = run(err);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Malformed JSON in request body" });
    expect(everythingLogged()).not.toContain(SECRET);
    // Not merely redacted-by-luck: the error object is not logged at all here.
    expect(everythingLogged()).not.toContain("currentPassword");
    // The line still has to be correlatable and actionable.
    expect(everythingLogged()).toContain("entity.parse.failed");
  });

  it("keeps the secret out of the log even when only the message carries it", () => {
    // Newer V8 quotes the offending input in the message itself, so scrubbing
    // `err.body` alone would not have been enough.
    const err = Object.assign(
      new SyntaxError(`Unexpected token '}', ..."word":"${SECRET}",}" is not valid JSON`),
      { body: `{"currentPassword":"${SECRET}",}` },
    );

    expect(run(err).statusCode).toBe(400);
    expect(everythingLogged()).not.toContain(SECRET);
  });

  it("answers 413 for a body that exceeded the parser's limit", () => {
    const err = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
    });

    const res = run(err);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: "Request body is too large" });
  });

  it("still treats an ordinary SyntaxError with no body as a 500", () => {
    // Only body-parser's failures are request faults; a genuine SyntaxError
    // thrown inside a service is a defect and must keep its 500 and its stack.
    expect(run(new SyntaxError("boom")).statusCode).toBe(500);
  });

  /** The same thing again, through the real express.json() that produces it. */
  it("returns 400, not 500, for a genuinely malformed request", async () => {
    const app = express();
    app.use(express.json());
    app.post("/auth/change-password", (_req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);

    const response = await request(app)
      .post("/auth/change-password")
      .set("Content-Type", "application/json")
      .send(`{"currentPassword":"${SECRET}",}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Malformed JSON in request body" });
    // The response must not echo it back either.
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
    expect(everythingLogged()).not.toContain(SECRET);
  });
});

/**
 * THE DEFECT THIS PINS (DAT-002/FUN-003). The only Prisma case here was an
 * unreachable database, so a unique-constraint violation — creating a category
 * that already exists — was reported as "Internal server error": the product
 * looked broken when the database had merely refused a duplicate as designed.
 */
describe("errorHandler on a constraint that did its job", () => {
  it("answers 409 for a unique-constraint violation", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.19.3",
      meta: { target: ["ExpenseCategory_profile_name_key"] },
    });

    const res = run(err);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("already exists");
    // The client is told the request conflicted, never which index or column.
    expect(JSON.stringify(res.body)).not.toContain("ExpenseCategory_profile_name_key");
  });

  it("answers 404 when the record to act on is gone", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Record to update not found", {
      code: "P2025",
      clientVersion: "6.19.3",
    });

    const res = run(err);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain("no longer exists");
  });

  it("does not swallow a connection fault that shares the known-error class", () => {
    // P1017 must keep reaching the 503 branch above this one.
    const err = new Prisma.PrismaClientKnownRequestError("Server has closed the connection", {
      code: "P1017",
      clientVersion: "6.19.3",
    });
    expect(run(err).statusCode).toBe(503);
  });
});
