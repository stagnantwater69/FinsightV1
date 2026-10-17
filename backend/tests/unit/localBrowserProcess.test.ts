import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanOwnedResources, runOwnedProcess } from "../browser-api/ownedProcess";

const scratch = mkdtempSync(path.join(tmpdir(), "finsight-browser-process-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("owned local browser lifecycle", () => {
  it("returns a natural child failure instead of claiming browser success", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", "console.error('synthetic failed');process.exit(2)"], { timeoutMs: 2_000 });
    expect(result.exit).toBe(2); expect(result.timedOut).toBe(false); expect(result.output).toContain("synthetic failed");
  });
  it("handles executable startup failure", async () => {
    await expect(runOwnedProcess(path.join(scratch, "missing-executable"), [], { timeoutMs: 500 })).rejects.toThrow();
  });
  it("requests graceful shutdown over IPC before force termination", async () => {
    const code = "process.on('message',m=>{if(m.finsightFixtureShutdown){console.log('graceful shutdown');process.exit(0)}});setInterval(()=>{},1000)";
    const result = await runOwnedProcess(process.execPath, ["-e", code], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true); expect(result.exit).toBe(0); expect(result.output).toContain("graceful shutdown");
  });
  it("terminates only its own stalled process tree, including a nested listener", async () => {
    const file = path.join(scratch, "tree.json");
    const nested = "require('node:http').createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){process.send({pid:process.pid,port:this.address().port})})";
    const code = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(nested)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',m=>require('node:fs').writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,...m})));setInterval(()=>{},1000)`;
    const result = await runOwnedProcess(process.execPath, ["-e", code, file], { timeoutMs: 1_000, graceMs: 100 });
    expect(result.timedOut).toBe(true);
    const tree = JSON.parse(readFileSync(file, "utf8"));
    expect(() => process.kill(tree.parent, 0)).toThrow(); expect(() => process.kill(tree.pid, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${tree.port}/health`)).rejects.toThrow();
  });
  it("still attempts database disconnection after earlier cleanup failures", async () => {
    const calls: string[] = [];
    await expect(cleanOwnedResources([
      async () => { calls.push("vite"); throw new Error("synthetic Vite close failed"); },
      async () => { calls.push("api"); },
      async () => { calls.push("reset"); throw new Error("synthetic reset failed"); },
      async () => { calls.push("disconnect"); },
    ])).rejects.toThrow("cleanup failed");
    expect(calls).toEqual(["vite", "api", "reset", "disconnect"]);
  });
});
