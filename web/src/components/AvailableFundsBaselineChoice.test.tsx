// @vitest-environment jsdom
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const business = vi.hoisted(() => ({
  selected: {
    availableFundsBaselineAt: "2026-10-04T01:00:00.000Z",
    availableFundsBaselineDate: "2026-10-04",
  },
  refresh: vi.fn(),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => business,
}));

import {
  AvailableFundsBaselineChoice,
  useAvailableFundsBaselineChoice,
} from "./AvailableFundsBaselineChoice";

type RecoveryCode = "AVAILABLE_FUNDS_BASELINE_CHANGED" | "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED";

function Harness({
  code = "AVAILABLE_FUNDS_BASELINE_CHANGED",
  date = "2026-10-04",
}: {
  code?: RecoveryCode;
  date?: string;
}) {
  const [description, setDescription] = useState("");
  const choice = useAvailableFundsBaselineChoice(date);
  return (
    <>
      <label>
        Description
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <AvailableFundsBaselineChoice choice={choice} />
      <output data-testid="request">
        {choice.decision === null ? "" : JSON.stringify(choice.requestFields())}
      </output>
      <button
        type="button"
        onClick={() => void choice.absorb({ code })}
      >
        Simulate recovery
      </button>
    </>
  );
}

beforeEach(() => {
  business.selected = {
    availableFundsBaselineAt: "2026-10-04T01:00:00.000Z",
    availableFundsBaselineDate: "2026-10-04",
  };
  business.refresh.mockReset().mockImplementation(async () => {
    business.selected = {
      availableFundsBaselineAt: "2026-10-04T02:00:00.000Z",
      availableFundsBaselineDate: "2026-10-04",
    };
  });
});

describe("available-funds baseline choice", () => {
  it.each([
    "AVAILABLE_FUNDS_BASELINE_CHANGED",
    "AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED",
  ] as const)("keeps form input while %s clears only the accessible choice", async (code) => {
    const user = userEvent.setup();
    const view = render(<Harness code={code} />);

    expect(screen.getByRole("radiogroup", { name: "Recorded balance inclusion" })).toBeInTheDocument();
    const included = screen.getByRole("radio", { name: "Yes, it was already included" });
    const afterBalance = screen.getByRole("radio", { name: "No, apply it after the balance" });
    await user.type(screen.getByLabelText("Description"), "Coffee beans");
    await user.click(afterBalance);

    expect(afterBalance).toBeChecked();
    expect(screen.getByTestId("request")).toHaveTextContent(JSON.stringify({
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: "2026-10-04T01:00:00.000Z",
    }));

    await user.click(screen.getByRole("button", { name: "Simulate recovery" }));
    await waitFor(() => expect(business.refresh).toHaveBeenCalledTimes(1));
    view.rerender(<Harness code={code} />);

    expect(screen.getByLabelText("Description")).toHaveValue("Coffee beans");
    expect(included).not.toBeChecked();
    expect(afterBalance).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The recorded balance changed while this form was open. Choose again using the latest balance.",
    );
  });

  it("keeps a refresh failure visible when the server unexpectedly requires a decision", async () => {
    business.refresh.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<Harness code="AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED" date="2026-10-03" />);
    await user.type(screen.getByLabelText("Description"), "Coffee beans");

    await user.click(screen.getByRole("button", { name: "Simulate recovery" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The recorded balance changed, but its latest details could not be loaded. Try again before saving.",
    );
    expect(screen.getByLabelText("Description")).toHaveValue("Coffee beans");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
