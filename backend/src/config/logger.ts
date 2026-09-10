import pino from "pino";

export const logger = pino({
  enabled: process.env.NODE_ENV !== "test",
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    /*
     * These match KEYS, not the contents of a string. That distinction is the
     * whole reason `err.body` and `err.raw` are here: body-parser attaches the
     * RAW, UNPARSED request text to a JSON SyntaxError, and a raw string is
     * opaque to a key-based redactor — a malformed body posted to
     * /auth/change-password would otherwise reach the log as plaintext.
     * error.middleware.ts answers those without logging the error object at
     * all; this is the second layer, for any path that logs one anyway.
     */
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "token",
      "accessToken",
      "refreshToken",
      "err.body",
      "err.raw",
    ],
    censor: "[REDACTED]",
  },
});
