import { beforeEach, describe, expect, it, vi } from "vitest";

const { info, warn } = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/config/logger", () => ({
  logger: { info, warn },
}));

import { securityEvent } from "../../src/lib/securityLog";

beforeEach(() => {
  info.mockReset();
  warn.mockReset();
});

describe("securityEvent severity", () => {
  it.each([
    "login.failed",
    "recovery.delivery_failed",
    "sessions.revoke_failed",
    "account.deletion_failed",
  ] as const)("logs %s at warning level", (event) => {
    securityEvent(event, { userId: 7 });

    expect(warn).toHaveBeenCalledWith(
      { securityEvent: event, userId: 7 },
      `security: ${event}`,
    );
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps successful revocation informational", () => {
    securityEvent("sessions.revoked", { userId: 7 });

    expect(info).toHaveBeenCalledWith(
      { securityEvent: "sessions.revoked", userId: 7 },
      "security: sessions.revoked",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
