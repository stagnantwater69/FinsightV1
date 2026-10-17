import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { guardBrowserFixture } from "./guard";
import { cleanOwnedResources, runOwnedProcess } from "./ownedProcess";

const controls = vi.hoisted(() => ({ identities: new Map<string, string>(), providerCalls: 0 }));
vi.mock("../../src/config/supabase", async (original) => ({
  ...await original<typeof import("../../src/config/supabase")>(),
  supabaseAdmin: { auth: { getUser: async (token: string) => {
    const id = controls.identities.get(token);
    return { data: { user: id ? { id } : null }, error: id ? null : { message: "Invalid synthetic fixture token", status: 401 } };
  } } },
}));
vi.mock("../../src/services/ai.service", async (original) => ({
  ...await original<typeof import("../../src/services/ai.service")>(),
  askFinSight: async () => {
    controls.providerCalls++;
    return { answer: "Review your recorded expenses before your next purchase.", provider: "gemini" };
  },
}));

const repoRoot = path.resolve(__dirname, "../../..");
const initialCwd = process.cwd();
const scratch = mkdtempSync(path.join(process.env.FINSIGHT_VERIFICATION_OUTPUT ?? tmpdir(), "finsight-local-api-"));
const fixtureAccess = randomUUID();
let apiServer: http.Server | undefined;
let webServer: http.Server | undefined;
let vite: { close: () => Promise<void> } | undefined;
let db: typeof import("../../src/config/prisma").prisma | undefined;
let reset: (() => Promise<void>) | undefined;
let fixturePath: string;
let webOrigin: string;
const externalRequests: string[] = [];

function tokenFor(authId: string, email: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: authId, email, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 86_400 })}.synthetic-local-signature`;
}

beforeAll(async () => {
  guardBrowserFixture(process.env);
  apiServer = http.createServer();
  await new Promise<void>((resolve, reject) => {
    apiServer!.once("error", reject);
    apiServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = apiServer.address();
  if (!address || typeof address === "string") throw new Error("Owned API did not bind loopback");
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  process.env.VITE_API_BASE_URL = `${apiOrigin}/api/v1`;
  process.env.VITE_SUPABASE_URL = apiOrigin;
  process.env.VITE_SUPABASE_ANON_KEY = "synthetic-local-only";
  // Tailwind resolves its existing configuration from the web package's working directory.
  process.chdir(path.join(repoRoot, "web"));
  const { createServer } = await import("../../../web/node_modules/vite/dist/node/index.js");
  webServer = http.createServer();
  await new Promise<void>((resolve, reject) => {
    webServer!.once("error", reject);
    webServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const dev = await createServer({ root: path.join(repoRoot, "web"), mode: "development", envDir: false,
    server: { middlewareMode: true, hmr: false, host: "127.0.0.1",
      proxy: { "/api": { target: apiOrigin, changeOrigin: false } }, allowedHosts: ["127.0.0.1"] } });
  vite = dev;
  webServer.on("request", dev.middlewares);
  const webAddress = webServer.address();
  if (!webAddress || typeof webAddress === "string") throw new Error("Owned Vite did not bind loopback");
  webOrigin = `http://127.0.0.1:${webAddress.port}`;
  process.env.CORS_ORIGIN = webOrigin;
  process.env.WEB_APP_URL = webOrigin;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (![apiOrigin, webOrigin].includes(url.origin)) {
      externalRequests.push(`${url.origin}${url.pathname}`);
      throw new Error("External transport is forbidden in the local browser fixture");
    }
    return realFetch(input, init);
  });
  const setup = await import("../setup/testDb");
  const prismaModule = await import("../../src/config/prisma");
  db = prismaModule.prisma;
  reset = setup.resetDb;
  await setup.resetDb();
  const ownerA = await setup.makeOwnerWithProfile({ name: "Local fixture A", availableFunds: 50_000 }, ["Inventory"]);
  const ownerB = await setup.makeOwnerWithProfile({ name: "Local fixture B" }, ["Inventory"]);
  const owners = [ownerA, ownerB].map((owner) => {
    const token = tokenFor(owner.user.authId, owner.user.email);
    controls.identities.set(token, owner.user.authId);
    return { id: owner.user.id, authId: owner.user.authId, email: owner.user.email, token,
      businessProfileId: owner.profile.id, categoryId: owner.categories.Inventory };
  });
  const { app } = await import("../../src/app");
  const fixture = express();
  fixture.get("/__qa/state", async (req, res, next) => {
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers["x-fixture-access"] !== fixtureAccess) {
      res.status(404).end(); return;
    }
    try {
      const [records, manualRequests, chats, messages, limits] = await Promise.all([
        db!.expenseRecord.findMany(), db!.manualRecordCreateRequest.count(), db!.chatSendRequest.findMany(),
        db!.chatMessage.count(), db!.apiRateLimit.findMany(),
      ]);
      res.json({ records: records.map((record) => ({ id: record.id, businessProfileId: record.businessProfileId,
        categoryId: record.categoryId, description: record.description, amount: record.amount.toFixed(2) })),
        manualRequests, chats: chats.map((chat) => ({ status: chat.status, userId: chat.userId,
          businessProfileId: chat.businessProfileId, conversationId: chat.conversationId })),
        messages, providerCalls: controls.providerCalls, limits: limits.map((limit) => ({ key: limit.key, count: limit.count })) });
    } catch (error) { next(error); }
  });
  fixture.use(app);
  apiServer.on("request", fixture);
  expect((await realFetch(`${apiOrigin}/api/v1/health/live`)).status).toBe(200);
  fixturePath = path.join(scratch, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ apiOrigin, webOrigin, fixtureAccess, owners, today: setup.businessDayString("Asia/Manila") }), { flag: "wx" });
}, 60_000);

afterAll(async () => {
  try {
    await cleanOwnedResources([
      async () => {
        if (!webServer) return;
        webServer.closeAllConnections();
        await new Promise<void>((resolve) => webServer!.close(() => resolve()));
      },
      async () => { await vite?.close(); },
      async () => {
        if (!apiServer) return;
        apiServer.closeAllConnections();
        await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
      },
      async () => { await reset?.(); },
      async () => { await db?.$disconnect(); },
    ]);
  } finally { vi.unstubAllGlobals(); process.chdir(initialCwd); }
}, 60_000);

it("runs the real local API/database browser journeys", async () => {
  const result = await runOwnedProcess(process.execPath, [path.join(__dirname, "playwrightRunner.mjs"),
    path.join(repoRoot, "web/node_modules/@playwright/test/cli.js"), "test",
    "--config", path.join(repoRoot, "web/e2e/local-api/playwright.config.ts")], {
    cwd: path.join(repoRoot, "web"), timeoutMs: 150_000,
    env: { ...process.env, FINSIGHT_LOCAL_BROWSER_FIXTURE: fixturePath, FINSIGHT_LOCAL_BROWSER_ORIGIN: webOrigin,
      FINSIGHT_LOCAL_BROWSER_OUTPUT: path.join(scratch, "browser"), FINSIGHT_LOCAL_BROWSER_RESULTS: path.join(scratch, "browser-results.json") },
  });
  writeFileSync(path.join(scratch, "browser.log"), result.output, { flag: "wx" });
  console.log(`Local browser evidence: ${scratch}`);
  expect(result.timedOut, result.output).toBe(false);
  expect(result.exit, result.output).toBe(0);
  const results = JSON.parse(readFileSync(path.join(scratch, "browser-results.json"), "utf8"));
  expect(results.stats).toMatchObject({ expected: 3, unexpected: 0, skipped: 0, flaky: 0 });
  expect(externalRequests).toEqual([]);
}, 180_000);
