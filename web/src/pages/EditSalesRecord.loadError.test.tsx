// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EditSalesRecord } from "./EditSalesRecord";
import type { RecordItem } from "../lib/types";

/**
 * Same dead end as the expense edit screen: a sales reference that 404s or a
 * session that has lapsed must produce a message and a way on, not a loading
 * line that stays put.
 */

const RECORD = {
  id: 12,
  date: "2026-03-04T00:00:00.000Z",
  description: "Saturday takings",
  amount: 4300,
} as unknown as RecordItem;

let getImpl: (url: string) => Promise<{ data: unknown }>;

vi.mock("../lib/api", () => ({
  api: {
    get: (url: string) => getImpl(url),
    patch: async () => ({ data: null }),
  },
}));

vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/records/sales/12"]}>
      <Routes>
        <Route path="/records/sales/:id" element={<EditSalesRecord />} />
        <Route path="/records" element={<p>Records list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function rejection(status: number, message: string) {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    response: { status, data: { error: message } },
  });
}

describe("EditSalesRecord load failure", () => {
  it("names the failure and offers a retry instead of loading forever", async () => {
    getImpl = () => Promise.reject(rejection(404, "Record not found"));
    renderPage();

    expect(await screen.findByText(/couldn't load this sales reference/i)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("loads the form when the retry succeeds", async () => {
    let attempts = 0;
    getImpl = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(rejection(403, "Your session has expired."))
        : Promise.resolve({ data: RECORD });
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Saturday takings")).toBeTruthy());
  });

  it("offers a route back to the records list", async () => {
    getImpl = () => Promise.reject(rejection(404, "Record not found"));
    renderPage();

    await userEvent.click(await screen.findByRole("link", { name: /back to records/i }));
    expect(screen.getByText("Records list")).toBeTruthy();
  });

  it("ignores a response that lands after the page is gone", async () => {
    let settle: (() => void) | null = null;
    getImpl = () =>
      new Promise((_resolve, reject) => {
        settle = () => reject(rejection(404, "Record not found"));
      });
    const view = renderPage();
    view.unmount();

    settle!();
    await Promise.resolve();
    expect(screen.queryByText(/couldn't load this sales reference/i)).toBeNull();
  });
});
