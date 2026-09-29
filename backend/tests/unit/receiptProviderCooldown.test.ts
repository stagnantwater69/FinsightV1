import { describe, expect, it } from "vitest";
import {
  evaluateReceiptProviderCooldown,
  RECEIPT_PROVIDER_AUTH_COOLDOWN_MS,
  RECEIPT_PROVIDER_COOLDOWN_MS,
} from "../../src/services/receiptProviderDispatch.service";

const now = new Date("2026-09-28T12:00:00.000Z");

function failure(outcomeCode: string, ageMs = 0) {
  return { outcomeCode, completedAt: new Date(now.getTime() - ageMs) };
}

describe("receipt provider cooldown policy", () => {
  it("opens immediately for authentication failures", () => {
    const cooldown = evaluateReceiptProviderCooldown([failure("AUTH_ERROR")], now);

    expect(cooldown).toEqual({
      reasonCode: "AUTH_ERROR",
      failureCount: 1,
      retryAt: new Date(now.getTime() + RECEIPT_PROVIDER_AUTH_COOLDOWN_MS),
    });
  });

  it("opens immediately for rate limits", () => {
    const cooldown = evaluateReceiptProviderCooldown([failure("RATE_LIMITED")], now);

    expect(cooldown).toEqual({
      reasonCode: "RATE_LIMITED",
      failureCount: 1,
      retryAt: new Date(now.getTime() + RECEIPT_PROVIDER_COOLDOWN_MS),
    });
  });

  it("honors a persisted Retry-After beyond the default cooldown", () => {
    const providerRetryAt = new Date(now.getTime() + 5 * 60 * 1000);
    const cooldown = evaluateReceiptProviderCooldown([
      { ...failure("RATE_LIMITED"), providerRetryAt },
    ], new Date(now.getTime() + RECEIPT_PROVIDER_COOLDOWN_MS + 1));

    expect(cooldown?.retryAt).toEqual(providerRetryAt);
  });

  it("requires three consecutive transient failures", () => {
    expect(evaluateReceiptProviderCooldown([
      failure("PROVIDER_SERVER_ERROR"),
      failure("TRANSPORT_ERROR", 1_000),
    ], now)).toBeNull();

    expect(evaluateReceiptProviderCooldown([
      failure("PROVIDER_SERVER_ERROR"),
      failure("TRANSPORT_ERROR", 1_000),
      failure("TIMEOUT_AFTER_SUBMISSION", 2_000),
    ], now)).toMatchObject({ reasonCode: "PROVIDER_SERVER_ERROR", failureCount: 3 });
  });

  it("a success breaks the consecutive failure run", () => {
    expect(evaluateReceiptProviderCooldown([
      failure("PROVIDER_SERVER_ERROR"),
      failure("OK", 1_000),
      failure("TRANSPORT_ERROR", 2_000),
    ], now)).toBeNull();
  });

  it("a newer success clears an older persisted Retry-After outside the transient window", () => {
    expect(evaluateReceiptProviderCooldown([
      failure("OK", 8 * 60 * 1000),
      {
        ...failure("RATE_LIMITED", 20 * 60 * 1000),
        providerRetryAt: new Date(now.getTime() + 4 * 60 * 1000),
      },
    ], now)).toBeNull();
  });

  it("does not reopen from an expired or non-retryable failure", () => {
    expect(evaluateReceiptProviderCooldown([
      failure("RATE_LIMITED", RECEIPT_PROVIDER_COOLDOWN_MS + 1),
    ], now)).toBeNull();
    expect(evaluateReceiptProviderCooldown([failure("INVALID_RESULT")], now)).toBeNull();
  });
});
