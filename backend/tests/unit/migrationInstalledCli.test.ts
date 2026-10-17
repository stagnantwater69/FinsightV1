import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backendTestCommand, prismaCommand, tsxCommand } from "../../scripts/migrate-workflow/installedCli";

/**
 * The migration workflow's commands must start on Windows, where bare "npx"
 * and "npm" are .cmd shims execFileSync cannot launch without a shell.
 */

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW_DIR = path.join(BACKEND_ROOT, "scripts", "migrate-workflow");

describe("installed CLI commands", () => {
  it("starts prisma through this Node", () => {
    const output = execFileSync(...prismaCommand("--version"), { cwd: BACKEND_ROOT, encoding: "utf8" });
    expect(output).toMatch(/prisma\s*:\s*\d+\.\d+/i);
  });

  it("starts tsx through this Node", () => {
    const output = execFileSync(...tsxCommand("-e", "console.log('tsx ran')"), { cwd: BACKEND_ROOT, encoding: "utf8" });
    expect(output.trim()).toBe("tsx ran");
  });

  it("points the test command at the installed vitest entry", () => {
    const [file, [entry, ...args]] = backendTestCommand();
    expect(file).toBe(process.execPath);
    expect(existsSync(entry!)).toBe(true);
    expect(args).toEqual(["--config", "vitest.config.mts", "run"]);
  });

  it("leaves no bare npx or npm launches in the migration workflow", () => {
    const launches = readdirSync(WORKFLOW_DIR)
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => {
        const source = readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
        return /exec(File)?Sync\(\s*["'](npx|npm)["']/.test(source) ? [name] : [];
      });
    expect(launches).toEqual([]);
  });
});
