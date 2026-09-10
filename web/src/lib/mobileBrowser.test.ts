import { describe, expect, it } from "vitest";
import { isMobileUserAgent } from "./mobileBrowser";

/**
 * The one consumer is the "Open in the FinSight app" button on the email
 * confirmation screen, so the cases that matter are "a device that could have
 * the app" versus "a device where the deep link is a dead end".
 */
describe("isMobileUserAgent", () => {
  it("recognises phones and tablets that can hold the app", () => {
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ]) {
      expect(isMobileUserAgent(ua)).toBe(true);
    }
  });

  it("treats desktop browsers as unable to open the app", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    ]) {
      expect(isMobileUserAgent(ua, 0)).toBe(false);
    }
  });

  /*
   * iPadOS defaults to "request desktop site", so its UA is Safari-on-Mac
   * verbatim. Touch points are the only thing that separates it from an actual
   * Mac, which reports none.
   */
  it("still recognises an iPad claiming to be a Mac, by its touch points", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
    expect(isMobileUserAgent(ua, 5)).toBe(true);
    expect(isMobileUserAgent(ua, 0)).toBe(false);
  });

  it("answers no rather than guessing when there is no user agent", () => {
    expect(isMobileUserAgent("")).toBe(false);
  });
});
