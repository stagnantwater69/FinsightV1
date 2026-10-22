#!/usr/bin/env node
// Prints the nginx CSP snippet for the production build in dist/. Run after
// `vite build` with the same mode, so the env it reads is the env the build
// used. web/Dockerfile does this; see scripts/csp.mjs for the policy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadEnv } from "vite";
import { buildCsp, nginxSnippet } from "./csp.mjs";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = loadEnv(process.env.MODE ?? "production", webRoot, "VITE_");
const html = readFileSync(path.join(webRoot, "dist", "index.html"), "utf8");

process.stdout.write(
  nginxSnippet(buildCsp({ html, supabaseUrl: env.VITE_SUPABASE_URL, sentryDsn: env.VITE_SENTRY_DSN })),
);
