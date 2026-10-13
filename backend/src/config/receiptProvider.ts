import "dotenv/config";

export const RECEIPT_PROVIDER_POLICY_VERSION = "receipt-provider-policy-v1" as const;
/**
 * The deadline on ONE provider HTTP call. Mirrors the `TIMEOUT_MS` the adapter
 * services apply to each `fetch` (visionOcr.service, veryfiOcr.service), and
 * is what the request contract records.
 */
export const RECEIPT_PROVIDER_TIMEOUT_MS = 20_000 as const;

/**
 * How many provider HTTP calls one extraction makes BACK TO BACK.
 *
 * Gemini's adapter extracts, then sends the answer back for a second model to
 * verify — two 20s deadlines in series. Veryfi calls its document endpoint
 * once per page, but concurrently (`Promise.all`), so its wall clock is one
 * deadline however many pages were sent.
 *
 * Keep this in step with the adapters in services/receiptScan/providerAdapters.ts:
 * a call added there and not counted here reintroduces the bug below.
 */
const PROVIDER_SEQUENTIAL_CALLS: Record<EnabledReceiptProvider, number> = {
  gemini: 2,
  veryfi: 1,
};

/** Base64 encoding, TLS setup and JSON parsing either side of the calls. */
const GATE_OVERHEAD_MS = 5_000;

/**
 * The gate's wall-clock budget for the whole adapter call.
 *
 * WHY THIS IS NOT `RECEIPT_PROVIDER_TIMEOUT_MS`. It used to be, and that made
 * the gate's budget for a two-call adapter equal to one of its calls: a Gemini
 * extraction that took 12s and a verification that took 9s was aborted at 20s
 * as `PROVIDER_TIMEOUT` — after the units had been reserved and both calls
 * billed. The owner paid for an answer the gate then threw away, and the scan
 * fell back to the local read as though the provider had never replied.
 *
 * So the gate is a backstop for an adapter that has stopped making progress,
 * not a second, tighter deadline on calls that already carry their own. It
 * must therefore always exceed what a healthy adapter can legitimately spend.
 */
export function receiptProviderGateTimeoutMs(provider: EnabledReceiptProvider | null): number {
  const calls = provider === null ? 1 : PROVIDER_SEQUENTIAL_CALLS[provider];
  return RECEIPT_PROVIDER_TIMEOUT_MS * calls + GATE_OVERHEAD_MS;
}
export const RECEIPT_PROVIDER_PHASE1_MONTHLY_UNIT_CAP = 100 as const;
export const RECEIPT_PROVIDER_ALLOWED_DATA_CLASSES = ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as const;
export const RECEIPT_PROVIDER_PURPOSE = "RECEIPT_EXTRACTION" as const;

export type EnabledReceiptProvider = "gemini" | "veryfi";
/** `rescue` sends the provider only what local OCR could not settle; `always` sends every scan. */
export type ReceiptProviderRouting = "rescue" | "always";
/** `explicit` needs an owner tap per business profile; `automatic` grants by operator policy. */
export type ReceiptProviderConsentMode = "explicit" | "automatic";

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
  /** Per provider HTTP call; recorded in the request contract. */
  timeoutMs: typeof RECEIPT_PROVIDER_TIMEOUT_MS;
  /** Wall clock for the whole adapter call — see receiptProviderGateTimeoutMs. */
  gateTimeoutMs: number;
  resourceMonthlyUnitLimit: number;
  businessMonthlyUnitLimit: number | null;
  unitType: "DOCUMENT" | "PAGE" | null;
  routing: ReceiptProviderRouting;
  consentMode: ReceiptProviderConsentMode;
  operational: boolean;
}

function strictBoolean(value: string | undefined, safeDefault: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return safeDefault;
}

function strictRouting(value: string | undefined): ReceiptProviderRouting {
  return value === "always" ? "always" : "rescue";
}

function strictConsentMode(value: string | undefined): ReceiptProviderConsentMode {
  return value === "automatic" ? "automatic" : "explicit";
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
    gateTimeoutMs: receiptProviderGateTimeoutMs(provider),
    resourceMonthlyUnitLimit,
    businessMonthlyUnitLimit,
    unitType: details?.unitType ?? null,
    routing: strictRouting(source.RECEIPT_PROVIDER_ROUTING),
    consentMode: strictConsentMode(source.RECEIPT_PROVIDER_CONSENT_MODE),
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
