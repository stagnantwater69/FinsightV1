// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MultiFileInput } from "./MultiFileInput";

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:fixture"; }
    static revokeObjectURL() {}
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function ControlledInput({ initial = [], onChange = () => {} }: { initial?: File[]; onChange?: (files: File[]) => void }) {
  const [files, setFiles] = useState(initial);
  return (
    <MultiFileInput
      id="files"
      files={files}
      onChange={(next) => {
        setFiles(next);
        onChange(next);
      }}
    />
  );
}

it.each([
  [new File([], "empty.png", { type: "image/png" }), /empty/],
  [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" }), /JPEG, PNG or WEBP/],
  [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }), /larger than 10 MiB/],
])("retains an invalid receipt file for correction", async (file, message) => {
  const user = userEvent.setup({ applyAccept: false });
  const onChange = vi.fn();
  render(<ControlledInput onChange={onChange} />);
  await user.upload(document.getElementById("files") as HTMLInputElement, file);
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.getByText(file.name)).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove page 1" })).toBeEnabled();
  expect(onChange).toHaveBeenCalledWith([file]);
});

it("retains duplicate file selection for correction", () => {
  const file = new File(["fixture"], "receipt.png", { type: "image/png", lastModified: 42 });
  const onChange = vi.fn();
  render(<ControlledInput initial={[file]} onChange={onChange} />);
  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, { dataTransfer: { files: [file] } });
  expect(screen.getByRole("alert")).toHaveTextContent(/already selected/);
  expect(screen.getByRole("button", { name: "Remove page 2" })).toBeEnabled();
  expect(onChange).toHaveBeenCalledWith([file, file]);
});

it("suppresses drops while disabled", () => {
  const file = new File(["fixture"], "receipt.png", { type: "image/png", lastModified: 42 });
  const onChange = vi.fn();
  render(<MultiFileInput id="files" files={[file]} onChange={onChange} disabled />);
  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, { dataTransfer: { files: [new File(["new"], "other.png", { type: "image/png" })] } });
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps the prior valid selection when an added photo exceeds a limit", () => {
  const selected = new File(["fixture"], "kept.png", { type: "image/png", lastModified: 42 });
  const tooLarge = {
    name: "too-large.png",
    type: "image/png",
    size: 10 * 1024 * 1024 + 1,
    lastModified: 43,
  } as File;
  const onChange = vi.fn();
  render(<ControlledInput initial={[selected]} onChange={onChange} />);

  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, {
    dataTransfer: { files: [tooLarge] },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(/larger than 10 MiB/);
  expect(screen.getByRole("img", { name: "Page 1" })).toBeVisible();
  expect(screen.getByText("too-large.png")).toBeVisible();
  expect(screen.getByText("Larger than 10 MiB")).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove page 2" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Remove page 1" })).toBeEnabled();
  expect(onChange).toHaveBeenCalledWith([selected, tooLarge]);
});

it("retains a ninth photo and asks the owner to remove it", () => {
  const selected = Array.from({ length: 8 }, (_, index) =>
    new File([String(index)], `page-${index + 1}.png`, { type: "image/png", lastModified: index }),
  );
  const ninth = new File(["9"], "page-9.png", { type: "image/png", lastModified: 9 });
  render(<ControlledInput initial={selected} />);

  fireEvent.drop(screen.getByText("Add more photos").closest("label")!, {
    dataTransfer: { files: [ninth] },
  });

  expect(screen.getByRole("alert")).toHaveTextContent("Remove 1 photo");
  expect(screen.getByRole("button", { name: "Remove page 9" })).toBeEnabled();
});
