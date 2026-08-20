import { env } from "../../config/env";

export interface DetectionFeatureFlags {
  amountOutlier: boolean;
  exactDuplicate: boolean;
  nearDuplicate: boolean;
  velocity: boolean;
  recurring: boolean;
  trends: boolean;
  behavioralNovelty: boolean;
  /** Shadow-only ML detector — see isolationForest.service.ts. */
  isolationForest: boolean;
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
    isolationForest: false,
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

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/**
 * The notification gate. A finding below `notificationMinimumSeverity` is still
 * computed and stored — it simply does not interrupt anyone.
 *
 * Lives here rather than in a detector so every caller reads the same rule from
 * the same config object. Lowering `notificationMinimumSeverity` changes the
 * noise level of every detector at once; raise an individual finding's severity
 * instead.
 */
export function meetsNotificationSeverity(severity: keyof typeof SEVERITY_RANK, config: DetectionConfig): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[config.notificationMinimumSeverity];
}

export const RUNTIME_DETECTION_CONFIG = detectionConfig({
  featureFlags: {
    ...DEFAULT_DETECTION_CONFIG.featureFlags,
    nearDuplicate: env.ANOMALY_NEAR_DUPLICATE_ENABLED,
    velocity: env.ANOMALY_VELOCITY_ENABLED,
    trends: env.ANOMALY_TRENDS_ENABLED,
    behavioralNovelty: env.ANOMALY_BEHAVIORAL_NOVELTY_ENABLED,
    recurring: env.ANOMALY_RECURRING_ENABLED,
    isolationForest: env.ANOMALY_ISOLATION_FOREST_ENABLED,
  },
});
