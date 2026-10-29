import type { Server } from "node:http";

/*
 * nginx keeps idle connections to this process open for up to 60 seconds
 * (`keepalive` in the upstream block; nginx's default keepalive_timeout) and
 * reuses them. Node's own default closes an idle socket after 5 seconds. In
 * between, nginx sends a request down a socket Node has just closed and the
 * owner gets a 502 "upstream prematurely closed connection" for a request the
 * API never saw — rare, random, and impossible to reproduce on demand.
 *
 * The rule is that the side that reuses connections must give up on them
 * first, so Node waits longer than nginx does. headersTimeout must exceed
 * keepAliveTimeout, or Node can still cut a reused socket mid-request.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = KEEP_ALIVE_TIMEOUT_MS + 1_000;

export function applyKeepAliveTimeouts(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
