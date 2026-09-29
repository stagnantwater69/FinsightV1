export type ReceiptPageWithOptionalProcessed = {
  processed: unknown | null;
};

export async function readReceiptPagesWithinOcrBudget<T extends ReceiptPageWithOptionalProcessed, R>(
  pages: readonly T[],
  readPage: (page: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < pages.length;) {
    const page = pages[index]!;
    if (page.processed !== null) {
      results.push(await readPage(page));
      index += 1;
      continue;
    }

    const next = pages[index + 1];
    const batch = next?.processed === null ? [page, next] : [page];
    results.push(...await Promise.all(batch.map(readPage)));
    index += batch.length;
  }
  return results;
}
