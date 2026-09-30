import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  evaluateCsvPerformanceBudget,
  parseCsvPerformanceBudget,
} from "./csv-performance-budget.mjs";

const baseUrl = process.env.BENCH_BASE_URL ?? "http://127.0.0.1:4100";
const contextsFile = process.env.BENCH_CONTEXTS_FILE;
const iterations = Number(process.env.BENCH_ITERATIONS ?? 5);
const pollMs = Number(process.env.BENCH_POLL_MS ?? 250);
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS ?? 180_000);
const outputFile = process.env.BENCH_OUTPUT;
const budgetFile = process.env.BENCH_BUDGETS_FILE;
const budgetJson = process.env.BENCH_BUDGETS_JSON;
const mixedDeleteBudgetMs = Number(process.env.BENCH_MIXED_DELETE_BUDGET_MS ?? 2_000);
const mixedDeleteTimeoutMs = Number(process.env.BENCH_MIXED_DELETE_TIMEOUT_MS ?? 10_000);
const mixedOnly = process.env.BENCH_MIXED_ONLY === "true";
const apiRoot = `${baseUrl.replace(/\/$/, "")}/api/v1`;
const endpoint = `${apiRoot}/records/csv-imports`;
const hostname = new URL(baseUrl).hostname;
const localTarget = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);

if (!contextsFile) throw new Error("BENCH_CONTEXTS_FILE is required");
if (!localTarget && process.env.BENCH_ALLOW_REMOTE !== "true") {
  throw new Error("Remote benchmark targets require BENCH_ALLOW_REMOTE=true");
}
if (mixedOnly && !localTarget) throw new Error("BENCH_MIXED_ONLY is restricted to local targets");
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error("BENCH_ITERATIONS must be an integer from 1 to 20");
}
if (!Number.isInteger(pollMs) || pollMs < 50 || !Number.isInteger(timeoutMs) || timeoutMs < 5_000) {
  throw new Error("BENCH_POLL_MS or BENCH_TIMEOUT_MS is invalid");
}
if (!Number.isFinite(mixedDeleteBudgetMs) || mixedDeleteBudgetMs <= 0) {
  throw new Error("BENCH_MIXED_DELETE_BUDGET_MS must be a positive number");
}
if (!Number.isInteger(mixedDeleteTimeoutMs) || mixedDeleteTimeoutMs < mixedDeleteBudgetMs) {
  throw new Error("BENCH_MIXED_DELETE_TIMEOUT_MS must be an integer at least as large as the delete budget");
}
if (budgetFile && budgetJson) throw new Error("Set only one of BENCH_BUDGETS_FILE or BENCH_BUDGETS_JSON");

const budgetInput = budgetFile
  ? await readFile(budgetFile, "utf8")
  : budgetJson ?? {};
const minimumSamplesOverride = process.env.BENCH_MIN_SAMPLES === undefined
  ? undefined
  : Number(process.env.BENCH_MIN_SAMPLES);
const performanceBudget = parseCsvPerformanceBudget(budgetInput, minimumSamplesOverride);
const performanceBudgetProfile = budgetFile || budgetJson ? "custom" : "local-regression";

const { contexts } = JSON.parse(await readFile(contextsFile, "utf8"));
if (!Array.isArray(contexts) || contexts.length < iterations || contexts.some(
  (value) => !Number.isInteger(value.profileId) || value.profileId < 1 || typeof value.token !== "string",
)) {
  throw new Error("Contexts must contain one { profileId, token } per iteration");
}

const mapping = { date: "Date", description: "Description", amount: "Amount", category: "Category" };
const scenarios = ["small", "near-5mb", "wide", "invalid", "30k-rows"];

function row(index, amount = String(100 + (index % 300))) {
  const month = String(1 + (Math.floor(index / 28) % 12)).padStart(2, "0");
  const day = String(1 + (index % 28)).padStart(2, "0");
  return `2026-${month}-${day},Benchmark item ${index},${amount},Inventory`;
}

function randomCell(length, seed) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = seed || 1;
  let value = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    value += alphabet[(state >>> 24) % alphabet.length];
  }
  return value;
}

function fixture(name) {
  const baseHeader = "Date,Description,Amount,Category";
  let lines;
  let rows;
  let invalidRows = 0;
  if (name === "small") {
    rows = 50;
    lines = [baseHeader, ...Array.from({ length: rows }, (_, index) => row(index))];
  } else if (name === "invalid") {
    rows = 100;
    invalidRows = 1;
    lines = [baseHeader, ...Array.from({ length: rows }, (_, index) => row(index, index === 41 ? "not-money" : String(100 + index)))];
  } else if (name === "30k-rows") {
    rows = 30_000;
    lines = [baseHeader, ...Array.from({ length: rows }, (_, index) => row(index))];
  } else if (name === "wide") {
    rows = 100;
    const extras = Array.from({ length: 196 }, (_, index) => `Note${index + 1}`);
    lines = [baseHeader + "," + extras.join(",")];
    for (let index = 0; index < rows; index += 1) {
      lines.push(`${row(index)},${extras.map((_, column) => randomCell(12, index * 257 + column + 1)).join(",")}`);
    }
  } else if (name === "near-5mb") {
    const extras = Array.from({ length: 20 }, (_, index) => `Note${index + 1}`);
    lines = [baseHeader + "," + extras.join(",")];
    let bytes = Buffer.byteLength(lines[0]) + 1;
    const target = 5 * 1024 * 1024 - 64 * 1024;
    rows = 0;
    while (bytes < target) {
      const line = `${row(rows)},${extras.map((_, column) => randomCell(200, rows * 31 + column + 1)).join(",")}`;
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
      rows += 1;
    }
  } else {
    throw new Error(`Unknown fixture: ${name}`);
  }
  const buffer = Buffer.from(lines.join("\n") + "\n");
  if (buffer.length > 5 * 1024 * 1024) throw new Error(`${name} exceeds the upload limit`);
  return { name, buffer, rows, invalidRows };
}

function serverTimings(value) {
  return Object.fromEntries((value ?? "").split(",").map((entry) => {
    const match = /^\s*([a-z-]+);dur=([\d.]+)/.exec(entry);
    return match ? [match[1], Number(match[2])] : null;
  }).filter(Boolean));
}

async function sendUrl(context, url, init = {}, acceptedStatuses) {
  const started = performance.now();
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${context.token}`, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${new URL(url).pathname} returned non-JSON HTTP ${response.status}`);
  }
  if (acceptedStatuses ? !acceptedStatuses.includes(response.status) : !response.ok) {
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status} ${String(body?.code ?? body?.error ?? "").slice(0, 180)}`);
  }
  return { body, elapsedMs, status: response.status, server: serverTimings(response.headers.get("server-timing")) };
}

function send(context, path, init = {}) {
  return sendUrl(context, `${endpoint}${path}`, init);
}

function sendApi(context, path, init = {}, acceptedStatuses) {
  return sendUrl(context, `${apiRoot}${path}`, init, acceptedStatuses);
}

async function runCase(context, sample, iteration) {
  const idempotencyKey = randomUUID();
  const upload = new FormData();
  upload.set("businessProfileId", String(context.profileId));
  upload.set("idempotencyKey", idempotencyKey);
  upload.set("file", new Blob([sample.buffer], { type: "text/csv" }), `${sample.name}.csv`);
  let stageId;
  let confirmed = false;
  try {
    const staged = await send(context, "/preview", { method: "POST", body: upload });
    stageId = staged.body?.stagedUploadId;
    if (staged.status !== 200 || typeof stageId !== "string") throw new Error("Stage response omitted stagedUploadId");

    const reviewBody = {
      stagedUploadId: stageId,
      businessProfileId: context.profileId,
      recordType: "expense",
      columnMapping: mapping,
    };
    const reviewed = await send(context, "/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewBody),
    });
    if (reviewed.body?.validation?.invalidRows !== sample.invalidRows) {
      throw new Error(`${sample.name} preview reported unexpected invalid row count`);
    }

    const confirmedAt = performance.now();
    const confirmation = await send(context, "/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...reviewBody, title: `CSV benchmark ${sample.name} ${iteration}`, idempotencyKey: randomUUID() }),
    });
    confirmed = true;
    const batchId = confirmation.body?.batchId;
    if (!Number.isInteger(batchId)) throw new Error("Confirm response omitted batchId");
    let terminal = confirmation.body;
    let polls = 0;
    while (terminal.processingStatus === "PENDING" || terminal.processingStatus === "PROCESSING") {
      if (performance.now() - confirmedAt > timeoutMs) throw new Error(`Batch ${batchId} did not reach a terminal state`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      terminal = (await send(context, `/batches/${batchId}/status`)).body;
      polls += 1;
    }
    const terminalMs = performance.now() - confirmedAt;
    const imported = terminal.importedRows ?? terminal.imported;
    if (terminal.processingStatus !== "COMPLETE" || imported !== sample.rows - sample.invalidRows) {
      throw new Error(`Batch ${batchId} ended ${terminal.processingStatus} with ${imported} imported rows`);
    }
    return {
      scenario: sample.name,
      iteration,
      bytes: sample.buffer.length,
      rows: sample.rows,
      invalidRows: sample.invalidRows,
      stageMs: staged.elapsedMs,
      reviewMs: reviewed.elapsedMs,
      confirmMs: confirmation.elapsedMs,
      queueAndWorkMs: Math.max(0, terminalMs - confirmation.elapsedMs),
      terminalMs,
      async: confirmation.status === 202,
      polls,
      server: { stage: staged.server, review: reviewed.server, confirm: confirmation.server },
    };
  } finally {
    if (stageId && !confirmed) {
      await send(context, `/stages/${stageId}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
}

async function waitForBatch(context, batchId, predicate, phase) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const current = (await send(context, `/batches/${batchId}/status`)).body;
    if (predicate(current)) return current;
    if (current.processingStatus === "COMPLETE" || current.processingStatus === "FAILED") {
      throw new Error(`Mixed workload batch reached ${current.processingStatus} before ${phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Mixed workload batch did not reach ${phase} within ${timeoutMs}ms`);
}

async function runMixedContentionGate(context) {
  const sample = fixture("30k-rows");
  const categories = await sendApi(context, `/records/categories?businessProfileId=${context.profileId}`);
  const categoryId = categories.body?.[0]?.id;
  if (!Number.isInteger(categoryId)) throw new Error("Mixed workload could not resolve a category");

  const manual = await sendApi(context, "/records/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessProfileId: context.profileId,
      categoryId,
      date: "2026-09-29",
      description: `Mixed workload delete target ${randomUUID()}`,
      amount: 777.77,
      vendor: "Local benchmark",
    }),
  });
  const recordId = manual.body?.id;
  if (!Number.isInteger(recordId)) throw new Error("Mixed workload create omitted the record id");

  const upload = new FormData();
  upload.set("businessProfileId", String(context.profileId));
  upload.set("idempotencyKey", randomUUID());
  upload.set("file", new Blob([sample.buffer], { type: "text/csv" }), "mixed-contention.csv");
  const staged = await send(context, "/preview", { method: "POST", body: upload });
  const stageId = staged.body?.stagedUploadId;
  if (typeof stageId !== "string") throw new Error("Mixed workload stage omitted stagedUploadId");

  const reviewBody = {
    stagedUploadId: stageId,
    businessProfileId: context.profileId,
    recordType: "expense",
    columnMapping: mapping,
  };
  await send(context, "/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reviewBody),
  });

  const confirmedAt = performance.now();
  const confirmation = await send(context, "/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...reviewBody, title: "CSV mixed workload gate", idempotencyKey: randomUUID() }),
  });
  const batchId = confirmation.body?.batchId;
  if (confirmation.status !== 202 || !Number.isInteger(batchId)) {
    throw new Error("Mixed workload large import was not accepted asynchronously");
  }

  const processing = await waitForBatch(
    context,
    batchId,
    (batch) => batch.processingStatus === "PROCESSING" && batch.processedRows > 0 && batch.processedRows < sample.rows,
    "partial processing",
  );
  const terminalPromise = waitForBatch(
    context,
    batchId,
    (batch) => batch.processingStatus === "COMPLETE",
    "COMPLETE",
  );
  const deletionPromise = sendApi(context, `/records/expenses/${recordId}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(mixedDeleteTimeoutMs),
  }, [204]);
  const [terminal, deletion] = await Promise.all([terminalPromise, deletionPromise]);
  const terminalMs = performance.now() - confirmedAt;
  const imported = terminal.importedRows ?? terminal.imported;
  if (imported !== sample.rows) throw new Error(`Mixed workload imported ${imported} of ${sample.rows} rows`);

  const deletedLookup = await sendApi(context, `/records/expenses/${recordId}`, {}, [404]);
  const deleteWithinBudget = deletion.elapsedMs <= mixedDeleteBudgetMs;
  const terminalBudgetMs = performanceBudget.scenarios["30k-rows"].terminalMs;
  const terminalWithinBudget = terminalMs <= terminalBudgetMs;
  return {
    status: deleteWithinBudget && terminalWithinBudget ? "pass" : "fail",
    profileId: context.profileId,
    batchId,
    processingObserved: processing.processingStatus === "PROCESSING",
    processedRowsWhenDeleteStarted: processing.processedRows ?? null,
    deleteMs: Math.round(deletion.elapsedMs),
    deleteBudgetMs: mixedDeleteBudgetMs,
    deleteWithinBudget,
    terminalMs: Math.round(terminalMs),
    terminalBudgetMs,
    terminalWithinBudget,
    importedRows: imported,
    expectedRows: sample.rows,
    deletedRecordStatus: deletedLookup.status,
  };
}

function summary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: Math.round(sorted[0]),
    median: Math.round(sorted[Math.floor((sorted.length - 1) / 2)]),
    p95: sorted.length >= 5 ? Math.round(sorted[Math.ceil(0.95 * sorted.length) - 1]) : null,
    max: Math.round(sorted.at(-1)),
  };
}

const startedAt = new Date().toISOString();
const results = [];
const failures = [];
if (!mixedOnly) {
  for (const name of scenarios) {
    const sample = fixture(name);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      try {
        const result = await runCase(contexts[iteration], sample, iteration + 1);
        results.push(result);
        process.stdout.write(`${name} ${iteration + 1}/${iterations}: stage ${Math.round(result.stageMs)}ms, review ${Math.round(result.reviewMs)}ms, confirm ${Math.round(result.confirmMs)}ms, terminal ${Math.round(result.terminalMs)}ms\n`);
      } catch (error) {
        failures.push({ scenario: name, iteration: iteration + 1, error: error instanceof Error ? error.message : String(error) });
        process.stderr.write(`${name} ${iteration + 1}/${iterations}: ${failures.at(-1).error}\n`);
      }
    }
  }
}

let mixedContention = { status: localTarget ? "not_run" : "skipped_remote" };
if (localTarget) {
  try {
    mixedContention = await runMixedContentionGate(contexts[0]);
    if (mixedContention.status !== "pass") {
      failures.push({ scenario: "mixed-contention", iteration: 1, error: "Mixed workload exceeded its local latency budget" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mixedContention = { status: "fail", error: message };
    failures.push({ scenario: "mixed-contention", iteration: 1, error: message });
  }
}

const scenarioSummaries = Object.fromEntries(scenarios.map((name) => {
  const values = results.filter((item) => item.scenario === name);
  return [name, {
    bytes: values[0]?.bytes ?? null,
    rows: values[0]?.rows ?? null,
    stageMs: summary(values.map((item) => item.stageMs)),
    reviewMs: summary(values.map((item) => item.reviewMs)),
    confirmMs: summary(values.map((item) => item.confirmMs)),
    queueAndWorkMs: summary(values.filter((item) => item.async).map((item) => item.queueAndWorkMs)),
    terminalMs: summary(values.map((item) => item.terminalMs)),
  }];
}));
const performanceEvaluation = mixedOnly
  ? { status: "skipped_mixed_only", passed: true, totals: { passed: 0, failed: 0, insufficient: 0 }, checks: [] }
  : evaluateCsvPerformanceBudget(scenarioSummaries, performanceBudget);
const report = {
  startedAt,
  baseUrl,
  iterations,
  scenarioSummaries,
  performanceBudget: {
    profile: performanceBudgetProfile,
    configuration: performanceBudget,
    evaluation: performanceEvaluation,
  },
  mixedContention,
  results,
  failures,
};
if (outputFile) await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  scenarioSummaries: report.scenarioSummaries,
  performanceBudget: report.performanceBudget,
  mixedContention,
  failures,
}, null, 2)}\n`);
if (failures.length || !performanceEvaluation.passed) process.exitCode = 1;
