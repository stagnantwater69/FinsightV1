// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ResultDetails } from "./ResultDetails";
import { ReceiptResultNotes } from "../pages/scanReceipt/ReceiptResultNotes";

describe("optional result details", () => {
  it("supports keyboard expansion and collapse without losing focus", async () => {
    const user = userEvent.setup();
    render(<ResultDetails label="Extraction evidence"><p>Printed total was difficult to read.</p></ResultDetails>);
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Extraction evidence" })).not.toBeInTheDocument();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "Extraction evidence" })).toBeVisible();
    expect(toggle).toHaveAttribute("aria-controls", screen.getByRole("region").id);
    await user.keyboard(" ");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps required guidance visible and groups optional scan evidence", async () => {
    const user = userEvent.setup();
    render(<ReceiptResultNotes warnings={[
      { code: "AMBIGUOUS_DATE", guidance: "Check the date before saving.", detail: "03/04 has two readings." },
      { code: "LOW_CONFIDENCE", guidance: "Check unclear values.", detail: "Faded receipt text." },
    ]} />);
    expect(screen.getByText("Check the date before saving.")).toBeVisible();
    expect(screen.getByText("Faded receipt text.")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Faded receipt text.")).toBeVisible();
    expect(screen.getByText("03/04 has two readings.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getByText("Check the date before saving.")).toBeVisible();
  });
});
