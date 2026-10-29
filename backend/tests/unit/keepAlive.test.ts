import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { applyKeepAliveTimeouts } from "../../src/lib/keepAlive";

// nginx's upstream keepalive_timeout defaults to 60s.
const NGINX_UPSTREAM_KEEPALIVE_MS = 60_000;

describe("applyKeepAliveTimeouts", () => {
  it("holds idle sockets longer than nginx reuses them, and header reads longer still", () => {
    const server = createServer();
    expect(server.keepAliveTimeout).toBeLessThan(NGINX_UPSTREAM_KEEPALIVE_MS);

    applyKeepAliveTimeouts(server);

    expect(server.keepAliveTimeout).toBeGreaterThan(NGINX_UPSTREAM_KEEPALIVE_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});
