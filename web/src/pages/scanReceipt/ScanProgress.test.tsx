// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ScanProgress } from "./ScanProgress";

it("uses the shared check icon for completed scan stages", () => {
  render(<ScanProgress stage="reading" />);

  const completedStep = screen.getByText("Uploading").closest("li");
  const activeStep = screen.getByText("Reading text").closest("li");

  expect(completedStep?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(completedStep).toHaveTextContent("done");
  expect(completedStep).not.toHaveTextContent("✓");
  expect(activeStep?.querySelector('svg[aria-hidden="true"]')).toBeNull();
  expect(activeStep).toHaveTextContent("in progress");
});

it("shows the photo's early reading as provisional, with nothing to act on", () => {
  render(<ScanProgress stage="reading" earlyReading={{ date: "2026-09-01", vendor: "LOCAL STORE", amount: 1250.5 }} />);

  const early = screen.getByRole("region", { name: "Early reading" });
  expect(early).toHaveTextContent("LOCAL STORE");
  expect(early).toHaveTextContent("2026-09-01");
  expect(early).toHaveTextContent("1,250.50");
  expect(early).toHaveTextContent("These can change before you review them.");
  expect(early.querySelector("button, a, input")).toBeNull();
});

it("says which fields the photo has not given up yet", () => {
  render(<ScanProgress stage="reading" earlyReading={{ date: null, vendor: null, amount: 99 }} />);

  expect(screen.getAllByText("Not read yet")).toHaveLength(2);
});

it("keeps the placeholder while there is no early reading", () => {
  render(<ScanProgress stage="reading" />);

  expect(screen.queryByRole("region", { name: "Early reading" })).toBeNull();
});
