/** Emit aggregate metrics only; keep URLs, tokens, and row data out of logs. */

const DEFAULT_QUEUE_WAIT_ALERT_SECONDS = 10 * 60;
const DEFAULT_PROCESSING_AGE_ALERT_SECONDS = 30 * 60;
const DEFAULT_PURGE_AGE_ALERT_SECONDS = 10 * 60;
const DEFAULT_STAGE_AGE_ALERT_SECONDS = 25 * 60 * 60;

type CsvHealthDetail = {
  pendingCsvImports: number;
  oldestPendingCsvImportAgeSeconds: number | null;
  processingCsvImports: number;
  oldestProcessingCsvImportAgeSeconds: number | null;
  queuedCsvSourcePurges: number;
  oldestQueuedCsvSourcePurgeAgeSeconds: number | null;
  failedCsvSourcePurges: number;
  stagedCsvUploads: number;
  oldestStagedCsvUploadAgeSeconds: number | null;
};

export type CsvReadinessResult = CsvHealthDetail & {
  check: "csv-import-readiness";
  status: "ok" | "attention";
  alerts: Array<"CSV_QUEUE_WAIT" | "CSV_PROCESSING_AGE" | "CSV_PURGE_AGE" | "CSV_PURGE_FAILED" | "CSV_STAGE_AGE">;
};

export type CsvReadinessThresholds = {
  queueWaitSeconds: number;
  processingAgeSeconds: number;
  purgeAgeSeconds: number;
  stageAgeSeconds: number;
};

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function age(value: unknown): number | null | undefined {
  return value === null ? null : count(value) ?? undefined;
}

export function assessCsvHealth(body: unknown, thresholds: CsvReadinessThresholds): CsvReadinessResult {
  if (typeof body !== "object" || body === null) throw new Error("HEALTH_DETAIL_INVALID");
  const source = body as Record<string, unknown>;
  if (source.status !== "ready" || source.database !== "ok") throw new Error("HEALTH_NOT_READY");

  const pendingCsvImports = count(source.pendingCsvImports);
  const oldestPendingCsvImportAgeSeconds = age(source.oldestPendingCsvImportAgeSeconds);
  const processingCsvImports = count(source.processingCsvImports);
  const oldestProcessingCsvImportAgeSeconds = age(source.oldestProcessingCsvImportAgeSeconds);
  const queuedCsvSourcePurges = count(source.queuedCsvSourcePurges);
  const oldestQueuedCsvSourcePurgeAgeSeconds = age(source.oldestQueuedCsvSourcePurgeAgeSeconds);
  const failedCsvSourcePurges = count(source.failedCsvSourcePurges);
  const stagedCsvUploads = count(source.stagedCsvUploads);
  const oldestStagedCsvUploadAgeSeconds = age(source.oldestStagedCsvUploadAgeSeconds);
  if (
    pendingCsvImports === null || oldestPendingCsvImportAgeSeconds === undefined ||
    processingCsvImports === null || oldestProcessingCsvImportAgeSeconds === undefined ||
    queuedCsvSourcePurges === null || oldestQueuedCsvSourcePurgeAgeSeconds === undefined ||
    failedCsvSourcePurges === null || stagedCsvUploads === null ||
    oldestStagedCsvUploadAgeSeconds === undefined
  ) {
    throw new Error("HEALTH_DETAIL_MISSING");
  }

  const alerts: CsvReadinessResult["alerts"] = [];
  if (oldestPendingCsvImportAgeSeconds !== null && oldestPendingCsvImportAgeSeconds > thresholds.queueWaitSeconds) {
    alerts.push("CSV_QUEUE_WAIT");
  }
  if (oldestProcessingCsvImportAgeSeconds !== null && oldestProcessingCsvImportAgeSeconds > thresholds.processingAgeSeconds) {
    alerts.push("CSV_PROCESSING_AGE");
  }
  if (oldestQueuedCsvSourcePurgeAgeSeconds !== null && oldestQueuedCsvSourcePurgeAgeSeconds > thresholds.purgeAgeSeconds) {
    alerts.push("CSV_PURGE_AGE");
  }
  if (failedCsvSourcePurges > 0) alerts.push("CSV_PURGE_FAILED");
  if (oldestStagedCsvUploadAgeSeconds !== null && oldestStagedCsvUploadAgeSeconds > thresholds.stageAgeSeconds) {
    alerts.push("CSV_STAGE_AGE");
  }

  return {
    check: "csv-import-readiness",
    status: alerts.length ? "attention" : "ok",
    alerts,
    pendingCsvImports,
    oldestPendingCsvImportAgeSeconds,
    processingCsvImports,
    oldestProcessingCsvImportAgeSeconds,
    queuedCsvSourcePurges,
    oldestQueuedCsvSourcePurgeAgeSeconds,
    failedCsvSourcePurges,
    stagedCsvUploads,
    oldestStagedCsvUploadAgeSeconds,
  };
}

function threshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > 172_800) throw new Error("THRESHOLD_INVALID");
  return parsed;
}

function healthUrl(): URL {
  const raw = process.env.CSV_READINESS_URL;
  if (!raw) throw new Error("HEALTH_URL_MISSING");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("HEALTH_URL_INVALID");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== "/api/v1/health/ready"
  ) {
    throw new Error("HEALTH_URL_INVALID");
  }
  return url;
}

export async function main(): Promise<number> {
  try {
    const url = healthUrl();
    const token = process.env.HEALTH_DETAIL_TOKEN;
    if (!token) throw new Error("HEALTH_TOKEN_MISSING");
    const thresholds = {
      queueWaitSeconds: threshold("CSV_QUEUE_WAIT_ALERT_SECONDS", DEFAULT_QUEUE_WAIT_ALERT_SECONDS),
      processingAgeSeconds: threshold("CSV_PROCESSING_AGE_ALERT_SECONDS", DEFAULT_PROCESSING_AGE_ALERT_SECONDS),
      purgeAgeSeconds: threshold("CSV_PURGE_AGE_ALERT_SECONDS", DEFAULT_PURGE_AGE_ALERT_SECONDS),
      stageAgeSeconds: threshold("CSV_STAGE_AGE_ALERT_SECONDS", DEFAULT_STAGE_AGE_ALERT_SECONDS),
    };
    const response = await fetch(url, {
      headers: { "x-health-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("HEALTH_HTTP_FAILURE");
    const result = assessCsvHealth(await response.json(), thresholds);
    console.log(JSON.stringify(result));
    return result.status === "ok" ? 0 : 1;
  } catch (error) {
    const known = new Set([
      "HEALTH_DETAIL_INVALID", "HEALTH_NOT_READY", "HEALTH_DETAIL_MISSING",
      "THRESHOLD_INVALID", "HEALTH_URL_MISSING", "HEALTH_URL_INVALID",
      "HEALTH_TOKEN_MISSING", "HEALTH_HTTP_FAILURE",
    ]);
    const message = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({
      check: "csv-import-readiness",
      status: "failed",
      code: known.has(message) ? message : "HEALTH_REQUEST_FAILED",
    }));
    return 1;
  }
}

if (require.main === module) {
  void main().then((exitCode) => { process.exitCode = exitCode; });
}
