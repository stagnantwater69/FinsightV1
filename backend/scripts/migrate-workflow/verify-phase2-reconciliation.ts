import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "prisma", "migrations");
const LEGACY_FIXTURE = path.join(BACKEND_ROOT, "tests", "fixtures", "phase2-legacy-scanner.sql");
const PHASE2_MIGRATION = "20260913100918_receipt_capture_batches_and_scan_revision";
const RECONCILIATION = "20260913230000_reconcile_phase2_scanner_migration_drift";
const LEGACY_CHECKSUM = "a0e4f79275cbb0e975f16d4675776ecf954395eaa6dd5900f15cd3f73030ca5b";
const POSTGRES_USER = "phase2check";
const POSTGRES_PASSWORD = "phase2check";

function migrationPath(name: string): string {
  return path.join(MIGRATIONS_DIR, name, "migration.sql");
}

function migrationChecksum(name: string): string {
  return createHash("sha256").update(readFileSync(migrationPath(name))).digest("hex");
}

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(migrationPath(name));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local PostgreSQL port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPostgres(containerName: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let consecutiveReadyChecks = 0;
  while (Date.now() < deadline) {
    try {
      execFileSync("docker", [
        "exec",
        containerName,
        "psql",
        "-X",
        "-U",
        POSTGRES_USER,
        "-d",
        "postgres",
        "-At",
        "-c",
        "SELECT 1",
      ], {
        stdio: "ignore",
      });
      consecutiveReadyChecks++;
      if (consecutiveReadyChecks >= 2) return;
    } catch {
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Disposable PostgreSQL container ${containerName} did not become ready.`);
}

// Only these two host paths are mounted; backend/.env and the rest of
// backend/ never enter the container.
const CONTAINER_MOUNTS: { host: string; container: string }[] = [
  { host: MIGRATIONS_DIR, container: "/workspace/prisma/migrations" },
  { host: LEGACY_FIXTURE, container: "/workspace/tests/fixtures/phase2-legacy-scanner.sql" },
];

function containerFile(localPath: string): string {
  const resolved = path.resolve(localPath);
  for (const mount of CONTAINER_MOUNTS) {
    if (resolved === mount.host) return mount.container;
    const relative = path.relative(mount.host, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return path.posix.join(mount.container, ...relative.split(path.sep));
    }
  }
  throw new Error(`Refusing to read ${localPath}: it is not inside a mounted path.`);
}

function psql(
  containerName: string,
  database: string,
  args: string[],
  stdio: "inherit" | "pipe" = "inherit",
): string {
  return execFileSync(
    "docker",
    ["exec", containerName, "psql", "-X", "-U", POSTGRES_USER, "-d", database, "-v", "ON_ERROR_STOP=1", ...args],
    { encoding: "utf8", stdio },
  ) ?? "";
}

function executeSql(containerName: string, database: string, sql: string): void {
  psql(containerName, database, ["-c", sql], "pipe");
}

function executeFile(containerName: string, database: string, filePath: string): void {
  psql(containerName, database, ["-f", containerFile(filePath)], "pipe");
}

function queryScalar(containerName: string, database: string, sql: string): string {
  return psql(containerName, database, ["-At", "-c", sql], "pipe").trim();
}

function phase2CatalogSnapshot(containerName: string, database: string): string {
  return queryScalar(containerName, database, `
    WITH relevant_tables(table_name) AS (
      VALUES
        ('ReceiptCaptureBatch'),
        ('ReceiptDuplicateCandidate'),
        ('ReceiptScan'),
        ('ReceiptPurgeJob'),
        ('ExpenseRecord')
    ),
    relevant_enums(type_name) AS (
      VALUES
        ('ReceiptCaptureBatchStatus'),
        ('ReceiptPurgeMode'),
        ('ReceiptDuplicateScoreBand'),
        ('ReceiptDuplicateReviewStatus')
    ),
    relevant_sequences(sequence_name) AS (
      VALUES
        ('ReceiptCaptureBatch_ReceiptCaptureBatch_ID_seq'),
        ('ReceiptDuplicateCandidate_ReceiptDuplicateCandidate_ID_seq'),
        ('ReceiptScan_ReceiptScan_ID_seq'),
        ('ReceiptPurgeJob_ReceiptPurgeJob_ID_seq'),
        ('ExpenseRecord_ExpenseRecord_ID_seq')
    ),
    table_relations AS (
      SELECT relation.*
      FROM pg_class relation
      JOIN relevant_tables expected ON expected.table_name = relation.relname
      WHERE relation.relnamespace = 'public'::regnamespace
    ),
    sequence_relations AS (
      SELECT relation.*
      FROM pg_class relation
      JOIN relevant_sequences expected ON expected.sequence_name = relation.relname
      WHERE relation.relnamespace = 'public'::regnamespace
    ),
    facts(fact_kind, object_name, detail) AS (
      SELECT
        'enum',
        enum_type.typname || ':' || enum_value.enumsortorder::text,
        jsonb_build_object('label', enum_value.enumlabel)
      FROM pg_type enum_type
      JOIN relevant_enums expected ON expected.type_name = enum_type.typname
      JOIN pg_enum enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE enum_type.typnamespace = 'public'::regnamespace

      UNION ALL

      SELECT
        'relation',
        relation.relname,
        jsonb_build_object(
          'kind', relation.relkind,
          'persistence', relation.relpersistence,
          'owner', pg_get_userbyid(relation.relowner),
          'row_security', relation.relrowsecurity,
          'force_row_security', relation.relforcerowsecurity
        )
      FROM (
        SELECT * FROM table_relations
        UNION ALL
        SELECT * FROM sequence_relations
      ) relation

      UNION ALL

      SELECT
        'column',
        relation.relname || ':' || attribute.attname,
        jsonb_build_object(
          'name', attribute.attname,
          'type', format_type(attribute.atttypid, attribute.atttypmod),
          'not_null', attribute.attnotnull,
          'identity', attribute.attidentity,
          'generated', attribute.attgenerated,
          'default', pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false)
        )
      FROM table_relations relation
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      LEFT JOIN pg_attrdef attribute_default
        ON attribute_default.adrelid = relation.oid
       AND attribute_default.adnum = attribute.attnum

      UNION ALL

      SELECT
        'constraint',
        source_relation.relname || ':' || constraint_metadata.conname,
        jsonb_build_object(
          'type', constraint_metadata.contype,
          'validated', constraint_metadata.convalidated,
          'deferrable', constraint_metadata.condeferrable,
          'deferred', constraint_metadata.condeferred,
          'no_inherit', constraint_metadata.connoinherit,
          'match', constraint_metadata.confmatchtype,
          'update', constraint_metadata.confupdtype,
          'delete', constraint_metadata.confdeltype,
          'target_schema', target_namespace.nspname,
          'target_table', target_relation.relname,
          'definition', pg_get_constraintdef(constraint_metadata.oid, false)
        )
      FROM table_relations source_relation
      JOIN pg_constraint constraint_metadata ON constraint_metadata.conrelid = source_relation.oid
      LEFT JOIN pg_class target_relation ON target_relation.oid = constraint_metadata.confrelid
      LEFT JOIN pg_namespace target_namespace ON target_namespace.oid = target_relation.relnamespace

      UNION ALL

      SELECT
        'index',
        target_relation.relname || ':' || index_relation.relname,
        jsonb_build_object(
          'access_method', access_method.amname,
          'unique', index_metadata.indisunique,
          'primary', index_metadata.indisprimary,
          'exclusion', index_metadata.indisexclusion,
          'immediate', index_metadata.indimmediate,
          'clustered', index_metadata.indisclustered,
          'valid', index_metadata.indisvalid,
          'ready', index_metadata.indisready,
          'live', index_metadata.indislive,
          'replica_identity', index_metadata.indisreplident,
          'nulls_not_distinct', index_metadata.indnullsnotdistinct,
          'attributes', index_metadata.indnatts,
          'key_attributes', index_metadata.indnkeyatts,
          'collations', index_metadata.indcollation::text,
          'operator_classes', index_metadata.indclass::text,
          'options', index_metadata.indoption::text,
          'predicate', pg_get_expr(index_metadata.indpred, index_metadata.indrelid, false),
          'definition', pg_get_indexdef(index_metadata.indexrelid, 0, false)
        )
      FROM table_relations target_relation
      JOIN pg_index index_metadata ON index_metadata.indrelid = target_relation.oid
      JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am access_method ON access_method.oid = index_relation.relam

      UNION ALL

      SELECT
        'policy',
        relation.relname || ':' || policy.polname,
        jsonb_build_object(
          'permissive', policy.polpermissive,
          'command', policy.polcmd,
          'roles', ARRAY(
            SELECT pg_get_userbyid(role_oid)
            FROM unnest(policy.polroles) role_oid
            ORDER BY pg_get_userbyid(role_oid)
          ),
          'using', pg_get_expr(policy.polqual, policy.polrelid, false),
          'check', pg_get_expr(policy.polwithcheck, policy.polrelid, false)
        )
      FROM table_relations relation
      JOIN pg_policy policy ON policy.polrelid = relation.oid

      UNION ALL

      SELECT
        'acl',
        relation.relname || ':' || COALESCE(grantee.rolname, 'PUBLIC') || ':' || privilege.privilege_type,
        jsonb_build_object(
          'grantor', grantor.rolname,
          'grantable', privilege.is_grantable
        )
      FROM (
        SELECT * FROM table_relations
        UNION ALL
        SELECT * FROM sequence_relations
      ) relation
      CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
      LEFT JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee

      UNION ALL

      SELECT
        'sequence',
        relation.relname,
        jsonb_build_object(
          'type', format_type(sequence.seqtypid, NULL),
          'start', sequence.seqstart,
          'increment', sequence.seqincrement,
          'maximum', sequence.seqmax,
          'minimum', sequence.seqmin,
          'cache', sequence.seqcache,
          'cycle', sequence.seqcycle
        )
      FROM sequence_relations relation
      JOIN pg_sequence sequence ON sequence.seqrelid = relation.oid
    )
    SELECT jsonb_build_array(fact_kind, object_name, detail)::text
    FROM facts
    ORDER BY fact_kind, object_name, detail::text
  `);
}

function assertMatchingCatalogs(
  containerName: string,
  currentDatabase: string,
  reconciledDatabase: string,
): { factCount: number; digest: string } {
  const current = phase2CatalogSnapshot(containerName, currentDatabase);
  const reconciled = phase2CatalogSnapshot(containerName, reconciledDatabase);
  if (current !== reconciled) {
    const currentDigest = createHash("sha256").update(current).digest("hex");
    const reconciledDigest = createHash("sha256").update(reconciled).digest("hex");
    const currentFacts = new Set(current.split("\n"));
    const reconciledFacts = new Set(reconciled.split("\n"));
    const onlyCurrent = [...currentFacts].filter((fact) => !reconciledFacts.has(fact)).slice(0, 5);
    const onlyReconciled = [...reconciledFacts].filter((fact) => !currentFacts.has(fact)).slice(0, 5);
    throw new Error(
      `Fresh and reconciled Phase 2 catalogs differ (${currentDigest} != ${reconciledDigest}). ` +
      `Fresh-only facts: ${JSON.stringify(onlyCurrent)}. ` +
      `Reconciled-only facts: ${JSON.stringify(onlyReconciled)}.`,
    );
  }
  return {
    factCount: current === "" ? 0 : current.split("\n").length,
    digest: createHash("sha256").update(current).digest("hex"),
  };
}

function recordMigration(
  containerName: string,
  database: string,
  migrationName: string,
  checksum: string,
): void {
  if (!/^[a-z0-9_]+$/.test(migrationName) || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("Refusing to record an invalid migration fixture identifier.");
  }
  executeSql(containerName, database, `
    INSERT INTO public."_prisma_migrations" (
      id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
    ) VALUES (
      '${randomUUID()}', '${checksum}', clock_timestamp(), '${migrationName}', NULL, NULL, clock_timestamp(), 1
    )
  `);
}

function applyRecordedMigration(containerName: string, database: string, migrationName: string): void {
  executeFile(containerName, database, migrationPath(migrationName));
  recordMigration(containerName, database, migrationName, migrationChecksum(migrationName));
}

function applyLegacyFixture(containerName: string, database: string): void {
  executeFile(containerName, database, LEGACY_FIXTURE);
  // The fixture is a reconstruction of the a0e4f792 catalog (that migration text is in no git object); the checksum selects the legacy path.
  recordMigration(containerName, database, PHASE2_MIGRATION, LEGACY_CHECKSUM);
}

function expectMigrationFailure(
  containerName: string,
  database: string,
  expectedMessage: string,
): void {
  try {
    executeFile(containerName, database, migrationPath(RECONCILIATION));
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = `${failure.stdout?.toString() ?? ""}\n${failure.stderr?.toString() ?? ""}`;
    if (!output.includes(expectedMessage)) {
      throw new Error(`Reconciliation failed for an unexpected reason:\n${output}`);
    }
    return;
  }
  throw new Error(`Reconciliation unexpectedly accepted malformed database ${database}.`);
}

function databaseUrl(port: number, database: string): string {
  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`;
}

function verifyPrismaDiff(url: string): void {
  execFileSync(
    "npx",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-url",
      url,
      "--to-schema-datamodel",
      path.join(BACKEND_ROOT, "prisma", "schema.prisma"),
      "--exit-code",
    ],
    {
      cwd: BACKEND_ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    },
  );
}

function verifyStartupGuard(url: string): void {
  const program = [
    "import { checkMigrationDrift } from './src/config/migrationGuard';",
    "import { prisma } from './src/config/prisma';",
    "void (async () => {",
    "  const result = await checkMigrationDrift();",
    "  if (result.status !== 'ok') { console.error(JSON.stringify(result)); process.exitCode = 1; }",
    "  await prisma.$disconnect();",
    "})();",
  ].join("\n");
  execFileSync("npx", ["tsx", "-e", program], {
    cwd: BACKEND_ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}

function createMigrationLedger(containerName: string, database: string): void {
  executeSql(containerName, database, `
    CREATE TABLE public."_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function main(): Promise<void> {
  const names = migrationNames();
  if (!names.includes(PHASE2_MIGRATION) || !names.includes(RECONCILIATION)) {
    throw new Error("Phase 2 migration fixtures are missing from prisma/migrations.");
  }

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const containerName = `finsight-phase2-reconciliation-test-${runId}`;
  const port = await findFreePort();

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${POSTGRES_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      ...CONTAINER_MOUNTS.flatMap((mount) => ["-v", `${mount.host}:${mount.container}:ro`]),
      "postgres:16-alpine",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForPostgres(containerName);
    executeSql(containerName, "postgres", "CREATE DATABASE phase2_template");
    createMigrationLedger(containerName, "phase2_template");

    for (const name of names.filter((candidate) => candidate < PHASE2_MIGRATION)) {
      applyRecordedMigration(containerName, "phase2_template", name);
    }

    for (const database of [
      "current_valid",
      "legacy_valid",
      "legacy_malformed",
      "current_malformed",
      "current_malformed_opclass",
      "current_malformed_collation",
    ]) {
      executeSql(containerName, "postgres", `CREATE DATABASE ${database} TEMPLATE phase2_template`);
    }

    const between = names.filter((name) => name > PHASE2_MIGRATION && name < RECONCILIATION);
    const after = names.filter((name) => name > RECONCILIATION);

    for (const name of names.filter((candidate) => candidate >= PHASE2_MIGRATION)) {
      applyRecordedMigration(containerName, "current_valid", name);
    }
    verifyPrismaDiff(databaseUrl(port, "current_valid"));
    verifyStartupGuard(databaseUrl(port, "current_valid"));

    applyLegacyFixture(containerName, "legacy_valid");
    for (const name of between) applyRecordedMigration(containerName, "legacy_valid", name);
    applyRecordedMigration(containerName, "legacy_valid", RECONCILIATION);
    for (const name of after) applyRecordedMigration(containerName, "legacy_valid", name);
    verifyPrismaDiff(databaseUrl(port, "legacy_valid"));
    verifyStartupGuard(databaseUrl(port, "legacy_valid"));
    const catalog = assertMatchingCatalogs(containerName, "current_valid", "legacy_valid");

    applyLegacyFixture(containerName, "legacy_malformed");
    for (const name of between) applyRecordedMigration(containerName, "legacy_malformed", name);
    executeSql(containerName, "legacy_malformed", `
      ALTER TABLE "ReceiptScan"
      DROP CONSTRAINT "ReceiptScan_batch_link_check",
      ADD CONSTRAINT "ReceiptScan_batch_link_check" CHECK (TRUE)
    `);
    expectMigrationFailure(
      containerName,
      "legacy_malformed",
      "Unsupported legacy Phase 2 shape: ReceiptScan_batch_link_check differs.",
    );
    const legacyRepairAbsent = queryScalar(containerName, "legacy_malformed", `
      SELECT (
        to_regtype('public."ReceiptPurgeMode"') IS NULL
        AND to_regclass('public."ReceiptDuplicateCandidate"') IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'ReceiptScan'
            AND column_name = 'ReceiptScan_EvidenceDeletedAt'
        )
      )::text
    `);
    if (legacyRepairAbsent !== "true") {
      throw new Error("Malformed legacy reconciliation left partial repair objects behind.");
    }

    applyRecordedMigration(containerName, "current_malformed", PHASE2_MIGRATION);
    for (const name of between) applyRecordedMigration(containerName, "current_malformed", name);
    executeSql(containerName, "current_malformed", `
      DROP INDEX "ReceiptPurgeJob_active_profile_receipt_key";
      CREATE UNIQUE INDEX "ReceiptPurgeJob_active_profile_receipt_key"
        ON "ReceiptPurgeJob"("BusinessProfile_ID", "ReceiptScan_ID")
        WHERE "ReceiptPurgeJob_Status" IN ('PENDING', 'PROCESSING', 'RETRY', 'FAILED')
    `);
    expectMigrationFailure(
      containerName,
      "current_malformed",
      "Phase 2 reconciliation postcondition failed: a partial-index predicate differs.",
    );

    for (const malformedIndex of [
      {
        database: "current_malformed_opclass",
        imageHashDefinition: '"ReceiptScan_SourceImageHash" pg_catalog.bpchar_pattern_ops',
      },
      {
        database: "current_malformed_collation",
        imageHashDefinition: '"ReceiptScan_SourceImageHash" COLLATE pg_catalog."C"',
      },
    ]) {
      applyRecordedMigration(containerName, malformedIndex.database, PHASE2_MIGRATION);
      for (const name of between) applyRecordedMigration(containerName, malformedIndex.database, name);
      executeSql(containerName, malformedIndex.database, `
        DROP INDEX "ReceiptScan_profile_source_image_hash_idx";
        CREATE INDEX "ReceiptScan_profile_source_image_hash_idx"
          ON "ReceiptScan"("BusinessProfile_ID", ${malformedIndex.imageHashDefinition})
      `);
      expectMigrationFailure(
        containerName,
        malformedIndex.database,
        "Phase 2 reconciliation postcondition failed: an index key definition differs.",
      );
    }

    console.log(
      `Phase 2 reconciliation verification passed: fresh and legacy catalogs share ` +
      `${catalog.factCount} facts (${catalog.digest}); malformed legacy, predicate, collation, and ` +
      `operator-class states were rejected.`,
    );
  } finally {
    if (containerName.startsWith("finsight-phase2-reconciliation-test-")) {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Phase 2 reconciliation verification failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
