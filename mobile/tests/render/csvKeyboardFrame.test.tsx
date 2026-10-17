import React from "react";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { act, render } from "@testing-library/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { Keyboard, Platform, StyleSheet, Text, type KeyboardEvent, type KeyboardEventName } from "react-native";
import { CsvKeyboardFrame } from "../../src/screens/records/importCsv/CsvKeyboardFrame";

const originalPlatform = Object.getOwnPropertyDescriptor(Platform, "OS")!;
afterEach(() => {
  Object.defineProperty(Platform, "OS", originalPlatform);
  vi.restoreAllMocks();
});

function keyboardProps(q: Awaited<ReturnType<typeof render>>) {
  let fiber = q.getByText("CSV editor").unstable_fiber;
  while (fiber && !("keyboardVerticalOffset" in (fiber.memoizedProps ?? {}))) fiber = fiber.return;
  if (!fiber) throw new Error("CSV editor has no keyboard frame");
  return fiber.stateNode?.props ?? fiber.memoizedProps;
}

function measurement(q: Awaited<ReturnType<typeof render>>) {
  let fiber = q.getByTestId("csv-keyboard-frame").unstable_fiber;
  while (fiber && typeof fiber.stateNode?.measureInWindow !== "function") fiber = fiber.return;
  if (!fiber) throw new Error("CSV frame has no native measurement ref");
  return vi.mocked(fiber.stateNode.measureInWindow);
}

it("uses measured Android keyboard overlap and removes padding after system resize or keyboard dismissal", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
  const listeners = new Map<KeyboardEventName, Array<(event: KeyboardEvent) => void>>();
  const removals: Array<MockInstance<ReturnType<typeof Keyboard.addListener>["remove"]>> = [];
  vi.spyOn(Keyboard, "metrics").mockReturnValue(undefined);
  const addListener = Keyboard.addListener.bind(Keyboard);
  vi.spyOn(Keyboard, "addListener").mockImplementation((event, listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    const subscription = addListener(event, listener);
    removals.push(vi.spyOn(subscription, "remove"));
    return subscription;
  });
  const q = await render(<CsvKeyboardFrame><Text>CSV editor</Text></CsvKeyboardFrame>);
  let height = 700;
  measurement(q).mockImplementation((callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 70, 390, height));
  const event: KeyboardEvent = {
    duration: 250,
    easing: "keyboard",
    startCoordinates: { screenX: 0, screenY: 800, width: 390, height: 350 },
    endCoordinates: { screenX: 0, screenY: 450, width: 390, height: 350 },
  };
  await act(() => { for (const listener of listeners.get("keyboardDidShow") ?? []) listener(event); });
  expect(StyleSheet.flatten(keyboardProps(q).style).paddingBottom).toBe(320);
  expect(keyboardProps(q).behavior).toBeUndefined();
  height = 380;
  await act(() => q.getByTestId("csv-keyboard-frame").props.onLayout());
  expect(StyleSheet.flatten(keyboardProps(q).style).paddingBottom).toBe(0);
  height = 700;
  await act(() => q.getByTestId("csv-keyboard-frame").props.onLayout());
  expect(StyleSheet.flatten(keyboardProps(q).style).paddingBottom).toBe(320);
  await act(() => { for (const listener of listeners.get("keyboardDidHide") ?? []) listener(event); });
  expect(StyleSheet.flatten(keyboardProps(q).style).paddingBottom).toBe(0);
  expect(removals.length).toBeGreaterThanOrEqual(2);
  await q.unmount();
  expect(removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
});

it("uses the iOS native header height as the keyboard offset", async () => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  const q = await render(<HeaderHeightContext.Provider value={96}><CsvKeyboardFrame><Text>CSV editor</Text></CsvKeyboardFrame></HeaderHeightContext.Provider>);
  expect(keyboardProps(q).behavior).toBe("padding");
  expect(keyboardProps(q).keyboardVerticalOffset).toBe(96);
  expect(StyleSheet.flatten(keyboardProps(q).style).paddingBottom).toBe(0);
});
