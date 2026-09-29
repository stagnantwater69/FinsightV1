import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../src/config/logger", () => ({
  logger: {
    warn,
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { ApiError, errorHandler } from "../../src/middleware/error.middleware";

function responseStub() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

beforeEach(() => warn.mockReset());

describe("CSV operational rejection logging", () => {
  it.each([
    ["CSV_STAGE_BUSY", 429],
    ["CSV_STAGE_OUTSTANDING_LIMIT", 429],
    ["CSV_STAGE_STORAGE_LIMIT", 413],
    ["CSV_STAGE_HOURLY_LIMIT", 429],
  ] as const)("emits a code-only event for %s", (code, statusCode) => {
    const { response, status, json } = responseStub();
    const request = {
      id: "req-csv-7",
      method: "POST",
      path: "/api/v1/records/csv-imports/preview",
    } as unknown as Request;

    errorHandler(
      new ApiError(statusCode, "owner-facing detail must not be logged", { code }),
      request,
      response,
      vi.fn() as NextFunction,
    );

    expect(warn).toHaveBeenCalledWith(
      {
        operationalEvent: "csv.request.rejected",
        code,
        status: statusCode,
        requestId: "req-csv-7",
        method: "POST",
        path: "/api/v1/records/csv-imports/preview",
      },
      "CSV request rejected by a capacity guard",
    );
    expect(status).toHaveBeenCalledWith(statusCode);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it("does not turn ordinary validation errors into capacity alerts", () => {
    const { response } = responseStub();
    errorHandler(
      new ApiError(400, "Invalid mapping", { code: "CSV_MAPPING_INVALID" }),
      { method: "POST", path: "/preview" } as Request,
      response,
      vi.fn() as NextFunction,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
