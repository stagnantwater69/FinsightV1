export interface ConfidenceInterval {
  confidenceLevel: 0.95;
  lower: number;
  upper: number;
  method:
    | "TWO_SIDED_WILSON_SCORE_WITHOUT_CONTINUITY_CORRECTION"
    | "TWO_SIDED_PERCENTILE_BOOTSTRAP";
  resamples?: number;
  seed?: number;
  resamplingUnit?: "DISTINCT_RECEIPT_ID" | "DECLARED_INDEPENDENT_TRIAL";
}

export interface RatioCluster {
  numerator: number;
  denominator: number;
}

const Z_95 = 1.959963984540054;

export function wilson95(numerator: number, denominator: number): ConfidenceInterval | null {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) return null;
  if (numerator < 0 || numerator > denominator) return null;

  const proportion = numerator / denominator;
  const zSquared = Z_95 * Z_95;
  const scale = 1 + zSquared / denominator;
  const centre = (proportion + zSquared / (2 * denominator)) / scale;
  const margin = (
    Z_95 * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * denominator)) / denominator)
  ) / scale;

  return {
    confidenceLevel: 0.95,
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
    method: "TWO_SIDED_WILSON_SCORE_WITHOUT_CONTINUITY_CORRECTION",
  };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function percentile(values: number[], probability: number): number | null {
  if (values.length === 0 || probability < 0 || probability > 1) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

export function bootstrapRatio95(
  clusters: RatioCluster[],
  options: {
    seed: number;
    resamples: number;
    resamplingUnit: "DISTINCT_RECEIPT_ID" | "DECLARED_INDEPENDENT_TRIAL";
  },
): ConfidenceInterval | null {
  const usable = clusters.filter(
    ({ numerator, denominator }) =>
      Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0,
  );
  if (usable.length === 0 || options.resamples <= 0) {
    return null;
  }

  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let sampleIndex = 0; sampleIndex < options.resamples; sampleIndex += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let clusterIndex = 0; clusterIndex < usable.length; clusterIndex += 1) {
      const selected = usable[Math.floor(random() * usable.length)]!;
      numerator += selected.numerator;
      denominator += selected.denominator;
    }
    if (denominator > 0) estimates.push(numerator / denominator);
  }

  const lower = percentile(estimates, 0.025);
  const upper = percentile(estimates, 0.975);
  if (lower === null || upper === null) return null;
  return {
    confidenceLevel: 0.95,
    lower,
    upper,
    method: "TWO_SIDED_PERCENTILE_BOOTSTRAP",
    resamples: options.resamples,
    seed: options.seed,
    resamplingUnit: options.resamplingUnit,
  };
}

export function bootstrapPercentile95(
  values: number[],
  targetPercentile: number,
  options: { seed: number; resamples: number },
): ConfidenceInterval | null {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0 || options.resamples <= 0) return null;

  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let sampleIndex = 0; sampleIndex < options.resamples; sampleIndex += 1) {
    const resample: number[] = [];
    for (let valueIndex = 0; valueIndex < usable.length; valueIndex += 1) {
      resample.push(usable[Math.floor(random() * usable.length)]!);
    }
    const estimate = percentile(resample, targetPercentile);
    if (estimate !== null) estimates.push(estimate);
  }

  const lower = percentile(estimates, 0.025);
  const upper = percentile(estimates, 0.975);
  if (lower === null || upper === null) return null;
  return {
    confidenceLevel: 0.95,
    lower,
    upper,
    method: "TWO_SIDED_PERCENTILE_BOOTSTRAP",
    resamples: options.resamples,
    seed: options.seed,
    resamplingUnit: "DECLARED_INDEPENDENT_TRIAL",
  };
}

export function bootstrapClusteredPercentile95(
  clusters: number[][],
  targetPercentile: number,
  options: { seed: number; resamples: number },
): ConfidenceInterval | null {
  const usable = clusters
    .map((cluster) => cluster.filter(Number.isFinite))
    .filter((cluster) => cluster.length > 0);
  if (usable.length === 0 || options.resamples <= 0) return null;

  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let sampleIndex = 0; sampleIndex < options.resamples; sampleIndex += 1) {
    const resample: number[] = [];
    for (let clusterIndex = 0; clusterIndex < usable.length; clusterIndex += 1) {
      resample.push(...usable[Math.floor(random() * usable.length)]!);
    }
    const estimate = percentile(resample, targetPercentile);
    if (estimate !== null) estimates.push(estimate);
  }

  const lower = percentile(estimates, 0.025);
  const upper = percentile(estimates, 0.975);
  if (lower === null || upper === null) return null;
  return {
    confidenceLevel: 0.95,
    lower,
    upper,
    method: "TWO_SIDED_PERCENTILE_BOOTSTRAP",
    resamples: options.resamples,
    seed: options.seed,
    resamplingUnit: "DISTINCT_RECEIPT_ID",
  };
}
