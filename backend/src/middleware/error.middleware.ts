import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { Prisma } from "@prisma/client";
import { logger } from "../config/logger";

/*
 * Codes for "the database was not reachable", as opposed to "the query was
 * wrong". P1001/P1002 are the connection itself; P1008 is a timeout waiting
 * for an operation; P1017 is the server closing it mid-flight, and P2024 is
 * the application pool timing out before a connection becomes available.
 */
const UNREACHABLE_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return err.errorCode === undefined || UNREACHABLE_DB_CODES.has(err.errorCode);
  }
  return err instanceof Prisma.PrismaClientKnownRequestError && UNREACHABLE_DB_CODES.has(err.code);
}

/**
 * The shape body-parser gives its failures: a `type` string identifying which
 * check rejected the payload, an HTTP `status`, and — for a parse failure —
 * the RAW request text it could not parse.
 */
type BodyParserError = Error & { type?: unknown; status?: unknown; body?: unknown };

const HANDLED_BODY_PARSER_TYPES = new Set(["entity.parse.failed", "entity.too.large"]);
const HANDLED_MULTIPART_PARSER_MESSAGES = new Set([
  "Malformed content type",
  "Malformed part header",
  "Multipart: Boundary not found",
  "Unexpected end of file",
  "Unexpected end of form",
]);

function bodyParserType(err: unknown): "entity.parse.failed" | "entity.too.large" | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { type } = err as BodyParserError;
  if (typeof type === "string" && HANDLED_BODY_PARSER_TYPES.has(type)) {
    return type as "entity.parse.failed" | "entity.too.large";
  }
  // Anything that re-throws the SyntaxError without body-parser's marker still
  // carries the raw body on it, which is the part that must not be logged.
  return err instanceof SyntaxError && "body" in err ? "entity.parse.failed" : undefined;
}

function isMalformedMultipart(err: unknown, req: Request): boolean {
  const contentType = req.headers["content-type"];
  return (
    typeof contentType === "string" &&
    /^multipart\/form-data(?:;|$)/i.test(contentType.trim()) &&
    err instanceof Error &&
    HANDLED_MULTIPART_PARSER_MESSAGES.has(err.message)
  );
}

export class ApiError extends Error {
  status: number;
  code?: string;
  responseDetails?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    options: { code?: string; responseDetails?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.responseDetails = options.responseDetails;
  }
}

/** The `x-request-id` echoed to the client, so a log line can be correlated with it. */
function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
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
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.responseDetails ?? {}),
    });
  }

  if (err instanceof MulterError) {
    return res.status(400).json({ error: err.message });
  }

  if (isMalformedMultipart(err, req)) {
    logger.warn(
      {
        requestId: requestIdOf(req),
        method: req.method,
        path: req.path,
        type: "multipart.parse.failed",
      },
      "malformed multipart request",
    );
    return res.status(400).json({ error: "Malformed multipart request" });
  }

  /*
   * A BODY THAT NEVER PARSED IS NOT A SERVER FAULT, AND MUST NOT BE LOGGED.
   *
   * body-parser attaches the raw, unparsed request text to the SyntaxError it
   * throws (`err.body`), and V8's own JSON.parse message quotes a slice of
   * that text as well. Falling through to the generic branch below therefore
   * wrote the request body — verbatim — into the log, and on
   * POST /auth/change-password that body is the caller's plaintext password.
   * pino's redact list could not save it: those paths match KEYS named
   * `password`, and this is one opaque string.
   *
   * So: nothing from the error is logged here beyond which check rejected it,
   * and the answer is the 400 it always should have been — the client sent
   * something that is not JSON, which is a fact about the request.
   */
  const parserType = bodyParserType(err);
  if (parserType !== undefined) {
    if (parserType === "entity.too.large") {
      logger.warn(
        { requestId: requestIdOf(req), method: req.method, path: req.path, type: parserType },
        "request body too large",
      );
      return res.status(413).json({ error: "Request body is too large" });
    }
    logger.warn(
      { requestId: requestIdOf(req), method: req.method, path: req.path, type: parserType },
      "malformed request body",
    );
    return res.status(400).json({ error: "Malformed JSON in request body" });
  }

  /*
   * A LOST DATABASE CONNECTION IS NOT A BUG IN THE REQUEST, and saying "the
   * server had a problem with that" told the owner the opposite — that
   * something was wrong with what they did, and that retrying was pointless.
   * A 503 with `Retry-After` identifies an unavailable dependency without
   * promising how quickly it will recover. A closed connection or timeout can
   * happen after a write committed, so neither automatic write retries nor a
   * promise that nothing changed would be safe here.
   */
  if (isDatabaseUnreachable(err)) {
    logger.error(
      { err, requestId: requestIdOf(req), method: req.method, path: req.path },
      "database unreachable",
    );
    res.setHeader("Retry-After", "5");
    return res.status(503).json({
      error:
        "FinSight's database connection is unavailable right now. Please try again shortly. " +
        "If you were saving changes, check whether they were saved before submitting them again.",
      code: "DATABASE_UNREACHABLE",
    });
  }

  /*
   * THE DATABASE IS REACHABLE BUT IS NOT THE SCHEMA THIS BUILD EXPECTS.
   *
   * P2022 is a missing column, P2021 a missing table. Both mean exactly one
   * thing in this codebase: a migration in the repository has not been applied
   * to the database this process is talking to. Nothing the caller did can
   * cause either code, and no retry can clear one.
   *
   * This is the branch that should never be reached — server.ts and worker.ts
   * refuse to start on that condition (see config/migrationGuard). It exists
   * for the window that check cannot cover: a schema that changes underneath a
   * process that is already running. Answering 500 "the server had a problem
   * with that" is how this last went unnoticed — a real receipt scan failed on
   * a phone with a message that blamed the photo — so the answer names the
   * operational fault instead, and the log carries the code an operator needs.
   */
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2022")) {
    logger.fatal(
      { err, requestId: requestIdOf(req), method: req.method, path: req.path, code: err.code },
      "database schema is behind this build — a migration has not been applied",
    );
    return res.status(503).json({
      error:
        "FinSight is briefly out of step with its database and can't complete that right now. " +
        "Nothing on your account has changed. This needs an update on our side rather than another try.",
      code: "SCHEMA_OUT_OF_DATE",
    });
  }

  /*
   * A CONSTRAINT THAT DID ITS JOB IS NOT A SERVER FAULT EITHER.
   *
   * Until this branch existed, the only Prisma case here was an unreachable
   * database, so a unique-constraint violation — creating a category that
   * already exists — fell through and was answered "Internal server error".
   * That tells the owner the product is broken when in fact the database
   * refused a duplicate exactly as designed, and the request that would
   * succeed is the one where they pick a different name.
   *
   * Services that can anticipate the collision still translate it themselves
   * (auth.service.ts's registration race, businessOperatingSchedule's date
   * override) so they can name the thing that collided. This is the backstop
   * for every place that does not, and it deliberately names nothing: the
   * client learns the request conflicted, never which column or index.
   */
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2002" || err.code === "P2025")) {
    logger.warn(
      { err, requestId: requestIdOf(req), method: req.method, path: req.path, code: err.code },
      "prisma constraint error",
    );
    return err.code === "P2002"
      ? res.status(409).json({ error: "That already exists. Please use a different value or refresh and try again." })
      : res.status(404).json({ error: "That record no longer exists." });
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
  logger.error(
    { err, requestId: requestIdOf(req), method: req.method, path: req.path },
    "unhandled error",
  );
  return res.status(500).json({ error: "Internal server error" });
}
