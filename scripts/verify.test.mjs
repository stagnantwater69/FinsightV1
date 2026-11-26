import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkNode, lockedEngineIsCurrent, npmCliPath, parseArgs, plan, upperDrive, verify } from "./verify.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "finsight-verify-selftest-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

function fixture({ installed = ["backend", "web", "mobile"], exitCodes = {}, hang = null } = {}) {
  const root = path.join(scratch, `repo-${sequence}`);
  const out = path.join(scratch, `out-${sequence++}`);
  for (const project of installed) mkdirSync(path.join(root, project, "node_modules"), { recursive: true });
  const started = [];
  const killed = [];
  const signals = new EventEmitter();
  const capture = (file, args) => {
    if (file === "git" && args[0] === "status") return " M scripts/verify.mjs\n";
    if (file === "git" && args.includes("--abbrev-ref")) return "feat/test\n";
    if (file === "git") return "0123456789abcdef0123456789abcdef01234567\n";
    return "10.9.0\n";
  };
  const start = (file, args, { cwd, logPath }) => {
    const pid = 1000 + started.length;
    const argv = args.slice(1);
    started.push({ file, args, cwd, logPath, pid });
    const key = argv.join(" ");
    if (hang && key.includes(hang)) {
      setImmediate(() => signals.emit("SIGINT", "SIGINT"));
      return { pid, done: new Promise(() => {}) };
    }
    return { pid, done: Promise.resolve(exitCodes[key] ?? 0) };
  };
  const options = (profile) => ({
    profile, out, root, nodeVersion: "v22.23.3", execPath: "/node/bin/node", npmCli: "/node/lib/node_modules/npm/bin/npm-cli.js",
    capture, start, kill: (pid) => killed.push(pid), signals, log: () => {},
  });
  const runJson = () => JSON.parse(readFileSync(path.join(out, "run.json"), "utf8"));
  return { root, out, started, killed, signals, options, runJson };
}

const names = (profile) => plan(profile).map((s) => s.name);

test("profiles contain the gate steps in order", () => {
  const web = ["web-typecheck", "web-lint", "web-test", "web-build", "web-check-bundle-budget"];
  const mobile = ["mobile-typecheck", "mobile-lint", "mobile-test"];
  const backend = ["backend-prisma-generate", "backend-prisma-validate", "backend-typecheck", "backend-lint", "backend-build"];
  assert.deepEqual(names("fast"), ["type-parity", ...backend, "backend-test-unit", ...web, ...mobile]);
  assert.deepEqual(names("full"), ["type-parity", ...backend, "backend-test-isolated", ...web, ...mobile]);
  assert.deepEqual(names("integration"), ["backend-test-isolated"]);
  assert.deepEqual(plan("integration")[0].argv, ["npm", "run", "test:isolated"]);
  assert.ok(plan("full").every((s) => !s.argv.includes("test:db:up") && !s.argv.includes("migrate")));
  assert.throws(() => plan("quick"), /Unknown profile/);
  assert.throws(() => parseArgs(["fast", "--force"]), /Unexpected argument/);
  assert.deepEqual(parseArgs(["full", "--out", "x", "--dry-run"]), { profile: "full", out: "x", dryRun: true });
});

test("refuses any Node major other than 22", async () => {
  assert.doesNotThrow(() => checkNode("v22.23.3"));
  for (const version of ["v25.1.0", "v24.0.0", "v20.11.1", "v2.0.0"]) assert.throws(() => checkNode(version), /Node 22 is required/);
  const f = fixture();
  await assert.rejects(verify({ ...f.options("fast"), nodeVersion: "v25.1.0" }), /Node 22 is required/);
  assert.equal(f.started.length, 0);
});

test("a passing run moves run.json from incomplete to passed and records each step", async () => {
  const f = fixture();
  const snapshots = [];
  const options = f.options("fast");
  const start = options.start;
  options.start = (...args) => { snapshots.push(f.runJson().status); return start(...args); };
  const result = await verify(options);
  assert.equal(result.exitCode, 0);
  assert.ok(snapshots.length === plan("fast").length && snapshots.every((status) => status === "incomplete"));
  const record = f.runJson();
  assert.equal(record.status, "passed");
  assert.equal(record.schemaVersion, 1);
  assert.deepEqual(record.git, { sha: "0123456789abcdef0123456789abcdef01234567", branch: "feat/test", dirty: true, status: " M scripts/verify.mjs\n" });
  assert.equal(record.npm, "10.9.0");
  assert.ok(record.endedAt);
  const unit = record.steps.find((s) => s.name === "backend-test-unit");
  assert.equal(unit.cwd, "backend");
  assert.deepEqual(unit.spawnArgv, ["/node/bin/node", "/node/lib/node_modules/npm/bin/npm-cli.js", "run", "test:unit"]);
  assert.equal(unit.status, "passed");
  assert.equal(unit.exitCode, 0);
  assert.equal(typeof unit.durationMs, "number");
  assert.match(readFileSync(unit.log, "utf8"), /^\$ npm run test:unit\n/);
  assert.equal(f.started.find((s) => s.args.at(-1) === "generate").args[0], path.join("/node/lib/node_modules/npm/bin", "npx-cli.js"));
  assert.equal(f.started[0].cwd, upperDrive(path.resolve(f.root)));
});

test("a failed step fails the run without stopping other projects", async () => {
  const f = fixture({ exitCodes: { "run lint": 2 } });
  const result = await verify(f.options("fast"));
  assert.equal(result.exitCode, 1);
  const record = f.runJson();
  assert.equal(record.status, "failed");
  assert.deepEqual(record.steps.filter((s) => s.status === "failed").map((s) => s.name), ["backend-lint", "web-lint", "mobile-lint"]);
  assert.equal(record.steps.find((s) => s.name === "mobile-test").status, "passed");
});

test("missing node_modules skips that project and the run can never pass", async () => {
  const f = fixture({ installed: ["backend", "mobile"] });
  const result = await verify(f.options("fast"));
  const record = f.runJson();
  assert.equal(result.exitCode, 1);
  assert.equal(record.status, "failed");
  const web = record.steps.filter((s) => s.cwd === "web");
  assert.ok(web.length === 5 && web.every((s) => s.status === "skipped" && /web\/node_modules is missing/.test(s.reason)));
  assert.ok(record.steps.filter((s) => s.cwd !== "web").every((s) => s.status === "passed"));
  assert.ok(!f.started.some((s) => s.cwd.endsWith(`${path.sep}web`)));
});

test("type parity is skipped without backend/node_modules, since it loads TypeScript from there", async () => {
  const f = fixture({ installed: ["web", "mobile"] });
  await verify(f.options("fast"));
  const parity = f.runJson().steps[0];
  assert.equal(parity.name, "type-parity");
  assert.equal(parity.status, "skipped");
  assert.equal(parity.log, null);
  assert.match(parity.reason, /backend\/node_modules is missing/);
});

test("prisma generate blocked only by a locked, identical engine counts as passed", async () => {
  const f = fixture({ exitCodes: { "prisma generate": 1 } });
  const seen = [];
  await verify({ ...f.options("fast"), engineCurrent: (dir, since, log) => { seen.push({ dir, since, log }); return true; } });
  const generate = f.runJson().steps.find((s) => s.name === "backend-prisma-generate");
  assert.equal(generate.status, "passed");
  assert.equal(generate.exitCode, 1);
  assert.match(generate.reason, /byte-identical/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].dir, path.join(f.root, "backend", "node_modules", ".prisma", "client"));
  assert.equal(f.runJson().status, "passed");
});

const LOCKED_LOG = "Error:\nEPERM: operation not permitted, rename\n'C:\\x\\query_engine-windows.dll.node.tmp26912' -> 'C:\\x\\query_engine-windows.dll.node'\n";

function engineDir({ engine = "engine-v1", copy = "engine-v1", log = LOCKED_LOG } = {}) {
  const dir = path.join(scratch, `client-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "query_engine-windows.dll.node"), engine);
  writeFileSync(path.join(dir, "query_engine-windows.dll.node.tmp26912"), copy);
  writeFileSync(path.join(dir, "generate.log"), log);
  return { dir, copy: path.join(dir, "query_engine-windows.dll.node.tmp26912"), log: path.join(dir, "generate.log") };
}

test("a locked engine is current only when the run's copy matches it and the log shows the rename failure", () => {
  const same = engineDir();
  assert.equal(lockedEngineIsCurrent(same.dir, 0, same.log), true);
  assert.equal(existsSync(same.copy), false, "the identical copy is cleaned up");

  const changed = engineDir({ copy: "engine-v2" });
  assert.equal(lockedEngineIsCurrent(changed.dir, 0, changed.log), false);
  assert.equal(existsSync(changed.copy), true, "a newer engine is left for the owner to install");

  const otherError = engineDir({ log: "Error: P1012 schema validation failed\n" });
  assert.equal(lockedEngineIsCurrent(otherError.dir, 0, otherError.log), false);

  const stale = engineDir();
  assert.equal(lockedEngineIsCurrent(stale.dir, Date.now() + 60_000, stale.log), false, "copies from earlier runs do not count");
  assert.equal(lockedEngineIsCurrent(path.join(scratch, "missing"), 0, same.log), false);
});

test("a failed setup step skips the rest of that project only", async () => {
  const f = fixture({ exitCodes: { "prisma generate": 1 } });
  await verify(f.options("full"));
  const record = f.runJson();
  const backend = record.steps.filter((s) => s.cwd === "backend");
  assert.equal(backend[0].status, "failed");
  assert.ok(backend.slice(1).every((s) => s.status === "skipped" && s.reason === "setup step backend-prisma-generate failed"));
  assert.ok(record.steps.filter((s) => s.cwd === "web" || s.cwd === "mobile").every((s) => s.status === "passed"));
  assert.equal(record.status, "failed");
});

test("an interrupted run stays incomplete and stops only its own child", async () => {
  const f = fixture({ hang: "run build" });
  const result = await verify(f.options("fast"));
  assert.equal(result.status, "incomplete");
  assert.notEqual(result.exitCode, 0);
  const record = f.runJson();
  assert.equal(record.status, "incomplete");
  const build = record.steps.find((s) => s.name === "backend-build");
  assert.equal(build.status, "interrupted");
  assert.deepEqual(f.killed, [f.started.at(-1).pid]);
  assert.ok(record.steps.slice(record.steps.indexOf(build) + 1).every((s) => s.status === "pending"));
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
});

test("refuses an output directory inside the repository or an existing run", async () => {
  const f = fixture();
  await assert.rejects(verify({ ...f.options("fast"), out: path.join(f.root, "evidence") }), /outside the repository/);
  await verify(f.options("integration"));
  await assert.rejects(verify(f.options("integration")), /already exists/);
});

test("upper-cases a lower-case Windows drive letter only", () => {
  assert.equal(upperDrive("c:\\Users\\Ken\\repo"), "C:\\Users\\Ken\\repo");
  assert.equal(upperDrive("C:/repo"), "C:/repo");
  assert.equal(upperDrive("/home/ken/repo"), "/home/ken/repo");
});

test("finds npm-cli.js for Windows/fnm and Linux layouts, and fails clearly otherwise", () => {
  const windows = "C:\\fnm\\v22\\installation\\node_modules\\npm\\bin\\npm-cli.js";
  assert.equal(npmCliPath("C:\\fnm\\v22\\installation\\node.exe", "win32", (p) => p === windows), windows);
  const linux = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
  assert.equal(npmCliPath("/usr/local/bin/node", "linux", (p) => p === linux), linux);
  assert.throws(() => npmCliPath("/opt/node/bin/node", "linux", () => false), /Cannot find npm-cli\.js/);
});
