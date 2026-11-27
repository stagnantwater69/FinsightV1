// Checks the RESTORED stack of run-local-supabase.sh through the real FinSight
// API. Passwords and object hashes come from the source's seed manifest, and
// tokens the source issued from source-tokens.json; everything else is read
// from the restored stack. Lines marked RECORD are observed behaviour, not
// pass/fail.
// Usage: DATABASE_URL=... SUPABASE_URL=... ANON_KEY=... API_PORT=4731 \
//          node verify-app.mjs <manifest> <source-tokens.json>
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { PrismaClient } = require("@prisma/client");
// It deletes every session near the end, so it must be the rehearsal target:
// the runner names its host:port, which must match exactly (not as a substring).
const dbHost = (() => { try { return new URL(process.env.DATABASE_URL ?? "").host; } catch { return ""; } })();
if (!process.env.RR_EXPECT_TARGET || dbHost !== process.env.RR_EXPECT_TARGET) {
  throw new Error("refusing: DATABASE_URL is not the rehearsal target");
}
const db = new PrismaClient();
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sourceTokens = JSON.parse(readFileSync(process.argv[3], "utf8"));
const API = `http://127.0.0.1:${process.env.API_PORT ?? 4731}/api/v1`;
const SB = process.env.SUPABASE_URL;
const ANON = process.env.ANON_KEY;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const objHash = (bucket, key) => manifest.objects.find((o) => o.bucket === bucket && o.key === key)?.sha256;

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
async function call(tok, method, path, body) {
  const res = await fetch(API + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" }, body: body && JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const bytes = async (url, headers = {}) => { const r = await fetch(url, { headers }); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };
const deny = (st) => st === 403 || st === 404;

// --- Auth: real GoTrue sign-in against restored password hashes.
const tokens = {};
for (const u of manifest.users) {
  const r = await call(null, "POST", "/auth/login", { email: u.email, password: u.password });
  tokens[u.userId] = r.json?.session?.access_token;
  check(`${u.email} signs in with the original password`, r.status === 200 && !!tokens[u.userId], `status ${r.status}`);
  const bad = await call(null, "POST", "/auth/login", { email: u.email, password: u.password + "x" });
  check(`${u.email} wrong password refused`, bad.status === 401, `status ${bad.status}`);
}
const [A, B, C] = manifest.users;

// --- Tokens the SOURCE project issued, against the restored one.
const kid = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split(".")[0], "base64url")).kid ?? "(none)"; } catch { return "(unreadable)"; } };
const sourceKid = kid(sourceTokens[A.email].access_token);
const targetKid = kid(tokens[A.userId] ?? "");
check("the target signs with a different key than the source", sourceKid !== targetKid, `source kid ${sourceKid}, target kid ${targetKid}`);
const gotrue = (path, init = {}) => fetch(`${SB}/auth/v1${path}`, { ...init, headers: { apikey: ANON, "content-type": "application/json", ...(init.headers ?? {}) } });
for (const u of manifest.users) {
  const old = sourceTokens[u.email];
  const me = await call(old.access_token, "GET", "/auth/me");
  check(`${u.email}: the source's access token is refused by the API`, me.status === 401, `status ${me.status}`);
  const user = await gotrue("/user", { headers: { authorization: `Bearer ${old.access_token}` } });
  console.log(`RECORD ${u.email}: target Auth /user with the source's access token -> ${user.status}`);
}
// Refresh tokens are opaque rows in auth.refresh_tokens, which the backup
// carries; a new signing key does not touch them.
const refreshed = await gotrue("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: sourceTokens[B.email].refresh_token }) });
const refreshedBody = await refreshed.json().catch(() => ({}));
console.log(`RECORD ${B.email}: the source's refresh token at the target's Auth -> ${refreshed.status}${refreshedBody.access_token ? `, new access token kid ${kid(refreshedBody.access_token)}` : ` (${refreshedBody.error_code ?? refreshedBody.msg ?? "no body"})`}`);
if (refreshedBody.access_token) {
  const me = await call(refreshedBody.access_token, "GET", "/auth/me");
  console.log(`RECORD ${B.email}: that new access token at the API /auth/me -> ${me.status}`);
  const pr = await call(refreshedBody.access_token, "GET", "/business-profiles");
  const ids = (Array.isArray(pr.json) ? pr.json : pr.json?.items ?? []).map((p) => p.id).sort();
  check(`${B.email}: a session refreshed from a restored token still sees only its own profiles`, pr.status !== 200 || JSON.stringify(ids) === JSON.stringify([...B.profiles].sort()), `status ${pr.status} ids ${ids}`);
}

// --- Records through the app, per owner and profile.
for (const u of manifest.users) {
  const t = tokens[u.userId];
  const me = await call(t, "GET", "/auth/me");
  check(`${u.email} GET /auth/me`, me.status === 200 && JSON.stringify(me.json).includes(u.email), `status ${me.status}`);
  const pr = await call(t, "GET", "/business-profiles");
  const ids = (Array.isArray(pr.json) ? pr.json : pr.json?.items ?? []).map((p) => p.id).sort();
  check(`${u.email} sees exactly own profiles`, JSON.stringify(ids) === JSON.stringify([...u.profiles].sort()), `api ${ids} expected ${u.profiles}`);
  for (const pid of u.profiles) {
    for (const type of ["expense", "sales"]) {
      const r = await call(t, "GET", `/records/search?businessProfileId=${pid}&type=${type}&includeTotal=true&limit=100`);
      const want = type === "expense" ? await db.expenseRecord.count({ where: { businessProfileId: pid } }) : await db.salesReferenceRecord.count({ where: { businessProfileId: pid } });
      check(`profile ${pid} ${type} total`, r.status === 200 && r.json?.totalCount === want, `api ${r.json?.totalCount} db ${want}`);
    }
    const dash = await call(t, "GET", `/dashboard/summary?businessProfileId=${pid}&periodDays=0`);
    // The dashboard counts COUNTED_EXPENSE only (financialPosition.service.ts): reviewed, not a duplicate, final.
    const final = { OR: [{ source: "MANUAL_ENTRY" }, { source: "CSV_UPLOAD", importBatch: { is: { processingStatus: "COMPLETE" } } },
      { source: "RECEIPT_SCAN", receiptScan: { is: { confirmationStatus: "Confirmed" } } }] };
    const sum = {
      e: String((await db.expenseRecord.aggregate({ _sum: { amount: true }, where: { businessProfileId: pid, reviewStatus: "Reviewed", duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null, ...final } }))._sum.amount),
      s: String((await db.salesReferenceRecord.aggregate({ _sum: { amount: true }, where: { businessProfileId: pid } }))._sum.amount),
    };
    const flat = JSON.stringify(dash.json ?? {});
    const cents = (v) => Math.round(Number(v) * 100);
    const has = (v, got) => cents(v) === cents(got);
    check(`profile ${pid} all-time dashboard totals`, dash.status === 200 && has(sum.e, dash.json?.overview?.totalExpenses) && has(sum.s, dash.json?.overview?.totalSalesReference), `expenses api ${dash.json?.overview?.totalExpenses} db ${sum.e}; sales api ${dash.json?.overview?.totalSalesReference} db ${sum.s}`);
  }
}

// --- Signed URLs minted by the restored stack, bytes checked against the source.
const aPid = A.profiles[0];
const receiptExp = await db.expenseRecord.findFirst({ where: { businessProfileId: aPid, source: "RECEIPT_SCAN" }, include: { receiptScan: true }, orderBy: { id: "asc" } });
const csvExp = await db.expenseRecord.findFirst({ where: { businessProfileId: aPid, source: "CSV_UPLOAD" }, include: { importBatch: true }, orderBy: { id: "asc" } });
let r = await call(tokens[A.userId], "GET", `/records/expenses/${receiptExp.id}`);
const imageUrl = r.json?.origin?.imageUrl;
check("A's receipt expense returns a signed image URL", r.status === 200 && typeof imageUrl === "string" && imageUrl.includes("/object/sign/"), `status ${r.status}`);
let got = imageUrl ? await bytes(imageUrl) : { status: 0, body: Buffer.alloc(0) };
check("signed receipt URL serves the original bytes", got.status === 200 && sha(got.body) === objHash("receipts", receiptExp.receiptScan.imageFile), `status ${got.status} ${got.body.length} bytes`);
r = await call(tokens[A.userId], "GET", `/records/expenses/${csvExp.id}`);
const fileUrl = r.json?.origin?.fileUrl;
got = fileUrl ? await bytes(fileUrl) : { status: 0, body: Buffer.alloc(0) };
check("signed CSV URL serves the original bytes", got.status === 200 && sha(got.body) === objHash("csv-imports", csvExp.importBatch.fileReference), `status ${got.status}`);
// Stored as full URLs on the old project's host; the runner rewrote them (runbook §6.2).
const images = [
  ...(await db.user.findMany({ where: { avatarUrl: { not: null } } })).map((u) => u.avatarUrl),
  ...(await db.businessProfile.findMany({ where: { logoUrl: { not: null } } })).map((p) => p.logoUrl),
];
const publicPrefix = `${SB}/storage/v1/object/public/avatars/`;
const badImages = [];
for (const url of images) {
  got = url.startsWith(publicPrefix) ? await bytes(url) : { status: 0, body: Buffer.alloc(0) };
  if (got.status !== 200 || sha(got.body) !== objHash("avatars", decodeURIComponent(url.slice(publicPrefix.length)))) badImages.push(url.slice(0, 60));
}
check("every avatar and logo URL is on the target's host and serves the original bytes", images.length === manifest.users.length + manifest.users.reduce((n, u) => n + u.profiles.length, 0) && badImages.length === 0,
  `${images.length} URLs${badImages.length ? `, failing: ${badImages.slice(0, 2).join(" ")}` : ""}`);

// --- Negative checks across users, profiles and Storage.
const aProfile = aPid;
const aSecond = A.profiles[1];
for (const [what, path] of [
  ["profile", `/business-profiles/${aProfile}`], ["receipt expense (no signed URL)", `/records/expenses/${receiptExp.id}`],
  ["CSV expense", `/records/expenses/${csvExp.id}`], ["record list", `/records/search?businessProfileId=${aProfile}&type=all`],
  ["dashboard", `/dashboard/summary?businessProfileId=${aSecond}`], ["receipt scan", `/records/receipts/${receiptExp.receiptScanId}`],
]) {
  const res = await call(tokens[B.userId], "GET", path);
  check(`B cannot read A's ${what}`, deny(res.status) && !JSON.stringify(res.json ?? {}).includes("/object/sign/"), `status ${res.status}`);
}
r = await call(tokens[C.userId], "PATCH", `/records/expenses/${receiptExp.id}`, { description: "hijack" });
check("C cannot edit A's expense", deny(r.status), `status ${r.status}`);
r = await call(tokens[B.userId], "POST", "/records/expenses", { businessProfileId: aProfile, categoryId: receiptExp.categoryId, date: "2026-11-20", description: "x", amount: 1 });
check("B cannot create a record in A's profile", deny(r.status) || r.status === 400, `status ${r.status}`);
const key = receiptExp.receiptScan.imageFile;
got = await bytes(`${SB}/storage/v1/object/public/receipts/${key}`);
check("private receipt not served as public", got.status !== 200, `status ${got.status}`);
got = await bytes(`${SB}/storage/v1/object/receipts/${key}`, { apikey: ANON, authorization: `Bearer ${ANON}` });
check("anon key cannot download a receipt", got.status !== 200, `status ${got.status}`);
got = await bytes(`${SB}/storage/v1/object/receipts/${key}`, { apikey: ANON, authorization: `Bearer ${tokens[B.userId]}` });
check("a signed-in owner's JWT cannot download directly from Storage", got.status !== 200, `status ${got.status}`);
if (imageUrl) {
  const otherKey = (await db.receiptScan.findFirst({ where: { businessProfileId: B.profiles[0] } })).imageFile;
  got = await bytes(imageUrl.replace(encodeURI(key), encodeURI(otherKey)));
  check("A's signed token does not open B's object", got.status !== 200, `status ${got.status}`);
}
const list = await fetch(`${SB}/storage/v1/object/list/receipts`, { method: "POST", headers: { apikey: ANON, authorization: `Bearer ${tokens[A.userId]}`, "content-type": "application/json" }, body: JSON.stringify({ prefix: `${aProfile}/` }) });
const listed = await list.json().catch(() => null);
check("owner JWT cannot list receipt objects", !Array.isArray(listed) || listed.length === 0, `status ${list.status} items ${Array.isArray(listed) ? listed.length : "-"}`);

// --- Deny-all RLS through the Data API.
for (const [who, bearer] of [["anon", ANON], ["signed-in owner", tokens[A.userId]]]) {
  for (const table of ["ExpenseRecord", "User", "BusinessProfile", "ReceiptScan"]) {
    const res = await fetch(`${SB}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: ANON, authorization: `Bearer ${bearer}` } });
    const body = await res.json().catch(() => null);
    check(`Data API: ${who} gets no ${table} rows`, !(Array.isArray(body) && body.length > 0), `status ${res.status}`);
  }
}

// --- The restored database takes writes, and sign-out ends the session.
const cat = await db.expenseCategory.findFirst({ where: { businessProfileId: aProfile } });
r = await call(tokens[A.userId], "POST", "/records/expenses", { businessProfileId: aProfile, categoryId: cat.id, date: "2026-11-20", description: "Post-restore write", amount: 123.45 });
check("A creates an expense on the restored stack", r.status === 201, `status ${r.status} id ${r.json?.id}`);
r = await call(tokens[C.userId], "POST", "/auth/logout");
const after = await call(tokens[C.userId], "GET", "/auth/me");
check("after logout C's token is refused", after.status === 401, `logout ${r.status}, then ${after.status}`);
const cRefresh = await gotrue("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: sourceTokens[C.email].refresh_token }) });
console.log(`RECORD ${C.email}: after signing out on the target, the source's refresh token -> ${cRefresh.status}`);

// The runbook's "Sessions after a restore" revoke (§6.1 Step 3), as written there.
await db.$executeRawUnsafe("DELETE FROM auth.refresh_tokens");
await db.$executeRawUnsafe("DELETE FROM auth.sessions");
const [left] = await db.$queryRawUnsafe("SELECT (SELECT count(*) FROM auth.refresh_tokens)::int AS refresh, (SELECT count(*) FROM auth.sessions)::int AS sessions");
check("the runbook's session revoke leaves no sessions or refresh tokens", left.refresh === 0 && left.sessions === 0, JSON.stringify(left));
const aRefresh = await gotrue("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: sourceTokens[A.email].refresh_token }) });
check(`${A.email}: after the revoke, the source's refresh token is refused`, aRefresh.status !== 200, `status ${aRefresh.status}`);
// The API remembers a verified token for 30 s (backend/src/lib/verifiedTokenCache.ts),
// so a revoke made in SQL rather than through the API lands after that.
console.log(`RECORD ${A.email}: right after the revoke, a token from a target sign-in at the API -> ${(await call(tokens[A.userId], "GET", "/auth/me")).status}`);
await new Promise((resolve) => setTimeout(resolve, 31_000));
if (refreshedBody.access_token) {
  const me = await call(refreshedBody.access_token, "GET", "/auth/me");
  check(`${B.email}: 31 s after the revoke, the session refreshed from a restored token is refused`, me.status === 401, `status ${me.status}`);
}
const aOld = await call(tokens[A.userId], "GET", "/auth/me");
check(`${A.email}: 31 s after the revoke, a token from a target sign-in is refused`, aOld.status === 401, `status ${aOld.status}`);
const relogin = await call(null, "POST", "/auth/login", { email: A.email, password: A.password });
check(`${A.email}: signs in again after the revoke`, relogin.status === 200, `status ${relogin.status}`);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await db.$disconnect();
process.exit(failed ? 1 : 0);
