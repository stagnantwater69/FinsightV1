import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { errorHandler } from "../../src/middleware/error.middleware";

vi.mock("../../src/config/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), fatal: vi.fn() } }));

function fakeReq(): Request {
  return { method: "GET", path: "/api/v1/dashboard", headers: {} } as unknown as Request;
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

/**
 * An unreachable database is a momentary network fact, not a bad request, and
 * the two need different answers. 500 "the server had a problem with that"
 * describes a defect and gives the owner nothing to do; 503 says the condition
 * is temporary and invites the retry that will actually work.
 */
describe("errorHandler on a lost database connection", () => {
  it("answers 503 with a retry hint when the server cannot be reached", () => {
    const err = new Prisma.PrismaClientInitializationError("Can't reach database server", "6.19.3", "P1001");
    const res = run(err);

    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect((res.body as { code: string }).code).toBe("DATABASE_UNREACHABLE");
    // The shared handler also answers failures after a write may have committed.
    // A lost connection cannot promise that nothing changed.
    expect((res.body as { error: string }).error).not.toContain("Nothing on your account has changed");
  });

  it("treats a connection closed mid-query the same way", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Server has closed the connection", {
      code: "P1017",
      clientVersion: "6.19.3",
    });
    const res = run(err);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toContain("check whether they were saved");
  });

  it("answers a connection pool acquisition timeout with a retryable 503", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Timed out fetching a new connection from the connection pool", {
      code: "P2024",
      clientVersion: "6.19.3",
    });
    const res = run(err);

    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("5");
    expect((res.body as { code: string }).code).toBe("DATABASE_UNREACHABLE");
    expect((res.body as { error: string }).error).not.toContain("connection pool");
  });

  it("leaves an unrecognised query fault as a 500", () => {
    // A constraint violation is now answered on its own terms (see the
    // conflict suite below); a fault with no such meaning still is not.
    const err = new Prisma.PrismaClientKnownRequestError("Query interpretation error", {
      code: "P2016",
      clientVersion: "6.19.3",
    });
    const res = run(err);

    expect(res.statusCode).toBe(500);
    // Detail still belongs in the log, not the body.
    expect(res.body).toEqual({ error: "Internal server error" });
  });

  it("leaves an ordinary error as a 500", () => {
    expect(run(new Error("boom")).statusCode).toBe(500);
  });
});

/*
 * The failure this suite was extended for. A receipt scan on a real phone was
 * answered "FinSight's server had a problem with that. Please try again in a
 * moment." — three statements, all false: the fault was not in the request,
 * the photo was fine, and no retry could ever have worked. The database was
 * simply missing a column the running build writes, because a migration had
 * not been applied.
 *
 * server.ts and worker.ts now refuse to start in that state. These cases cover
 * the window that cannot close: a schema that moves under a live process.
 */
describe("errorHandler when the database schema is behind the build", () => {
  it("answers 503 and names the real fault for a missing column", () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "The column `ReceiptScan.ReceiptScan_UploadKey` does not exist in the current database.",
      { code: "P2022", clientVersion: "6.19.3" },
    );
    const res = run(err);

    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe("SCHEMA_OUT_OF_DATE");
    // It must not invite the retry that cannot work, nor imply the caller erred.
    expect((res.body as { error: string }).error).toContain("Nothing on your account has changed");
    expect((res.body as { error: string }).error).not.toContain("try again in a moment");
  });

  it("answers 503 for a missing table too", () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "The table `public.AuthHandoff` does not exist in the current database.",
      { code: "P2021", clientVersion: "6.19.3" },
    );
    const res = run(err);

    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe("SCHEMA_OUT_OF_DATE");
  });

  // Nothing about the schema, or the column that is missing, reaches the client.
  it("keeps the database's own wording out of the response", () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      "The column `ReceiptScan.ReceiptScan_UploadKey` does not exist in the current database.",
      { code: "P2022", clientVersion: "6.19.3" },
    );
    expect(JSON.stringify(run(err).body)).not.toContain("ReceiptScan_UploadKey");
  });
});
