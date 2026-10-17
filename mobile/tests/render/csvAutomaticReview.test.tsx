import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import * as fixtures from "./support/fixtures";

const upload = vi.fn();
const post = vi.fn();
const remove = vi.fn();
const document = vi.fn();
vi.mock("../../src/lib/api", () => ({
  api: { upload, post, delete: remove },
  getFieldErrors: () => ({}),
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: document }));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => (() => void)) => React.useEffect(effect, [effect]),
}));
vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: fixtures.businessProfile, categories: fixtures.categories }),
}));

const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ImportCsvScreen } = await import("../../src/screens/records/ImportCsvScreen");
const navigation = { navigate: vi.fn(), goBack: vi.fn() };
const mapping = { date: "date", description: "description", amount: "amount", category: "category", vendor: "vendor" };
const row = { date: "2026-09-01", description: "Coffee beans", amount: "250", category: "Stock", vendor: "Local supplier" };
const stage = {
  stagedUploadId: "12345678-1234-4123-8123-123456789abc",
  stageExpiresAt: "2099-10-12T00:00:00.000Z",
  headers: Object.keys(mapping),
  previewRows: [row],
  totalRows: 1,
  suggestedMapping: mapping,
};
const checked = {
  validation: { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false },
};

async function choose() {
  const q = await render(<ThemeProvider initialMode="light"><ImportCsvScreen navigation={navigation} /></ThemeProvider>);
  await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
  await waitFor(() => expect(q.getByText("Review your records")).toBeTruthy());
  return q;
}

async function ready() {
  const q = await choose();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
  return q;
}

async function finish(q: Awaited<ReturnType<typeof choose>>) {
  await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
  await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
  await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
  await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
  return post.mock.calls.find(([path]) => path.endsWith("confirm"))!;
}

beforeEach(() => {
  upload.mockReset().mockResolvedValue(stage);
  post.mockReset().mockImplementation(async (path: string) => path.endsWith("confirm")
    ? { imported: 1, totalRows: 1, skipped: [], importedExpenses: 1, importedSales: 0 }
    : checked);
  remove.mockReset().mockResolvedValue({});
  document.mockReset().mockResolvedValue({ canceled: false, assets: [{ uri: "file:///records.csv", name: "records.csv", size: 1024, mimeType: "text/csv" }] });
  navigation.navigate.mockReset();
  navigation.goBack.mockReset();
});

describe("CSV automatic review matches web", () => {
  it("opens the file picker from the file panel and keeps Choose file after cancelling before the footer action starts review", async () => {
    document.mockResolvedValueOnce({ canceled: true, assets: null });
    const q = await render(<ThemeProvider initialMode="light"><ImportCsvScreen navigation={navigation} /></ThemeProvider>);
    expect(q.getByText("Step 1 of 3 · Choose file")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file from your phone or cloud storage" }));
    expect(document).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(q.getByText("Step 1 of 3 · Choose file")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(q.getByText("Step 2 of 3 · Review")).toBeTruthy();
    expect(document).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/records/csv-imports/preview");
  });

  it("opens review and checks the full staged file automatically without a mapping step", async () => {
    const q = await ready();
    expect(q.queryByRole("button", { name: "Review records" })).toBeNull();
    expect(q.queryByRole("button", { name: "Back to the columns" })).toBeNull();
    expect(q.queryByText(/Map columns/)).toBeNull();
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    expect(q.getByLabelText("Ready to import: 1")).toBeTruthy();
    expect(q.getByLabelText("Will be skipped: 0")).toBeTruthy();
    expect(q.getByRole("button", { name: "Show more, detected columns" })).toBeEnabled();
    expect(post.mock.calls[0]).toEqual([
      "/records/csv-imports/preview",
      { stagedUploadId: stage.stagedUploadId, businessProfileId: 1, recordType: "expense", columnMapping: mapping, corrections: {} },
      expect.any(AbortSignal),
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("uses the server's unusual headings and the sign of its selected amount column", async () => {
    const unusual = { date: "Booking", description: "Narrative", amount: "Movement", category: "Bucket", vendor: "Counterparty" };
    upload.mockResolvedValue({
      ...stage,
      headers: Object.values(unusual),
      previewRows: [{ Booking: "2026-09-01", Narrative: "Coffee beans", Movement: "-250", Bucket: "Stock", Counterparty: "Local supplier" }],
      suggestedMapping: unusual,
      columnsWithNegatives: ["Movement"],
      columnDetection: { suggestedRecordType: "sales" },
    });
    const q = await ready();
    expect(post.mock.calls[0][1]).toMatchObject({ recordType: "mixed", mixedStrategy: "sign", columnMapping: unusual });
    await fireEvent.press(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }));
    expect(q.getByLabelText("Amount").props.value).toBe("-250");
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    const confirmation = await finish(q);
    expect(confirmation[1]).toMatchObject({ recordType: "mixed", mixedStrategy: "sign", columnMapping: unusual });
  });

  it("does not infer mixed records from negative numbers in an unused column", async () => {
    upload.mockResolvedValue({ ...stage, headers: [...stage.headers, "running balance"], columnsWithNegatives: ["running balance"], columnDetection: { suggestedRecordType: "sales" } });
    await ready();
    expect(post.mock.calls[0][1]).toMatchObject({ recordType: "sales", columnMapping: { date: "date", description: "description", amount: "amount" } });
    expect(post.mock.calls[0][1].mixedStrategy).toBeUndefined();
  });

  it("prioritizes a detected type column and keeps it out of category names", async () => {
    upload.mockResolvedValue({
      ...stage,
      headers: [...stage.headers, "Type"],
      previewRows: [{ ...row, Type: "expense", amount: "-250" }],
      suggestedMapping: { ...mapping, category: "Type" },
      detectedTypeColumn: "Type",
      columnsWithNegatives: ["amount"],
      columnDetection: { suggestedRecordType: "sales" },
    });
    await ready();
    expect(post.mock.calls[0][1]).toMatchObject({ recordType: "mixed", mixedStrategy: "column", columnMapping: { date: "date", description: "description", amount: "amount", vendor: "vendor", recordType: "Type" } });
    expect(post.mock.calls[0][1].columnMapping.category).toBeUndefined();
  });

  it("uses detected sales defaults and omits expense fields from review and confirmation", async () => {
    upload.mockResolvedValue({ ...stage, columnDetection: { suggestedRecordType: "sales" } });
    const q = await ready();
    expect(post.mock.calls[0][1].recordType).toBe("sales");
    await fireEvent.press(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }));
    expect(q.queryByLabelText("Category")).toBeNull();
    expect(q.queryByLabelText("Vendor")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    const confirmation = await finish(q);
    expect(confirmation[1].columnMapping).toEqual({ date: "date", description: "description", amount: "amount" });
    expect(confirmation[1].recordType).toBe("sales");
  });

  it("shows the server's automatic row category without turning it into a manual correction", async () => {
    upload.mockResolvedValue({ ...stage, suggestedMapping: { date: "date", description: "description", amount: "amount" }, previewRows: [{ ...row, category: "" }] });
    post.mockImplementation(async (path: string) => path.endsWith("confirm")
      ? { imported: 1, totalRows: 1, skipped: [], importedExpenses: 1, importedSales: 0 }
      : { ...checked, rowCategories: [{ row: 2, name: "Inventory", source: "suggested", confidence: "medium", isNew: false }] });
    const q = await ready();
    expect(q.getByText(/ · Inventory/)).toBeTruthy();
    expect(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }).props.accessibilityLabel).toMatch(/Category: Inventory.*Suggested category/);
    const confirmation = await finish(q);
    expect(confirmation[1].corrections).toEqual({});
    expect(confirmation[1].columnMapping.category).toBeUndefined();
  });

  it("keeps a suggested category automatic when an owner edits only the amount", async () => {
    post.mockImplementation(async (path: string) => path.endsWith("confirm")
      ? { imported: 1, totalRows: 1, skipped: [], importedExpenses: 1, importedSales: 0 }
      : { ...checked, rowCategories: [{ row: 2, name: "Inventory", source: "suggested", confidence: "medium", isNew: false }] });
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }));
    expect(q.getByLabelText("Category").props.value).toBe("Inventory");
    await fireEvent.changeText(q.getByLabelText("Amount"), "300");
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    expect(post).toHaveBeenCalledTimes(1);
    const confirmation = await finish(q);
    expect(confirmation[1].corrections).toEqual({ "2": { amount: "300" } });
  });

  it("keeps an explicit category edit ahead of the server's previous suggestion", async () => {
    post.mockImplementation(async (path: string) => path.endsWith("confirm")
      ? { imported: 1, totalRows: 1, skipped: [], importedExpenses: 1, importedSales: 0 }
      : { ...checked, rowCategories: [{ row: 2, name: "Inventory", source: "history", confidence: "high", isNew: false }] });
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }));
    await fireEvent.changeText(q.getByLabelText("Category"), "Maintenance");
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    expect(q.getByText(/ · Maintenance/)).toBeTruthy();
    expect(q.queryByText(/ · Inventory/)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    const confirmation = await finish(q);
    expect(confirmation[1].corrections).toEqual({ "2": { category: "Maintenance" } });
  });

  it("rechecks a user override to the detected record type while preserving column choices", async () => {
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Show more, import settings" }));
    await fireEvent.press(q.getByRole("button", { name: "Sales" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(post.mock.calls[1][1]).toMatchObject({ recordType: "sales", columnMapping: { date: "date", description: "description", amount: "amount" }, corrections: {} });
    await fireEvent.press(q.getByRole("button", { name: "Expenses" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1]).toMatchObject({ recordType: "expense", columnMapping: mapping });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("lets an owner correct a server-rejected future date beyond the initial sample", async () => {
    upload.mockResolvedValue({ ...stage, totalRows: 500 });
    post.mockResolvedValueOnce({
      validation: { validRows: 499, invalidRows: 1, skipped: [{ row: 427, reason: 'Future date: "2026-10-13"' }], skippedTruncated: false },
      reviewRows: [{ row: 427, values: { ...row, date: "2026-10-13", description: "Later future record" } }],
    });
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Needs fixing (1)" }));
    expect(q.getByText('Future date: "2026-10-13"')).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: /^Row 427, Later future record\. Edit this row\./ }));
    await fireEvent.changeText(q.getByLabelText("Date"), "2026-09-02");
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    expect(q.queryByText('Future date: "2026-10-13"')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(post.mock.calls[1][1].corrections).toEqual({ "427": { date: "2026-09-02" } });
  });

  it("shows the server's future-date reason ahead of an unrecognized mixed record type", async () => {
    upload.mockResolvedValue({ ...stage, headers: [...stage.headers, "Type"], detectedTypeColumn: "Type", previewRows: [{ ...row, date: "2026-10-13", Type: "unknown" }] });
    post.mockResolvedValueOnce({ validation: { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: 'Future date: "2026-10-13"' }], skippedTruncated: false } });
    const q = await choose();
    await waitFor(() => expect(q.getByText('Future date: "2026-10-13"')).toBeTruthy());
    expect(q.queryByText('Could not tell if "unknown" means a sale or an expense')).toBeNull();
    expect(q.getByRole("button", { name: "Needs fixing (1)" })).toBeTruthy();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
  });

  it("keeps an undetected required header recoverable inside review before checking", async () => {
    upload.mockResolvedValue({ ...stage, suggestedMapping: { date: "date", description: "description" } });
    const q = await choose();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Choose column for Amount, not found" })).toBeEnabled();
    await fireEvent.press(q.getByRole("button", { name: "Choose column for Amount, not found" }));
    await fireEvent.press(q.getByRole("button", { name: "Close without choosing" }));
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole("button", { name: "Choose column for Amount, not found" }));
    await fireEvent.press(q.getByRole("button", { name: /^amount/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].columnMapping).toEqual({ date: "date", description: "description", amount: "amount" });
    expect(q.queryByRole("button", { name: "Review records" })).toBeNull();
  });

  it("does not override the server's missing mapping with a local header guess", async () => {
    upload.mockResolvedValue({ ...stage, suggestedMapping: undefined });
    const q = await choose();
    expect(post).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    for (const field of ["Date", "Description", "Amount"]) expect(q.getByRole("button", { name: `Choose column for ${field}, not found` })).toBeEnabled();
  });

  it("blocks reused columns and checks only after an owner chooses a distinct heading", async () => {
    upload.mockResolvedValue({ ...stage, suggestedMapping: { ...mapping, amount: "description" } });
    const q = await choose();
    expect(post).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    await fireEvent.press(q.getByRole("button", { name: "Choose column for Amount, description" }));
    await fireEvent.press(q.getByRole("button", { name: /^amount/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].columnMapping).toEqual(mapping);
  });

  it("waits for the owner to settle an ambiguous date, then submits that format", async () => {
    upload.mockResolvedValue({ ...stage, previewRows: [{ ...row, date: "03/04/2026" }], dateFormatAmbiguous: true, detectedDateFormat: "dmy" });
    const q = await choose();
    expect(post).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    await fireEvent.press(q.getByRole("button", { name: "Choose how the dates in this file should be read" }));
    await fireEvent.press(q.getByRole("button", { name: /Day first/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ dateFormat: "dmy", columnMapping: mapping });
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    const confirmation = await finish(q);
    expect(confirmation[1].dateFormat).toBe("dmy");
  });

  it.each([
    [".csv", "CSV import"],
    ["  September expenses.CSV", "September expenses"],
    [`${"word ".repeat(60)}.csv`, "word ".repeat(60).trim().slice(0, 150).trim()],
  ])("names %s using the same filename rule as web", async (name, title) => {
    document.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///records.csv", name, size: 1024, mimeType: "text/csv" }] });
    const q = await ready();
    const confirmation = await finish(q);
    expect(confirmation[1].title).toBe(title);
    expect(confirmation[1].title.length).toBeLessThanOrEqual(150);
  });

  it("replaces file detection and clears the old date answer and corrections for a new file", async () => {
    upload.mockResolvedValueOnce({ ...stage, previewRows: [{ ...row, date: "03/04/2026", amount: "-250" }], columnsWithNegatives: ["amount"], dateFormatAmbiguous: true });
    const q = await choose();
    await fireEvent.press(q.getByRole("button", { name: "Choose how the dates in this file should be read" }));
    await fireEvent.press(q.getByRole("button", { name: /Day first/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: /^Row 2, Coffee beans\. Edit this row\./ }));
    await fireEvent.changeText(q.getByLabelText("Amount"), "-300");
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    await fireEvent.press(q.getByRole("button", { name: "Change file" }));
    upload.mockResolvedValueOnce({ ...stage, stagedUploadId: "22345678-1234-4123-8123-123456789abc", columnDetection: { suggestedRecordType: "sales" } });
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({ stagedUploadId: "22345678-1234-4123-8123-123456789abc", recordType: "sales", corrections: {} });
    expect(post.mock.calls[1][1].dateFormat).toBeUndefined();
    expect(post.mock.calls[1][1].mixedStrategy).toBeUndefined();
    expect(upload.mock.calls[1][1].get("idempotencyKey")).not.toBe(upload.mock.calls[0][1].get("idempotencyKey"));
    expect(remove).toHaveBeenCalledWith(`/records/csv-imports/stages/${stage.stagedUploadId}`, undefined, { cacheScope: { businessProfileId: 1 } });
  });
});
