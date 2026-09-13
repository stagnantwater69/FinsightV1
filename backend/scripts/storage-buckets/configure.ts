import {
  BUCKET_CONTRACTS,
  StorageOperatorError,
  bucketMatchesContract,
  bucketSettings,
  createStorageAdmin,
  getRequiredBucket,
  loadStorageOperatorEnvironment,
  writeFailure,
} from "./contract";

const COMMAND = "storage:buckets:configure";
const HELP = `Usage: npm run ${COMMAND} -- --apply

Required environment:
  SUPABASE_URL
  SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_STORAGE_BUCKET=receipts

This command updates only the existing receipts and csv-imports buckets.
It never creates a bucket and never touches avatars.`;

function requiresApply(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "--apply";
}

export async function main(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(HELP);
    return 0;
  }
  if (!requiresApply(argv)) throw new StorageOperatorError("EXPLICIT_APPLY_REQUIRED");

  const operatorEnvironment = loadStorageOperatorEnvironment(environment, { requireDirectUrl: false });
  const storageAdmin = createStorageAdmin(operatorEnvironment);

  // Resolve every target before the first update so a missing second bucket cannot cause a partial run.
  const preflight = await Promise.all(
    BUCKET_CONTRACTS.map(async (contract) => ({
      contract,
      bucket: await getRequiredBucket(storageAdmin, contract),
    })),
  );

  let updatedCount = 0;
  let unchangedCount = 0;
  for (const { contract, bucket } of preflight) {
    if (bucketMatchesContract(bucket, contract)) {
      unchangedCount++;
      continue;
    }

    const { error } = await storageAdmin.storage.updateBucket(contract.id, {
      public: contract.public,
      fileSizeLimit: contract.fileSizeLimit,
      allowedMimeTypes: [...contract.allowedMimeTypes],
    });
    if (error) {
      const httpStatus =
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : undefined;
      throw new StorageOperatorError("STORAGE_BUCKET_UPDATE_FAILED", {
        bucket: contract.id,
        httpStatus,
      });
    }
    updatedCount++;
  }

  const finalSettings = [];
  for (const contract of BUCKET_CONTRACTS) {
    const bucket = await getRequiredBucket(storageAdmin, contract);
    if (!bucketMatchesContract(bucket, contract)) {
      throw new StorageOperatorError("STORAGE_BUCKET_POST_UPDATE_MISMATCH", {
        bucket: contract.id,
      });
    }
    finalSettings.push(bucketSettings(bucket));
  }

  console.log(
    JSON.stringify({
      command: COMMAND,
      status: "ok",
      bucketCount: finalSettings.length,
      updatedCount,
      unchangedCount,
      buckets: finalSettings,
    }),
  );
  return 0;
}

if (require.main === module) {
  void main(process.argv.slice(2), process.env)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      writeFailure(COMMAND, error);
      process.exitCode = 1;
    });
}
