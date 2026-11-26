#!/usr/bin/env node
// Run the FinSight verification gate and record what happened.
//
//   node scripts/verify.mjs <fast|integration|full> [--out <dir>] [--dry-run]
//
//   fast         type parity, then backend (unit tests only), web and mobile
//   integration  backend `npm run test:isolated` (its own throwaway Postgres container)
//   full         fast, with the backend unit tests replaced by `npm run test:isolated`
//
// Writes run.json and one log per step to --out, by default
// <os.tmpdir()>/finsight-verify/<UTC timestamp>-<short sha>/, never inside the repo.
// run.json says "incomplete" until the last step ends, so a killed run never reads as passed.
// Needs Node 22 and installed node_modules; a project without them is recorded as skipped.
// It never reads .env files, sets DATABASE_URL, runs migrations or touches the shared finsight-test-db.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILES = ["fast", "integration", "full"];

const step = (project, argv, setup = false, name = null, needs = project) => ({
  name: name ?? `${project}-${argv.slice(argv[0] === "npm" && argv[1] === "run" ? 2 : 1).join("-").replace(/[^\w.-]+/g, "-")}`,
  project, needs, cwd: project ?? ".", argv, setup,
});
const npmRun = (project, script) => step(project, ["npm", "run", script]);

export function plan(profile) {
  if (!PROFILES.includes(profile)) throw new Error(`Unknown profile "${profile}". Use one of: ${PROFILES.join(", ")}`);
  const isolated = npmRun("backend", "test:isolated");
  if (profile === "integration") return [isolated];
  return [
    // type-parity.mjs loads TypeScript from backend/node_modules.
    step(null, ["node", "scripts/check-type-parity.mjs"], false, "type-parity", "backend"),
    step("backend", ["npx", "prisma", "generate"], true),
    step("backend", ["npx", "prisma", "validate"], true),
    ...["typecheck", "lint", "build"].map((script) => npmRun("backend", script)),
    profile === "full" ? isolated : npmRun("backend", "test:unit"),
    ...["typecheck", "lint", "test", "build", "check:bundle-budget"].map((script) => npmRun("web", script)),
    ...["typecheck", "lint", "test"].map((script) => npmRun("mobile", script)),
  ];
}

export function checkNode(version = process.version) {
  if (Number(/^v?(\d+)/.exec(version)?.[1]) !== 22) {
    throw new Error(`Node 22 is required (this is ${version}). Put Node 22 first on PATH and run again; results from other versions are not comparable to CI.`);
  }
}

// vitest fails every file when its cwd starts with a lower-case drive letter.
export const upperDrive = (location) => location.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);

// Bare npm/npx are .cmd shims on Windows that spawn cannot start without a shell.
export function npmCliPath(execPath = process.execPath, platform = process.platform, exists = existsSync) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dir = p.dirname(execPath);
  const candidates = [p.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) throw new Error(`Cannot find npm-cli.js next to ${execPath}. Looked in:\n  ${candidates.join("\n  ")}`);
  return found;
}

export function spawnArgv([command, ...rest], { execPath = process.execPath, npmCli }) {
  if (command === "node") return [execPath, ...rest];
  if (command === "npm") return [execPath, npmCli, ...rest];
  if (command === "npx") return [execPath, path.join(path.dirname(npmCli), "npx-cli.js"), ...rest];
  throw new Error(`No launcher for "${command}"`);
}

/**
 * On Windows a running backend (the dev API or worker) holds the query engine DLL open, so
 * `prisma generate` rewrites the client and then fails to rename its fresh engine copy over the
 * locked one. If every copy this run left is byte-identical to the engine in place, the client is
 * current: the copies are removed and the caller counts the step as passed. Anything else stays failed.
 */
export function lockedEngineIsCurrent(clientDir, since, logPath) {
  let log, names;
  try { log = readFileSync(logPath, "utf8"); names = readdirSync(clientDir); } catch { return false; }
  if (!/EPERM[\s\S]{0,40}rename[\s\S]{0,400}query_engine/.test(log)) return false;
  const copies = names.filter((name) => /^query_engine.*\.node\.tmp\d+$/.test(name))
    .map((name) => path.join(clientDir, name))
    .filter((file) => statSync(file).birthtimeMs >= since);
  if (copies.length === 0) return false;
  const engine = (copy) => copy.replace(/\.tmp\d+$/, "");
  if (!copies.every((copy) => existsSync(engine(copy)) && readFileSync(copy).equals(readFileSync(engine(copy))))) return false;
  for (const copy of copies) rmSync(copy, { force: true });
  return true;
}

function within(root, location) {
  const relative = path.relative(root, location);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseArgs(args) {
  const [profile, ...rest] = args;
  const options = { profile, dryRun: false, out: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") options.dryRun = true;
    else if (rest[i] === "--out" && rest[i + 1]) options.out = rest[++i];
    else throw new Error(`Unexpected argument "${rest[i]}"`);
  }
  plan(profile);
  return options;
}

function defaultCapture(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function defaultStart(file, args, { cwd, logPath }) {
  const fd = openSync(logPath, "a");
  // POSIX: own process group, so the whole tree can be signalled by this one PID.
  const child = spawn(file, args, { cwd, stdio: ["ignore", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
  closeSync(fd);
  const done = new Promise((resolve) => {
    child.once("error", (error) => { writeFileSync(logPath, `\nverify: could not start: ${error.message}\n`, { flag: "a" }); resolve(null); });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : null)));
  });
  return { pid: child.pid, done };
}

function defaultKill(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGTERM");
  } catch { /* already exited */ }
}

function writeRecord(out, record) {
  const file = path.join(out, "run.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Runs a profile and returns { status, exitCode, out, record }.
 * `signals` is an EventEmitter for SIGINT/SIGTERM; start/kill/capture are injectable so tests spawn nothing.
 */
export async function verify({
  profile, out = null, root = ROOT, nodeVersion = process.version, execPath = process.execPath,
  npmCli, exists = existsSync, capture = defaultCapture, start = defaultStart, kill = defaultKill,
  signals = process, log = console.log, engineCurrent = lockedEngineIsCurrent,
}) {
  checkNode(nodeVersion);
  const steps = plan(profile);
  root = upperDrive(path.resolve(root));
  npmCli ??= npmCliPath(execPath);
  const git = (...args) => capture("git", args, root).trim();
  const sha = git("rev-parse", "HEAD");
  const status = capture("git", ["status", "--porcelain"], root);
  const startedAt = new Date();
  out = path.resolve(out ?? path.join(os.tmpdir(), "finsight-verify", `${stamp(startedAt)}-${sha.slice(0, 7)}`));
  if (within(root, out)) throw new Error(`--out must be outside the repository (${out})`);
  mkdirSync(out, { recursive: true });
  if (exists(path.join(out, "run.json"))) throw new Error(`${path.join(out, "run.json")} already exists; pick a new --out`);

  const record = {
    schemaVersion: 1, profile, status: "incomplete",
    git: { sha, branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: status.trim() !== "", status },
    node: nodeVersion, npm: capture(execPath, [npmCli, "--version"], root).trim(),
    startedAt: startedAt.toISOString(), endedAt: null, out,
    steps: steps.map((s, i) => ({
      name: s.name, cwd: s.cwd, argv: s.argv, spawnArgv: spawnArgv(s.argv, { execPath, npmCli }),
      startedAt: null, durationMs: null, exitCode: null, status: "pending", reason: null,
      log: path.join(out, `${String(i + 1).padStart(2, "0")}-${s.name}.log`),
    })),
  };
  writeRecord(out, record);
  log(`verify ${profile}: writing to ${out}`);

  let interrupt;
  const interrupted = new Promise((resolve) => { interrupt = resolve; });
  const onSignal = (signal) => interrupt(signal);
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  const blocked = new Map();
  try {
    for (const [i, s] of steps.entries()) {
      const entry = record.steps[i];
      const missing = s.needs && !exists(path.join(root, s.needs, "node_modules"));
      const reason = missing ? `${s.needs}/node_modules is missing; run npm ci in ${s.needs}` : blocked.get(s.project);
      if (reason) {
        Object.assign(entry, { status: "skipped", reason, log: null });
        writeRecord(out, record);
        log(`  skipped  ${s.name}: ${reason}`);
        continue;
      }
      const cwd = upperDrive(path.join(root, s.cwd));
      writeFileSync(entry.log, `$ ${s.argv.join(" ")}\ncwd: ${cwd}\n\n`);
      entry.startedAt = new Date().toISOString();
      entry.status = "running";
      writeRecord(out, record);
      const began = Date.now();
      const [file, ...args] = entry.spawnArgv;
      const child = start(file, args, { cwd, logPath: entry.log });
      const result = await Promise.race([child.done.then((code) => ({ code })), interrupted.then((signal) => ({ signal }))]);
      entry.durationMs = Date.now() - began;
      if (result.signal) {
        kill(child.pid);
        Object.assign(entry, { status: "interrupted", reason: `received ${result.signal}` });
        record.endedAt = new Date().toISOString();
        writeRecord(out, record);
        log(`  interrupted ${s.name}; run left incomplete. Record: ${path.join(out, "run.json")}`);
        return { status: "incomplete", exitCode: 130, out, record };
      }
      entry.exitCode = result.code;
      entry.status = result.code === 0 ? "passed" : "failed";
      if (entry.status === "failed" && s.argv.join(" ") === "npx prisma generate"
        && engineCurrent(path.join(cwd, "node_modules", ".prisma", "client"), began, entry.log)) {
        entry.status = "passed";
        entry.reason = "client regenerated; a running process holds the query engine, which is byte-identical to the new one";
      }
      if (entry.status === "failed" && s.setup) blocked.set(s.project, `setup step ${s.name} failed`);
      writeRecord(out, record);
      log(`  ${entry.status.padEnd(8)} ${s.name} (${entry.durationMs} ms)`);
    }
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
  record.status = record.steps.every((entry) => entry.status === "passed") ? "passed" : "failed";
  record.endedAt = new Date().toISOString();
  writeRecord(out, record);
  log(`verify ${profile}: ${record.status}. Record: ${path.join(out, "run.json")}`);
  return { status: record.status, exitCode: record.status === "passed" ? 0 : 1, out, record };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    checkNode();
    if (options.dryRun) {
      for (const s of plan(options.profile)) console.log(`${s.name.padEnd(28)} cwd=${s.cwd.padEnd(8)} ${s.argv.join(" ")}`);
    } else {
      const { exitCode } = await verify(options);
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(`verify: ${error.message}`);
    console.error("Usage: node scripts/verify.mjs <fast|integration|full> [--out <dir>] [--dry-run]");
    process.exit(1);
  }
}
