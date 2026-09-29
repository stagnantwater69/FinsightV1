import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiError } from "./error.middleware";

export const CSV_HTTP_WORK_CONCURRENCY_LIMIT = 2;
export const CSV_HTTP_WORK_PER_USER_LIMIT = 1;
export const CSV_HTTP_WORK_RETRY_SECONDS = 2;

let activeCsvHttpWork = 0;
const activeCsvHttpWorkByUser = new Map<number, number>();

type CsvHttpPermit = {
  release: () => void;
};

const permits = new WeakMap<Response, CsvHttpPermit>();

export function limitCsvHttpWork(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.id;
  const activeForUser = userId === undefined ? CSV_HTTP_WORK_PER_USER_LIMIT : activeCsvHttpWorkByUser.get(userId) ?? 0;
  if (
    activeCsvHttpWork >= CSV_HTTP_WORK_CONCURRENCY_LIMIT ||
    activeForUser >= CSV_HTTP_WORK_PER_USER_LIMIT
  ) {
    res.setHeader("Retry-After", String(CSV_HTTP_WORK_RETRY_SECONDS));
    next(new ApiError(429, "CSV processing is busy. Try again shortly.", {
      code: "CSV_STAGE_BUSY",
      responseDetails: { retryAfterSeconds: CSV_HTTP_WORK_RETRY_SECONDS },
    }));
    return;
  }

  activeCsvHttpWork += 1;
  activeCsvHttpWorkByUser.set(userId!, activeForUser + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeCsvHttpWork -= 1;
    const remainingForUser = (activeCsvHttpWorkByUser.get(userId!) ?? 1) - 1;
    if (remainingForUser > 0) activeCsvHttpWorkByUser.set(userId!, remainingForUser);
    else activeCsvHttpWorkByUser.delete(userId!);
    permits.delete(res);
    res.off("finish", release);
    res.off("close", release);
  };
  const permit: CsvHttpPermit = { release };
  permits.set(res, permit);
  res.once("finish", release);
  res.once("close", release);
  next();
}

export function handleCsvHttpWork(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const permit = permits.get(res);
    try {
      Promise.resolve(handler(req, res, next)).then(
        () => permit?.release(),
        (error: unknown) => {
          permit?.release();
          next(error);
        },
      );
    } catch (error) {
      permit?.release();
      next(error);
    }
  };
}
