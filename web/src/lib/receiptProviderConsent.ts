/**
 * The receipt provider consent contract as the client consumes it.
 *
 * Shared names with mobile/src/lib/receiptProviderConsent.ts so
 * scripts/check-type-parity.mjs can hold the two in step. The endpoint is
 * GET/PUT/DELETE /records/receipts/provider-consent/:businessProfileId.
 */

export type ReceiptProviderKey = "gemini" | "veryfi";
export type ReceiptProviderDataClass = "RECEIPT_IMAGE" | "DERIVED_RECEIPT_IMAGE";

export interface ReceiptProviderTerms {
  key: ReceiptProviderKey;
  label: string;
  version: string;
  region: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: ReceiptProviderDataClass[];
  retentionHours: number;
  trainingAllowed: false;
  revocable: true;
}

export interface ActiveReceiptProviderConsent {
  reference: string;
  provider: string;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: ReceiptProviderDataClass[];
  region: string;
  retentionHours: number;
  trainingAllowed: boolean;
  grantedAt: string;
  revocable: true;
}

/**
 * "explicit": the owner grants from this page. "automatic": operator policy
 * grants on the server and the page has nothing to ask.
 */
export type ReceiptProviderConsentMode = "explicit" | "automatic";

export interface ReceiptProviderConsentState {
  available: boolean;
  /** Absent on older servers; treated as "explicit". */
  mode?: ReceiptProviderConsentMode;
  provider: ReceiptProviderTerms | null;
  consent: { reference: string; grantedAt: string; revokedAt: string | null } | null;
  activeConsents: ActiveReceiptProviderConsent[];
  /**
   * True in automatic mode when an owner revoke with nothing open afterwards
   * keeps policy from granting again. Absent on older servers.
   */
  policyBlocked?: boolean;
}

/** The PUT body; every value is copied from the terms the server offered. */
export interface ReceiptProviderConsentGrant {
  provider: ReceiptProviderKey;
  policyVersion: string;
  purpose: "RECEIPT_EXTRACTION";
  dataClasses: ReceiptProviderDataClass[];
  region: string;
  retentionHours: number;
  trainingAllowed: false;
}
