// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeInput, CodeResend } from "./CodeInput";
import { Field } from "./Field";

function CodeField({ disabled = false, error }: { disabled?: boolean; error?: string }) {
  const [value, setValue] = useState("");
  return (
    <Field label="Recovery code" hint="Use the code from your email." error={error}>
      <CodeInput value={value} onChange={(event) => setValue(event.target.value)} disabled={disabled} />
    </Field>
  );
}

describe("segmented code entry", () => {
  it("provides one labelled autofill input and six decorative cells", () => {
    const { container } = render(<CodeField />);
    const input = screen.getByRole("textbox", { name: "Recovery code" });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAccessibleDescription("Use the code from your email.");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(container.querySelectorAll(".code-input__cell")).toHaveLength(6);
    expect(container.querySelector(".code-input__cells")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps leading zeroes and native selection, replacement, and deletion", async () => {
    const user = userEvent.setup();
    render(<CodeField />);
    const input = screen.getByRole("textbox", { name: "Recovery code" }) as HTMLInputElement;
    await user.type(input, "082450");
    expect(input).toHaveValue("082450");
    input.setSelectionRange(2, 3);
    await user.keyboard("7");
    expect(input).toHaveValue("087450");
    await user.keyboard("{End}{Backspace}");
    expect(input).toHaveValue("08745");
  });

  it.each([
    ["08 2450", "082450"],
    ["0753-2474", "07532474"],
    ["01234 56789", "0123456789"],
    ["01234567890", "01234567890"],
    ["012a-45", "012a45"],
  ])("shows the complete pasted value %s without hiding invalid characters", async (raw, displayed) => {
    const user = userEvent.setup();
    const { container } = render(<CodeField />);
    const input = screen.getByRole("textbox", { name: "Recovery code" });
    await user.click(input);
    await user.paste(raw);
    expect(input).toHaveValue(raw);
    expect(container.querySelector(".code-input__cells")).toHaveTextContent(displayed);
    expect(container.querySelectorAll(".code-input__cell")).toHaveLength(displayed.length);
  });

  it("keeps validation linked to the input and prevents disabled edits", async () => {
    const user = userEvent.setup();
    render(<CodeField error="The code is digits only." disabled />);
    const input = screen.getByRole("textbox", { name: "Recovery code" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Use the code from your email. The code is digits only.");
    expect(input).toBeDisabled();
    await user.type(input, "824540");
    expect(input).toHaveValue("");
  });

  it("resends only when the cooldown and pending states allow it", () => {
    const onResend = vi.fn();
    const { rerender } = render(<CodeResend remaining={20} sending={false} disabled={false} onResend={onResend} />);
    fireEvent.click(screen.getByRole("button", { name: "Resend code in 20s" }));
    expect(onResend).not.toHaveBeenCalled();
    rerender(<CodeResend remaining={0} sending disabled={false} onResend={onResend} />);
    expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    rerender(<CodeResend remaining={0} sending={false} disabled={false} onResend={onResend} />);
    fireEvent.click(screen.getByRole("button", { name: "Get another code" }));
    expect(onResend).toHaveBeenCalledOnce();
  });
});
