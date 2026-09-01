import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react-native";

/**
 * The three states `ReceiptCamera` can show while ML Kit is the only capture
 * path on Android — see `src/components/receipt-camera/ScannerStatusStates.tsx`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. These mount real React trees and
 * query them the way a screen reader or a test runner's role query would, so
 * "the retry button is actually reachable and actually fires" is genuine
 * evidence, not a source-text guess. What it cannot prove — because nothing
 * here touches Nitro, Google Play Services or a camera sensor — is that ML
 * Kit itself launches, captures or returns pages correctly. That remains
 * physical-device-only; see docs/mobile-camera-verification-checklist.md.
 */

const { ScannerLaunchingState, ScannerUnsupportedState, ScannerFailureState } = await import(
  "../../src/components/receipt-camera/ScannerStatusStates"
);
const { ThemeProvider } = await import("../../src/context/ThemeContext");

function withTheme(node: React.ReactNode) {
  return <ThemeProvider initialMode="light">{node}</ThemeProvider>;
}

describe("ScannerLaunchingState", () => {
  it("announces itself as a progress state, not silence, while ML Kit opens", async () => {
    const queries = await render(withTheme(<ScannerLaunchingState />));
    expect(queries.getByRole("progressbar", { name: "Opening the automatic receipt scanner" })).toBeTruthy();
  });
});

describe("ScannerUnsupportedState", () => {
  it("says a native build is required and offers only a way back — no camera, no gallery button", async () => {
    const onCancel = vi.fn();
    const queries = await render(withTheme(<ScannerUnsupportedState onCancel={onCancel} />));

    expect(queries.getByText("A native FinSight build is required")).toBeTruthy();
    // Nothing in this state should offer to open a camera or a gallery picker
    // directly — those live on the screen behind it as separate, explicitly
    // chosen actions. This state's only affordance is leaving it.
    expect(queries.queryByRole("button", { name: /gallery/i })).toBeNull();
    expect(queries.queryByRole("button", { name: /camera/i })).toBeNull();

    fireEvent.press(queries.getByRole("button", { name: "Go back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ScannerFailureState", () => {
  it("states what failed and offers exactly Retry scanner and Go back", async () => {
    const onRetry = vi.fn();
    const onGoBack = vi.fn();
    const queries = await render(
      withTheme(
        <ScannerFailureState
          message="The document scanner returned no receipt pages."
          onRetry={onRetry}
          onGoBack={onGoBack}
        />,
      ),
    );

    expect(queries.getByText("The document scanner returned no receipt pages.")).toBeTruthy();

    fireEvent.press(queries.getByRole("button", { name: "Retry scanner" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.press(queries.getByRole("button", { name: "Go back" }));
    expect(onGoBack).toHaveBeenCalledTimes(1);

    // The same failure never opens a different capture implementation — there
    // is no button here that could do that.
    expect(queries.queryByRole("button", { name: /camera/i })).toBeNull();
  });
});
