import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const RECEIPT_BUCKET_ID = "receipts";
export const CSV_IMPORT_BUCKET_ID = "csv-imports";

export interface BucketContract {
  id: string;
  public: false;
  fileSizeLimit: number;
  allowedMimeTypes: readonly string[];
}

export const BUCKET_CONTRACTS: readonly BucketContract[] = [
  {
    id: RECEIPT_BUCKET_ID,
    public: false,
    fileSizeLimit: 10_485_760,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  {
    id: CSV_IMPORT_BUCKET_ID,
    public: false,
    fileSizeLimit: 5_242_880,
    allowedMimeTypes: ["text/csv"],
  },
];

interface SafeErrorDetails {
  bucket?: string;
  httpStatus?: number;
}

export class StorageOperatorError extends Error {
  constructor(
    readonly code: string,
    readonly details: SafeErrorDetails = {},
  ) {
    super(code);
    this.name = "StorageOperatorError";
  }
}

export interface StorageOperatorEnvironment {
  supabaseUrl: string;
  storageAdminKey: string;
  projectRef: string;
  directUrl?: string;
}

export interface BucketSettings {
  bucket: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[];
}

type BucketRecord = Awaited<ReturnType<SupabaseClient["storage"]["getBucket"]>>["data"];

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const STORAGE_API_TIMEOUT_MS = 20_000;

function requiredExactEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  missingCode: string,
): string {
  const value = environment[name];
  if (!value || value.trim() === "") throw new StorageOperatorError(missingCode);
  if (value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new StorageOperatorError(`${name}_INVALID`);
  }
  return value;
}

function parseSupabaseUrl(rawUrl: string): { url: string; projectRef: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new StorageOperatorError("SUPABASE_URL_INVALID");
  }

  const hostMatch = parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !hostMatch?.[1] ||
    !PROJECT_REF_PATTERN.test(hostMatch[1])
  ) {
    throw new StorageOperatorError("SUPABASE_URL_INVALID");
  }

  return { url: parsed.origin, projectRef: hostMatch[1] };
}

function parseDirectUrl(rawUrl: string, expectedProjectRef: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new StorageOperatorError("DIRECT_URL_INVALID");
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    parsed.pathname === "" ||
    parsed.pathname === "/" ||
    parsed.hash !== ""
  ) {
    throw new StorageOperatorError("DIRECT_URL_INVALID");
  }

  let decodedUsername: string;
  try {
    decodedUsername = decodeURIComponent(parsed.username);
  } catch {
    throw new StorageOperatorError("DIRECT_URL_INVALID");
  }

  const directHostRef = parsed.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/)?.[1];
  const poolerUsernameRef = decodedUsername.match(/^postgres\.([a-z0-9]{20})$/)?.[1];
  const resolvedRefs = [directHostRef, poolerUsernameRef].filter(
    (value): value is string => value !== undefined,
  );

  if (resolvedRefs.length === 0 || resolvedRefs.some((value) => value !== expectedProjectRef)) {
    throw new StorageOperatorError("SUPABASE_DATABASE_TARGET_MISMATCH");
  }

  if (!parsed.searchParams.has("connect_timeout")) parsed.searchParams.set("connect_timeout", "10");
  if (!parsed.searchParams.has("pool_timeout")) parsed.searchParams.set("pool_timeout", "10");
  if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}

export function loadStorageOperatorEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { requireDirectUrl: boolean },
): StorageOperatorEnvironment {
  const receiptBucket = requiredExactEnvironmentValue(
    environment,
    "SUPABASE_STORAGE_BUCKET",
    "SUPABASE_STORAGE_BUCKET_MISSING",
  );
  if (receiptBucket !== RECEIPT_BUCKET_ID) {
    throw new StorageOperatorError("SUPABASE_STORAGE_BUCKET_UNSAFE");
  }

  const rawSupabaseUrl = requiredExactEnvironmentValue(
    environment,
    "SUPABASE_URL",
    "SUPABASE_URL_MISSING",
  );
  const { url: supabaseUrl, projectRef } = parseSupabaseUrl(rawSupabaseUrl);

  const secretKey = environment.SUPABASE_SECRET_KEY;
  const legacyServiceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  const selectedKey = secretKey?.trim() ? secretKey : legacyServiceKey;
  if (!selectedKey?.trim()) throw new StorageOperatorError("STORAGE_ADMIN_KEY_MISSING");
  if (selectedKey !== selectedKey.trim() || selectedKey.length < 20 || /[\r\n\0]/.test(selectedKey)) {
    throw new StorageOperatorError("STORAGE_ADMIN_KEY_INVALID");
  }

  if (!options.requireDirectUrl) {
    return { supabaseUrl, storageAdminKey: selectedKey, projectRef };
  }

  const rawDirectUrl = requiredExactEnvironmentValue(
    environment,
    "DIRECT_URL",
    "DIRECT_URL_MISSING",
  );
  return {
    supabaseUrl,
    storageAdminKey: selectedKey,
    projectRef,
    directUrl: parseDirectUrl(rawDirectUrl, projectRef),
  };
}

export function createStorageAdmin(environment: StorageOperatorEnvironment): SupabaseClient {
  return createClient(environment.supabaseUrl, environment.storageAdminKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(STORAGE_API_TIMEOUT_MS),
        }),
    },
  });
}

function storageHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export async function getRequiredBucket(
  storageAdmin: SupabaseClient,
  contract: BucketContract,
): Promise<NonNullable<BucketRecord>> {
  if (contract.id === "avatars") throw new StorageOperatorError("AVATAR_BUCKET_TARGET_REFUSED");
  const { data, error } = await storageAdmin.storage.getBucket(contract.id);
  if (error || !data) {
    const httpStatus = storageHttpStatus(error);
    throw new StorageOperatorError(
      httpStatus === 404 ? "STORAGE_BUCKET_MISSING" : "STORAGE_BUCKET_READ_FAILED",
      { bucket: contract.id, httpStatus },
    );
  }
  if (data.id !== contract.id || data.name !== contract.id) {
    throw new StorageOperatorError("STORAGE_BUCKET_IDENTITY_MISMATCH", { bucket: contract.id });
  }
  return data;
}

function normalizeFileSizeLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function normalizeMimeTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((mimeType) => typeof mimeType !== "string")) return [];
  return [...value].sort();
}

export function bucketSettings(bucket: NonNullable<BucketRecord>): BucketSettings {
  return {
    bucket: bucket.id,
    public: bucket.public,
    fileSizeLimit: normalizeFileSizeLimit(bucket.file_size_limit),
    allowedMimeTypes: normalizeMimeTypes(bucket.allowed_mime_types),
  };
}

export function expectedBucketSettings(contract: BucketContract): BucketSettings {
  return {
    bucket: contract.id,
    public: contract.public,
    fileSizeLimit: contract.fileSizeLimit,
    allowedMimeTypes: [...contract.allowedMimeTypes].sort(),
  };
}

export function bucketMatchesContract(
  bucket: NonNullable<BucketRecord>,
  contract: BucketContract,
): boolean {
  const actual = bucketSettings(bucket);
  const expected = expectedBucketSettings(contract);
  return (
    actual.bucket === expected.bucket &&
    actual.public === expected.public &&
    actual.fileSizeLimit === expected.fileSizeLimit &&
    actual.allowedMimeTypes.length === expected.allowedMimeTypes.length &&
    actual.allowedMimeTypes.every((value, index) => value === expected.allowedMimeTypes[index])
  );
}

export function writeFailure(command: string, error: unknown): void {
  const known = error instanceof StorageOperatorError ? error : undefined;
  console.error(
    JSON.stringify({
      command,
      status: "failed",
      errorCode: known?.code ?? "UNEXPECTED_OPERATOR_FAILURE",
      ...(known?.details.bucket ? { bucket: known.details.bucket } : {}),
      ...(known?.details.httpStatus ? { httpStatus: known.details.httpStatus } : {}),
    }),
  );
}
