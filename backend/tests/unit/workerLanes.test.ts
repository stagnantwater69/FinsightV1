import { describe, expect, it } from "vitest";
import { WORKER_LANE_NAMES, workerLanesSchema } from "../../src/config/workerLanes";

describe("worker lane configuration", () => {
  it("keeps the unset local default as one process owning every lane", () => {
    expect(workerLanesSchema.parse(undefined)).toEqual(WORKER_LANE_NAMES);
    expect(workerLanesSchema.parse("all")).toEqual(WORKER_LANE_NAMES);
  });

  it("accepts an explicit subset and returns it in stable lane order", () => {
    expect(workerLanesSchema.parse("maintenance, csv,analysis")).toEqual([
      "csv",
      "analysis",
      "maintenance",
    ]);
    expect(workerLanesSchema.parse("receipt")).toEqual(["receipt"]);
  });

  it.each(["", "jobs", "receipt,receipt", "all,maintenance", "receipt,"])(
    "rejects an unsafe or ambiguous lane set: %j",
    (value) => {
      expect(workerLanesSchema.safeParse(value).success).toBe(false);
    },
  );
});
