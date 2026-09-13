import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = join(__dirname, "../..");

describe("receipt API and worker process boundary", () => {
  it("does not load OCR, receipt provider adapters, dispatch, or the receipt worker when the API app starts", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        [
          'require("./src/app.ts")',
          "const root = process.cwd()",
          "const loaded = Object.keys(require.cache).filter((path) => path.startsWith(root)).map((path) => path.slice(root.length + 1)).sort()",
          "process.stdout.write(JSON.stringify(loaded))",
        ].join(";"),
      ],
      { cwd: backendRoot, env: process.env, encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
    const loaded = JSON.parse(probe.stdout) as string[];
    expect(loaded).toContain("src/services/receiptScan/queue.ts");
    expect(loaded).toContain("src/services/receiptProviderConsent.service.ts");
    expect(loaded).not.toContain("src/services/receiptScan/worker.ts");
    expect(loaded).not.toContain("src/services/receiptScan/providerAdapters.ts");
    expect(loaded).not.toContain("src/services/receiptProviderDispatch.service.ts");
    expect(loaded).not.toContain("src/services/ocr.service.ts");
    expect(loaded).not.toContain("src/services/visionOcr.service.ts");
    expect(loaded).not.toContain("src/services/veryfiOcr.service.ts");
  });

  it("keeps API receipt uploads and retries queue-only", () => {
    const controller = readFileSync(join(backendRoot, "src/controllers/receiptScan.controller.ts"), "utf8");
    const queue = readFileSync(join(backendRoot, "src/services/receiptScan/queue.ts"), "utf8");
    const server = readFileSync(join(backendRoot, "src/server.ts"), "utf8");

    expect(controller).toMatch(/services\/receiptScan\/queue/);
    expect(controller).not.toMatch(/runReceiptWorkerOnce|claimAndProcessScan|services\/receiptScan\/worker/);
    expect(queue).not.toMatch(/extractReceipt|dispatchReceiptProviderRescue|createGeminiReceiptAdapter|createVeryfiReceiptAdapter/);
    expect(server).not.toMatch(/from ["']\.\/worker|runReceiptWorkerOnce|claimAndProcessScan/);
  });
});
