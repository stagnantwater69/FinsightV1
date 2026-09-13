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

const COMMAND = "storage:buckets:verify";
const HELP = `Usage: npm run ${COMMAND}

Required environment:
  SUPABASE_URL
  SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_STORAGE_BUCKET=receipts
  DIRECT_URL

This command is read-only. It reads bucket settings through the Storage API
and reads PostgreSQL catalogs in a read-only transaction.`;

interface StorageSqlEvidence {
  clientRoleCount: number;
  elevatedClientRoleCount: number;
  storageTableCount: number;
  rlsEnabledTableCount: number;
  forceRlsTableCount: number;
  clientOwnedTableCount: number;
  storagePolicyCount: number;
  clientApplicablePolicyCount: number;
  effectiveClientDmlGrantCount: number;
}

const STORAGE_SECURITY_SQL = `
WITH client_roles AS (
  SELECT oid, rolname, rolsuper, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname IN ('anon', 'authenticated')
),
storage_relations AS (
  SELECT c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'storage'
    AND c.relname IN ('buckets', 'objects')
    AND c.relkind IN ('r', 'p')
),
applicable_policies AS (
  SELECT DISTINCT p.oid
  FROM pg_catalog.pg_policy AS p
  JOIN storage_relations AS relation ON relation.oid = p.polrelid
  WHERE EXISTS (
    SELECT 1
    FROM unnest(p.polroles) AS policy_role(role_oid)
    WHERE policy_role.role_oid = 0
       OR EXISTS (
         SELECT 1
         FROM client_roles AS client_role
         WHERE pg_catalog.pg_has_role(client_role.oid, policy_role.role_oid, 'MEMBER')
       )
  )
),
dml_privileges(privilege_name) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
)
SELECT
  (SELECT count(*)::int FROM client_roles) AS "clientRoleCount",
  (SELECT count(*)::int FROM client_roles WHERE rolsuper OR rolbypassrls) AS "elevatedClientRoleCount",
  (SELECT count(*)::int FROM storage_relations) AS "storageTableCount",
  (SELECT count(*)::int FROM storage_relations WHERE relrowsecurity) AS "rlsEnabledTableCount",
  (SELECT count(*)::int FROM storage_relations WHERE relforcerowsecurity) AS "forceRlsTableCount",
  (
    SELECT count(*)::int
    FROM storage_relations AS relation
    JOIN client_roles AS client_role ON client_role.oid = relation.relowner
  ) AS "clientOwnedTableCount",
  (
    SELECT count(*)::int
    FROM pg_catalog.pg_policy AS policy
    JOIN storage_relations AS relation ON relation.oid = policy.polrelid
  ) AS "storagePolicyCount",
  (SELECT count(*)::int FROM applicable_policies) AS "clientApplicablePolicyCount",
  (
    SELECT count(*)::int
    FROM client_roles AS client_role
    CROSS JOIN storage_relations AS relation
    CROSS JOIN dml_privileges AS privilege
    WHERE pg_catalog.has_table_privilege(
      client_role.oid,
      relation.oid,
      privilege.privilege_name
    )
  ) AS "effectiveClientDmlGrantCount"
`;

async function readStorageSqlEvidence(directUrl: string): Promise<StorageSqlEvidence> {
  // Import only after the operator environment has been captured. This generated client
  // loads backend/.env as a side effect, but it must not satisfy missing CLI credentials.
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: directUrl });
  try {
    return await prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const rows = await transaction.$queryRawUnsafe<StorageSqlEvidence[]>(STORAGE_SECURITY_SQL);
        const evidence = rows[0];
        if (!evidence) throw new StorageOperatorError("STORAGE_SQL_EVIDENCE_MISSING");
        return evidence;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (error) {
    if (error instanceof StorageOperatorError) throw error;
    throw new StorageOperatorError("STORAGE_SQL_VERIFICATION_FAILED");
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

// Supabase owns these tables, so FORCE RLS is not part of its normal Storage posture.
// Client DML grants may also exist because the Storage API needs RLS to decide which
// rows a JWT may use. The deny proof is therefore: RLS is on, neither client role
// owns/bypasses it, and no policy applies to either role. The other counts remain in
// the evidence so a reviewer can spot platform-level privilege changes.
function denyAllFailureCode(evidence: StorageSqlEvidence): string | undefined {
  if (evidence.clientRoleCount !== 2) return "STORAGE_CLIENT_ROLES_MISSING";
  if (evidence.storageTableCount !== 2) return "STORAGE_TABLES_MISSING";
  if (evidence.rlsEnabledTableCount !== 2) return "STORAGE_RLS_DISABLED";
  if (evidence.elevatedClientRoleCount !== 0) {
    return "STORAGE_CLIENT_ROLE_BYPASSES_RLS";
  }
  if (evidence.clientOwnedTableCount !== 0) {
    return "STORAGE_CLIENT_ROLE_OWNS_TABLE";
  }
  if (evidence.clientApplicablePolicyCount !== 0) {
    return "STORAGE_CLIENT_POLICY_PRESENT";
  }
  return undefined;
}

export async function main(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.length !== 0) throw new StorageOperatorError("UNEXPECTED_ARGUMENT");

  const operatorEnvironment = loadStorageOperatorEnvironment(environment, { requireDirectUrl: true });
  const storageAdmin = createStorageAdmin(operatorEnvironment);

  const buckets = [];
  let bucketMismatchCount = 0;
  for (const contract of BUCKET_CONTRACTS) {
    const bucket = await getRequiredBucket(storageAdmin, contract);
    if (!bucketMatchesContract(bucket, contract)) bucketMismatchCount++;
    buckets.push(bucketSettings(bucket));
  }

  const sqlEvidence = await readStorageSqlEvidence(operatorEnvironment.directUrl!);
  const securityFailureCode = denyAllFailureCode(sqlEvidence);
  const failureCodes = [
    ...(bucketMismatchCount > 0 ? ["STORAGE_BUCKET_SETTINGS_MISMATCH"] : []),
    ...(securityFailureCode ? [securityFailureCode] : []),
  ];
  const status = failureCodes.length === 0 ? "ok" : "failed";

  const output = JSON.stringify({
    command: COMMAND,
    status,
    bucketCount: buckets.length,
    bucketMismatchCount,
    buckets,
    sqlEvidence,
    ...(failureCodes.length > 0 ? { failureCodes } : {}),
  });
  if (status === "ok") console.log(output);
  else console.error(output);

  return status === "ok" ? 0 : 1;
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
