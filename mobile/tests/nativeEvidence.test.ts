import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectNativeEvidence, findAdb, nativeChecks, parseDeviceInventory, saveNativeEvidence } from "./support/nativeEvidence";

const scratch = mkdtempSync(path.join(tmpdir(), "finsight-native-evidence-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("native evidence inventory", () => {
  it("keeps an empty real device inventory unavailable with all checks pending", () => {
    const commands: string[][] = [];
    const report = collectNativeEvidence("adb", (args) => { commands.push(args); return "List of devices attached\n\n"; });
    expect(report.status).toBe("DEVICE_UNAVAILABLE");
    expect(report.inventoryReadable).toBe(true);
    expect(report.connectedDevices).toBe(0);
    expect(report.manualChecks).toEqual(nativeChecks.map((id) => ({ id, status: "PENDING" })));
    expect(commands).toEqual([["devices", "-l"]]);
  });
  it("records missing adb and failed inventory separately without exposing error output", () => {
    expect(collectNativeEvidence().adbAvailable).toBe(false);
    const report = collectNativeEvidence("adb", () => { throw new Error("private serial or token"); });
    expect(report.status).toBe("INVENTORY_UNAVAILABLE");
    expect(JSON.stringify(report)).not.toContain("private serial or token");
  });
  it("counts unauthorized/offline devices without querying their private data", () => {
    const report = collectNativeEvidence("adb", (args) => {
      expect(args).toEqual(["devices", "-l"]);
      return "List of devices attached\nPRIVATE_A unauthorized\nPRIVATE_B offline\n";
    });
    expect(report.unauthorizedDevices).toBe(1);
    expect(report.offlineDevices).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_[AB]/);
  });
  it("does not promote an emulator or connected device into physical acceptance", () => {
    const commands: string[][] = [];
    const report = collectNativeEvidence("adb", (args) => {
      commands.push(args);
      if (args[0] === "devices") return "List of devices attached\nemulator-5554 device model:virtual\nPRIVATE_PHONE device\n";
      if (args.at(-1) === "ro.kernel.qemu") return args[1] === "PRIVATE_PHONE" ? "0" : "1";
      if (args.at(-1) === "ro.product.model") return "Synthetic phone";
      return "14";
    });
    expect(report.status).toBe("OPERATOR_VERIFICATION_REQUIRED");
    expect(report.emulators).toBe(1);
    expect(report.devices.map((device) => device.kind)).toEqual(["emulator", "unconfirmed-device"]);
    expect(report.manualChecks.every((check) => check.status === "PENDING")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PHONE");
    expect(commands.every((args) => args[0] === "devices" || (args[2] === "shell" && args[3] === "getprop"))).toBe(true);
  });
  it("recognizes a remotely connected emulator from its qemu metadata", () => {
    const report = collectNativeEvidence("adb", (args) => args[0] === "devices"
      ? "127.0.0.1:5555 device\n" : args.at(-1) === "ro.kernel.qemu" ? "1" : "virtual");
    expect(report.emulators).toBe(1);
    expect(report.devices[0]?.kind).toBe("emulator");
  });
  it("ignores daemon messages and malformed inventory rows", () => {
    expect(parseDeviceInventory("* daemon started successfully\nList of devices attached\ninvalid\nA device model:public\n"))
      .toEqual([{ serial: "A", state: "device" }]);
  });
  it("does not fall through to another adb when an explicit override is missing", () => {
    expect(findAdb({ FINSIGHT_NATIVE_ADB: path.join(scratch, "missing-adb") })).toBeUndefined();
  });
  it("writes sanitized evidence exclusively and never overwrites an existing file", () => {
    const output = path.join(scratch, "native-evidence-test.json");
    const report = collectNativeEvidence();
    saveNativeEvidence(output, report);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
    expect(() => saveNativeEvidence(output, report)).toThrow();
    expect(() => saveNativeEvidence(path.join(scratch, ".env"), report)).toThrow("Output must be");
  });
});
