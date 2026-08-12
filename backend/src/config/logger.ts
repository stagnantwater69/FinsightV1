import pino from "pino";

export const logger = pino({
  enabled: process.env.NODE_ENV !== "test",
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "token", "accessToken", "refreshToken"],
    censor: "[REDACTED]",
  },
});
