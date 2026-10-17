#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set([".gitignore", ".gitattributes", ".nvmrc", "AGENTS.md", "CLAUDE.md", "PRODUCT.md", "DESIGN.md", "README.md", "THIRD_PARTY_NOTICES.md", "cross-cutting-principles.md", "docker-compose.yml"]);
const ROOTS = new Set(["backend", "web", "mobile", "ml", "scripts", "nginx", ".github", ".agents", ".claude", "docs"]);
const GENERATED = /^(?:\.git|node_modules|\.venv|__pycache__|coverage|\.expo|\.cache|\.gradle|\.kotlin|\.cxx|\.idea|\.vscode|\.auth|\.supabase|\.aws|\.azure|\.config|\.pytest_cache|\.ruff_cache|\.mypy_cache)$/;
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".sql", ".prisma", ".yaml", ".yml", ".css", ".html", ".csv", ".txt", ".py", ".sh", ".patch", ".toml", ".conf", ".svg", ".xml", ".properties", ".kt", ".kts", ".java", ".gradle", ".pro", ".swift", ".m", ".mm", ".h", ".cpp", ".c", ".cmake", ".plist", ".podspec", ".xcconfig"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".ico", ".mp4", ".ttf", ".otf", ".woff", ".woff2"]);
const POLICY_FIXTURES = new Set(["docs/phase-0/benchmark-policy-v1.json", "docs/phase-0/receipt-corpus-intake.example.csv", "docs/phase-0/receipt-pair-label.example.csv"]);
const EVALUATION_FIXTURES = new Set([
  "backend/tests/ocr-accuracy/ground-truth.json", "backend/tests/ocr-accuracy/results.json",
  ...["manifest.json", "thresholds.json", "local-quality-thresholds.json", "tsconfig.local-quality.json", "tsconfig.policy-v1.json"]
    .map((name) => `backend/tests/receipt-scanner-evaluation/${name}`),
]);

export const REQUIRED = [
  "AGENTS.md", "CLAUDE.md", ".gitignore", ".nvmrc",
  ...["backend", "web", "mobile"].flatMap((project) => [`${project}/package.json`, `${project}/package-lock.json`, `${project}/tsconfig.json`]),
  "backend/.env.test", "backend/src/app.ts", "backend/src/server.ts", "backend/src/worker.ts", "backend/vitest.config.mts",
  "backend/prisma/schema.prisma", "backend/prisma/migrations/migration_lock.toml", "backend/tests/ocr-accuracy/results.json", "backend/tests/ocr-accuracy/ground-truth.json",
  "web/src/App.tsx", "web/vite.config.ts", "web/index.html", "mobile/App.tsx", "mobile/index.ts", "mobile/vitest.config.ts",
  "mobile/scripts/apply-dependency-patches.mjs", "mobile/patches/manifest.json", "ml/requirements.txt", "ml/worker/server.py",
  "mobile/modules/finsight-receipt-scanner/package.json", "mobile/modules/finsight-receipt-scanner/expo-module.config.json", "mobile/modules/finsight-receipt-scanner/android/build.gradle",
  "mobile/modules/finsight-receipt-scanner/android/src/main/java/expo/modules/finsightreceiptscanner/FinsightReceiptScannerModule.kt",
  ".github/workflows/ci.yml", "backend/tests/contract/vitest.ml-worker.config.mts", "backend/tests/contract/mlWorkerContract.test.ts",
  "backend/tests/browser-api/vitest.local-api.config.mts", "web/e2e/local-api/playwright.config.ts", "web/e2e/local-api/journeys.spec.ts",
  "backend/tests/receipt-scanner-evaluation/run-readiness-report.ts",
  "scripts/development-checkpoint.mjs", "scripts/development-checkpoint.test.mjs", "scripts/check-type-parity.mjs", "scripts/check-type-parity.test.mjs", "scripts/type-parity.mjs",
  ...POLICY_FIXTURES,
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const within = (root, location) => {
  const relative = path.relative(root, location);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export function exclusion(relative) {
  const parts = relative.split("/");
  if (parts.some((part) => GENERATED.test(part))) return "generated/dependency directory";
  if (/^(?:backend|web|mobile)\/(?:dist|dist-ssr|build|logs|web-build|test-results(?:-.*)?|playwright-report)(?:\/|$)/.test(relative) || /^mobile\/(?:android|ios)(?:\/|$)/.test(relative)) return "generated project output";
  if (/^mobile\/modules\/[^/]+\/(?:android|ios)\/(?:build|\.build|Pods)(?:\/|$)/.test(relative)) return "generated native module output";
  if (/^(?:backend\/tests\/(?:ocr-accuracy\/(?:images|inbox|\.html-tmp)|load\/results)|ml\/experiment\/reports)(?:\/|$)/.test(relative)) return "private corpus or generated report directory";
  if (/^docs\/(?:qa-reports\/.*-evidence|qa-reports\/evidence|evidence)(?:\/|$)/.test(relative)) return "generated evidence directory";
  if (/^docs\/(?:TEAM-ONBOARDING-SECRETS|.*(?:private-credentials|auth-cache))\.md$/i.test(relative)) return "private credential-oriented documentation";
  if (/(?:^|\/)(?:private[^/]*|representative-results[^/]*|native-evidence[^/]*|live-feedback[^/]*)\.json$/i.test(relative)) return "private or generated evidence JSON";
  if (/^backend\/tests\/(?:ocr-accuracy|receipt-scanner-evaluation)\/.*\.json$/.test(relative) && !EVALUATION_FIXTURES.has(relative)) return "evaluation JSON outside the reviewed fixture allowlist";
  if (/^backend\/tests\/(?:ocr-accuracy|receipt-scanner-evaluation)\/.*REPORT\.md$/i.test(relative)) return "generated evaluation report";
  if (parts.some((part) => /^(?:\.env(?:\..*)?|\.mcp\.json|settings\.local\.json)$/.test(part)) &&
      relative !== "backend/.env.test" && !relative.endsWith("/.env.example")) return "live or local environment/configuration";
  if (/\.(?:log|tsbuildinfo|traineddata|pem|key|p12|p8|jks|sqlite|db|zip|gz|dump|bak)$/i.test(relative)) return "cache, archive, credential or generated data";
  if (/^(?:backend\/tests\/ocr-accuracy\/(?:LIVE-FEEDBACK-REPORT\.md|live-feedback\.json)|backend\/tests\/receipt-scanner-evaluation\/local-quality-results\.json)$/.test(relative)) return "private or machine-specific evaluation output";
  return null;
}

export function selected(relative, directory = false) {
  if (exclusion(relative)) return false;
  const [root] = relative.split("/");
  if (!ROOTS.has(root)) return ROOT_FILES.has(relative);
  if (directory) return true;
  if (root === "docs") return POLICY_FIXTURES.has(relative) || path.extname(relative) === ".md";
  if (relative.endsWith("/.env.example") || relative === "backend/.env.test") return true;
  if (["Dockerfile", ".gitignore", ".dockerignore", "CODEOWNERS", "LICENSE", "NOTICE"].includes(path.basename(relative))) return true;
  if (TEXT_EXTENSIONS.has(path.extname(relative))) return true;
  if ((relative.startsWith("web/public/") || relative.startsWith("mobile/assets/") || relative.startsWith("backend/tests/fixtures/synthetic/")) && ASSET_EXTENSIONS.has(path.extname(relative))) return true;
  throw new Error(`Unclassified candidate artifact: ${relative}; review the include/exclude policy`);
}

function validateRelative(relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error(`Invalid relative candidate path: ${relative}`);
}

function checkedFile(root, relative) {
  validateRelative(relative);
  const location = path.resolve(root, relative);
  if (!within(root, location)) throw new Error(`Candidate path escapes root: ${relative}`);
  const info = lstatSync(location);
  if (info.isSymbolicLink() || !info.isFile() || !within(root, realpathSync(location))) throw new Error(`Unsafe candidate artifact: ${relative}`);
  return { location, info };
}

export function candidateFiles(root) {
  const files = [];
  const omitted = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!selected(relative, entry.isDirectory())) { omitted.push(relative); continue; }
      if (entry.isSymbolicLink()) throw new Error(`Refusing candidate symlink: ${relative}`);
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!within(root, realpathSync(location))) throw new Error(`Candidate directory escapes root: ${relative}`);
        walk(location, relative);
      } else {
        checkedFile(root, relative);
        files.push(relative);
      }
    }
  }
  walk(root);
  return { files, omitted };
}

function assertSafeContent(relative, bytes) {
  const text = bytes.toString("utf8");
  const credentials = [/AIza[0-9A-Za-z_-]{35}/, /\bgh[pousr]_[0-9A-Za-z]{30,}\b/, /\bsb_secret_[0-9A-Za-z_-]{20,}\b/, /\bsk_live_[0-9A-Za-z]{20,}\b/, /\bsk-or-v1-[0-9A-Za-z_-]{32,}\b/, /\bsk-proj-[0-9A-Za-z_-]{32,}\b/];
  if (credentials.some((pattern) => pattern.test(text))) throw new Error(`Recognizable credential in ${relative}; content omitted from diagnostics`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`Private key material in ${relative}; content omitted from diagnostics`);
  for (const token of text.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      if (payload.role === "service_role") throw new Error(`Service-role token in ${relative}; content omitted from diagnostics`);
    } catch (error) {
      if (error.message.startsWith("Service-role token")) throw error;
    }
  }
  if (relative !== "backend/.env.test") return;
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))) {
    const index = line.indexOf("=");
    const name = line.slice(0, index);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate synthetic test configuration key: ${name}`);
    values[name] = line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    const url = new URL(values[name]);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/finsight_test") throw new Error(`backend/.env.test ${name} must target a local finsight_test database`);
    if (url.username !== "testuser" || url.password !== "testpass") throw new Error(`backend/.env.test ${name} must use the synthetic testuser/testpass credentials`);
  }
  if (values.NODE_ENV !== "test") throw new Error("backend/.env.test must set NODE_ENV=test");
  for (const [name, value] of Object.entries(values)) {
    if (/(?:KEY|SECRET|TOKEN|PASSWORD|CLIENT_ID|USERNAME)$/.test(name) && value && !/^(?:test|fake|dummy|ci|non-secret|placeholder)[-_]/i.test(value)) throw new Error(`backend/.env.test ${name} is not an explicit synthetic placeholder`);
    if (name === "SUPABASE_URL" && value) {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
          !["example.supabase.co", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw new Error("backend/.env.test Supabase URL must use HTTP(S), no userinfo, and a loopback or synthetic example host");
      }
    }
  }
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-c", `safe.directory=${slash(root)}`, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" }, ...options,
  });
}

function originalState(source) {
  const indexLocation = path.resolve(source, git(source, ["rev-parse", "--git-path", "index"]).trim());
  return {
    revision: git(source, ["rev-parse", "HEAD"]).trim(),
    indexSha256: existsSync(indexLocation) ? sha256(readFileSync(indexLocation)) : null,
    statusSha256: sha256(git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])),
  };
}

export function verifyCheckpoint(root, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid checkpoint manifest");
  const names = new Set();
  for (const file of manifest.files) {
    validateRelative(file.path);
    if (names.has(file.path)) throw new Error(`Duplicate manifest path: ${file.path}`);
    if (!selected(file.path)) throw new Error(`Excluded path in checkpoint manifest: ${file.path}`);
    names.add(file.path);
    const bytes = readFileSync(checkedFile(root, file.path).location);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Checkpoint hash mismatch: ${file.path}`);
    assertSafeContent(file.path, bytes);
  }
  const current = candidateFiles(root).files;
  if (current.length !== names.size || current.some((name) => !names.has(name))) throw new Error("Checkpoint file inventory differs from its manifest");
  return true;
}

export function createCheckpoint({ source, output, required = REQUIRED }) {
  source = realpathSync(path.resolve(source));
  output = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
  if (within(source, output) || within(output, source)) throw new Error("Checkpoint output must be outside the source tree and cannot contain it");
  if (existsSync(output)) throw new Error("Checkpoint output already exists; choose a new empty destination");
  const before = originalState(source);
  const modes = new Map(git(source, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)]));
  const inventory = candidateFiles(source);
  const names = new Set(inventory.files);
  for (const relative of required) if (!names.has(relative)) throw new Error(`Required candidate artifact omitted or absent: ${relative}`);
  const patchManifest = names.has("mobile/patches/manifest.json") ? JSON.parse(readFileSync(path.join(source, "mobile/patches/manifest.json"))) : [];
  for (const patch of patchManifest) {
    const relative = `mobile/patches/${patch.patchFile}`;
    if (!names.has(relative) || sha256(readFileSync(checkedFile(source, relative).location)) !== patch.patchSha256) throw new Error(`Required compatibility patch absent or changed: ${relative}`);
  }
  const repository = path.join(output, "repository");
  mkdirSync(output);
  mkdirSync(repository);
  const files = [];
  for (const relative of inventory.files) {
    const { location, info } = checkedFile(source, relative);
    const bytes = readFileSync(location);
    assertSafeContent(relative, bytes);
    const mode = modes.get(relative) ?? ((info.mode & 0o111) || path.extname(relative) === ".sh" ? "100755" : "100644");
    const destination = path.join(repository, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
    if (process.platform !== "win32") chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), mode });
  }
  const manifest = {
    version: 1, capturedAt: new Date().toISOString(), source: before,
    qualification: "Complete selected working candidate, including earlier changes and required untracked dependencies; not a task-only diff or external evidence archive.",
    policy: "Explicit development roots/extensions and reviewed evaluation-JSON fixture allowlist; private data, live environments, dependencies, caches and generated reports excluded. Required synthetic test configuration and pinned policy/OCR fixtures retained. Credential scanning covers recognizable formats only, not exhaustive secret certification.",
    files, omitted: inventory.omitted,
  };
  verifyCheckpoint(source, manifest);
  if (JSON.stringify(originalState(source)) !== JSON.stringify(before)) throw new Error("Source Git revision, index or status changed during capture; recapture after owners freeze");
  git(repository, ["init", "--initial-branch=development-checkpoint"]);
  git(repository, ["add", "--force", "--all", "."]);
  for (const file of files.filter((entry) => entry.mode === "100755")) git(repository, ["update-index", "--chmod=+x", "--", file.path]);
  git(repository, ["-c", "user.name=FinSight Development Checkpoint", "-c", "user.email=development-checkpoint@invalid.local", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Capture reviewed development working candidate"]);
  manifest.checkpointRevision = git(repository, ["rev-parse", "HEAD"]).trim();
  const checkout = path.join(output, "checkout");
  git(output, ["clone", "--no-hardlinks", "--local", "--", repository, checkout]);
  verifyCheckpoint(checkout, manifest);
  const checkoutModes = new Map(git(checkout, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)]));
  for (const file of files) if (checkoutModes.get(file.path) !== file.mode) throw new Error(`Checkpoint executable mode differs: ${file.path}`);
  if (git(checkout, ["status", "--porcelain=v1", "-z"]).length) throw new Error("Isolated checkpoint checkout is not clean");
  verifyCheckpoint(source, manifest);
  if (JSON.stringify(originalState(source)) !== JSON.stringify(before)) throw new Error("Original source Git state changed; isolated checkpoint is not certified");
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { checkout, manifestPath: path.join(output, "manifest.json"), files: files.length, revision: manifest.checkpointRevision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--verify" && args.length === 3) {
      verifyCheckpoint(realpathSync(args[1]), JSON.parse(readFileSync(args[2])));
      console.log("Checkpoint files match the SHA256 manifest.");
    } else if (args.length === 4 && args[0] === "--source" && args[2] === "--output") {
      console.log(JSON.stringify(createCheckpoint({ source: args[1], output: args[3] }), null, 2));
    } else {
      console.log("Usage: node scripts/development-checkpoint.mjs --source <repository> --output <new directory outside repository>\nVerify: node scripts/development-checkpoint.mjs --verify <checkout> <manifest.json>\nIncludes reviewed earlier working changes; excludes private data, live environments and generated directories. Does not modify original Git state.");
      if (args.length && args[0] !== "--help") process.exitCode = 1;
    }
  } catch (error) {
    console.error(`development-checkpoint: ${error.message}`);
    process.exitCode = 1;
  }
}
