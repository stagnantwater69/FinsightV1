import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTION_CONFIG, detectionConfig } from "../../src/services/anomalyDetection/config";

describe("anomaly detection configuration", () => {
  it("keeps existing detectors enabled and stages new detectors behind flags", () => {
    expect(DEFAULT_DETECTION_CONFIG.featureFlags).toEqual({
      amountOutlier: true,
      exactDuplicate: true,
      nearDuplicate: false,
      velocity: false,
      recurring: false,
      trends: false,
      behavioralNovelty: false,
    });
  });

  it("uses bounded rolling history defaults", () => {
    expect(DEFAULT_DETECTION_CONFIG.baselineDays).toBe(365);
    expect(DEFAULT_DETECTION_CONFIG.shortTermBaselineDays).toBe(90);
    expect(DEFAULT_DETECTION_CONFIG.maximumCategoryRecords).toBe(1_000);
  });

  it("merges feature overrides without changing the defaults", () => {
    const configured = detectionConfig({ featureFlags: { ...DEFAULT_DETECTION_CONFIG.featureFlags, velocity: true } });

    expect(configured.featureFlags.velocity).toBe(true);
    expect(configured.featureFlags.amountOutlier).toBe(true);
    expect(DEFAULT_DETECTION_CONFIG.featureFlags.velocity).toBe(false);
  });
});
