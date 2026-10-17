import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const nativeChecks = [
  "camera-permission", "scanner-geometry", "capture-lifecycle", "receipt-history",
  "durable-chat-recovery", "storage-logout", "date-money-touch", "older-history-retry",
] as const;

export function parseDeviceInventory(stdout: string) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^([^\s]+)\s+(device|offline|unauthorized)(?:\s|$)/.exec(line.trim());
    return match ? [{ serial: match[1]!, state: match[2]! }] : [];
  });
}

export function findAdb(env: Record<string, string | undefined> = process.env) {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    env.FINSIGHT_NATIVE_ADB,
    env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, "platform-tools", executable),
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, "platform-tools", executable),
    path.join(os.homedir(), "AppData/Local/Android/Sdk/platform-tools", executable),
    path.join(os.homedir(), "Android/Sdk/platform-tools", executable),
    path.join(os.homedir(), "Library/Android/sdk/platform-tools", executable),
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, executable)),
  ];
  if (env.FINSIGHT_NATIVE_ADB) return existsSync(env.FINSIGHT_NATIVE_ADB) ? env.FINSIGHT_NATIVE_ADB : undefined;
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

type ReadAdb = (args: string[]) => string;
const readAdb = (adb: string): ReadAdb => (args) => execFileSync(adb, args, {
  encoding: "utf8", timeout: 5_000, maxBuffer: 16_384, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();

function publicMetadata(value: string) {
  return /^[\p{L}\p{N} ._()/-]{1,80}$/u.test(value) ? value : "unavailable";
}

export function collectNativeEvidence(adb?: string, execute?: ReadAdb) {
  const report = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    status: "DEVICE_UNAVAILABLE",
    adbAvailable: Boolean(adb),
    inventoryReadable: false,
    connectedDevices: 0,
    offlineDevices: 0,
    unauthorizedDevices: 0,
    emulators: 0,
    devices: [] as { model: string; androidVersion: string; kind: "emulator" | "unconfirmed-device" }[],
    manualChecks: nativeChecks.map((id) => ({ id, status: "PENDING" })),
    limits: ["Read-only inventory and public OS/model metadata; no app/account access.",
      "No camera, storage, gesture, lifecycle or accessibility behavior is verified."],
  };
  if (!adb) return report;
  const run = execute ?? readAdb(adb);
  let inventory: ReturnType<typeof parseDeviceInventory>;
  try {
    inventory = parseDeviceInventory(run(["devices", "-l"]));
    report.inventoryReadable = true;
  } catch {
    report.status = "INVENTORY_UNAVAILABLE";
    return report;
  }
  for (const device of inventory) {
    if (device.state === "offline") { report.offlineDevices++; continue; }
    if (device.state === "unauthorized") { report.unauthorizedDevices++; continue; }
    const get = (property: string) => {
      try { return run(["-s", device.serial, "shell", "getprop", property]); }
      catch { return "unavailable"; }
    };
    const emulator = device.serial.startsWith("emulator-") || get("ro.kernel.qemu") === "1";
    report.connectedDevices++;
    if (emulator) report.emulators++;
    report.devices.push({
      model: publicMetadata(get("ro.product.model")),
      androidVersion: publicMetadata(get("ro.build.version.release")),
      kind: emulator ? "emulator" : "unconfirmed-device",
    });
  }
  if (report.connectedDevices) report.status = "OPERATOR_VERIFICATION_REQUIRED";
  return report;
}

export function saveNativeEvidence(output: string, report: ReturnType<typeof collectNativeEvidence>) {
  if (!/^native-evidence-[a-zA-Z0-9._-]+\.json$/.test(path.basename(output))) {
    throw new Error("Output must be a new native-evidence-<run>.json file");
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: nativeEvidence.ts --output <new native-evidence-run.json>");
  const report = collectNativeEvidence(findAdb());
  saveNativeEvidence(path.resolve(args[1]!), report);
  console.log(`Native inventory: ${report.status}; connected=${report.connectedDevices}; all ${nativeChecks.length} manual checks PENDING`);
  process.exitCode = report.status === "INVENTORY_UNAVAILABLE" ? 1 : 0;
}
