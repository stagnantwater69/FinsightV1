/**
 * Local stand-in for Supabase Auth + Storage, for load testing only.
 *
 * The API calls supabaseAdmin.auth.getUser(token) on EVERY authenticated
 * request. Pointing SUPABASE_URL here keeps the load test off the hosted
 * project entirely: no third-party traffic, no auth rate limits, no cost.
 *
 * The token IS the auth id: a deterministic UUID, because User.authId is a
 * uuid column. The seeder writes User rows with the same ids. Nothing here
 * validates a signature — that is the point: this process exists so the test
 * measures FinSight, not Supabase.
 *
 * LATENCY: set STUB_LATENCY_MS to model the real round trip. Zero by default
 * so a baseline run isolates FinSight's own cost.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 54321);
const LATENCY = Number(process.env.STUB_LATENCY_MS ?? 0);
const CSV_STORAGE_ENABLED = process.env.STUB_CSV_STORAGE === "true";
const csvObjects = new Map();

let calls = 0;

const server = createServer((req, res) => {
  calls += 1;
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  const respond = (code, body) => {
    const send = () => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (LATENCY > 0) setTimeout(send, LATENCY);
    else send();
  };

  if (url.pathname === "/__stub/stats") {
    return respond(200, { calls, latencyMs: LATENCY });
  }

  // supabase-js calls GET /auth/v1/user with the bearer token.
  if (url.pathname === "/auth/v1/user") {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!/^00000000-0000-4000-8000-\d{12}$/.test(token)) {
      return respond(401, { error: "invalid token", message: "invalid token" });
    }
    return respond(200, {
      id: token,
      aud: "authenticated",
      role: "authenticated",
      email: `u${token.slice(-12)}@loadtest.invalid`,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    });
  }

  if (CSV_STORAGE_ENABLED && url.pathname.startsWith("/storage/v1/object/csv-imports")) {
    const objectPrefix = "/storage/v1/object/csv-imports/";
    let objectPath = null;
    try {
      if (url.pathname.startsWith(objectPrefix)) {
        objectPath = decodeURIComponent(url.pathname.slice(objectPrefix.length));
      }
    } catch {
      return respond(400, { error: "invalid CSV object path" });
    }
    if (objectPath && !/^\d+\/[A-Za-z0-9._-]+$/.test(objectPath)) {
      return respond(400, { error: "invalid CSV object path" });
    }
    if (req.method === "POST" && objectPath) {
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on("data", (chunk) => {
        if (rejected) return;
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          rejected = true;
          respond(413, { error: "CSV object too large" });
        } else chunks.push(chunk);
      });
      req.on("end", () => {
        if (rejected) return;
        if (csvObjects.has(objectPath)) return respond(409, { error: "object already exists" });
        csvObjects.set(objectPath, Buffer.concat(chunks));
        respond(200, { Id: objectPath, Key: `csv-imports/${objectPath}` });
      });
      return;
    }
    if (req.method === "GET" && objectPath) {
      const data = csvObjects.get(objectPath);
      if (!data) return respond(404, { error: "object not found" });
      res.writeHead(200, { "content-type": "text/csv", "content-length": data.length });
      res.end(data);
      return;
    }
    if (req.method === "DELETE" && objectPath === null) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let paths;
        try {
          paths = JSON.parse(Buffer.concat(chunks).toString("utf8")).prefixes;
        } catch {
          return respond(400, { error: "invalid delete request" });
        }
        if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
          return respond(400, { error: "invalid delete request" });
        }
        for (const path of paths) csvObjects.delete(path);
        respond(200, []);
      });
      return;
    }
  }

  // Other Storage and admin calls fail loudly so the benchmark cannot silently expand its scope.
  respond(501, { error: "not implemented in load-test stub", path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`supabase stub on http://127.0.0.1:${PORT} latency=${LATENCY}ms`);
});
