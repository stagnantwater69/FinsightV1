import path from "node:path";
import { describe, expect, it } from "vitest";
import { databaseTlsProblem, isLoopbackHost } from "../../src/config/databaseTls";
import { withIdleConnectionLifetime, withPoolSize, withSocketTimeout } from "../../src/config/prisma";

// Public test certificates (no key is kept): a CA, and a leaf it signed. Paths
// as an operator writes them in a URL: forward slashes, nothing escaped.
const plain = (file: string) => path.resolve(__dirname, file).replace(/\\/g, "/");
const CA = plain("../fixtures/database-tls/test-ca.crt");
const LEAF = plain("../fixtures/database-tls/test-leaf.crt");
const HOST = "postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
const tls = (ca: string) => `sslmode=require&sslcert=${ca}&sslaccept=strict`;

describe("databaseTlsProblem", () => {
  it("accepts a remote URL that verifies the server, alongside other parameters", () => {
    expect(databaseTlsProblem(`${HOST}?${tls(CA)}`)).toBeNull();
    expect(databaseTlsProblem(`${HOST}?pgbouncer=true&${tls(CA)}&connection_limit=8`)).toBeNull();
  });

  it.each([
    ["no TLS settings (the repository template)", `${HOST}?pgbouncer=true`, "needs sslmode=require"],
    ["sslmode=require alone", `${HOST}?sslmode=require`, "needs sslaccept=strict"],
    ["sslmode=prefer, which falls back to plaintext", `${HOST}?sslmode=prefer&sslcert=${CA}&sslaccept=strict`, "needs sslmode=require"],
    ["sslmode given twice", `${HOST}?sslmode=require&sslmode=disable&sslcert=${CA}&sslaccept=strict`, "needs sslmode=require"],
    // Prisma takes the last of a repeated key (measured), so any repeat is refused.
    ["sslaccept given twice", `${HOST}?sslmode=require&sslcert=${CA}&sslaccept=strict&sslaccept=accept_invalid_certs`, "needs sslaccept=strict"],
    ["sslaccept repeated under an encoded name", `${HOST}?sslmode=require&sslcert=${CA}&sslaccept=strict&ssl%61ccept=accept_invalid_certs`, "needs sslaccept=strict"],
    ["sslcert given twice", `${HOST}?${tls(CA)}&sslcert=${LEAF}`, "needs sslcert="],
    ["sslaccept=accept_invalid_certs",`${HOST}?sslmode=require&sslcert=${CA}&sslaccept=accept_invalid_certs`, "needs sslaccept=strict"],
    ["no CA file", `${HOST}?sslmode=require&sslaccept=strict`, "needs sslcert="],
    ["a relative CA path", `${HOST}?sslmode=require&sslcert=certs/ca.crt&sslaccept=strict`, "absolute sslcert path"],
    ["a missing CA file", `${HOST}?${tls(plain("no-such-ca.crt"))}`, "cannot read the CA certificate"],
    ["a file that is not a certificate", `${HOST}?${tls(plain(__filename))}`, "holds no PEM certificate"],
    ["a leaf certificate instead of a CA", `${HOST}?${tls(LEAF)}`, "not a CA certificate"],
    ["an unparseable URL", "postgresql://u:p@[bad/postgres", "is not a valid URL"],
    // Prisma would open the decoded name, deploy.sh and backup-db.sh the raw one.
    ["a percent-escaped CA path", `${HOST}?${tls(CA.replace("test-ca", "test%2Dca"))}`, "needs a plain sslcert path"],
    ["a CA path with \"+\" (a space once decoded)", `${HOST}?${tls(CA.replace("test-ca", "test+ca"))}`, "needs a plain sslcert path"],
    // Written as-is, so only the character rule can refuse it; the shell helper refuses it too.
    ["a CA path with other characters", `${HOST}?${tls(CA.replace("test-ca", "test-ca(1)"))}`, "needs a plain sslcert path"],
    ["a CA path with a space",`${HOST}?${tls(CA.replace("test-ca", "test ca"))}`, "needs a plain sslcert path"],
    ["sslcert under an encoded name", `${HOST}?sslmode=require&ssl%63ert=${CA}&sslaccept=strict`, "needs a plain sslcert path"],
  ])("refuses %s", (_label, url, reason) => {
    const problem = databaseTlsProblem(url);
    expect(problem).toContain(reason);
    expect(problem).not.toContain(":p@");
  });

  it("accepts the verified URL after prisma.ts rewrites it (URLSearchParams writes / as %2F)", () => {
    // That form decodes to the same plain path, and deploy.sh and backup-db.sh refuse it.
    expect(databaseTlsProblem(`${HOST}?${tls(encodeURIComponent(CA))}`)).toBeNull();
    const rewritten = withIdleConnectionLifetime(withSocketTimeout(withPoolSize(`${HOST}?pgbouncer=true&${tls(CA)}`, "8"), undefined), undefined)!;
    expect(rewritten).toMatch(/sslcert=[^&]*%2F/);
    expect(databaseTlsProblem(rewritten)).toBeNull();
  });

  it("refuses a bundle, of which Prisma would trust only the first certificate", () => {
    const pem = require("node:fs").readFileSync(CA, "utf8") as string;
    expect(databaseTlsProblem(`${HOST}?${tls(CA)}`, () => pem + pem)).toContain("has 2 certificates");
  });

  it("refuses an expired CA certificate", () => {
    const pem = require("node:fs").readFileSync(CA, "utf8") as string;
    const realNow = Date.now;
    Date.now = () => Date.parse("2200-01-01T00:00:00Z");
    try {
      expect(databaseTlsProblem(`${HOST}?${tls(CA)}`, () => pem)).toContain("expired");
    } finally {
      Date.now = realNow;
    }
  });

  it("exempts only loopback hosts, which never leave this machine", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "[::1]", "localhost."]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(databaseTlsProblem(`postgresql://u:p@${host}:5432/finsight_test`)).toBeNull();
    }
    for (const host of ["localhost.attacker.example", "127.0.0.1.nip.io", "127.a.b.c", "host.docker.internal", "10.0.0.5", "db.example.invalid"]) {
      expect(isLoopbackHost(host)).toBe(false);
      expect(databaseTlsProblem(`postgresql://u:p@${host}:5432/postgres`)).toContain("needs sslmode=require");
    }
  });

  it("does not exempt a loopback URL whose ?host= points elsewhere (Prisma connects there instead)", () => {
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?host=db.example.invalid")).toContain("needs sslmode=require");
    expect(databaseTlsProblem("postgresql://u:p@127.0.0.1:5432/postgres?host=127.0.0.1&host=10.0.0.5")).toContain("needs sslmode=require");
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?hostaddr=10.0.0.5")).toContain("needs sslmode=require");
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?HOST=db.example.invalid")).toContain("needs sslmode=require");
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?h%6Fstaddr=10.0.0.5")).toContain("needs sslmode=require");
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?hostaddr=127.0.0.1")).toBeNull();
    expect(databaseTlsProblem("postgresql://u:p@localhost:5432/postgres?host=127.0.0.1")).toBeNull();
    expect(databaseTlsProblem("postgresql://u@localhost/postgres?host=/var/run/postgresql")).toBeNull();
  });
});
