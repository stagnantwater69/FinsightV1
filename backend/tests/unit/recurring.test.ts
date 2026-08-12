import { describe, expect, it } from "vitest";
import { inferRecurringPattern, recurringKey } from "../../src/services/anomalyDetection/recurring.service";

const record = (id: number, date: string, amount = 1_000) => ({
  id, categoryId: 1, vendor: "Power Co.", description: "Monthly electricity", amount,
  date: new Date(`${date}T00:00:00.000Z`),
});

describe("recurring pattern inference", () => {
  it("recognizes a stable monthly sequence", () => {
    const pattern = inferRecurringPattern([
      record(1, "2026-01-01"), record(2, "2026-01-31"), record(3, "2026-03-02"), record(4, "2026-04-01"),
    ]);
    expect(pattern).toMatchObject({ intervalDays: 30, expectedAmount: 1_000 });
    expect(pattern!.confidence).toBe(1);
  });

  it("requires at least three observations", () => {
    expect(inferRecurringPattern([record(1, "2026-01-01"), record(2, "2026-01-31")])).toBeNull();
  });

  it("rejects irregular intervals", () => {
    expect(inferRecurringPattern([
      record(1, "2026-01-01"), record(2, "2026-01-12"), record(3, "2026-03-20"), record(4, "2026-04-03"),
    ])).toBeNull();
  });

  it("creates stable normalized identities", () => {
    expect(recurringKey(record(1, "2026-01-01"))).toBe(recurringKey({ ...record(2, "2026-02-01"), vendor: "POWER CO" }));
  });
});
