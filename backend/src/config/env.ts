import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default("receipts"),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /**
   * How many reverse proxies sit in front of this process.
   *
   * This is a NUMBER OF HOPS, not a boolean, and the difference is the whole
   * point. `trust proxy: true` tells Express to believe the left-most entry in
   * `X-Forwarded-For` — which any client can write — so a rate limiter keyed on
   * `req.ip` becomes trivially evadable. A hop count makes Express take the
   * n-th address from the RIGHT, i.e. the one our own nginx appended, which a
   * client cannot forge.
   *
   * Left unset it is 0 (trust nothing), which is right for `npm run dev` where
   * the process is the edge. Deployed behind the nginx in docker-compose it is
   * 1. It has NO DEFAULT IN PRODUCTION on purpose — see the assertion below.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),
  /**
   * Shared secret for the detailed half of the readiness probe.
   *
   * `/health/ready` returns queue depths and the stalled-deletion count. Each
   * is minor alone; together they are a live load-and-backlog readout for an
   * unauthenticated caller. The plain ready/not-ready verdict stays public
   * because that is what a load balancer needs — the numbers do not.
   *
   * Unset in production means the numbers are simply never returned, so a
   * forgotten variable fails closed rather than open. Outside production they
   * are always returned, because a probe you have to authenticate to read is a
   * probe nobody uses while developing.
   */
  HEALTH_DETAIL_TOKEN: z.string().optional(),
  /** Where the web client is served, for auth email redirect links. */
  WEB_APP_URL: z.string().url().default("http://localhost:5173"),
  /** The mobile app's deep-link scheme root, for auth email redirect links. */
  MOBILE_APP_URL: z.string().default("finsight://"),
  GOOGLE_GEMINI_API_KEY: z.string().optional().default(""),
  OPENROUTER_API_KEY: z.string().optional().default(""),
  TESSERACT_LANG: z.string().default("eng"),
  ANOMALY_NEAR_DUPLICATE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ANOMALY_VELOCITY_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ANOMALY_TRENDS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ANOMALY_BEHAVIORAL_NOVELTY_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ANOMALY_RECURRING_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /**
   * Isolation Forest (shadow mode). Unlike the other detector flags, enabling
   * this produces SHADOW-status findings only — nothing owner-visible — and it
   * additionally requires the ML worker at ML_WORKER_URL to be running. If the
   * worker is down the analysis job still completes on the deterministic
   * detectors (fail open).
   */
  ANOMALY_ISOLATION_FOREST_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /** The Python scoring sidecar (ml/worker/server.py). Local-only by default. */
  ML_WORKER_URL: z.string().url().default("http://127.0.0.1:8321"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  /*
   * The one place `console.error` is deliberate rather than an oversight.
   *
   * This runs before the process is configured at all, and pino is disabled
   * under NODE_ENV=test — so routing this through the logger would make a
   * misconfigured environment fail SILENTLY in exactly the situation where the
   * message is the only thing that explains the crash. Everything after boot
   * uses the logger.
   */
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables — check backend/.env against .env.example");
}

/*
 * A production process behind a proxy that has not been told so keys every
 * rate limit on the proxy's own address — one bucket for the entire internet,
 * which turns a single wrong password into a site-wide lockout. A production
 * process NOT behind a proxy that claims to be is the mirror failure: clients
 * spoof `X-Forwarded-For` and every limit becomes optional.
 *
 * Neither is detectable at runtime, and both are silent. So production must
 * state which it is rather than inherit a default that is wrong half the time.
 */
if (parsed.data.NODE_ENV === "production" && parsed.data.TRUST_PROXY_HOPS === undefined) {
  throw new Error(
    "TRUST_PROXY_HOPS must be set explicitly in production. Use 1 behind the bundled nginx, " +
      "or 0 if the Node process is itself the public edge. See backend/.env.example.",
  );
}

export const env = { ...parsed.data, TRUST_PROXY_HOPS: parsed.data.TRUST_PROXY_HOPS ?? 0 };
