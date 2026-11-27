import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/*
 * Whether a Prisma connection string verifies the database server.
 *
 * Measured against a local Postgres with test certificates (runtime client
 * through this directory's prisma.ts, and the CLI's schema engine): with no
 * sslmode, or sslmode=prefer, Prisma accepts any certificate and falls back
 * to plaintext when the server offers no TLS; sslmode=require still accepts
 * an untrusted certificate or a wrong host name. Only
 *   sslmode=require & sslcert=<CA file> & sslaccept=strict
 * refuses all three. So every connection that leaves this machine must carry
 * exactly that, with a readable, current CA certificate.
 *
 * The one exception is a loopback host: a local Postgres, the test databases,
 * and the development TLS relay (scripts/database-tls-relay.ts), which can
 * only work with an unverified certificate and says so in its start-up line.
 */

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** An absolute path, optionally after a Windows drive letter, with nothing a URL decoder would change. */
const PLAIN_PATH = /^([A-Za-z]:)?\/[A-Za-z0-9._/-]+$/;

/** Why this URL would not verify the server, or null when it does (or never leaves this machine). */
export function databaseTlsProblem(databaseUrl: string, readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return "is not a valid URL";
  }
  const only = (key: string) => url.searchParams.getAll(key);
  // Prisma connects to a ?host= parameter instead of the URL's host (measured), so
  // every one must stay on this machine too: loopback, or a Unix socket directory.
  const stays = (host: string) => isLoopbackHost(host) || host.startsWith("/");
  if (isLoopbackHost(url.hostname) && only("host").every(stays)) return null;
  if (only("sslmode").join("&") !== "require") return "needs sslmode=require: any other mode can connect without TLS";
  if (only("sslaccept").join("&") !== "strict") return "needs sslaccept=strict: without it any certificate is accepted";
  const paths = only("sslcert");
  if (paths.length !== 1 || !paths[0]) return "needs sslcert=<absolute path to the database's CA certificate>";
  const path = paths[0];
  if (!isAbsolute(path)) return `needs an absolute sslcert path (the runtime and the CLI resolve relative ones differently): ${path}`;
  // Exactly as written: Prisma percent-decodes the path and reads "+" as a space
  // (measured), while deploy.sh and backup-db.sh read it raw. A plain path is
  // the same file for all of them. Also accepted: the same path as URLSearchParams
  // re-serializes it ("/" as %2F), which is how prisma.ts hands the URL on.
  const written = url.search.slice(1).split("&").filter((pair) => pair.startsWith("sslcert="));
  const reserialized = new URLSearchParams({ sslcert: path }).toString();
  if (written.length !== 1 || (written[0] !== `sslcert=${path}` && written[0] !== reserialized) || !PLAIN_PATH.test(path)) {
    return `needs a plain sslcert path (letters, digits, "." "_" "-" "/" only; no %-escapes or "+"): ${path}`;
  }
  let pem: string;
  try {
    pem = readFile(path);
  } catch {
    return `cannot read the CA certificate at ${path}`;
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) return `holds no PEM certificate at ${path}`;
  // Measured: Prisma trusts only the first certificate in the file, so a bundle would half-work.
  if (blocks.length > 1) return `has ${blocks.length} certificates at ${path}; Prisma reads only the first, so keep exactly one CA certificate there`;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(blocks[0]!);
  } catch {
    return `has an unreadable certificate at ${path}`;
  }
  if (!certificate.ca) return `has a certificate at ${path} that is not a CA certificate`;
  if (Date.parse(certificate.validTo) <= Date.now()) return `has a CA certificate at ${path} that expired on ${certificate.validTo}`;
  return null;
}

/* c8 ignore start -- `node dist/config/databaseTls.js DIRECT_URL` before `prisma migrate deploy`
   (docker-compose.prod.yml); the check itself is tested in databaseTls.test.ts. */
if (require.main === module) {
  const name = process.argv[2] ?? "DATABASE_URL";
  const problem = databaseTlsProblem(process.env[name] ?? "");
  if (problem) {
    console.error(`${name} ${problem}. See backend/.env.example (database TLS).`);
    process.exit(1);
  }
}
/* c8 ignore stop */
