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
