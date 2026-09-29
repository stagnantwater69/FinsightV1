import { prisma } from "../src/config/prisma";
import { reconcileCsvStorageProfile } from "../src/services/csvStorageReconciliation.service";

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: tsx scripts/reconcile-csv-storage.ts --profile-id ID [--delete] [--max-objects 500] [--offset 0] [--grace-days 7]\n" +
      "Audit is the default. --delete queues eligible objects for the durable Storage purge worker.\n",
    );
    return;
  }
  const profileId = Number(argument("--profile-id"));
  const maxObjects = argument("--max-objects");
  const offset = argument("--offset");
  const graceDays = argument("--grace-days");
  const result = await reconcileCsvStorageProfile({
    businessProfileId: profileId,
    delete: process.argv.includes("--delete"),
    ...(maxObjects === undefined ? {} : { maxObjects: Number(maxObjects) }),
    ...(offset === undefined ? {} : { offset: Number(offset) }),
    ...(graceDays === undefined ? {} : { graceDays: Number(graceDays) }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "CSV Storage reconciliation failed"}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
