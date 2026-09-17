// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { EditExpense } from "./EditExpense";
import type { RecordDetail } from "../lib/types";

/**
 * The edit screen when the record cannot be read.
 *
 * A record deleted from another tab answers 404, and a lapsed session answers
 * 403. Either way the page has to say so and offer a way on, rather than
 * leaving the owner on a loading line that never resolves.
 */

const RECORD = {
  id: 7,
  date: "2026-03-04T00:00:00.000Z",
  description: "Rice sack",
  vendor: "Puregold",
  amount: 1250,
  categoryId: 3,
  origin: null,
} as unknown as RecordDetail;

let getImpl: (url: string) => Promise<{ data: unknown }>;
const patchCalls: { url: string; body: unknown }[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: (url: string) => getImpl(url),
    patch: async (url: string, body: unknown) => {
      patchCalls.push({ url, body });
      return { data: null };
    },
  },
}));

vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/CategorySelect", () => ({
  CategorySelect: () => <select aria-label="Category" />,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/records/expenses/7"]}>
      <Routes>
        <Route path="/records/expenses/:id" element={<EditExpense />} />
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

describe("EditExpense load failure", () => {
  beforeEach(() => {
    patchCalls.length = 0;
  });

  it("names the failure and offers a retry instead of loading forever", async () => {
    getImpl = () => Promise.reject(rejection(404, "Record not found"));
    renderPage();

    expect(await screen.findByText(/couldn't load this expense/i)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByDisplayValue("Rice sack")).toBeTruthy());
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
    expect(screen.queryByText(/couldn't load this expense/i)).toBeNull();
  });
});
