import net from "node:net";

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 64;

function parseCompatibleUrl(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("The database relay requires a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("The database relay requires a PostgreSQL URL.");
  }

  // Prisma has no separate TLS server-name setting. A loopback destination
  // cannot preserve a strict hostname check, so never override that policy.
  const accept = url.searchParams.getAll("sslaccept");
  const mode = url.searchParams.getAll("sslmode");
  const hasCertificateOptions = [...url.searchParams.keys()].some((key) =>
    ["sslcert", "sslrootcert", "sslidentity", "sslpassword", "sslkey", "host"].includes(key),
  );
  if (
    accept.length > 1 ||
    (accept.length === 1 && accept[0] !== "accept_invalid_certs") ||
    mode.length > 1 ||
    (mode.length === 1 && !["prefer", "require"].includes(mode[0]!)) ||
    hasCertificateOptions
  ) {
    throw new Error("The database relay cannot preserve these TLS or host settings; use the direct connection.");
  }
  return url;
}

/** Automatic use is limited to the shared Supabase pooler in development. */
export function shouldUseDatabaseTlsRelay(databaseUrl: string): boolean {
  try {
    const url = parseCompatibleUrl(databaseUrl);
    return (
      /^[a-z0-9-]+\.pooler\.supabase\.(com|co)$/i.test(url.hostname) &&
      ["5432", "6543"].includes(url.port || "5432")
    );
  } catch {
    return false;
  }
}

export interface DatabaseTlsRelay {
  databaseUrl: string;
  upstreamHost: string;
  upstreamPort: number;
  close(): Promise<void>;
}

/**
 * Some network paths stall PostgreSQL's one-byte SSL acknowledgement until
 * the TLS ClientHello follows it. Prisma waits for that byte before sending
 * ClientHello, creating a deadlock. A local early acknowledgement lets those
 * two messages proceed; the upstream acknowledgement is then consumed once.
 *
 * All TLS records pass through unchanged. This relay does not terminate TLS,
 * inspect credentials, replay queries, or permit a plaintext fallback.
 */
export async function startDatabaseTlsRelay(databaseUrl: string): Promise<DatabaseTlsRelay> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The database TLS relay is only available for local development.");
  }
  const target = parseCompatibleUrl(databaseUrl);
  const upstreamHost = target.hostname;
  const upstreamPort = Number(target.port || 5432);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((local) => {
    if (sockets.size >= MAX_CONNECTIONS * 2) {
      local.destroy();
      return;
    }
    const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort });
    sockets.add(local);
    sockets.add(upstream);
    local.setNoDelay(true);
    upstream.setNoDelay(true);
    const header = Buffer.alloc(SSL_REQUEST.length);
    let headerLength = 0;
    let requested = false;
    let confirmed = false;
    let started = false;
    let remainder: Buffer = Buffer.alloc(0);
    let acknowledgementTimer: NodeJS.Timeout | undefined;

    const abort = () => {
      clearTimeout(deadline);
      clearTimeout(acknowledgementTimer);
      sockets.delete(local);
      sockets.delete(upstream);
      local.destroy();
      upstream.destroy();
    };
    const deadline = setTimeout(abort, HANDSHAKE_TIMEOUT_MS);
    deadline.unref();
    local.on("error", abort);
    upstream.on("error", abort);
    local.on("close", abort);
    upstream.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(acknowledgementTimer);
      sockets.delete(upstream);
      // end() flushes the final TLS records already queued for the client.
      // destroy() here could discard a response sent just before upstream EOF.
      local.end();
    });
    upstream.on("drain", () => local.resume());
    local.on("drain", () => upstream.resume());

    const forward = (destination: net.Socket, source: net.Socket, chunk: Buffer) => {
      if (chunk.length > 0 && !destination.write(chunk)) {
        source.pause();
        return false;
      }
      return true;
    };

    const beginHandshake = () => {
      if (!requested || started || upstream.connecting || upstream.destroyed) return;
      started = true;
      upstream.write(SSL_REQUEST, () => {
        // Keep the startup packet separate from ClientHello. Supavisor matches
        // the eight-byte request exactly, so queueing both before TCP connects
        // could combine them into one invalid startup packet.
        acknowledgementTimer = setTimeout(() => {
          if (local.destroyed || upstream.destroyed) return;
          local.write("S");
          if (forward(upstream, local, remainder)) local.resume();
          remainder = Buffer.alloc(0);
        }, 25);
        acknowledgementTimer.unref();
      });
    };
    upstream.once("connect", beginHandshake);

    local.on("data", (chunk: Buffer) => {
      if (requested) {
        forward(upstream, local, chunk);
        return;
      }
      const take = Math.min(header.length - headerLength, chunk.length);
      chunk.copy(header, headerLength, 0, take);
      headerLength += take;
      if (headerLength < header.length) return;
      if (!header.equals(SSL_REQUEST)) {
        abort();
        return;
      }
      requested = true;
      local.pause();
      remainder = chunk.subarray(take);
      beginHandshake();
    });

    upstream.on("data", (chunk: Buffer) => {
      if (!confirmed) {
        if (!requested || chunk[0] !== 83) {
          abort();
          return;
        }
        confirmed = true;
        clearTimeout(deadline);
        chunk = chunk.subarray(1);
      }
      forward(local, upstream, chunk);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const localUrl = new URL(target);
  localUrl.hostname = "127.0.0.1";
  localUrl.port = String((server.address() as net.AddressInfo).port);
  localUrl.searchParams.set("sslmode", "require");
  let closing: Promise<void> | undefined;

  return {
    databaseUrl: localUrl.toString(),
    upstreamHost,
    upstreamPort,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
