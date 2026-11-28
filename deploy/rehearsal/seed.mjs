// Synthetic fixture for the SOURCE stack of run-local-supabase.sh. Users
// through GoTrue's admin API, objects through Storage's API, records through
// Prisma. Writes a manifest (passwords, object hashes) for verify-app.mjs.
// Refuses anything but the rehearsal stack's own loopback ports.
// Usage: DATABASE_URL=... SUPABASE_URL=... SERVICE_KEY=... node seed.mjs <manifest-out>
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const { PrismaClient, Prisma } = require("@prisma/client");
const { createClient } = require("@supabase/supabase-js");
for (const [k, v] of Object.entries({ DATABASE_URL: process.env.DATABASE_URL, SUPABASE_URL: process.env.SUPABASE_URL })) {
  if (!/127\.0\.0\.1:5473[12]\b/.test(v ?? "")) throw new Error(`refusing: ${k} is not the rehearsal stack`);
}
const prisma = new PrismaClient();
const sb = createClient(process.env.SUPABASE_URL, process.env.SERVICE_KEY, { auth: { persistSession: false } });

let s = 20261127;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const uuid = () => {
  const h = [...Array(32)].map(() => int(0, 15).toString(16));
  h[12] = "4"; h[16] = "89ab"[int(0, 3)];
  const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const money = (lo, hi) => new Prisma.Decimal((int(lo * 100, hi * 100) / 100).toFixed(2));
const day = () => new Date(Date.UTC(2026, int(0, 9), int(1, 28)));
const jpeg = () => {
  const b = Buffer.alloc(int(2_500, 37_500) * 4);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE(int(0, 2 ** 31), i);
  b.write("\xff\xd8\xff\xe0", 0, "latin1");
  return b;
};
const png = (text) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(text)]);
const publicUrl = (key) => sb.storage.from("avatars").getPublicUrl(key).data.publicUrl;
const manifest = { users: [], objects: [] };
async function put(bucket, key, bytes, contentType) {
  const { error } = await sb.storage.from(bucket).upload(key, bytes, { contentType, upsert: false });
  if (error) throw new Error(`upload ${bucket}/${key}: ${error.message}`);
  manifest.objects.push({ bucket, key, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, contentType });
}

// The bucket contract from docs/deployment-runbook.md §6.2.
for (const [id, opts] of [
  ["receipts", { public: false, fileSizeLimit: 10485760, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] }],
  ["csv-imports", { public: false, fileSizeLimit: 5242880, allowedMimeTypes: ["text/csv"] }],
  ["avatars", { public: true }],
]) {
  const { error } = await sb.storage.createBucket(id, opts);
  if (error) throw new Error(`bucket ${id}: ${error.message}`);
}

const owners = [
  { first: "Alma", last: "Reyes", email: "rr-alma@example.test", profiles: 2 },
  { first: "Ben", last: "Cruz", email: "rr-ben@example.test", profiles: 2 },
  { first: "Carla", last: "Santos", email: "rr-carla@example.test", profiles: 1 },
];
for (const o of owners) {
  const password = `rr-pass-${o.first}-2026!`;
  const { data, error } = await sb.auth.admin.createUser({ email: o.email, password, email_confirm: true, user_metadata: { first_name: o.first } });
  if (error) throw new Error(`createUser ${o.email}: ${error.message}`);
  const authId = data.user.id;
  let user = await prisma.user.create({ data: { authId, firstName: o.first, lastName: o.last, email: o.email } });
  // Keys as storage.service.ts names them, so publicImagePathFromUrl reads them.
  const avatarKey = `users/${user.id}.${uuid()}`;
  await put("avatars", avatarKey, png(o.email), "image/png");
  user = await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: publicUrl(avatarKey) } });
  const entry = { email: o.email, password, authId, userId: user.id, profiles: [] };
  manifest.users.push(entry);

  for (let p = 0; p < o.profiles; p++) {
    const profile = await prisma.businessProfile.create({
      data: { userId: user.id, name: `${o.first}'s ${["Carinderia", "Sari-sari"][p]}`, type: "Food",
        availableFunds: money(20000, 90000), expectedMonthlyExpenses: money(15000, 60000), operatingDays: 26 },
    });
    entry.profiles.push(profile.id);
    const logoKey = `businesses/${profile.id}.${uuid()}`;
    await put("avatars", logoKey, png(profile.name), "image/png");
    await prisma.businessProfile.update({ where: { id: profile.id }, data: { logoUrl: publicUrl(logoKey) } });
    const cats = [];
    for (const name of ["Ingredients", "Rent", "Utilities", "Wages", "Packaging", "Transport"]) {
      cats.push(await prisma.expenseCategory.create({ data: { businessProfileId: profile.id, name } }));
    }
    const scans = [];
    for (let r = 0; r < 12; r++) {
      const key = `${profile.id}/${uuid()}.jpg`;
      const bytes = jpeg();
      await put("receipts", key, bytes, "image/jpeg");
      const scan = await prisma.receiptScan.create({ data: {
        businessProfileId: profile.id, imageFile: key, extractedAmount: money(50, 4000), extractedVendor: `Vendor ${r}`,
        extractedDate: day(), processingStatus: "Complete", confirmationStatus: "Confirmed" } });
      await prisma.receiptScanPage.create({ data: { receiptScanId: scan.id, pageNumber: 1, imageFile: key } });
      if (r < 4) { // a second page, its own object
        const key2 = `${profile.id}/${uuid()}.jpg`;
        await put("receipts", key2, jpeg(), "image/jpeg");
        await prisma.receiptScanPage.create({ data: { receiptScanId: scan.id, pageNumber: 2, imageFile: key2 } });
      }
      scans.push(scan);
    }
    const csvKey = `${profile.id}/${uuid()}-ledger.csv`;
    await put("csv-imports", csvKey, Buffer.from("date,description,amount\n2026-01-05,Rice,1200.00\n"), "text/csv");
    const batch = await prisma.cSVImportBatch.create({ data: { businessProfileId: profile.id, title: "Ledger import", uploadDate: day(), fileReference: csvKey } });

    const expenses = [];
    for (let e = 0; e < 400; e++) {
      const scan = e < scans.length ? scans[e] : null;
      const csv = !scan && e < 40;
      expenses.push({
        businessProfileId: profile.id, categoryId: cats[int(0, 5)].id, receiptScanId: scan?.id ?? null, importBatchId: csv ? batch.id : null,
        date: scan?.extractedDate ?? day(), description: `Expense ${e} ñ “synthetic”`, vendor: scan?.extractedVendor ?? `Supplier ${int(1, 30)}`,
        amount: scan?.extractedAmount ?? money(5, 5000), source: scan ? "RECEIPT_SCAN" : csv ? "CSV_UPLOAD" : "MANUAL_ENTRY", reviewStatus: "Reviewed",
      });
    }
    await prisma.expenseRecord.createMany({ data: expenses });
    const sales = [];
    for (let i = 0; i < 200; i++) sales.push({ businessProfileId: profile.id, date: day(), description: `Daily sales ${i}`, amount: money(500, 15000), source: "MANUAL_ENTRY", reviewStatus: "Reviewed" });
    await prisma.salesReferenceRecord.createMany({ data: sales });
  }
}
writeFileSync(process.argv[2], JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({
  authUsers: manifest.users.length, profiles: await prisma.businessProfile.count(), expenses: await prisma.expenseRecord.count(),
  sales: await prisma.salesReferenceRecord.count(), scans: await prisma.receiptScan.count(), pages: await prisma.receiptScanPage.count(),
  csvBatches: await prisma.cSVImportBatch.count(), objects: manifest.objects.length,
  bytes: manifest.objects.reduce((a, o) => a + o.size, 0),
}));
await prisma.$disconnect();
