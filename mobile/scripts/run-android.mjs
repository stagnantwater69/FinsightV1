import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function firstDirectory(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

const env = { ...process.env };
const javaHome = firstDirectory([
  env.JAVA_HOME,
  join(homedir(), "devtools", "jdk"),
  join(homedir(), "android-tools", "jdk"),
]);
const androidHome = firstDirectory([
  env.ANDROID_HOME,
  env.ANDROID_SDK_ROOT,
  join(homedir(), "devtools", "android-sdk"),
  join(homedir(), "android-tools", "sdk"),
]);

if (javaHome) env.JAVA_HOME = javaHome;
if (androidHome) {
  env.ANDROID_HOME = androidHome;
  env.ANDROID_SDK_ROOT = androidHome;
}

if (!javaHome || !androidHome) {
  console.error(
    "A native Android build is required for Auto scan. Set JAVA_HOME and ANDROID_HOME (or install the project-local toolchain) before running this command.",
  );
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["expo", "run:android", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
