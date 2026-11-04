import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { LOG_REDACT } from "../../src/config/logger";

function capture(entry: object): string {
  let out = "";
  const sink = new Writable({
    write(chunk, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  pino({ redact: LOG_REDACT }, sink).info(entry, "request completed");
  return out;
}

describe("request log redaction", () => {
  // pino-http logs every request header; the detailed-health token is a
  // credential and must not reach the log in plain text.
  it("redacts the health-detail token header", () => {
    const line = capture({
      req: { headers: { "x-health-token": "SECRET-HEALTH-TOKEN", authorization: "Bearer abc" } },
    });
    expect(line).not.toContain("SECRET-HEALTH-TOKEN");
    expect(line).not.toContain("Bearer abc");
  });
});
