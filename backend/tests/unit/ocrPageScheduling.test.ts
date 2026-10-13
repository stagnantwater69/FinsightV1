import { describe, expect, it } from "vitest";
import { readReceiptPagesWithinOcrBudget } from "../../src/services/receiptScan/ocrPageScheduling";

type Page = { pageNumber: number; processed: object | null };

describe("receipt OCR page scheduling", () => {
  it("runs two original-only pages together and preserves result order", async () => {
    const pages: Page[] = [
      { pageNumber: 1, processed: null },
      { pageNumber: 2, processed: null },
      { pageNumber: 3, processed: null },
    ];
    let active = 0;
    let maxActive = 0;

    const results = await readReceiptPagesWithinOcrBudget(pages, async (page) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, page.pageNumber === 1 ? 10 : 1));
      active -= 1;
      return page.pageNumber;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([1, 2, 3]);
  });

  it("does not overlap a two-candidate page with neighboring pages", async () => {
    const pages: Page[] = [
      { pageNumber: 1, processed: null },
      { pageNumber: 2, processed: {} },
      { pageNumber: 3, processed: null },
      { pageNumber: 4, processed: null },
    ];
    let recognitionBudget = 0;
    let maxBudget = 0;
    const activePages = new Set<number>();

    await readReceiptPagesWithinOcrBudget(pages, async (page) => {
      const cost = page.processed === null ? 1 : 2;
      recognitionBudget += cost;
      maxBudget = Math.max(maxBudget, recognitionBudget);
      activePages.add(page.pageNumber);
      if (page.processed !== null) expect(activePages).toEqual(new Set([page.pageNumber]));
      await new Promise((resolve) => setTimeout(resolve, 1));
      activePages.delete(page.pageNumber);
      recognitionBudget -= cost;
      return page.pageNumber;
    });

    expect(maxBudget).toBe(2);
  });
});
