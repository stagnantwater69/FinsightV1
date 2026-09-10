import { describe, expect, it } from "vitest";
import { humanRetryAfter } from "../../src/middleware/rateLimit.middleware";

/**
 * The 429 body is read by a shop owner, not a developer. It used to say
 * "Please wait about 2275 seconds and try again" — arithmetic homework in an
 * error message, on the hour-long auth buckets where it matters most.
 */
describe("humanRetryAfter", () => {
  it("keeps sub-minute waits in seconds", () => {
    expect(humanRetryAfter(1)).toBe("1 second");
    expect(humanRetryAfter(45)).toBe("45 seconds");
    expect(humanRetryAfter(59)).toBe("59 seconds");
  });

  it("switches to minutes at a minute", () => {
    expect(humanRetryAfter(60)).toBe("1 minute");
    expect(humanRetryAfter(90)).toBe("2 minutes");
    expect(humanRetryAfter(600)).toBe("10 minutes");
  });

  it("states the reported case in minutes", () => {
    // The exact number from the screenshot that prompted this.
    expect(humanRetryAfter(2275)).toBe("38 minutes");
  });

  it("switches to hours at an hour", () => {
    expect(humanRetryAfter(3600)).toBe("1 hour");
  });

  /**
   * Rounded UP, never down: a message that promises a shorter wait than the
   * bucket actually holds sends the owner back to a second refusal, which
   * reads as the product lying to them.
   */
  it("never promises a shorter wait than the bucket holds", () => {
    for (let s = 1; s <= 3600; s++) {
      const text = humanRetryAfter(s);
      const [n, unit] = text.split(" ");
      const promisedSeconds =
        unit.startsWith("second") ? Number(n) : unit.startsWith("minute") ? Number(n) * 60 : Number(n) * 3600;
      expect(promisedSeconds, `${s}s rendered as "${text}"`).toBeGreaterThanOrEqual(s);
    }
  });

  it("never renders a bare unit without a number, or a plural '1'", () => {
    for (const s of [1, 2, 59, 60, 61, 119, 120, 3599, 3600]) {
      const text = humanRetryAfter(s);
      expect(text).toMatch(/^\d+ (second|minute|hour)s?$/);
      expect(text).not.toMatch(/^1 \w+s$/);
    }
  });
});
