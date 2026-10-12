// @vitest-environment jsdom
import { lazy, type ComponentType, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedLayout } from "./AuthenticatedLayout";

vi.mock("./ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/BusinessProfileContext", () => ({
  BusinessProfileProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./BusinessOwnedBoundary", () => ({
  BusinessOwnedBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  ExpenseCategoryProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/NotificationContext", () => ({
  NotificationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/ReportingPeriodContext", () => ({
  ReportingPeriodProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/TourContext", () => ({
  TourProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/AiChatContext", () => ({
  AiChatProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/FutureDatedRecordsContext", () => ({
  FutureDatedRecordsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./FutureDateGate", () => ({
  FutureDateGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./RequireBusinessProfile", () => ({ RequireBusinessProfile: Outlet }));
vi.mock("./AskFinSightDrawer", () => ({ AskFinSightDrawer: () => null }));
vi.mock("./AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div>
      <aside aria-label="Persistent sidebar">Navigation</aside>
      <header>Persistent top bar</header>
      <main>{children}</main>
    </div>
  ),
}));

function deferredModule() {
  let resolve!: (module: { default: ComponentType }) => void;
  const promise = new Promise<{ default: ComponentType }>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("authenticated route suspension", () => {
  it("keeps the authenticated shell mounted around an accessible content fallback", async () => {
    const route = deferredModule();
    const SlowPage = lazy(() => route.promise);

    render(
      <MemoryRouter initialEntries={["/slow"]}>
        <Routes>
          <Route element={<AuthenticatedLayout />}>
            <Route path="/slow" element={<SlowPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const sidebar = screen.getByRole("complementary", { name: "Persistent sidebar" });
    expect(sidebar).toBeInTheDocument();
    expect(screen.getByText("Persistent top bar")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading page…");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");

    await act(async () => {
      route.resolve({ default: () => <h1>Loaded route</h1> });
      await route.promise;
    });

    expect(await screen.findByRole("heading", { name: "Loaded route" })).toBeInTheDocument();
    expect(sidebar).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
