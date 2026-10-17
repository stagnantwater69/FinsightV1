import { config as loadEnv } from "dotenv";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { guardBrowserFixture } from "./guard";

const defaults = loadEnv({ path: ".env.test" }).parsed ?? {};
guardBrowserFixture(process.env);

export default defineConfig({
  test: {
    environment: "node",
    env: { ...defaults, ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      NODE_ENV: "development", DOTENV_CONFIG_PATH: path.resolve(".env.test"), LOG_LEVEL: "silent", GOOGLE_GEMINI_API_KEY: "", OPENROUTER_API_KEY: "",
      SUPABASE_URL: "http://127.0.0.1", SUPABASE_ANON_KEY: "synthetic-local-only", SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-only" },
    include: ["tests/browser-api/localApi.suite.ts"],
    globalSetup: ["./tests/browser-api/globalSetup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
