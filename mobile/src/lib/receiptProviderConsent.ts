export type ReceiptProviderKey = "gemini" | "veryfi";
export type ReceiptProviderDataClass = "RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE";

export interface ReceiptProviderTerms {
  key: ReceiptProviderKey;
  label: string;
  version: string;
  region: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: readonly ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"];
  retentionHours: number;
  trainingAllowed: false;
  revocable: true;
}

export interface ActiveReceiptProviderConsent {
  reference: string;
  provider: ReceiptProviderKey;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: readonly ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"];
  region: string;
  retentionHours: number;
  trainingAllowed: false;
  grantedAt: string;
  revocable: true;
}

export interface ReceiptProviderConsentState {
  available: boolean;
  provider: ReceiptProviderTerms | null;
  consent: { reference: string; grantedAt: string; revokedAt: null } | null;
  activeConsents: ActiveReceiptProviderConsent[];
}

export interface ReceiptProviderConsentGrant {
  provider: ReceiptProviderKey;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"];
  region: string;
  retentionHours: number;
  trainingAllowed: false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerKey(value: unknown): ReceiptProviderKey | null {
  return value === "gemini" || value === "veryfi" ? value : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function retention(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 24
    ? Number(value)
    : null;
}

function exactDataClasses(value: unknown): value is ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] {
  return Array.isArray(value) &&
    value.length === 2 &&
    value[0] === "RECEIPT_IMAGE" &&
    value[1] === "DERIVED_RECEIPT_IMAGE";
}

function parseTerms(value: unknown): ReceiptProviderTerms | null {
  const input = record(value);
  if (!input) return null;
  const key = providerKey(input.key);
  const label = text(input.label, 120);
  const version = text(input.version, 96);
  const region = text(input.region, 64);
  const policyVersion = text(input.policyVersion, 64);
  const retentionHours = retention(input.retentionHours);
  if (!key || !label || !version || !region || !policyVersion || retentionHours === null ||
      input.purpose !== "RECEIPT_EXTRACTION" || !exactDataClasses(input.dataClasses) ||
      input.trainingAllowed !== false || input.revocable !== true) return null;
  return {
    key,
    label,
    version,
    region,
    policyVersion,
    purpose: "RECEIPT_EXTRACTION",
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    retentionHours,
    trainingAllowed: false,
    revocable: true,
  };
}

function parseActiveConsent(value: unknown): ActiveReceiptProviderConsent | null {
  const input = record(value);
  if (!input) return null;
  const provider = providerKey(input.provider);
  const reference = text(input.reference, 128);
  const policyVersion = text(input.policyVersion, 64);
  const region = text(input.region, 64);
  const grantedAt = text(input.grantedAt, 64);
  const retentionHours = retention(input.retentionHours);
  if (!provider || !reference || !policyVersion || !region || !grantedAt || retentionHours === null ||
      input.purpose !== "RECEIPT_EXTRACTION" || !exactDataClasses(input.dataClasses) ||
      input.trainingAllowed !== false || input.revocable !== true) return null;
  return {
    reference,
    provider,
    policyVersion,
    purpose: "RECEIPT_EXTRACTION",
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region,
    retentionHours,
    trainingAllowed: false,
    grantedAt,
    revocable: true,
  };
}

function parseCurrentConsent(value: unknown): ReceiptProviderConsentState["consent"] | undefined {
  if (value === null) return null;
  const input = record(value);
  if (!input) return undefined;
  const reference = text(input.reference, 128);
  const grantedAt = text(input.grantedAt, 64);
  if (!reference || !grantedAt || input.revokedAt !== null) return undefined;
  return { reference, grantedAt, revokedAt: null };
}

export function parseReceiptProviderConsentState(value: unknown): ReceiptProviderConsentState | null {
  const input = record(value);
  if (!input || typeof input.available !== "boolean" || !Array.isArray(input.activeConsents)) return null;
  const activeConsents = input.activeConsents.map(parseActiveConsent);
  if (activeConsents.some((consent) => consent === null)) return null;
  const consent = parseCurrentConsent(input.consent);
  if (consent === undefined) return null;

  if (!input.available) {
    if (input.provider !== null || consent !== null) return null;
    return { available: false, provider: null, consent: null, activeConsents: activeConsents as ActiveReceiptProviderConsent[] };
  }

  const provider = parseTerms(input.provider);
  if (!provider) return null;
  return {
    available: true,
    provider,
    consent,
    activeConsents: activeConsents as ActiveReceiptProviderConsent[],
  };
}

export function receiptProviderConsentGrant(terms: ReceiptProviderTerms): ReceiptProviderConsentGrant {
  return {
    provider: terms.key,
    policyVersion: terms.policyVersion,
    purpose: terms.purpose,
    dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
    region: terms.region,
    retentionHours: terms.retentionHours,
    trainingAllowed: false,
  };
}

export function sameReceiptProviderTerms(a: ReceiptProviderTerms, b: ReceiptProviderTerms): boolean {
  return a.key === b.key &&
    a.version === b.version &&
    a.region === b.region &&
    a.policyVersion === b.policyVersion &&
    a.purpose === b.purpose &&
    a.retentionHours === b.retentionHours &&
    a.trainingAllowed === b.trainingAllowed &&
    a.dataClasses[0] === b.dataClasses[0] &&
    a.dataClasses[1] === b.dataClasses[1];
}

export function receiptProviderName(provider: ReceiptProviderKey): string {
  return provider === "gemini" ? "Google Gemini" : "Veryfi";
}
