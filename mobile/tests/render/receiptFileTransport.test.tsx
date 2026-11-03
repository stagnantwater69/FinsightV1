import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "react-native";

vi.mock("expo-file-system", () => ({
  File: class {
    constructor() { throw new Error("expo-file-system has no web implementation"); }
  },
}));

const { appendLocalFile } = await import("../../src/lib/localFilePart");
const { localFileByteSize } = await import("../../src/lib/localFileSize");
const NativeFormData = createRequire(import.meta.url)("react-native/Libraries/Network/FormData").default;
const BrowserFormData = globalThis.FormData;
const originalPlatform = Object.getOwnPropertyDescriptor(Platform, "OS")!;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function setPlatform(platform: "web" | "android") {
  Object.defineProperty(Platform, "OS", { configurable: true, value: platform });
  vi.stubGlobal("FormData", platform === "web" ? BrowserFormData : NativeFormData);
}

afterEach(() => {
  Object.defineProperty(Platform, "OS", originalPlatform);
  vi.unstubAllGlobals();
});

describe("receipt file transport", () => {
  it("measures and uploads the browser's photo bytes in the web build", async () => {
    setPlatform("web");
    const uri = URL.createObjectURL(new Blob([JPEG]));
    try {
      expect(await localFileByteSize(uri)).toBe(JPEG.length);
      const form = new FormData();
      await appendLocalFile(form, "files", { uri, name: "receipt.jpg", type: "image/jpeg" });
      // Decode the real multipart body, so an "[object Object]" text field cannot pass.
      const received = await new Request("http://localhost/scan", { method: "POST", body: form }).formData();
      const file = (received as unknown as { get: (name: string) => File }).get("files");
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("receipt.jpg");
      expect(file.type).toBe("image/jpeg");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
    } finally {
      URL.revokeObjectURL(uri);
    }
  });

  it("keeps React Native's URI part on Android", async () => {
    setPlatform("android");
    const form = new FormData() as unknown as FormData & { getParts: () => unknown[] };
    await appendLocalFile(form, "files", { uri: "file:///cache/Camera/receipt.jpg", name: "receipt.jpg", type: "image/jpeg" });
    expect(form.getParts()).toEqual([{
      fieldName: "files",
      uri: "file:///cache/Camera/receipt.jpg",
      name: "receipt.jpg",
      type: "image/jpeg",
      headers: { "content-disposition": 'form-data; name="files"; filename="receipt.jpg"', "content-type": "image/jpeg" },
    }]);
  });
});
