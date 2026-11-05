import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// Labels replaced with plain words so an owner without accounting training can
// read the screens. Feature names (Recovery target, Available funds, ...) stay.
const RETIRED = [
  "Daily needed target",
  "Adjusted daily target",
  "Remaining operating days",
  "Cumulative target",
  "Checkpoint ahead",
  "Buffer percent",
  "Behind pace",
  "Ahead of pace",
  "Strong confidence",
  "Moderate confidence",
  "Limited confidence",
  "High confidence",
  "Low confidence",
  "Month-to-date coverage",
  "Daily coverage",
  "hypothetical recovery scenario",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("plain-language labels", () => {
  it.each([["mobile", join(__dirname, "../src")], ["web", join(__dirname, "../../web/src")]])(
    "%s screens no longer show the retired labels",
    (_app, root) => {
      const hits: string[] = [];
      const files = sources(root);
      expect(files.length).toBeGreaterThan(50);
      for (const file of files) {
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (/^\s*(\/\/|\/?\*)/.test(line)) return; // comments may still name the old term
          for (const term of RETIRED) if (line.includes(term)) hits.push(`${file}:${i + 1} ${term}`);
        });
      }
      expect(hits).toEqual([]);
    },
  );
});
