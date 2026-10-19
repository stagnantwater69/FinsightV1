// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { dismissTip, isNewAccount, NEW_ACCOUNT_DAYS, readDismissedTips } from "./pageTips";

const DAY = 24 * 60 * 60 * 1000;

describe("page tip storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps dismissals per user", () => {
    dismissTip(1, "csv-import");
    expect(readDismissedTips(1)).toEqual(["csv-import"]);
    expect(readDismissedTips(2)).toEqual([]);
  });

  it("does not store a dismissal twice", () => {
    dismissTip(1, "csv-import");
    dismissTip(1, "csv-import");
    expect(readDismissedTips(1)).toEqual(["csv-import"]);
  });

  it("reads corrupt storage as nothing dismissed", () => {
    window.localStorage.setItem("finsight.tips.1", "{not json");
    expect(readDismissedTips(1)).toEqual([]);
    window.localStorage.setItem("finsight.tips.1", JSON.stringify({ a: 1 }));
    expect(readDismissedTips(1)).toEqual([]);
  });
});

describe("which accounts get tips", () => {
  const now = Date.parse("2026-10-19T00:00:00Z");

  it("includes accounts inside the window and excludes older ones", () => {
    expect(isNewAccount(new Date(now - 2 * DAY).toISOString(), now)).toBe(true);
    expect(isNewAccount(new Date(now - NEW_ACCOUNT_DAYS * DAY).toISOString(), now)).toBe(true);
    expect(isNewAccount(new Date(now - (NEW_ACCOUNT_DAYS + 1) * DAY).toISOString(), now)).toBe(false);
  });

  it("shows nothing when the sign-up date is missing or unreadable", () => {
    expect(isNewAccount(undefined, now)).toBe(false);
    expect(isNewAccount("not a date", now)).toBe(false);
  });
});
