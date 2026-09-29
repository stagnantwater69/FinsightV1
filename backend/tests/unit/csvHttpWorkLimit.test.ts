import { EventEmitter } from "node:events";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  CSV_HTTP_WORK_CONCURRENCY_LIMIT,
  CSV_HTTP_WORK_PER_USER_LIMIT,
  handleCsvHttpWork,
  limitCsvHttpWork,
} from "../../src/middleware/csvHttpWorkLimit.middleware";

class TestResponse extends EventEmitter {
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }
}

function requestFor(userId: number): Request {
  return { user: { id: userId } } as Request;
}

function acquire(userId: number) {
  const response = new TestResponse();
  const next = vi.fn<(error?: unknown) => void>();
  limitCsvHttpWork(requestFor(userId), response as unknown as Response, next as NextFunction);
  return { response, next, error: next.mock.calls[0]?.[0] as unknown };
}

describe("CSV HTTP work permits", () => {
  it("enforces one permit per user and two globally, releasing on finish or close", () => {
    expect(CSV_HTTP_WORK_PER_USER_LIMIT).toBe(1);
    expect(CSV_HTTP_WORK_CONCURRENCY_LIMIT).toBe(2);

    const first = acquire(1);
    expect(first.error).toBeUndefined();
    const sameUser = acquire(1);
    expect(sameUser.error).toMatchObject({ status: 429, code: "CSV_STAGE_BUSY" });

    const second = acquire(2);
    expect(second.error).toBeUndefined();
    const globalOverflow = acquire(3);
    expect(globalOverflow.error).toMatchObject({ status: 429, code: "CSV_STAGE_BUSY" });

    first.response.emit("finish");
    const firstAgain = acquire(1);
    expect(firstAgain.error).toBeUndefined();
    firstAgain.response.emit("close");
    second.response.emit("close");

    const afterClose = acquire(3);
    expect(afterClose.error).toBeUndefined();
    afterClose.response.emit("finish");
  });

  it("releases a permit when a wrapped controller settles or rejects", async () => {
    let finishController!: () => void;
    const controllerFinished = new Promise<void>((resolve) => { finishController = resolve; });
    const response = new TestResponse();
    const next = vi.fn<(error?: unknown) => void>();
    const handler = handleCsvHttpWork((async () => controllerFinished) as RequestHandler);
    const req = requestFor(10);
    limitCsvHttpWork(req, response as unknown as Response, (error?: unknown) => {
      if (error) next(error);
      else handler(req, response as unknown as Response, next as NextFunction);
    });
    expect(acquire(10).error).toMatchObject({ status: 429 });
    finishController();
    await vi.waitFor(() => {
      const released = acquire(10);
      expect(released.error).toBeUndefined();
      released.response.emit("finish");
    });

    const failedResponse = new TestResponse();
    const failure = new Error("controller failed");
    const failedNext = vi.fn<(error?: unknown) => void>();
    const failing = handleCsvHttpWork((async () => { throw failure; }) as RequestHandler);
    limitCsvHttpWork(req, failedResponse as unknown as Response, (error?: unknown) => {
      if (error) failedNext(error);
      else failing(req, failedResponse as unknown as Response, failedNext as NextFunction);
    });
    await vi.waitFor(() => expect(failedNext).toHaveBeenCalledWith(failure));
    const afterFailure = acquire(10);
    expect(afterFailure.error).toBeUndefined();
    afterFailure.response.emit("finish");
  });
});
