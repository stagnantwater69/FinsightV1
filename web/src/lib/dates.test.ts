/**
 * QA register FUN-005 — the reported failure, reproduced.
 *
 * `TZ=Asia/Manila` plus an instant that is still "yesterday" in UTC is exactly
 * the case an owner hit: 02:30 on 20 August in Manila is 18:30 on 19 August in
 * UTC, so `toISOString().slice(0, 10)` returned `2026-08-19` and every form
 * defaulted a day early.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayIso, toLocalIsoDate } from "./dates";

/*
 * `src` is compiled with `types: ["vite/client"]` and no node types, so
 * `process` is not declared here. Only `env` is needed, and only to reproduce
 * the reported bug's timezone — the shipped code never touches it.
 */
declare const process: { env: Record<string, string | undefined> };

/** 2026-08-19T18:30:00Z === 2026-08-20 02:30 in Manila (UTC+8). */
const EARLY_MORNING_MANILA = new Date("2026-08-19T18:30:00.000Z");

describe("toLocalIsoDate", () => {
  it("returns the local calendar date, not the UTC one", () => {
    // The environment's own zone is whatever the test runner is set to, so the
    // zone is passed explicitly here; the process-level TZ case is below.
    expect(toLocalIsoDate(EARLY_MORNING_MANILA, "Asia/Manila")).toBe("2026-08-20");
    expect(EARLY_MORNING_MANILA.toISOString().slice(0, 10)).toBe("2026-08-19");
  });

  it("agrees with UTC when the zone is UTC", () => {
    expect(toLocalIsoDate(EARLY_MORNING_MANILA, "UTC")).toBe("2026-08-19");
  });

  it("pads single-digit months and days", () => {
    expect(toLocalIsoDate(new Date("2026-01-05T12:00:00.000Z"), "UTC")).toBe("2026-01-05");
  });

  it("handles a zone behind UTC, where the local date can be the earlier one", () => {
    // 2026-08-20T02:30Z is still 19 August in Los Angeles (UTC-7).
    expect(toLocalIsoDate(new Date("2026-08-20T02:30:00.000Z"), "America/Los_Angeles")).toBe(
      "2026-08-19",
    );
  });
});

describe("todayIso under TZ=Asia/Manila", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Node re-reads TZ when the zone cache is invalidated, which assigning it
    // does; `vi.setSystemTime` then pins the instant.
    process.env.TZ = "Asia/Manila";
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_MORNING_MANILA);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTz;
  });

  it("gives the owner's calendar date at 02:30 local, not yesterday's UTC date", () => {
    expect(new Date().getHours()).toBe(2); // sanity: the process really is on Manila time
    expect(todayIso()).toBe("2026-08-20");
  });

  it("is the date a <input type=\"date\"> default would show", () => {
    expect(todayIso()).not.toBe(new Date().toISOString().slice(0, 10));
  });
});
