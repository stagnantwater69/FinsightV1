/** Maps in input order, stops scheduling after a failure, and waits for in-flight work before rejecting. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive integer");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailureIndex = values.length;
  let firstFailure: unknown;

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed) {
        const index = nextIndex++;
        if (index >= values.length) return;
        try {
          results[index] = await mapper(values[index]!, index);
        } catch (error) {
          failed = true;
          if (index < firstFailureIndex) {
            firstFailureIndex = index;
            firstFailure = error;
          }
        }
      }
    },
  );

  await Promise.all(workers);
  if (firstFailureIndex < values.length) throw firstFailure;
  return results;
}
