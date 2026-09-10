// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { BusinessProfileProvider, useBusinessProfiles } from "./BusinessProfileContext";
import { RequireBusinessProfile } from "../components/RequireBusinessProfile";
import type { BusinessProfile } from "../lib/types";

/**
 * "THE LIST IS EMPTY" AND "THE LIST DID NOT ARRIVE" ARE DIFFERENT FACTS.
 *
 * `refresh()` had no `catch`, so a failed GET /business-profiles left
 * `profiles` at `[]` — indistinguishable from a brand-new account. Everything
 * downstream reads that array, and RequireBusinessProfile reads it to decide
 * whether to redirect into the setup wizard. The result was that a dropped
 * request marched an owner with an established business into onboarding and
 * invited them to create a second one.
 *
 * The contract these lock down:
 *   - a failed load sets `error` and does NOT claim the owner has no business;
 *   - a successful load clears it, so a recovered connection recovers the app;
 *   - the onboarding redirect requires a SUCCESSFUL empty load.
 *
 * The mobile client fixed the same defect the same way; see
 * mobile/src/context/BusinessProfileContext.tsx.
 */

const get = vi.fn();

vi.mock("../lib/api", () => ({
  api: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));

vi.mock("./AuthContext", () => ({
  useAuth: () => ({ profile: { id: 7, firstName: "Ken" } }),
}));

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

function Probe() {
  const { profiles, loading, error } = useBusinessProfiles();
  return (
    <div>
      <span data-testid="count">{profiles.length}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? "none"}</span>
    </div>
  );
}

function mountProbe() {
  return render(
    <BusinessProfileProvider>
      <Probe />
    </BusinessProfileProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  window.localStorage.clear();
});

describe("BusinessProfileContext — a failed load is not an empty account", () => {
  it("surfaces the reason instead of reporting zero businesses", async () => {
    get.mockRejectedValue(new Error("Network Error"));

    mountProbe();

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("error")).toHaveTextContent("Network Error");
  });

  it("reports a genuinely empty account with no error", async () => {
    get.mockResolvedValue({ data: [] });

    mountProbe();

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });

  it("clears the error once the list arrives", async () => {
    get.mockResolvedValue({ data: [profile] });

    mountProbe();

    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
    expect(screen.getByTestId("error")).toHaveTextContent("none");
  });
});

describe("RequireBusinessProfile — the onboarding gate", () => {
  function mountGate() {
    return render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <BusinessProfileProvider>
          <Routes>
            <Route element={<RequireBusinessProfile />}>
              <Route path="/dashboard" element={<p>Dashboard</p>} />
            </Route>
            <Route path="/onboarding" element={<p>Setup wizard</p>} />
          </Routes>
        </BusinessProfileProvider>
      </MemoryRouter>,
    );
  }

  it("keeps an owner where they are when the list failed to load", async () => {
    get.mockRejectedValue(new Error("Network Error"));

    mountGate();

    await waitFor(() => expect(screen.getByText("Dashboard")).toBeInTheDocument());
    expect(screen.queryByText("Setup wizard")).not.toBeInTheDocument();
  });

  it("still sends a genuinely new owner into setup", async () => {
    get.mockResolvedValue({ data: [] });

    mountGate();

    await waitFor(() => expect(screen.getByText("Setup wizard")).toBeInTheDocument());
  });
});

describe("NoBusinessProfile — the retry path out of a failed load", () => {
  it("offers a retry rather than the setup invitation, and recovers", async () => {
    get.mockRejectedValueOnce(new Error("Network Error"));
    const { NoBusinessProfile } = await import("../components/NoBusinessProfile");

    render(
      <MemoryRouter>
        <BusinessProfileProvider>
          <NoBusinessProfile />
        </BusinessProfileProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("Your businesses didn't load")).toBeInTheDocument());
    // Never "finish setting up" — that is the message that tells an owner with
    // a business to create another one.
    expect(screen.queryByText("Finish setting up your business")).not.toBeInTheDocument();

    get.mockResolvedValue({ data: [profile] });
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() =>
      expect(screen.queryByText("Your businesses didn't load")).not.toBeInTheDocument(),
    );
  });
});
