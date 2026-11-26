// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoneyInput } from "./Field";

/** A number field reads "1e3" as 1000 while still showing "1e3"; MoneyInput refuses the exponent keys. */

function renderMoney(onKeyDown?: () => void) {
  render(<MoneyInput aria-label="Amount" onKeyDown={onKeyDown} />);
  return screen.getByLabelText("Amount");
}

describe("MoneyInput exponent guard", () => {
  it.each(["e", "E", "+"])("refuses the %j key", (key) => {
    const input = renderMoney();
    expect(fireEvent.keyDown(input, { key })).toBe(false);
  });

  it.each(["1", "0", ".", "-", "Backspace", "Enter", "ArrowLeft", "Tab"])("lets %j through", (key) => {
    const input = renderMoney();
    expect(fireEvent.keyDown(input, { key })).toBe(true);
  });

  it.each([["1e3", false], ["2E-1", false], ["1e+3", false], ["1250.50", true], ["500", true]])("paste %j allowed=%s", (text, allowed) => {
    const input = renderMoney();
    expect(fireEvent.paste(input, { clipboardData: { getData: () => text } })).toBe(allowed);
  });

  it("still lets a call site supply its own key handler", () => {
    const own = vi.fn();
    const input = renderMoney(own);
    fireEvent.keyDown(input, { key: "e" });
    expect(own).toHaveBeenCalledTimes(1);
  });
});
