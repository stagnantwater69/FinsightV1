import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldUseDatabaseTlsRelay, startDatabaseTlsRelay } from "../../scripts/database-tls-relay";

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
// Opaque TLS-shaped bytes: these tests assert transport framing, never decrypt
// traffic or send authentication credentials to any service.
const CLIENT_HELLO = Buffer.from([22, 3, 1, 0, 4, 1, 0, 0, 0]);
const SERVER_HELLO = Buffer.from([22, 3, 3, 0, 4, 2, 0, 0, 0]);
const sockets = new Set<Socket>();
const cleanups: Array<() => Promise<void>> = [];

function record(socket: Socket) {
  sockets.add(socket);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  // Refusal and abrupt shutdown are deliberate test inputs; the close event
  // and transcript below are the observable outcomes, not unhandled errors.
  socket.on("error", () => undefined);
  return { socket, bytes: () => Buffer.concat(chunks) };
}

async function peer() {
  const connections: Array<ReturnType<typeof record>> = [];
  const server = createServer((socket) => connections.push(record(socket)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock peer did not bind a TCP port");
  return { port: address.port, connections };
}

async function relay(port: number, query = "") {
  const active = await startDatabaseTlsRelay(`postgresql://test-user:test-password@127.0.0.1:${port}/test-database${query}`);
  cleanups.push(() => active.close());
  return active;
}

async function client(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const connection = record(createConnection({ host: url.hostname, port: Number(url.port) }));
  await once(connection.socket, "connect");
  return connection;
}

async function expectBytes(connection: ReturnType<typeof record>, expected: Buffer) {
  await expect.poll(() => connection.bytes().toString("hex"), { timeout: 2_000, interval: 10 }).toBe(expected.toString("hex"));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("development PostgreSQL TLS relay", () => {
  it("waits for a complete SSLRequest, pipelines TLS, and removes only the upstream acknowledgement", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);

    downstream.socket.write(SSL_REQUEST.subarray(0, 3));
    await delay(25);
    expect(downstream.bytes()).toHaveLength(0);
    expect(upstream.connections.every((connection) => connection.bytes().length === 0)).toBe(true);

    downstream.socket.write(SSL_REQUEST.subarray(3));
    await expectBytes(downstream, Buffer.from("S"));
    downstream.socket.write(CLIENT_HELLO);
    await expect.poll(() => upstream.connections.length).toBe(1);
    const remote = upstream.connections[0]!;
    await expectBytes(remote, Buffer.concat([SSL_REQUEST, CLIENT_HELLO]));

    // The acknowledgement can share a TCP packet with the server's TLS data.
    remote.socket.write(Buffer.concat([Buffer.from("S"), SERVER_HELLO]));
    await expectBytes(downstream, Buffer.concat([Buffer.from("S"), SERVER_HELLO]));

    const subsequent = Buffer.from([23, 3, 3, 0, 2, 83, 0]);
    remote.socket.write(subsequent);
    downstream.socket.write(subsequent);
    await expectBytes(downstream, Buffer.concat([Buffer.from("S"), SERVER_HELLO, subsequent]));
    await expectBytes(remote, Buffer.concat([SSL_REQUEST, CLIENT_HELLO, subsequent]));
  });

  it.each([Buffer.from("N"), Buffer.from("Eupstream-error")])("closes instead of forwarding an upstream SSL refusal: %j", async (refusal) => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);
    downstream.socket.write(SSL_REQUEST);
    await expectBytes(downstream, Buffer.from("S"));
    await expect.poll(() => upstream.connections.length).toBe(1);
    upstream.connections[0]!.socket.write(refusal);

    await expect.poll(() => downstream.socket.destroyed).toBe(true);
    expect(downstream.bytes()).toEqual(Buffer.from("S"));
    await expect.poll(() => upstream.connections[0]!.socket.destroyed).toBe(true);
  });

  it("closes the client when the upstream connection ends during negotiation", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);
    downstream.socket.write(SSL_REQUEST);
    await expect.poll(() => upstream.connections.length).toBe(1);
    upstream.connections[0]!.socket.destroy();

    await expect.poll(() => downstream.socket.destroyed).toBe(true);
    expect(downstream.bytes().length).toBeLessThanOrEqual(1);
  });

  it("retains TLS bytes that arrive with the client's SSLRequest", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);
    downstream.socket.write(Buffer.concat([SSL_REQUEST, CLIENT_HELLO]));

    await expectBytes(downstream, Buffer.from("S"));
    await expect.poll(() => upstream.connections.length).toBe(1);
    await expectBytes(upstream.connections[0]!, Buffer.concat([SSL_REQUEST, CLIENT_HELLO]));
  });

  it("flushes the final encrypted response before closing the client connection", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);
    downstream.socket.write(SSL_REQUEST);
    await expectBytes(downstream, Buffer.from("S"));
    await expect.poll(() => upstream.connections.length).toBe(1);
    const remote = upstream.connections[0]!;

    // A large final write exercises queued data and backpressure during EOF.
    const encryptedResponse = Buffer.alloc(512 * 1024, 0xa5);
    downstream.socket.pause();
    remote.socket.end(Buffer.concat([Buffer.from("S"), encryptedResponse]));
    await delay(25);
    downstream.socket.resume();

    await expectBytes(downstream, Buffer.concat([Buffer.from("S"), encryptedResponse]));
    await expect.poll(() => downstream.socket.destroyed).toBe(true);
  });

  it("refuses a plaintext PostgreSQL startup without forwarding it upstream", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await client(active.databaseUrl);
    downstream.socket.write(Buffer.from([0, 0, 0, 8, 0, 3, 0, 0]));

    await expect.poll(() => downstream.socket.destroyed).toBe(true);
    expect(downstream.bytes()).toHaveLength(0);
    expect(upstream.connections.every((connection) => connection.bytes().length === 0)).toBe(true);
  });

  it("keeps concurrent connection data separate and closes active connections on shutdown", async () => {
    const upstream = await peer();
    const active = await relay(upstream.port);
    const downstream = await Promise.all(Array.from({ length: 4 }, () => client(active.databaseUrl)));
    for (const connection of downstream) connection.socket.write(SSL_REQUEST);
    await Promise.all(downstream.map((connection) => expectBytes(connection, Buffer.from("S"))));
    await expect.poll(() => upstream.connections.length).toBe(4);

    for (const [index, connection] of downstream.entries()) {
      connection.socket.write(Buffer.from([22, 3, 3, 0, 1, index]));
    }
    await expect.poll(() => upstream.connections.every((connection) => connection.bytes().length === 14)).toBe(true);
    for (const remote of upstream.connections) {
      remote.socket.write(Buffer.concat([Buffer.from("S"), remote.bytes().subarray(8)]));
    }
    await Promise.all(downstream.map((connection, index) => expectBytes(connection, Buffer.from([83, 22, 3, 3, 0, 1, index]))));

    await active.close();
    await expect.poll(() => downstream.every(({ socket }) => socket.destroyed)).toBe(true);
    await expect.poll(() => upstream.connections.every(({ socket }) => socket.destroyed)).toBe(true);
    await expect(active.close()).resolves.toBeUndefined();

    const url = new URL(active.databaseUrl);
    const closedPort = record(createConnection({ host: url.hostname, port: Number(url.port) }));
    const connected = vi.fn();
    closedPort.socket.on("connect", connected);
    await expect.poll(() => closedPort.socket.destroyed).toBe(true);
    expect(connected).not.toHaveBeenCalled();
  });
});

describe("relay connection URL policy", () => {
  it.each(["postgres:/private-database", "https://localhost/private-database", "invalid-private-url"])(
    "rejects malformed endpoints without exposing their input: %s",
    async (url) => {
      let failure: unknown;
      try {
        const active = await startDatabaseTlsRelay(url);
        cleanups.push(() => active.close());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("private-");
      expect(JSON.stringify(failure)).not.toContain("private-");
    },
  );

  it("refuses to start in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(startDatabaseTlsRelay("postgresql://user:password@127.0.0.1:5432/test")).rejects.toThrow();
  });

  it("binds only to loopback and requires TLS while retaining the configured credentials and other query settings", async () => {
    const upstream = await peer();
    const original = `postgresql://synthetic-user:p%40ssword@127.0.0.1:${upstream.port}/test-database?sslmode=prefer&sslaccept=accept_invalid_certs&pgbouncer=true&connection_limit=2`;
    const active = await startDatabaseTlsRelay(original);
    cleanups.push(() => active.close());
    const rewritten = new URL(active.databaseUrl);

    expect(rewritten.hostname).toBe("127.0.0.1");
    expect(Number(rewritten.port)).toBeGreaterThan(0);
    expect(Number(rewritten.port)).not.toBe(upstream.port);
    expect(rewritten.username).toBe("synthetic-user");
    expect(rewritten.password).toBe("p%40ssword");
    expect(rewritten.pathname).toBe("/test-database");
    expect(rewritten.searchParams.get("sslmode")).toBe("require");
    expect(rewritten.searchParams.get("sslaccept")).toBe("accept_invalid_certs");
    expect(rewritten.searchParams.get("pgbouncer")).toBe("true");
    expect(rewritten.searchParams.get("connection_limit")).toBe("2");
    expect(active.upstreamHost).toBe("127.0.0.1");
    expect(active.upstreamPort).toBe(upstream.port);
  });

  it.each([
    "sslmode=disable",
    "sslmode=require&sslmode=prefer",
    "sslaccept=strict",
    "sslaccept=unknown",
    "sslaccept=accept_invalid_certs&sslaccept=strict",
    "host=other-host",
    "sslcert=private-certificate",
    "sslrootcert=private-certificate",
    "sslidentity=private-identity",
    "sslpassword=private-password",
    "sslkey=private-key",
  ])("refuses unsupported TLS or host settings: %s", async (query) => {
    await expect(startDatabaseTlsRelay(`postgresql://synthetic-user:synthetic-secret@127.0.0.1:5432/test?${query}`)).rejects.toThrow();
    expect(shouldUseDatabaseTlsRelay(`postgresql://user:password@aws-0-test.pooler.supabase.com:6543/postgres?${query}`)).toBe(false);
  });

  it.each([
    ["postgresql://user:password@aws-0-test.pooler.supabase.com:5432/postgres", true],
    ["postgresql://user:password@aws-0-test.pooler.supabase.com:6543/postgres", true],
    ["postgresql://user:password@aws-0-test.pooler.supabase.co:6543/postgres", true],
    ["postgresql://user:password@aws-0-test.pooler.supabase.com:9999/postgres", false],
    ["postgresql://user:password@aws-0-test.pooler.supabase.com.attacker.test:6543/postgres", false],
    ["postgresql://user:password@localhost:5432/test", false],
    ["postgresql://user:password@db.project.supabase.co:5432/postgres", false],
    ["https://aws-0-test.pooler.supabase.com:6543/postgres", false],
    ["not-a-url", false],
  ])("restricts automatic use to recognized shared pooler endpoints: %s", (url, expected) => {
    expect(shouldUseDatabaseTlsRelay(url)).toBe(expected);
  });
});
