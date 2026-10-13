// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const imports = vi.hoisted(() => ({ landing: 0, login: 0, register: 0 }));

vi.mock("./pages/Landing", () => {
  imports.landing += 1;
  return { Landing: () => <h1>Public landing page</h1> };
});
vi.mock("./pages/Login", () => {
  imports.login += 1;
  return { Login: () => <h1>Account login</h1> };
});
vi.mock("./pages/Register", () => {
  imports.register += 1;
  return { Register: () => <h1>Create an account</h1> };
});
vi.mock("./context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ profile: null, loading: false }),
}));
vi.mock("./context/ThemeContext", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/Toast", () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/ConfirmDialog", () => ({ ConfirmProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/AuthenticatedLayout", () => ({ AuthenticatedLayout: () => null, OnboardingLayout: () => null }));

import App from "./App";

it("loads each public entry page only when its route is visited", async () => {
  expect(imports).toEqual({ landing: 0, login: 0, register: 0 });
  window.history.replaceState({}, "", "/login");
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Account login" })).toBeVisible();
  expect(imports).toEqual({ landing: 0, login: 1, register: 0 });

  act(() => {
    window.history.pushState({}, "", "/register");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByRole("heading", { name: "Create an account" })).toBeVisible();
  expect(imports).toEqual({ landing: 0, login: 1, register: 1 });

  act(() => {
    window.history.pushState({}, "", "/#features");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByRole("heading", { name: "Public landing page" })).toBeVisible();
  expect(imports).toEqual({ landing: 1, login: 1, register: 1 });
});
