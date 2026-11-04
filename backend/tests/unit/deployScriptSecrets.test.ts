import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deployDir = join(__dirname, "..", "..", "..", "deploy");

describe("deploy scripts", () => {
  // `docker run -e NAME="$VALUE"` puts the value in the docker process's
  // argv, readable by any local user via `ps` or /proc/*/cmdline while the
  // job runs. A bare `-e NAME` makes docker copy it from its environment.
  it("never pass a variable's value to docker on the command line", () => {
    const offenders = readdirSync(deployDir)
      .filter((name) => name.endsWith(".sh"))
      .flatMap((name) =>
        readFileSync(join(deployDir, name), "utf8")
          .split("\n")
          .map((line, index) => ({ where: `${name}:${index + 1}`, line }))
          .filter(({ line }) => /\s-e\s+[A-Z_][A-Z0-9_]*="?\$/.test(line)),
      )
      .map(({ where }) => where);
    expect(offenders).toEqual([]);
  });
});
