// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MultiFileInput } from "./MultiFileInput";

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:fixture"; }
    static revokeObjectURL() {}
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  [new File([], "empty.png", { type: "image/png" }), /empty/],
  [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" }), /JPEG, PNG or WEBP/],
  [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }), /over 10MB/],
])("rejects an invalid receipt file without changing the selection", async (file, message) => {
  const user = userEvent.setup({ applyAccept: false });
  const onChange = vi.fn();
  render(<MultiFileInput id="files" files={[]} onChange={onChange} />);
  await user.upload(document.getElementById("files") as HTMLInputElement, file);
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(onChange).not.toHaveBeenCalled();
});

it("rejects duplicate file selection and suppresses drops while disabled", () => {
  const file = new File(["fixture"], "receipt.png", { type: "image/png", lastModified: 42 });
  const onChange = vi.fn();
  const view = render(<MultiFileInput id="files" files={[file]} onChange={onChange} />);
  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, { dataTransfer: { files: [file] } });
  expect(screen.getByRole("alert")).toHaveTextContent(/already selected/);
  view.rerender(<MultiFileInput id="files" files={[file]} onChange={onChange} disabled />);
  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, { dataTransfer: { files: [new File(["new"], "other.png", { type: "image/png" })] } });
  expect(onChange).not.toHaveBeenCalled();
});
