// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeResend } from "./useCodeResend";

const post = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { post } }));

beforeEach(() => { post.mockReset().mockResolvedValue({ data: {} }); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("email code resend", () => {
  it("blocks repeat delivery during the signup cooldown and counts down", async () => {
    const { result } = renderHook(() => useCodeResend("/auth/resend-verification", true));
    expect(result.current.remaining).toBe(60);
    await act(async () => { await result.current.resend("owner@shop.ph"); });
    expect(post).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.remaining).toBe(59);
  });

  it("sends an eligible address with explicit web platform and neutral success copy", async () => {
    const { result } = renderHook(() => useCodeResend("/auth/recover-password"));
    await act(async () => { await result.current.resend("owner@shop.ph"); });
    expect(post).toHaveBeenCalledWith("/auth/recover-password", { email: "owner@shop.ph", platform: "web" });
    expect(result.current.message).toMatch(/^If this address is eligible/);
    expect(result.current.remaining).toBe(60);
    await act(async () => { await result.current.resend("owner@shop.ph"); });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("validates the email before requesting delivery", async () => {
    const { result } = renderHook(() => useCodeResend("/auth/resend-verification"));
    await act(async () => { await result.current.resend("bad-address"); });
    expect(post).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/valid email address/);
    expect(result.current.remaining).toBe(0);
  });

  it("re-enables retry after a failed request without claiming a code was sent", async () => {
    post.mockRejectedValueOnce(new Error("Too many requests. Try again later."));
    const { result } = renderHook(() => useCodeResend("/auth/recover-password"));
    await act(async () => { await result.current.resend("owner@shop.ph"); });
    expect(result.current.message).toBeNull();
    expect(result.current.error).toMatch(/Too many requests/);
    expect(result.current.sending).toBe(false);
    expect(result.current.remaining).toBe(0);
  });
});
