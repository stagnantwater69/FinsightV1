import React, { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const business = vi.hoisted(() => ({
  selected: {
    availableFundsBaselineAt: "2026-10-04T01:00:00.000Z",
    availableFundsBaselineDate: "2026-10-04",
  },
  refresh: vi.fn(),
}));

vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => business,
}));

import {
  AvailableFundsBaselineChoice,
  useAvailableFundsBaselineChoice,
} from "../../src/components/AvailableFundsBaselineChoice";
import { ThemeProvider } from "../../src/context/ThemeContext";

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
    <View>
      <TextInput
        accessibilityLabel="Description"
        value={description}
        onChangeText={setDescription}
      />
      <AvailableFundsBaselineChoice choice={choice} />
      <Text testID="request">
        {choice.decision === null ? "" : JSON.stringify(choice.requestFields())}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Simulate recovery"
        onPress={() => void choice.absorb({ code })}
      >
        <Text>Simulate recovery</Text>
      </Pressable>
    </View>
  );
}

function Screen({ code, date }: { code?: RecoveryCode; date?: string }) {
  return (
    <ThemeProvider initialMode="light">
      <Harness code={code} date={date} />
    </ThemeProvider>
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
    const view = await render(<Screen code={code} />);
    const afterBalance = screen.getByRole("radio", { name: "No, apply it after the balance" });

    await fireEvent.changeText(screen.getByLabelText("Description"), "Coffee beans");
    await fireEvent.press(afterBalance);

    expect(screen.getByRole("radio", { name: "No, apply it after the balance" }).props.accessibilityState)
      .toMatchObject({ checked: true });
    expect(screen.getByTestId("request").props.children).toBe(JSON.stringify({
      includedInAvailableFundsBaseline: false,
      availableFundsBaselineAt: "2026-10-04T01:00:00.000Z",
    }));

    await fireEvent.press(screen.getByRole("button", { name: "Simulate recovery" }));
    await waitFor(() => expect(business.refresh).toHaveBeenCalledTimes(1));
    await view.rerender(<Screen code={code} />);

    expect(screen.getByLabelText("Description").props.value).toBe("Coffee beans");
    expect(screen.getByRole("radio", { name: "Yes, it was already included" }).props.accessibilityState)
      .toMatchObject({ checked: false });
    expect(screen.getByRole("radio", { name: "No, apply it after the balance" }).props.accessibilityState)
      .toMatchObject({ checked: false });
    expect(screen.getByRole("alert").props.children).toBe(
      "The recorded balance changed while this form was open. Choose again using the latest balance.",
    );
  });

  it("keeps a refresh failure visible when the server unexpectedly requires a decision", async () => {
    business.refresh.mockRejectedValueOnce(new Error("offline"));
    await render(
      <Screen
        code="AVAILABLE_FUNDS_BASELINE_CLASSIFICATION_REQUIRED"
        date="2026-10-03"
      />,
    );
    await fireEvent.changeText(screen.getByLabelText("Description"), "Coffee beans");

    await fireEvent.press(screen.getByRole("button", { name: "Simulate recovery" }));

    await waitFor(() => expect(screen.getByRole("alert").props.children).toBe(
      "The recorded balance changed, but its latest details could not be loaded. Try again before saving.",
    ));
    expect(screen.getByLabelText("Description").props.value).toBe("Coffee beans");
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
