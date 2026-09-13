import "dotenv/config";

export const RECEIPT_PROVIDER_POLICY_VERSION = "receipt-provider-policy-v1" as const;
export const RECEIPT_PROVIDER_TIMEOUT_MS = 20_000 as const;
export const RECEIPT_PROVIDER_PHASE1_MONTHLY_UNIT_CAP = 100 as const;
export const RECEIPT_PROVIDER_ALLOWED_DATA_CLASSES = ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as const;
export const RECEIPT_PROVIDER_PURPOSE = "RECEIPT_EXTRACTION" as const;

export type EnabledReceiptProvider = "gemini" | "veryfi";

const PROVIDER_DETAILS = {
  gemini: { label: "Google Gemini", supportedVersion: "gemini-3.5-flash-lite", unitType: "DOCUMENT" },
  veryfi: { label: "Veryfi", supportedVersion: "receipt-api-v8", unitType: "PAGE" },
} as const;

export interface ReceiptProviderConfiguration {
  dispatchEnabled: boolean;
  killSwitchActive: boolean;
  dataTermsApproved: boolean;
  routingCalibrated: boolean;
  calibrationVersion: string | null;
  provider: EnabledReceiptProvider | null;
  providerLabel: string | null;
  providerVersion: string | null;
  providerRegion: string | null;
  policyVersion: typeof RECEIPT_PROVIDER_POLICY_VERSION;
  purpose: typeof RECEIPT_PROVIDER_PURPOSE;
  allowedDataClasses: readonly ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"];
  providerRetentionHours: number | null;
  providerTrainingAllowed: false;
  timeoutMs: typeof RECEIPT_PROVIDER_TIMEOUT_MS;
  resourceMonthlyUnitLimit: number;
  businessMonthlyUnitLimit: number | null;
  unitType: "DOCUMENT" | "PAGE" | null;
  operational: boolean;
}

function strictBoolean(value: string | undefined, safeDefault: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return safeDefault;
}

function finiteInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= RECEIPT_PROVIDER_PHASE1_MONTHLY_UNIT_CAP
    ? parsed
    : fallback;
}

function boundedText(value: string | undefined, max: number): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized.length <= max && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : null;
}

function boundedRegion(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized.length <= 64 && /^[A-Za-z0-9._-]+$/.test(normalized)
    ? normalized
    : null;
}

function selectedProvider(value: string | undefined): EnabledReceiptProvider | null {
  return value === "gemini" || value === "veryfi" ? value : null;
}

function credentialsComplete(provider: EnabledReceiptProvider | null, source: NodeJS.ProcessEnv): boolean {
  if (provider === "gemini") return (source.GOOGLE_GEMINI_API_KEY ?? "").trim().length > 0;
  if (provider === "veryfi") {
    return [source.VERYFI_CLIENT_ID, source.VERYFI_CLIENT_SECRET, source.VERYFI_USERNAME, source.VERYFI_API_KEY].every(
      (value) => (value ?? "").trim().length > 0,
    );
  }
  return false;
}

/**
 * Resolves the receipt-only provider policy. Invalid or absent values collapse
 * to an unavailable state; credentials never switch dispatch on by themselves.
 */
export function getReceiptProviderConfiguration(
  source: NodeJS.ProcessEnv = process.env,
): ReceiptProviderConfiguration {
  const provider = selectedProvider(source.RECEIPT_PROVIDER);
  const details = provider ? PROVIDER_DETAILS[provider] : null;
  const dispatchEnabled = strictBoolean(source.RECEIPT_PROVIDER_DISPATCH_ENABLED, false);
  const killSwitchActive = strictBoolean(source.RECEIPT_PROVIDER_KILL_SWITCH, true);
  const dataTermsApproved = strictBoolean(source.RECEIPT_PROVIDER_DATA_TERMS_APPROVED, false);
  const routingCalibrated = strictBoolean(source.RECEIPT_PROVIDER_ROUTING_CALIBRATED, false);
  const calibrationVersion = boundedText(source.RECEIPT_PROVIDER_CALIBRATION_VERSION, 64);
  const providerVersion = boundedText(source.RECEIPT_PROVIDER_VERSION, 96);
  const providerRegion = boundedRegion(source.RECEIPT_PROVIDER_REGION);
  const retention = finiteInteger(source.RECEIPT_PROVIDER_RETENTION_HOURS, -1);
  const providerRetentionHours = retention >= 0 && retention <= 24 ? retention : null;
  const resourceMonthlyUnitLimit = finiteInteger(source.RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT, 0);
  const businessLimitRaw = source.RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT;
  const businessMonthlyUnitLimit =
    businessLimitRaw === undefined || businessLimitRaw.trim() === ""
      ? null
      : finiteInteger(businessLimitRaw, 0);

  const complete =
    provider !== null &&
    details !== null &&
    providerVersion === details.supportedVersion &&
    providerRegion !== null &&
    providerRetentionHours !== null &&
    dataTermsApproved &&
    routingCalibrated &&
    calibrationVersion !== null &&
    resourceMonthlyUnitLimit > 0 &&
    (businessMonthlyUnitLimit === null || businessMonthlyUnitLimit > 0) &&
    credentialsComplete(provider, source);

  return {
    dispatchEnabled,
    killSwitchActive,
    dataTermsApproved,
    routingCalibrated,
    calibrationVersion,
    provider,
    providerLabel: details?.label ?? null,
    providerVersion,
    providerRegion,
    policyVersion: RECEIPT_PROVIDER_POLICY_VERSION,
    purpose: RECEIPT_PROVIDER_PURPOSE,
    allowedDataClasses: RECEIPT_PROVIDER_ALLOWED_DATA_CLASSES,
    providerRetentionHours,
    providerTrainingAllowed: false,
    timeoutMs: RECEIPT_PROVIDER_TIMEOUT_MS,
    resourceMonthlyUnitLimit,
    businessMonthlyUnitLimit,
    unitType: details?.unitType ?? null,
    operational: dispatchEnabled && !killSwitchActive && complete,
  };
}

export type ReceiptProviderPublicDetails = {
  key: EnabledReceiptProvider;
  label: string;
  version: string;
  region: string;
  policyVersion: string;
  purpose: typeof RECEIPT_PROVIDER_PURPOSE;
  dataClasses: readonly ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"];
  retentionHours: number;
  trainingAllowed: false;
  revocable: true;
};

/** Returns no provider metadata unless every dispatch prerequisite is active. */
export function publicReceiptProviderDetails(
  config = getReceiptProviderConfiguration(),
): ReceiptProviderPublicDetails | null {
  if (
    !config.operational ||
    !config.provider ||
    !config.providerLabel ||
    !config.providerVersion ||
    !config.providerRegion ||
    config.providerRetentionHours === null
  ) {
    return null;
  }
  return {
    key: config.provider,
    label: config.providerLabel,
    version: config.providerVersion,
    region: config.providerRegion,
    policyVersion: config.policyVersion,
    purpose: config.purpose,
    dataClasses: config.allowedDataClasses,
    retentionHours: config.providerRetentionHours,
    trainingAllowed: false,
    revocable: true,
  };
}
