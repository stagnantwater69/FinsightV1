import { env } from "../../config/env";

export interface DetectionFeatureFlags {
  amountOutlier: boolean;
  exactDuplicate: boolean;
  nearDuplicate: boolean;
  velocity: boolean;
  recurring: boolean;
  trends: boolean;
  behavioralNovelty: boolean;
}

export interface DetectionConfig {
  featureFlags: DetectionFeatureFlags;
  minimumCategoryHistory: number;
  baselineDays: number;
  shortTermBaselineDays: number;
  maximumCategoryRecords: number;
  zScoreThreshold: number;
  iqrFenceMultiplier: number;
  minimumDeviationFraction: number;
  notificationMinimumSeverity: "MEDIUM" | "HIGH";
}

export const DEFAULT_DETECTION_CONFIG: Readonly<DetectionConfig> = Object.freeze({
  featureFlags: Object.freeze({
    amountOutlier: true,
    exactDuplicate: true,
    nearDuplicate: false,
    velocity: false,
    recurring: false,
    trends: false,
    behavioralNovelty: false,
  }),
  minimumCategoryHistory: 8,
  baselineDays: 365,
  shortTermBaselineDays: 90,
  maximumCategoryRecords: 1_000,
  zScoreThreshold: 2,
  iqrFenceMultiplier: 1.5,
  minimumDeviationFraction: 0.15,
  notificationMinimumSeverity: "HIGH",
});

export function detectionConfig(overrides: Partial<DetectionConfig> = {}): DetectionConfig {
  return {
    ...DEFAULT_DETECTION_CONFIG,
    ...overrides,
    featureFlags: {
      ...DEFAULT_DETECTION_CONFIG.featureFlags,
      ...overrides.featureFlags,
    },
  };
}

export const RUNTIME_DETECTION_CONFIG = detectionConfig({
  featureFlags: {
    ...DEFAULT_DETECTION_CONFIG.featureFlags,
    nearDuplicate: env.ANOMALY_NEAR_DUPLICATE_ENABLED,
    velocity: env.ANOMALY_VELOCITY_ENABLED,
    trends: env.ANOMALY_TRENDS_ENABLED,
    behavioralNovelty: env.ANOMALY_BEHAVIORAL_NOVELTY_ENABLED,
  },
});
