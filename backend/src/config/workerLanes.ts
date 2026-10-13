import { z } from "zod";

export const WORKER_LANE_NAMES = ["receipt", "csv", "analysis", "maintenance"] as const;

export type WorkerLane = (typeof WORKER_LANE_NAMES)[number];

const workerLaneNames = new Set<string>(WORKER_LANE_NAMES);

function laneTokens(value: string): string[] {
  return value.split(",").map((lane) => lane.trim());
}

export const workerLanesSchema = z
  .string()
  .trim()
  .min(1, "choose all or a comma-separated worker lane set")
  .default("all")
  .superRefine((value, context) => {
    const lanes = laneTokens(value);
    const uniqueLanes = new Set(lanes);

    if (lanes.includes("all") && lanes.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"all" cannot be combined with named worker lanes',
      });
    }
    if (uniqueLanes.size !== lanes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "worker lanes must not be repeated",
      });
    }

    const unknownLanes = lanes.filter((lane) => lane !== "all" && !workerLaneNames.has(lane));
    if (unknownLanes.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown worker lane: ${unknownLanes.join(", ")}`,
      });
    }
  })
  .transform((value): WorkerLane[] => {
    if (value === "all") return [...WORKER_LANE_NAMES];
    const selected = new Set(laneTokens(value));
    return WORKER_LANE_NAMES.filter((lane) => selected.has(lane));
  });

export function hasWorkerLane(lanes: readonly WorkerLane[], lane: WorkerLane): boolean {
  return lanes.includes(lane);
}
