import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkWorkerPrerequisites, readinessAddress, startOwnedWorker, validateWorkerVersions, withinWorkerStartupBudget, workerEnvironment } from "../support/mlWorkerHarness";

const root = mkdtempSync(path.join(tmpdir(), "finsight-ml-harness-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ML contract prerequisites", () => {
  it("selects the Windows venv interpreter", () => {
    expect(workerEnvironment(root, {}, "win32").python).toBe(path.join(root, "ml/.venv/Scripts/python.exe"));
  });
  it("selects the Unix venv interpreter", () => {
    expect(workerEnvironment(root, {}, "linux").python).toBe(path.join(root, "ml/.venv/bin/python"));
  });
  it("resolves an explicit interpreter without PATH fallback", () => {
    expect(workerEnvironment(root, { FINSIGHT_ML_CONTRACT_PYTHON: "custom/python" }, "win32").python)
      .toBe(path.join(root, "custom/python"));
  });
  it("fails closed when strict prerequisites are missing", () => {
    const config = workerEnvironment(root, { FINSIGHT_REQUIRE_ML_WORKER_CONTRACT: "1" });
    expect(config.required).toBe(true);
    expect(() => checkWorkerPrerequisites(config)).toThrow("prerequisites unavailable");
  });
  it("rejects a misspelled strict flag", () => {
    expect(() => workerEnvironment(root, { FINSIGHT_REQUIRE_ML_WORKER_CONTRACT: "true" })).toThrow("must be 0 or 1");
  });
  const pins = "scikit-learn==1.9.0\nnumpy==2.5.2\n";
  const good = { python: [3, 14], numpy: "2.5.2", sklearn: "1.9.0" };
  it("accepts only the documented interpreter and exact dependency pins", () => {
    expect(() => validateWorkerVersions(pins, good)).not.toThrow();
  });
  it.each([
    { ...good, python: [3, 13] },
    { ...good, numpy: "2.5.1" },
    { ...good, sklearn: "1.8.0" },
  ])("rejects an incompatible installed environment %#", (versions) => {
    expect(() => validateWorkerVersions(pins, versions)).toThrow(/requires/);
  });
  it("rejects unpinned or duplicated dependency requirements", () => {
    expect(() => validateWorkerVersions("numpy>=2.5\nscikit-learn==1.9.0", good)).toThrow();
    expect(() => validateWorkerVersions(`${pins}numpy==2.5.2\n`, good)).toThrow();
  });
  it("does not silently ignore an explicit unusable interpreter", () => {
    const fake = path.join(root, "not-python");
    mkdirSync(path.join(root, "ml/worker"), { recursive: true });
    writeFileSync(fake, "not executable");
    writeFileSync(path.join(root, "ml/worker/server.py"), "");
    writeFileSync(path.join(root, "ml/requirements.txt"), pins);
    expect(() => checkWorkerPrerequisites(workerEnvironment(root, { FINSIGHT_ML_CONTRACT_PYTHON: fake })))
      .toThrow("could not import");
  });
});

describe("owned worker process", () => {
  it("charges prerequisite time to the same startup budget, leaving cleanup inside the original hook", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(11_000);
    try {
      const start = vi.fn().mockResolvedValue("owned");
      expect(await withinWorkerStartupBudget(() => {}, start)).toBe("owned");
      expect(start).toHaveBeenCalledWith(5_000);
    } finally { clock.mockRestore(); }
  });
  it("does not spawn when prerequisite work exhausts the startup budget", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(16_000);
    try {
      const start = vi.fn();
      await expect(withinWorkerStartupBudget(() => {}, start)).rejects.toThrow("exhausted");
      expect(start).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it.each([
    { nonce: "foreign", host: "127.0.0.1", port: 4321 },
    { nonce: "owned", host: "0.0.0.0", port: 4321 },
    { nonce: "owned", host: "127.0.0.1", port: 0 },
    { nonce: "owned", host: "127.0.0.1", port: "4321" },
  ])("rejects foreign or invalid readiness metadata %#", (metadata) => {
    expect(readinessAddress(JSON.stringify(metadata), "owned")).toBeNull();
  });
  const serverCode = [
    "const http=require('node:http'),fs=require('node:fs');",
    "const nonce=process.argv[1],file=process.argv[2],wrong=process.argv[3]==='wrong';",
    "http.createServer((req,res)=>{res.end('{}')}).listen(0,'127.0.0.1',function(){",
    "const record={nonce:wrong?'foreign':nonce,host:'127.0.0.1',port:this.address().port,pid:process.pid};",
    "fs.writeFileSync(file,JSON.stringify(record));console.log(JSON.stringify(record));});",
  ].join("");
  it("owns an ephemeral listener and awaits complete process termination", async () => {
    const file = path.join(root, "owned.json");
    const worker = await startOwnedWorker(process.execPath, (nonce) => ["-e", serverCode, nonce, file]);
    try {
      expect((await fetch(`${worker.base}/health`)).ok).toBe(true);
      expect(worker.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await worker.stop();
    }
    await expect(fetch(`${worker.base}/health`)).rejects.toThrow();
    expect(() => process.kill(worker.pid!, 0)).toThrow();
  });
  it("never accepts foreign readiness, and cleans up a timed-out owned process", async () => {
    const file = path.join(root, "foreign.json");
    await expect(startOwnedWorker(process.execPath, (nonce) => ["-e", serverCode, nonce, file, "wrong"], 1_000))
      .rejects.toThrow("startup timed out");
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(() => process.kill(record.pid, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${record.port}/health`)).rejects.toThrow();
  });
  it("fails immediately when the spawned process exits", async () => {
    await expect(startOwnedWorker(process.execPath, () => ["-e", "process.exit(3)"], 1_000))
      .rejects.toThrow("exited before");
  });
  it("handles interpreter spawn errors without an unhandled error or orphan", async () => {
    await expect(startOwnedWorker(path.join(root, "missing-python"), () => [], 1_000))
      .rejects.toThrow("exited before");
  });
});
