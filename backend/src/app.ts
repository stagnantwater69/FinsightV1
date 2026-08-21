import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { logger } from "./config/logger";
import { authRouter } from "./routes/auth.routes";
import { businessProfileRouter } from "./routes/businessProfile.routes";
import { aiRouter } from "./routes/ai.routes";
import { expenseCategoryRouter } from "./routes/expenseCategory.routes";
import { expenseRecordRouter } from "./routes/expenseRecord.routes";
import { salesRecordRouter } from "./routes/salesRecord.routes";
import { recordsRouter } from "./routes/records.routes";
import { receiptRouter } from "./routes/receipt.routes";
import { csvImportRouter } from "./routes/csvImport.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { notificationRouter } from "./routes/notification.routes";
import { insightsRouter } from "./routes/insights.routes";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { countStalledAccountDeletions } from "./services/accountDeletion.service";

export const app = express();

/*
 * WHO THE CLIENT IS, as far as every IP-keyed rate limit is concerned.
 *
 * A hop count, never `true`. With `true`, Express believes the LEFT-most
 * `X-Forwarded-For` entry — a header the client writes — so anyone could mint a
 * fresh rate-limit bucket per request. With a count, Express takes the n-th
 * address from the right: the one our own nginx appended, which the client
 * cannot reach past.
 *
 * With this left at 0 behind a proxy, `req.ip` is nginx's container address for
 * every request on earth, the auth limiters collapse to a single global bucket,
 * and the product's real login limit becomes ten attempts per fifteen minutes
 * for all users combined. env.ts refuses to start a production process that has
 * not chosen a value, because both mistakes are silent.
 */
app.set("trust proxy", env.TRUST_PROXY_HOPS);

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const supplied = req.headers["x-request-id"];
      const id = typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel(_req, res, error) {
      if (error || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  }),
);
const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      // Native/mobile requests have no Origin. Browsers must match the
      // explicit comma-separated allowlist.
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
  }),
);
app.use(express.json());

app.get("/api/v1/health/live", (_req, res) => {
  res.status(200).json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
});

/**
 * Whether this caller may see the operational counters, not just the verdict.
 *
 * Outside production, always — a probe you must authenticate to read is a probe
 * nobody looks at while developing. In production, only with the configured
 * token, and an unset token means never: a variable someone forgot to set has
 * to fail closed.
 */
function maySeeHealthDetail(req: express.Request): boolean {
  if (env.NODE_ENV !== "production") return true;
  const supplied = req.headers["x-health-token"];
  return Boolean(env.HEALTH_DETAIL_TOKEN) && supplied === env.HEALTH_DETAIL_TOKEN;
}

app.get(["/api/v1/health", "/api/v1/health/ready"], async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [
      queuedScans,
      oldestQueuedScan,
      queuedCsvImports,
      oldestQueuedCsvImport,
      queuedAnalysisJobs,
      oldestQueuedAnalysisJob,
      failedAnalysisJobs,
      stalledAccountDeletions,
    ] = await Promise.all([
      prisma.receiptScan.count({ where: { processingStatus: "Processing" } }),
      prisma.receiptScan.findFirst({
        where: { processingStatus: "Processing" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.cSVImportBatch.count({ where: { processingStatus: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.cSVImportBatch.findFirst({
        where: { processingStatus: { in: ["PENDING", "PROCESSING"] } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.analysisJob.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
      prisma.analysisJob.findFirst({
        where: { status: { in: ["PENDING", "PROCESSING"] } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.analysisJob.count({ where: { status: "FAILED" } }),
      // Surfaced because a deletion that has exhausted its retries is a data
      // obligation nobody is working on. It is quiet by design — the owner was
      // already told their account was gone — so it needs somewhere to be loud.
      countStalledAccountDeletions(),
    ]);
    // Age of the oldest job still waiting on a worker, per queue — a coarse
    // backlog signal that doesn't need a dashboard: if this climbs, the
    // worker process is behind or down.
    const ageSeconds = (row: { createdAt: Date } | null): number | null =>
      row ? Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 1000)) : null;
    res.status(200).json({
      status: "ready",
      database: "ok",
      ...(maySeeHealthDetail(req)
        ? {
            queuedReceiptScans: queuedScans,
            oldestQueuedReceiptScanAgeSeconds: ageSeconds(oldestQueuedScan),
            queuedCsvImports,
            oldestQueuedCsvImportAgeSeconds: ageSeconds(oldestQueuedCsvImport),
            queuedAnalysisJobs,
            oldestQueuedAnalysisJobAgeSeconds: ageSeconds(oldestQueuedAnalysisJob),
            failedAnalysisJobs,
            stalledAccountDeletions,
          }
        : {}),
    });
  } catch (error) {
    logger.error({ err: error }, "readiness check failed");
    res.status(503).json({ status: "not-ready", database: "unavailable" });
  }
});

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/business-profiles", businessProfileRouter);
app.use("/api/v1/ai", aiRouter);
app.use("/api/v1/records/categories", expenseCategoryRouter);
app.use("/api/v1/records/expenses", expenseRecordRouter);
app.use("/api/v1/records/sales", salesRecordRouter);
app.use("/api/v1/records/receipts", receiptRouter);
app.use("/api/v1/records/csv-imports", csvImportRouter);
app.use("/api/v1/records", recordsRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use("/api/v1/notifications", notificationRouter);
app.use("/api/v1/insights", insightsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
