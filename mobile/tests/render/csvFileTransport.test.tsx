import React from "react";
import { createRequire } from "node:module";
import { File } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import * as fixtures from "./support/fixtures";

const upload = vi.fn();
const post = vi.fn();
const remove = vi.fn();
const document = vi.fn();
vi.mock("expo-document-picker", () => ({ getDocumentAsync: document }));
vi.mock("../../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return { ...actual, api: { ...actual.api, upload, post, delete: remove } };
});
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: fixtures.businessProfile, categories: fixtures.categories }),
}));
vi.mock("../../src/components/DateField", async () => {
  const { Field } = await import("../../src/components/ui");
  return { DateField: ({ label, value, onChange }: any) => <Field label={label} value={value} onChangeText={onChange} /> };
});

const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ImportCsvScreen } = await import("../../src/screens/records/ImportCsvScreen");
const { ApiError } = await import("../../src/lib/api");
const { csvUploadForm } = await import("../../src/lib/csvUploadForm");
const NativeFormData = createRequire(import.meta.url)("react-native/Libraries/Network/FormData").default;
const BrowserFormData = globalThis.FormData;
const originalPlatform = Object.getOwnPropertyDescriptor(Platform, "OS")!;
const CSV = "date,description,amount,category\n2026-09-01,Coffee beans,250,Stock\n";
const preview = {
  stagedUploadId: "12345678-1234-4123-8123-123456789abc",
  stageExpiresAt: "2099-10-12T00:00:00.000Z",
  headers: ["date", "description", "amount", "category"],
  previewRows: [{ date: "2026-09-01", description: "Coffee beans", amount: "250", category: "Stock" }],
  totalRows: 1,
  suggestedMapping: { date: "date", description: "description", amount: "amount", category: "category" },
};
const validation = { validation: { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false } };
const navigation = { navigate: vi.fn(), goBack: vi.fn() };

function setPlatform(platform: "web" | "android" | "ios") {
  Object.defineProperty(Platform, "OS", { configurable: true, value: platform });
  vi.stubGlobal("FormData", platform === "web" ? BrowserFormData : NativeFormData);
}

async function assertBrowserCsv(form: FormData) {
  const part = form.get("file");
  expect(part).toBeInstanceOf(Blob);
  expect(part).toMatchObject({ name: "records.csv", size: Buffer.byteLength(CSV) });
  // Decode actual multipart bytes, so a text field named "file" cannot pass.
  const received = await new Request("http://localhost/csv", { method: "POST", body: form }).formData();
  const receivedFile = (received as unknown as { get: (name: string) => File }).get("file");
  expect(receivedFile).toBeInstanceOf(Blob);
  expect(receivedFile.name).toBe("records.csv");
  expect(await receivedFile.text()).toBe(CSV);
}

async function openScreen() {
  const q = await render(<ThemeProvider initialMode="light"><ImportCsvScreen navigation={navigation} /></ThemeProvider>);
  await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
  return q;
}

async function finishImport(q: Awaited<ReturnType<typeof openScreen>>) {
  await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
  await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
  await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
  await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
  await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
}

beforeEach(() => {
  upload.mockReset();
  post.mockReset();
  remove.mockReset();
  document.mockReset();
  navigation.navigate.mockReset();
  navigation.goBack.mockReset();
  const browserFile = new File([CSV], "records.csv", { type: "text/csv" });
  document.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "blob:http://localhost/selected-csv", name: "records.csv", size: browserFile.size, mimeType: "text/csv", file: browserFile }],
  });
  upload.mockResolvedValue(preview);
  post.mockImplementation(async (path: string) => path.endsWith("confirm")
    ? { imported: 1, totalRows: 1, skipped: [], importedExpenses: 1, importedSales: 0 }
    : validation);
  remove.mockResolvedValue({});
});

afterEach(() => {
  Object.defineProperty(Platform, "OS", originalPlatform);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CSV file transport", () => {
  it("uploads browser File bytes once and uses the same stage for JSON review and confirmation", async () => {
    setPlatform("web");
    const q = await openScreen();
    await finishImport(q);
    expect(upload).toHaveBeenCalledTimes(1);
    for (const [, form] of upload.mock.calls) await assertBrowserCsv(form);
    const initial = upload.mock.calls[0]!;
    expect(initial[1].get("businessProfileId")).toBe("1");
    const confirmation = post.mock.calls.find(([path]) => path.endsWith("confirm"))!;
    expect(confirmation[1]).toMatchObject({ businessProfileId: 1, stagedUploadId: preview.stagedUploadId, columnMapping: preview.suggestedMapping });
    expect(confirmation[1].idempotencyKey).toBe(initial[1].get("idempotencyKey"));
    expect(confirmation[1].idempotencyKey).toMatch(/^.{8,100}$/);
    expect(confirmation[2]).toMatchObject({ cacheScope: { businessProfileId: 1 } });
    expect(post.mock.calls.filter(([path]) => path.endsWith("preview"))).toHaveLength(2);
    expect(post.mock.calls.every(([, body]) => body.stagedUploadId === preview.stagedUploadId)).toBe(true);
  });

  it("retries the same browser File without opening the picker or discarding its contents", async () => {
    setPlatform("web");
    upload.mockRejectedValueOnce(new ApiError(0, "Network request failed"));
    const q = await openScreen();
    await waitFor(() => expect(q.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(q.getByText(/The file you chose is still selected/)).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Try again" }));
    await finishImport(q);
    expect(document).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);
    for (const [, form] of upload.mock.calls) await assertBrowserCsv(form);
  });

  it.each(["android", "ios"] as const)("preserves React Native URI, filename, and MIME headers on %s", (platform) => {
    setPlatform(platform);
    const form = csvUploadForm({ uri: "file:///cache/records.csv", name: "records.csv" }) as unknown as {
      getParts: () => unknown[];
    };
    expect(form.getParts()).toEqual([{
      fieldName: "file",
      uri: "file:///cache/records.csv",
      name: "records.csv",
      type: "text/csv",
      headers: { "content-disposition": 'form-data; name="file"; filename="records.csv"', "content-type": "text/csv" },
    }]);
  });

  it("shows the server's CSV rejection reason and lets the owner select another file", async () => {
    setPlatform("web");
    upload.mockRejectedValueOnce(new ApiError(400, "CSV must contain at least one transaction row"));
    const q = await openScreen();
    await waitFor(() => expect(q.getByText(/CSV must contain at least one transaction row/)).toBeTruthy());
    await fireEvent.press(q.getByRole("button", { name: "Choose a different file" }));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(document).toHaveBeenCalledTimes(2);
    await assertBrowserCsv(upload.mock.calls.at(-1)![1]);
  });

  it("shows a structured file validation reason instead of the generic validation summary", async () => {
    setPlatform("web");
    upload.mockRejectedValueOnce(new ApiError(400, "Some details need fixing.", { file: "The CSV is missing its header row." }));
    const q = await openScreen();
    await waitFor(() => expect(q.getByText(/The CSV is missing its header row/)).toBeTruthy());
    expect(q.queryByText(/Some details need fixing/)).toBeNull();
    expect(q.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("preserves an Excel-exported CSV's bytes when the browser reports a spreadsheet MIME type", async () => {
    setPlatform("web");
    const browserFile = new File([CSV], "records.csv", { type: "application/vnd.ms-excel" });
    document.mockResolvedValue({ canceled: false, assets: [{ uri: "blob:http://localhost/excel-csv", name: "records.csv", size: browserFile.size, mimeType: browserFile.type, file: browserFile }] });
    const q = await openScreen();
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    await assertBrowserCsv(upload.mock.calls[0]![1]);
    expect(upload.mock.calls[0]![1].get("file").type).toBe("application/vnd.ms-excel");
  });

  it("explains a missing browser File without uploading a URI object or string", async () => {
    setPlatform("web");
    document.mockResolvedValue({ canceled: false, assets: [{ uri: "blob:http://localhost/no-file", name: "records.csv", size: 1024 }] });
    const q = await openScreen();
    await waitFor(() => expect(q.getByText(/This browser couldn't read the selected file. Choose it again./)).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Choose a different file" })).toBeEnabled();
  });

  it("keeps the selected blob URI for retry and releases it when replaced and on unmount", async () => {
    setPlatform("web");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    upload.mockRejectedValueOnce(new ApiError(0, "Network request failed"));
    const q = await openScreen();
    await waitFor(() => expect(q.getByRole("button", { name: "Try again" })).toBeEnabled());
    expect(revoke).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(revoke).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole("button", { name: "Change file" }));
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/selected-csv");
    const replacementFile = new File([CSV], "records.csv", { type: "text/csv" });
    document.mockResolvedValueOnce({ canceled: false, assets: [{ uri: "blob:http://localhost/replacement-csv", name: "records.csv", size: replacementFile.size, mimeType: replacementFile.type, file: replacementFile }] });
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    await q.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/replacement-csv");
    revoke.mockRestore();
  });

  it("releases a picker result returned after the import screen has unmounted", async () => {
    setPlatform("web");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let finishPicker!: (result: unknown) => void;
    document.mockReturnValueOnce(new Promise((resolve) => { finishPicker = resolve; }));
    const q = await openScreen();
    expect(document).toHaveBeenCalledTimes(1);
    await q.unmount();
    const lateFile = new File([CSV], "records.csv", { type: "text/csv" });
    await act(() => finishPicker({ canceled: false, assets: [{ uri: "blob:http://localhost/stale-picker", name: "records.csv", size: lateFile.size, mimeType: lateFile.type, file: lateFile }] }));
    expect(upload).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/stale-picker");
  });

  it.each([
    ["records.xlsx", 1024, "Choose a CSV file. Export Excel files as CSV first."],
    ["records.csv", 0, "This file is empty. Choose a CSV with transaction rows."],
    ["records.csv", 5 * 1024 * 1024 + 1, "Choose a CSV smaller than 5 MB."],
  ])("rejects %s (%s bytes) before making an upload request", async (name, size, message) => {
    setPlatform("web");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    document.mockResolvedValue({ canceled: false, assets: [{ uri: "blob:http://localhost/invalid-file", name, size }] });
    const q = await openScreen();
    await waitFor(() => expect(q.getByText(message)).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/invalid-file");
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
  });
});
