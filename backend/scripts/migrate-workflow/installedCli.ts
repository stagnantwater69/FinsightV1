// Commands for the CLIs installed in backend/node_modules, run by this Node.
//
// Bare "npx" and "npm" are .cmd shims on Windows, which execFileSync cannot
// start without a shell, so every call failed with ENOENT before doing
// anything. deploy-hosted.ts fixed its one call this way; the rest of the
// migration workflow shares it here. It also pins the tool to the version in
// the lockfile rather than whatever npx would resolve.
import path from "node:path";

export type Command = readonly [file: string, args: string[]];

const vitestEntry = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

export function prismaCommand(...args: string[]): Command {
  return [process.execPath, [require.resolve("prisma/build/index.js"), ...args]];
}

export function tsxCommand(...args: string[]): Command {
  return [process.execPath, [require.resolve("tsx/cli"), ...args]];
}

/** The same run `npm test` starts, without going through npm. */
export function backendTestCommand(): Command {
  return [process.execPath, [vitestEntry, "--config", "vitest.config.mts", "run"]];
}
