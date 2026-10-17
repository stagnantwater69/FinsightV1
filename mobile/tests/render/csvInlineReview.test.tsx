import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { BackHandler, FlatList } from "react-native";
import * as fixtures from "./support/fixtures";

const upload = vi.fn();
const post = vi.fn();
const get = vi.fn();
const remove = vi.fn();
const document = vi.fn();
let selectedBusiness: typeof fixtures.businessProfile | undefined = fixtures.businessProfile;
const focusSetters = new Set<React.Dispatch<React.SetStateAction<boolean>>>();
vi.mock("../../src/lib/api", () => ({
  api: { upload, post, get, delete: remove },
  getFieldErrors: (error: { fieldErrors?: Record<string, string> } | null) => error?.fieldErrors ?? {},
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: document }));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => (() => void)) => {
    const [focused, setFocused] = React.useState(true);
    React.useEffect(() => {
      focusSetters.add(setFocused);
      return () => { focusSetters.delete(setFocused); };
    }, []);
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));
vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedBusiness, categories: fixtures.categories }),
}));

const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ImportCsvScreen } = await import("../../src/screens/records/ImportCsvScreen");
const navigation = {
  navigate: vi.fn(), goBack: vi.fn(), canGoBack: vi.fn(() => false), setOptions: vi.fn(),
  addListener: vi.fn((_event: string, _listener: (event: { preventDefault: () => void }) => void) => vi.fn()),
};
const wrap = (mode: "light" | "dark" = "light") => <ThemeProvider initialMode={mode}><ImportCsvScreen navigation={navigation} /></ThemeProvider>;
const mapping = { date: "date", description: "description", amount: "amount", category: "category", vendor: "vendor" };
const sample = Array.from({ length: 6 }, (_, index) => ({
  date: "2026-09-01",
  description: `Coffee order ${index + 1}`,
  amount: `${100 + index}`,
  category: "Stock",
  vendor: "Synthetic supplier",
}));
const stage = {
  stagedUploadId: "12345678-1234-4123-8123-123456789abc",
  stageExpiresAt: "2099-10-12T00:00:00.000Z",
  headers: Object.keys(mapping),
  previewRows: sample,
  totalRows: 30_000,
  suggestedMapping: mapping,
};
const checked = {
  ...stage,
  validation: { validRows: 29_999, invalidRows: 1, skipped: [{ row: 427, reason: 'Invalid amount: ""' }], skippedTruncated: false, possibleDuplicateRows: 3, duplicateRows: [2, 5, 427], duplicateRowsTruncated: false },
  reviewRows: [{ row: 427, values: { ...sample[0], description: "Later CSV issue", amount: "" } }],
  reviewRowsTruncated: false,
  categorySummary: { newCategories: [], uncategorised: 0, fromFile: 29_999, suggested: 0 },
};

function pressHandler(button: ReturnType<Awaited<ReturnType<typeof render>>["getByRole"]>): () => void {
  let fiber = button.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === "function") return fiber.memoizedProps.onPress;
    fiber = fiber.return;
  }
  throw new Error("Button has no press handler");
}

function listProps(q: Awaited<ReturnType<typeof render>>): {
  data: unknown[];
  initialNumToRender: number;
  maxToRenderPerBatch: number;
  onLayout: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
  onContentSizeChange: (width: number, height: number) => void;
  onScrollBeginDrag: () => void;
} {
  let fiber = q.getByText("Review your records").unstable_fiber;
  while (fiber) {
    if (Array.isArray(fiber.memoizedProps?.data)) return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error("Review header is not inside the virtualized list");
}

async function ready(mode: "light" | "dark" = "light", type?: "Sales") {
  if (type) upload.mockResolvedValue({ ...stage, columnDetection: { suggestedRecordType: "sales" } });
  const q = await render(wrap(mode));
  await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
  return q;
}

async function edit(q: Awaited<ReturnType<typeof ready>>, row: number, description: string) {
  if (!q.queryByRole("button", { name: new RegExp(`^Row ${row}, ${description}\\. Edit this row\\.`) })) {
    await fireEvent.press(q.getByRole("button", { name: /Needs fixing/ }));
  }
  await fireEvent.press(q.getByRole("button", { name: new RegExp(`^Row ${row}, ${description}\\. Edit this row\\.`) }));
}

async function saveAmount(q: Awaited<ReturnType<typeof ready>>, amount: string) {
  await fireEvent.changeText(q.getByLabelText("Amount"), amount);
  await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
}

beforeEach(() => {
  selectedBusiness = fixtures.businessProfile;
  focusSetters.clear();
  upload.mockReset(); post.mockReset(); get.mockReset(); remove.mockReset(); document.mockReset();
  navigation.navigate.mockReset(); navigation.goBack.mockReset();
  navigation.canGoBack.mockReset().mockReturnValue(false); navigation.setOptions.mockReset(); navigation.addListener.mockClear();
  document.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///synthetic-records.csv", name: "synthetic-records.csv", size: 2_000_000, mimeType: "text/csv" }] });
  upload.mockResolvedValue(stage);
  post.mockImplementation(async (path: string) => path.endsWith("confirm")
    ? { imported: 29_999, totalRows: 30_000, skippedCount: 1, skipped: [], importedExpenses: 29_999, importedSales: 0 }
    : checked);
  remove.mockResolvedValue({});
});

afterEach(() => vi.restoreAllMocks());

describe("CSV compact ledger review", () => {
  it.each([false, true])("bounds 500 skipped-row summaries while preserving full counts (server truncation: %s)", async (skippedTruncated) => {
    post.mockResolvedValueOnce({
      ...checked,
      validation: {
        ...checked.validation,
        validRows: 29_500,
        invalidRows: 500,
        skipped: Array.from({ length: 500 }, (_, index) => ({ row: index + 2, reason: `Boundary detail ${index + 1}` })),
        skippedTruncated,
      },
    });
    const q = await ready();
    expect(q.getByLabelText("Ready to import: 29,500")).toBeTruthy();
    expect(q.getByLabelText("Will be skipped: 500")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Show more, review details" }));
    expect(q.getAllByText(/^Row \d+: Boundary detail \d+$/)).toHaveLength(100);
    expect(q.getByText("Row 101: Boundary detail 100")).toBeTruthy();
    expect(q.queryByText("Row 102: Boundary detail 101")).toBeNull();
    expect(q.getByText("Showing the first 100 skipped row details.")).toBeTruthy();
    expect(post.mock.calls.every(([path]) => path.endsWith("preview"))).toBe(true);
  });

  it("waits for a server count after a processing replay instead of showing zero rows processed", async () => {
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    post.mockResolvedValueOnce({ batchId: 12, processingStatus: "PROCESSING", totalRows: 30_000, imported: 250, skippedCount: 2 });
    get.mockResolvedValue({ processingStatus: "PROCESSING", totalRows: 30_000, processedRows: 252, importedRows: 250, skippedRows: 2 });
    await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
    try {
      expect(q.getByText("Importing your records")).toBeTruthy();
      expect(q.queryByRole("progressbar", { name: "Import progress" })).toBeNull();
      expect(q.getByText("FinSight is processing the import. Checking its row count.")).toBeTruthy();
      await waitFor(() => expect(q.getByRole("progressbar", { name: "Import progress" }).props.accessibilityValue).toMatchObject({ now: 252, max: 30_000 }), { timeout: 4_000 });
      expect(q.getByText("252 of 30000 rows processed.")).toBeTruthy();
    } finally {
      await q.unmount();
    }
  });

  it.each(["light", "dark"] as const)("keeps drafts isolated, cancels without changing records, and disables continue while editing in %s", async (mode) => {
    const q = await ready(mode);
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    await edit(q, 2, "Coffee order 1");
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(5);
    await fireEvent.changeText(q.getByLabelText("Amount"), "170");
    expect(q.queryByRole("button", { name: "Check & continue" })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    await edit(q, 2, "Coffee order 1");
    expect(q.getByLabelText("Amount").props.value).toBe("100");
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({});
  });

  it("saves a correction locally, collapses the editor, and rechecks the file before showing confirmation", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    expect(q.getAllByText(/Previously flagged/).length).toBeGreaterThan(0);
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(post.mock.calls[1][1]).toMatchObject({ stagedUploadId: stage.stagedUploadId, businessProfileId: 1, corrections: { "2": { amount: "170" } } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(q.queryByText(/Previously flagged/)).toBeNull();
  });

  it("keeps possible duplicates in the ready count and imports them without automatically excluding any row", async () => {
    upload.mockResolvedValue({ ...stage, totalRows: 6 });
    post.mockImplementation(async (path: string) => path.endsWith("confirm")
      ? { imported: 6, totalRows: 6, skippedCount: 0, skipped: [], importedExpenses: 6, importedSales: 0, flagged: 3 }
      : { ...checked, totalRows: 6, validation: { validRows: 6, invalidRows: 0, skipped: [], possibleDuplicateRows: 3, duplicateRows: [2, 5, 7] }, reviewRows: [] });
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Duplicates (3)" }));
    expect(q.getByRole("button", { name: /^Row 2, Coffee order 1\. Edit this row\./ })).toBeEnabled();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(q.getByLabelText("Ready to import: 6")).toBeTruthy();
    expect(q.getByLabelText("Will be skipped: 0")).toBeTruthy();
    expect(q.getByText(/3 possible duplicates will be flagged if imported\. They are included in the ready count\./)).toBeTruthy();
    expect(post.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(0);
    await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
    await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
    expect(q.getByText(/Imported 6 of 6 rows/)).toBeTruthy();
    expect(q.getByText("3 row(s) look like possible duplicates.")).toBeTruthy();
    expect(post.mock.calls.find(([path]) => path.endsWith("confirm"))![1].corrections).toEqual({});
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["button", "header", "hardware"] as const)("returns from the import summary through %s Back with saved edits, exclusions, and the current list intact", async (source) => {
    let hardwareBack!: () => boolean | null | undefined;
    vi.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      hardwareBack = () => listener({ type: "hardwareBackPress", timeStamp: 0 });
      return { remove: vi.fn() };
    });
    upload.mockResolvedValue({ ...stage, totalRows: 6 });
    post.mockImplementation(async (path: string, body: { corrections?: Record<string, { exclude?: boolean }> }) => {
      const excluded = Object.entries(body.corrections ?? {}).filter(([, correction]) => correction.exclude).map(([row]) => Number(row));
      return path.endsWith("confirm")
        ? { imported: 6 - excluded.length, totalRows: 6, skippedCount: excluded.length, skipped: [], importedExpenses: 6 - excluded.length, importedSales: 0 }
        : { ...checked, totalRows: 6, validation: { validRows: 6 - excluded.length, invalidRows: excluded.length, skipped: excluded.map((row) => ({ row, reason: "Excluded by you" })), possibleDuplicateRows: 0, duplicateRows: [] }, reviewRows: [] };
    });
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    await fireEvent.press(q.getByRole("checkbox", { name: /^Select row 3, Coffee order 2\./ }));
    await fireEvent.press(q.getByRole("button", { name: "Remove 1 from import" }));
    await fireEvent.press(q.getByRole("button", { name: "Edited (1)" }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(q.getByText("Import these records?")).toBeTruthy();
    expect(q.queryByText("Review your records")).toBeNull();
    expect(q.getByLabelText("Ready to import: 5")).toBeTruthy();
    expect(q.getByLabelText("Will be skipped: 1")).toBeTruthy();
    expect(q.getByLabelText(/Left out.*: 1/)).toBeTruthy();
    expect(post.mock.calls[1][1].corrections).toEqual({ "2": { amount: "170" }, "3": { exclude: true } });
    if (source === "button") await fireEvent.press(q.getByRole("button", { name: "Back to review" }));
    else await act(() => source === "header"
      ? navigation.setOptions.mock.calls.at(-1)![0].headerLeft({}).props.onPress()
      : hardwareBack());
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(q.getByText("Review your records")).toBeTruthy();
    expect(q.getByRole("button", { name: "Edited (1)" }).props.accessibilityState.selected).toBe(true);
    expect(listProps(q).data.map((row) => (row as { rowNumber: number }).rowNumber)).toEqual([2]);
    expect(q.getByRole("button", { name: "Excluded (1)" })).toBeTruthy();
    await edit(q, 2, "Coffee order 1");
    expect(q.getByLabelText("Amount").props.value).toBe("170");
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(0);
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
    await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
    const confirmation = post.mock.calls.find(([path]) => path.endsWith("confirm"))![1];
    expect(confirmation.corrections).toEqual({ "2": { amount: "170" }, "3": { exclude: true } });
    expect(confirmation.idempotencyKey).toBe(upload.mock.calls[0][1].get("idempotencyKey"));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["layout", "content"] as const)("restores the saved review offset once after both measurements when %s arrives first", async (first) => {
    const scroll = vi.spyOn(FlatList.prototype, "scrollToOffset");
    const q = await ready();
    await fireEvent.scroll(q.getByText("Review your records"), { nativeEvent: { contentOffset: { x: 0, y: 587 }, contentSize: { width: 360, height: 2_000 }, layoutMeasurement: { width: 360, height: 640 } } });
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Back to review" }));
    const returned = listProps(q);
    scroll.mockClear();
    const layout = (height: number) => returned.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height } } });
    const content = (height: number) => returned.onContentSizeChange(360, height);
    await act(() => { layout(0); content(0); });
    expect(scroll).not.toHaveBeenCalled();
    await act(() => first === "layout" ? layout(640) : content(2_000));
    expect(scroll).not.toHaveBeenCalled();
    await act(() => first === "layout" ? content(2_000) : layout(640));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ offset: 587, animated: false });
    await act(() => { layout(500); content(2_400); });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(0);
  });

  it.each(["edit", "filter", "drag", "new file"] as const)("does not apply a delayed summary-return offset after %s changes the review context", async (interaction) => {
    const scroll = vi.spyOn(FlatList.prototype, "scrollToOffset");
    const q = await ready();
    await fireEvent.scroll(q.getByText("Review your records"), { nativeEvent: { contentOffset: { x: 0, y: 587 }, contentSize: { width: 360, height: 2_000 }, layoutMeasurement: { width: 360, height: 640 } } });
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Back to review" }));
    const returned = listProps(q);
    if (interaction === "edit") await edit(q, 2, "Coffee order 1");
    else if (interaction === "filter") await fireEvent.press(q.getByRole("button", { name: "Duplicates (3)" }));
    else if (interaction === "drag") await act(() => returned.onScrollBeginDrag());
    else await fireEvent.press(q.getByRole("button", { name: "Change file" }));
    scroll.mockClear();
    await act(() => {
      returned.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 640 } } });
      returned.onContentSizeChange(360, 2_000);
    });
    expect(scroll).not.toHaveBeenCalledWith({ offset: 587, animated: false });
    if (interaction === "edit") expect(q.getByLabelText("Amount").props.value).toBe("100");
    if (interaction === "filter") expect(q.getByRole("button", { name: "Duplicates (3)" }).props.accessibilityState.selected).toBe(true);
    if (interaction === "new file") expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(0);
  });

  it("does not save invalid input or send an API request on every keystroke", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await fireEvent.changeText(q.getByLabelText("Amount"), "not a number");
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    expect(q.getByLabelText(/Amount, Invalid amount/).props.value).toBe("not a number");
    expect(q.queryByRole("button", { name: "Check & continue" })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps sale type read-only and omits expense-only category and vendor editors", async () => {
    const q = await ready("light", "Sales");
    await edit(q, 2, "Coffee order 1");
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(3);
    expect(q.queryByLabelText("Category")).toBeNull();
    expect(q.queryByLabelText("Vendor")).toBeNull();
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({ recordType: "sales", corrections: { "2": { amount: "170" } } });
    expect(post.mock.calls[1][1].columnMapping.category).toBeUndefined();
    expect(post.mock.calls[1][1].columnMapping.vendor).toBeUndefined();
  });

  it("preserves signed source amounts when mixed imports use the sign to classify expenses", async () => {
    upload.mockResolvedValue({ ...stage, previewRows: [{ ...sample[0], amount: "-100" }], columnsWithNegatives: ["amount"] });
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    expect(q.getByLabelText("Amount").props.value).toBe("-100");
    expect(q.getByLabelText("Amount").props.keyboardType).toBe("default");
    expect(post.mock.calls[0][1]).toMatchObject({ recordType: "mixed", mixedStrategy: "sign" });
  });

  it("bulk excludes selected rows and restores them without removing earlier field corrections", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    for (const [row, description] of [[2, "Coffee order 1"], [4, "Coffee order 3"], [5, "Coffee order 4"]] as const) {
      await fireEvent.press(q.getByRole("checkbox", { name: new RegExp(`^Select row ${row}, ${description}\\.`) }));
    }
    expect(q.getByRole("button", { name: "Remove 3 from import" })).toBeEnabled();
    await fireEvent.press(q.getByRole("button", { name: "Remove 3 from import" }));
    await fireEvent.press(q.getByRole("button", { name: "Undo" }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({ "2": { amount: "170" } });
  });

  it("requires an explicit discard before switching editors and never opens two row forms", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await fireEvent.changeText(q.getByLabelText("Amount"), "170");
    await edit(q, 3, "Coffee order 2");
    expect(q.getByText("Discard this unsaved edit?")).toBeTruthy();
    expect(q.getByLabelText("Amount").props.value).toBe("170");
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(5);
    await fireEvent.press(q.getByRole("button", { name: "Discard edit" }));
    expect(q.getByLabelText("Amount").props.value).toBe("101");
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(5);
    await fireEvent.press(q.getByRole("button", { name: "Cancel" }));
    await edit(q, 2, "Coffee order 1");
    expect(q.getByLabelText("Amount").props.value).toBe("100");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not exclude selected records merely by leaving selection mode", async () => {
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    expect(q.getByRole("button", { name: "Remove 0 from import" })).toBeDisabled();
    await fireEvent.press(q.getByRole("checkbox", { name: /^Select row 2, Coffee order 1\./ }));
    await fireEvent.press(q.getByRole("button", { name: "Done" }));
    expect(q.queryByRole("checkbox", { name: /^Select row 2/ })).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({});
  });

  it("restores a single excluded row while retaining its saved correction", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    await fireEvent.press(q.getByRole("checkbox", { name: /^Select row 2, Coffee order 1\./ }));
    await fireEvent.press(q.getByRole("button", { name: "Remove 1 from import" }));
    await fireEvent.press(q.getByRole("button", { name: "Excluded (1)" }));
    await fireEvent.press(q.getByRole("button", { name: /^Restore row 2\./ }));
    expect(q.getByText("No rows are excluded.")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({ "2": { amount: "170" } });
  });

  it("uses spreadsheet row identity for an issue beyond the initial preview", async () => {
    const q = await ready();
    await edit(q, 427, "Later CSV issue");
    await saveAmount(q, "250");
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({ "427": { amount: "250" } });
    expect(post.mock.calls[1][1].corrections["8"]).toBeUndefined();
  });

  it("preserves the current row order when a correction is saved with later CSV issues present", async () => {
    upload.mockResolvedValue({ ...stage, previewRows: sample.map((row, index) => index < 2 ? { ...row, amount: "" } : row) });
    const q = await ready();
    const rowNumbers = () => listProps(q).data.map((row) => (row as { rowNumber: number }).rowNumber);
    const before = rowNumbers();
    expect(before[0]).toBe(2);
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    expect(rowNumbers()).toEqual(before);
    expect(rowNumbers()[0]).toBe(2);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("bounds mounted review data to the returned sample and issues rather than the whole file", async () => {
    upload.mockResolvedValue({ ...stage, previewRows: Array.from({ length: 50 }, (_, index) => ({ ...sample[0], description: `Preview ${index}` })) });
    post.mockResolvedValue({ ...checked, reviewRows: Array.from({ length: 200 }, (_, index) => ({ row: 1_000 + index, values: { ...sample[0], description: `Issue ${index}`, amount: "" } })), reviewRowsTruncated: true });
    const q = await ready();
    const list = listProps(q);
    expect(list.data.length).toBe(50);
    expect(list.data.length).toBeLessThan(stage.totalRows);
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    await fireEvent.press(q.getByRole("button", { name: /Needs fixing/ }));
    expect(listProps(q).data.length).toBe(200);
    expect(q.getByText("Limited row details. Fix remaining issues in the CSV.")).toBeTruthy();
  });

  it("replaces untouched issue windows while retaining corrected and excluded late rows", async () => {
    const issueWindow = (start: number) => Array.from({ length: 200 }, (_, index) => ({
      row: start + index,
      values: { ...sample[0], description: `Issue ${start + index}`, amount: "" },
    }));
    post.mockResolvedValueOnce({ ...checked, validation: { validRows: 29_600, invalidRows: 400, skipped: [], skippedTruncated: true, duplicateRows: [] }, reviewRows: issueWindow(1_000), reviewRowsTruncated: true });
    const q = await ready();
    await edit(q, 1_000, "Issue 1000");
    await saveAmount(q, "250");
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    await fireEvent.press(q.getByRole("checkbox", { name: /^Select row 1001, Issue 1001\./ }));
    await fireEvent.press(q.getByRole("button", { name: "Remove 1 from import" }));
    post.mockResolvedValueOnce({ ...checked, validation: { validRows: 29_601, invalidRows: 399, skipped: [], skippedTruncated: true, duplicateRows: [] }, reviewRows: issueWindow(2_000), reviewRowsTruncated: true });
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Back to review" }));
    expect(post.mock.calls[1][1].corrections).toEqual({ "1000": { amount: "250" }, "1001": { exclude: true } });
    await fireEvent.press(q.getByRole("button", { name: "Needs fixing (200)" }));
    const currentIssues = listProps(q).data.map((row) => (row as { rowNumber: number }).rowNumber);
    expect(currentIssues).toHaveLength(200);
    expect(currentIssues[0]).toBe(2_000);
    expect(currentIssues).not.toContain(1_002);
    await fireEvent.press(q.getByRole("button", { name: "Edited (1)" }));
    expect(listProps(q).data.map((row) => (row as { rowNumber: number }).rowNumber)).toEqual([1_000]);
    expect(q.getByRole("button", { name: /^Row 1000, Issue 1000\. Edit this row\./ })).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Excluded (1)" }));
    expect(listProps(q).data.map((row) => (row as { rowNumber: number }).rowNumber)).toEqual([1_001]);
    expect(q.getByRole("button", { name: /^Restore row 1001\./ })).toBeTruthy();
  });

  it("serializes same-frame recheck taps into one request", async () => {
    const q = await ready();
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const check = pressHandler(q.getByRole("button", { name: "Check & continue" }));
    await act(() => { check(); check(); });
    expect(post).toHaveBeenCalledTimes(2);
    await act(() => finish(checked));
    expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled();
  });

  it("discards an in-flight staged review after the active business changes", async () => {
    const q = await ready();
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    const pending = post.mock.calls.at(-1)!;
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap());
    expect((pending[2].signal ?? pending[2]).aborted).toBe(true);
    await act(() => finish(checked));
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
  });

  it("cancels a pending review on header Back and ignores its late response", async () => {
    const q = await ready();
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    const pending = post.mock.calls.at(-1)!;
    await act(() => navigation.setOptions.mock.calls.at(-1)![0].headerLeft({}).props.onPress());
    expect((pending[2].signal ?? pending[2]).aborted).toBe(true);
    expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled();
    await act(() => finish(checked));
    expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled();
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it("handles a temporarily missing business without changing hook order or restoring another profile's draft", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await fireEvent.changeText(q.getByLabelText("Amount"), "170");
    selectedBusiness = undefined;
    await q.rerender(wrap());
    expect(q.queryByRole("button", { name: "Check & continue" })).toBeNull();
    expect(q.container.queryAll((node) => typeof node.props.onChangeText === "function")).toHaveLength(0);
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap());
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("preserves a correction after review fails and safely retries the same staged upload", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    post.mockRejectedValueOnce(new TypeError("Network request failed"));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[2][1]);
    expect(post.mock.calls[2][1].corrections).toEqual({ "2": { amount: "170" } });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["CSV_STAGE_EXPIRED", "CSV_STAGE_NOT_FOUND"])("offers preserved-file recovery after %s without changing financial records", async (code) => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    post.mockRejectedValueOnce(Object.assign(new Error("This CSV upload has expired. Choose the file again."), { status: code === "CSV_STAGE_EXPIRED" ? 410 : 404, code }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByText(/expired/)).toBeTruthy());
    expect(q.getByRole("button", { name: "Check & continue" })).toBeDisabled();
    expect(q.queryByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeNull();
    expect(post.mock.calls.every(([path]) => path.endsWith("preview"))).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(q.getByRole("button", { name: "Upload this file again" })).toBeEnabled();
    const replacementStage = "22345678-1234-4123-8123-123456789abc";
    upload.mockResolvedValueOnce({ ...stage, stagedUploadId: replacementStage });
    await fireEvent.press(q.getByRole("button", { name: "Upload this file again" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(document).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][1].get("idempotencyKey")).toBe(upload.mock.calls[0][1].get("idempotencyKey"));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    expect(post.mock.calls.at(-1)![1]).toMatchObject({ stagedUploadId: replacementStage, corrections: { "2": { amount: "170" } } });
  });

  it.each(["network", "JSON parse"] as const)("shows one accessible recovery message and replays an accepted confirmation after a lost %s response", async (failure) => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    let confirmations = 0;
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("preview")) throw Object.assign(new Error("This upload has already been confirmed"), { status: 409, code: "CSV_STAGE_ALREADY_CONFIRMED" });
      if (++confirmations === 1) throw failure === "JSON parse"
        ? new SyntaxError("JSON Parse error: Unexpected end of input")
        : Object.assign(new Error("Network request failed"), { status: 0 });
      return { processingStatus: "COMPLETE", imported: 29_999, totalRows: 30_000, skippedCount: 1, skipped: [] };
    });
    await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the same import" })).toBeEnabled());
    expect(q.queryByRole("button", { name: "Check & continue" })).toBeNull();
    const recoveryMessage = "The confirmation response was lost. Check the same import before making more changes.";
    expect(q.getAllByRole("alert")).toHaveLength(1);
    expect(q.getByRole("alert")).toHaveTextContent(recoveryMessage);
    expect(q.getByRole("alert").props.accessibilityLiveRegion).toBe("assertive");
    expect(q.getAllByText(recoveryMessage)).toHaveLength(1);
    expect(q.queryByText(/JSON Parse error|Unexpected end of input|Network request failed/)).toBeNull();
    expect(q.getByRole("button", { name: "Select" })).toBeDisabled();
    const replay = pressHandler(q.getByRole("button", { name: "Check the same import" }));
    await act(() => { replay(); replay(); });
    await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
    const attempts = post.mock.calls.filter(([path]) => path.endsWith("confirm"));
    expect(attempts).toHaveLength(2);
    expect(post.mock.calls.filter(([path]) => path.endsWith("preview"))).toHaveLength(2);
    expect(attempts[0][1]).toEqual(attempts[1][1]);
    expect(attempts[1][1]).toMatchObject({ stagedUploadId: stage.stagedUploadId, corrections: { "2": { amount: "170" } } });
    expect(attempts[1][1].idempotencyKey).toBe(upload.mock.calls[0][1].get("idempotencyKey"));
    expect(upload).toHaveBeenCalledTimes(1);
    await fireEvent.press(q.getByRole("button", { name: "Done" }));
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
  });

  it("clears an uncertain confirmation when the active business changes", async () => {
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    post.mockRejectedValueOnce(Object.assign(new Error("Network request failed"), { status: 0 }));
    await fireEvent.press(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the same import" })).toBeEnabled());
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap());
    expect(q.queryByRole("button", { name: "Check the same import" })).toBeNull();
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
    expect(post.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(1);
    await q.unmount();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["header Back", "blur"] as const)("keeps an in-flight confirmation frozen after %s and replays it directly on return", async (transition) => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await saveAmount(q, "170");
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(() => { pressHandler(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }))(); });
    const pending = post.mock.calls.at(-1)!;
    if (transition === "header Back") await act(() => navigation.setOptions.mock.calls.at(-1)![0].headerLeft({}).props.onPress());
    expect(q.getByRole("button", { name: transition === "header Back" ? "Change file" : "Back to review" })).toBeDisabled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
    await act(() => { for (const setFocused of focusSetters) setFocused(false); });
    expect(pending[2].signal.aborted).toBe(true);
    await act(() => finish({ imported: 29_999, totalRows: 30_000, skippedCount: 1, skipped: [] }));
    expect(q.queryByText("Import complete")).toBeNull();
    await act(() => { for (const setFocused of focusSetters) setFocused(true); });
    await waitFor(() => expect(q.getByRole("button", { name: "Check the same import" })).toBeEnabled());
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("preview")) throw Object.assign(new Error("Already confirmed"), { status: 409, code: "CSV_STAGE_ALREADY_CONFIRMED" });
      return { imported: 29_999, totalRows: 30_000, skippedCount: 1, skipped: [] };
    });
    await fireEvent.press(q.getByRole("button", { name: "Check the same import" }));
    await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
    const attempts = post.mock.calls.filter(([path]) => path.endsWith("confirm"));
    expect(attempts).toHaveLength(2);
    expect(attempts[1][1]).toEqual(pending[1]);
    expect(post.mock.calls.filter(([path]) => path.endsWith("preview"))).toHaveLength(2);
    expect(upload).toHaveBeenCalledTimes(1);
    await q.unmount();
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes an explicitly abandoned stage once and starts a replacement with a new key", async () => {
    const q = await render(wrap());
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    const originalKey = upload.mock.calls[0][1].get("idempotencyKey");
    await fireEvent.press(q.getByRole("button", { name: "Change file" }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove.mock.calls[0][0]).toBe(`/records/csv-imports/stages/${stage.stagedUploadId}`);
    expect(post.mock.calls.every(([path]) => path.endsWith("preview"))).toBe(true);
    upload.mockResolvedValueOnce({ ...stage, stagedUploadId: "22345678-1234-4123-8123-123456789abc" });
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(upload.mock.calls[1][1].get("idempotencyKey")).not.toBe(originalKey);
    await q.unmount();
    expect(remove.mock.calls.map(([path]) => path)).toEqual([
      `/records/csv-imports/stages/${stage.stagedUploadId}`,
      "/records/csv-imports/stages/22345678-1234-4123-8123-123456789abc",
    ]);
  });

  it("cleans up the old profile's stage without deleting a replacement profile's stage", async () => {
    const q = await ready();
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap());
    expect(remove.mock.calls.map(([path]) => path)).toEqual([`/records/csv-imports/stages/${stage.stagedUploadId}`]);
    expect(remove.mock.calls[0][2]).toEqual({ cacheScope: { businessProfileId: 1 } });
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
    const replacementStage = "22345678-1234-4123-8123-123456789abc";
    upload.mockResolvedValueOnce({ ...stage, stagedUploadId: replacementStage });
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(upload.mock.calls[1][1].get("businessProfileId")).toBe("2");
    expect(remove).toHaveBeenCalledTimes(1);
    await q.unmount();
    expect(remove.mock.calls.map(([path]) => path)).toEqual([
      `/records/csv-imports/stages/${stage.stagedUploadId}`,
      `/records/csv-imports/stages/${replacementStage}`,
    ]);
    expect(remove.mock.calls[1][2]).toEqual({ cacheScope: { businessProfileId: 2 } });
  });

  it.each(["profile switch", "file replacement", "unmount"] as const)("deletes a late upload's truly abandoned stage after %s", async (reason) => {
    let finish!: (value: unknown) => void;
    upload.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const q = await render(wrap());
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const pending = upload.mock.calls[0];
    const replacementStage = "22345678-1234-4123-8123-123456789abc";
    if (reason === "profile switch") {
      selectedBusiness = { ...fixtures.businessProfile, id: 2 };
      await q.rerender(wrap());
    } else if (reason === "file replacement") {
      await fireEvent.press(q.getByRole("button", { name: "Cancel upload" }));
      await fireEvent.press(q.getByRole("button", { name: "Choose a different file" }));
      upload.mockResolvedValueOnce({ ...stage, stagedUploadId: replacementStage });
      await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
      expect(upload.mock.calls[1][1].get("idempotencyKey")).not.toBe(pending[1].get("idempotencyKey"));
    } else await q.unmount();
    expect(pending[1].get("businessProfileId")).toBe("1");
    expect(pending[2].aborted).toBe(true);
    await act(() => finish(stage));
    if (reason === "profile switch") {
      expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
      expect(q.queryByText("Review your records")).toBeNull();
    }
    expect(remove.mock.calls.map(([path]) => path)).toEqual([`/records/csv-imports/stages/${stage.stagedUploadId}`]);
    expect(remove.mock.calls[0][2]).toEqual({ cacheScope: { businessProfileId: 1 } });
    if (reason === "file replacement") {
      await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
      expect(post.mock.calls[0][1]).toMatchObject({ stagedUploadId: replacementStage, businessProfileId: 1 });
      await q.unmount();
      expect(remove.mock.calls.map(([path]) => path)).toEqual([
        `/records/csv-imports/stages/${stage.stagedUploadId}`,
        `/records/csv-imports/stages/${replacementStage}`,
      ]);
    } else {
      if (reason !== "unmount") await q.unmount();
      expect(remove).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["before", "after"] as const)("does not delete a retained same-key retry's stage when the cancelled upload responds %s the retry", async (order) => {
    let finishOriginal!: (value: unknown) => void;
    let finishRetry!: (value: unknown) => void;
    upload.mockReturnValueOnce(new Promise((resolve) => { finishOriginal = resolve; }));
    upload.mockReturnValueOnce(new Promise((resolve) => { finishRetry = resolve; }));
    const q = await render(wrap());
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await fireEvent.press(q.getByRole("button", { name: "Cancel upload" }));
    expect(upload.mock.calls[0][2].aborted).toBe(true);
    await fireEvent.press(q.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls[1][1].get("idempotencyKey")).toBe(upload.mock.calls[0][1].get("idempotencyKey"));
    if (order === "before") await act(() => finishOriginal(stage));
    await act(() => finishRetry(stage));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    if (order === "after") await act(() => finishOriginal(stage));
    expect(remove).not.toHaveBeenCalled();
    expect(document).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    expect(post.mock.calls[0][1]).toMatchObject({ stagedUploadId: stage.stagedUploadId, businessProfileId: 1 });
    await q.unmount();
    expect(remove.mock.calls.map(([path]) => path)).toEqual([`/records/csv-imports/stages/${stage.stagedUploadId}`]);
  });

  it("retains a late cancelled-upload stage for cleanup when the selected file is eventually abandoned", async () => {
    let finish!: (value: unknown) => void;
    upload.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const q = await render(wrap());
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await fireEvent.press(q.getByRole("button", { name: "Cancel upload" }));
    await act(() => finish(stage));
    expect(q.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(q.queryByText("Review your records")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole("button", { name: "Choose a different file" }));
    expect(remove.mock.calls.map(([path]) => path)).toEqual([`/records/csv-imports/stages/${stage.stagedUploadId}`]);
    await q.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("allows file replacement when best-effort abandoned-stage cleanup fails", async () => {
    const q = await render(wrap());
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled());
    remove.mockRejectedValueOnce(new TypeError("Network request failed"));
    await fireEvent.press(q.getByRole("button", { name: "Change file" }));
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
    await q.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.every(([path]) => path.endsWith("preview"))).toBe(true);
  });

  it("never deletes a stage after confirmation was sent, even when the screen unmounts before the response", async () => {
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(q.getByRole("button", { name: /^Import [\d,]+ records?$/ })).toBeEnabled());
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await act(() => { pressHandler(q.getByRole("button", { name: /^Import [\d,]+ records?$/ }))(); });
    const pending = post.mock.calls.at(-1)!;
    await q.unmount();
    expect(pending[2].signal.aborted).toBe(true);
    await act(() => finish({ imported: 29_999, totalRows: 30_000, skippedCount: 1, skipped: [] }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("handles header Back and beforeRemove without losing an unsaved edit or leaving review unexpectedly", async () => {
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await fireEvent.changeText(q.getByLabelText("Amount"), "170");
    await act(() => navigation.setOptions.mock.calls.at(-1)![0].headerLeft({}).props.onPress());
    expect(q.getByText("Discard this unsaved edit?")).toBeTruthy();
    const prevented = vi.fn();
    const intercept = navigation.addListener.mock.calls.at(-1)![1];
    await act(() => intercept({ preventDefault: prevented }));
    expect(prevented).toHaveBeenCalledTimes(1);
    expect(q.getByText("Discard this unsaved edit?")).toBeTruthy();
    expect(q.getByLabelText("Amount").props.value).toBe("170");
    await fireEvent.press(q.getByRole("button", { name: "Discard edit" }));
    expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled();
    expect(q.queryByText("Discard this unsaved edit?")).toBeNull();
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
    expect(navigation.goBack).not.toHaveBeenCalled();
    const options = navigation.setOptions.mock.calls.at(-1)![0];
    expect(options.headerBackVisible).toBe(false);
    await act(() => options.headerLeft({}).props.onPress());
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
  });

  it.each(["header", "hardware"] as const)("closes a dirty editor and leaves review once after discarding through %s Back", async (source) => {
    let hardwareBack!: () => boolean | null | undefined;
    vi.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      hardwareBack = () => listener({ type: "hardwareBackPress", timeStamp: 0 });
      return { remove: vi.fn() };
    });
    const q = await ready();
    await edit(q, 2, "Coffee order 1");
    await fireEvent.changeText(q.getByLabelText("Amount"), "170");
    await act(() => source === "hardware"
      ? hardwareBack()
      : navigation.setOptions.mock.calls.at(-1)![0].headerLeft({}).props.onPress());
    expect(navigation.navigate).not.toHaveBeenCalled();
    await fireEvent.press(q.getByRole("button", { name: "Discard edit" }));
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
    expect(q.queryByText("Discard this unsaved edit?")).toBeNull();
    expect(q.queryByLabelText("Amount")).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("handles hardware Back through selection and leaves review through the no-history fallback, cleaning up its listener", async () => {
    let back!: () => boolean | null | undefined;
    const removeListener = vi.fn();
    vi.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      back = () => listener({ type: "hardwareBackPress", timeStamp: 0 });
      return { remove: removeListener };
    });
    const q = await ready();
    await fireEvent.press(q.getByRole("button", { name: "Select" }));
    await act(() => { expect(back()).toBe(true); });
    expect(q.getByRole("button", { name: "Select" })).toBeEnabled();
    expect(q.getByRole("button", { name: "Check & continue" })).toBeEnabled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    await act(() => { expect(back()).toBe(true); });
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
    await q.unmount();
    expect(removeListener).toHaveBeenCalled();
  });

  it("clears a row balance override when its draft date moves away from the recorded balance date", async () => {
    const baseline = { baselineAt: "2026-09-01T03:00:00.000Z", baselineDate: "2026-09-01", matchingRowCount: 6 };
    post.mockResolvedValue({ ...checked, availableFundsBaseline: baseline });
    const q = await ready();
    await fireEvent.press(q.getByRole("radio", { name: "Yes, it was already included" }));
    await edit(q, 2, "Coffee order 1");
    await fireEvent.press(q.getByRole("radio", { name: "After the balance, row 2" }));
    await fireEvent.changeText(q.getByLabelText("Date"), "2026-09-02");
    expect(q.queryByRole("radio", { name: "After the balance, row 2" })).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Save changes" }));
    await fireEvent.press(q.getByRole("button", { name: "Check & continue" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].corrections).toEqual({ "2": { date: "2026-09-02" } });
    expect(post.mock.calls[1][1]).toMatchObject({ includedInAvailableFundsBaseline: true, availableFundsBaselineAt: baseline.baselineAt });
  });
});
