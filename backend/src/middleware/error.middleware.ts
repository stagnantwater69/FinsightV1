import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { logger } from "../config/logger";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }

  if (err instanceof MulterError) {
    return res.status(400).json({ error: err.message });
  }

  /*
   * THE LINE MOST WORTH CORRELATING, and it was the one that could not be.
   *
   * `console.error(err)` wrote an unstructured stack to stdout, outside pino
   * and therefore without the `x-request-id` that every other log line in the
   * request carries. That id is echoed to the client in a response header, so
   * the one thing a user can actually give support — "it said try again, here
   * is the code on screen" — led to a log line that did not have it.
   *
   * The RESPONSE is deliberately unchanged: still nothing but "Internal server
   * error". Detail belongs in the log, not in the body of a 500.
   */
  const id = (req as Request & { id?: unknown }).id;
  logger.error(
    { err, requestId: typeof id === "string" ? id : undefined, method: req.method, path: req.path },
    "unhandled error",
  );
  return res.status(500).json({ error: "Internal server error" });
}
