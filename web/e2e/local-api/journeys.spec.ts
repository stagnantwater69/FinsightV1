import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

type Owner = { id: number; authId: string; email: string; token: string; businessProfileId: number; categoryId: number };
type Fixture = { apiOrigin: string; webOrigin: string; fixtureAccess: string; owners: Owner[]; today: string };
const source = process.env.FINSIGHT_LOCAL_BROWSER_FIXTURE;
if (!source) throw new Error("Owned local API fixture metadata is required");
const fixture = JSON.parse(readFileSync(source, "utf8")) as Fixture;
for (const origin of [fixture.apiOrigin, fixture.webOrigin]) {
  if (new URL(origin).hostname !== "127.0.0.1") throw new Error("Fixture origins must be loopback");
}
const [owner, other] = fixture.owners as [Owner, Owner];
const api = `${fixture.apiOrigin}/api/v1`;
let external: string[];

async function state(request: APIRequestContext) {
  const response = await request.get(`${fixture.apiOrigin}/__qa/state`, { headers: { "x-fixture-access": fixture.fixtureAccess } });
  expect(response.status()).toBe(200);
  return response.json();
}

async function openChat(page: Page) {
  const search = page.getByRole("combobox", { name: "Search FinSight" }).filter({ visible: true });
  await search.fill("ask"); await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "Ask FinSight" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  external = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ([fixture.apiOrigin, fixture.webOrigin].includes(url.origin)) return route.continue();
    external.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  await page.addInitScript((account) => {
    const session = { access_token: account.token, refresh_token: "synthetic-local-refresh", token_type: "bearer",
      expires_at: Math.floor(Date.now() / 1000) + 86_400, expires_in: 86_400,
      user: { id: account.authId, email: account.email, aud: "authenticated", role: "authenticated" } };
    localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
    localStorage.setItem(`finsight.tour.${account.id}`, JSON.stringify({ status: "completed" }));
  }, owner);
});
test.afterEach(() => expect(external).toEqual([]));

test("expense UI persists exact cents/category and replays without a duplicate financial row", async ({ page, request }) => {
  let body: Record<string, unknown> | undefined;
  page.on("request", (req) => {
    if (req.url() === `${api}/records/expenses` && req.method() === "POST") body = req.postDataJSON();
  });
  await page.goto("/records/expenses/new");
  await expect(page.getByRole("heading", { name: "Add expense", exact: true })).toBeVisible();
  await page.locator("#category").selectOption(String(owner.categoryId));
  await page.locator("#description").fill("Local browser stock purchase");
  await page.locator("#vendor").fill("Synthetic supplier");
  await page.locator("#amount").fill("1234.56");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await expect(page.getByText("That's your first expense recorded", { exact: true })).toBeVisible();
  const saved = await state(request);
  expect(saved.records).toHaveLength(1);
  expect(saved.records[0]).toMatchObject({ businessProfileId: owner.businessProfileId, categoryId: owner.categoryId,
    amount: "1234.56", description: "Local browser stock purchase" });
  expect(saved.manualRequests).toBe(1);
  expect(body).toMatchObject({ businessProfileId: owner.businessProfileId, categoryId: owner.categoryId, amount: 1234.56 });
  expect(body?.idempotencyKey).toEqual(expect.any(String));
  const replay = await request.post(`${api}/records/expenses`, { headers: { Authorization: `Bearer ${owner.token}` }, data: body });
  expect(replay.status()).toBe(201);
  expect((await replay.json()).id).toBe(saved.records[0].id);
  expect((await state(request)).records).toHaveLength(1);
  await page.goto(`/records/expenses/${saved.records[0].id}/edit`);
  await expect(page.locator("#amount")).toHaveValue("1234.56");
  await expect(page.locator("#category")).toHaveValue(String(owner.categoryId));
  await page.reload();
  await expect(page.locator("#description")).toHaveValue("Local browser stock purchase");
});

test("real ownership, bearer refusal and durable write cooldown are enforced by the API", async ({ request }) => {
  const saved = await state(request);
  const own = await request.post(`${api}/records/expenses`, { headers: { Authorization: `Bearer ${owner.token}` },
    data: { businessProfileId: owner.businessProfileId, categoryId: owner.categoryId, date: fixture.today,
      amount: 12.34, description: "Ownership fixture expense", idempotencyKey: "local-ownership-fixture-key" } });
  expect(own.status()).toBe(201);
  const recordId = (await own.json()).id;
  const unknown = await request.get(`${api}/records/expenses/${recordId}`, { headers: { Authorization: "Bearer unknown-synthetic" } });
  expect(unknown.status()).toBe(401);
  const foreign = await request.get(`${api}/records/expenses/${recordId}`, { headers: { Authorization: `Bearer ${other.token}` } });
  expect(foreign.status()).toBe(404);
  expect(await foreign.json()).not.toHaveProperty("amount");
  for (let index = 0; index < 120; index++) {
    const rejected = await request.post(`${api}/records/expenses`, { headers: { Authorization: `Bearer ${other.token}` }, data: {} });
    expect(rejected.status()).toBe(400);
  }
  const limited = await request.post(`${api}/records/expenses`, { headers: { Authorization: `Bearer ${other.token}` }, data: {} });
  expect(limited.status()).toBe(429);
  const error = await limited.json();
  expect(error.code).toBe("RATE_LIMITED");
  expect(error.retryAfterSeconds).toBeGreaterThan(0);
  expect(Number(limited.headers()["retry-after"])).toBe(error.retryAfterSeconds);
  const persisted = await state(request);
  expect(persisted.limits.some((limit: { key: string; count: number }) =>
    limit.key.includes("authenticated-write") && limit.count >= 121)).toBe(true);
  expect(persisted.records).toHaveLength(saved.records.length + 1);
});

test("a committed lost chat response recovers after refresh and replays one immutable send", async ({ page, request }) => {
  let body: Record<string, unknown> | undefined;
  let committed: { conversation: { id: number; title: string }; assistantMessage: { content: string } } | undefined;
  await page.route(`${api}/ai/conversations`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    body = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = await response.json();
    await route.abort("failed");
  });
  await page.goto("/records");
  await openChat(page);
  const composer = page.getByRole("textbox", { name: "Ask about your numbers" });
  await composer.fill("Which recorded expenses should I review?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check answer status", exact: true })).toBeVisible();
  const stored = await state(request);
  expect(stored.providerCalls).toBe(1);
  expect(stored.chats).toHaveLength(1);
  expect(stored.chats[0]).toMatchObject({ status: "COMPLETE", userId: owner.id, businessProfileId: owner.businessProfileId });
  expect(stored.messages).toBe(2);
  const recovery = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("finsight.pendingChatSend."))?.[1]);
  expect(JSON.parse(recovery!).body).toEqual(body);
  await page.reload();
  await openChat(page);
  await composer.fill("Independent draft after refresh");
  await page.getByRole("button", { name: "Check answer status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check answer status", exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Independent draft after refresh");
  await page.getByRole("button", { name: "Chat history", exact: true }).click();
  await page.getByRole("button", { name: committed!.conversation.title, exact: true }).click();
  await expect(page.getByText(committed!.assistantMessage.content, { exact: true })).toBeVisible();
  const replay = await request.post(`${api}/ai/conversations`, { headers: { Authorization: `Bearer ${owner.token}` }, data: body });
  expect(replay.status()).toBe(201);
  expect(await replay.json()).toEqual(committed);
  const final = await state(request);
  expect(final.providerCalls).toBe(1); expect(final.chats).toHaveLength(1); expect(final.messages).toBe(2);
  const foreign = await request.get(`${api}/ai/send-requests/${body!.idempotencyKey}?businessProfileId=${owner.businessProfileId}`,
    { headers: { Authorization: `Bearer ${other.token}` } });
  expect(foreign.status()).toBe(404);
  expect(await foreign.json()).not.toHaveProperty("result");
});
