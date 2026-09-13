import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { androidBuildSpaceError } from "./android-build-space.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const spaceError = androidBuildSpaceError(projectRoot);
if (spaceError) {
  console.error(spaceError);
  process.exit(1);
}

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
    "A standalone Android build needs JAVA_HOME and ANDROID_HOME (or the project-local toolchain).",
  );
  process.exit(1);
}

const androidDir = join(projectRoot, "android");
const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const configResult = spawnSync(npx, ["expo", "config", "--type", "public", "--json"], {
  cwd: projectRoot,
  env,
  encoding: "utf8",
});
if (configResult.error) throw configResult.error;
if (configResult.status !== 0) {
  console.error("Could not resolve the Expo configuration for this APK build.");
  process.exit(configResult.status ?? 1);
}

let apiBaseUrl;
try {
  apiBaseUrl = JSON.parse(configResult.stdout).extra?.apiBaseUrl;
  const url = new URL(apiBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "10.0.2.2"].includes(url.hostname)) {
    throw new Error("host is not reachable from a physical phone");
  }
} catch {
  console.error(
    "EXPO_PUBLIC_API_BASE_URL must be an http(s) address reachable from the physical phone, such as your computer's current LAN IP.",
  );
  process.exit(1);
}
console.log(`Standalone APK API: ${apiBaseUrl}`);

const prebuild = spawnSync(npx, ["expo", "prebuild", "--platform", "android", "--no-install"], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});
if (prebuild.error) throw prebuild.error;
if (prebuild.status !== 0) process.exit(prebuild.status ?? 1);

// This APK is installed directly on the physical phone, which is arm64. A
// default React Native release compiles four ABIs and ran the host out of
// memory during native compilation; limiting both ABI and Gradle concurrency
// keeps the local build inside the available RAM without changing app code.
const result = spawnSync(gradle, [
  ":app:assembleRelease",
  "-PreactNativeArchitectures=arm64-v8a",
  "--no-parallel",
  "--max-workers=2",
], {
  cwd: androidDir,
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("Standalone APK: android/app/build/outputs/apk/release/app-release.apk");
