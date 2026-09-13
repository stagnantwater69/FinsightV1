// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthLayout } from "./AuthLayout";

/**
 * WEB-F02. The signed-out pages wrapped everything in <div>s, so landmark
 * navigation — the first thing a screen-reader user reaches for on a new
 * page — had nothing to jump to. Exactly one <main>, containing the form.
 */
describe("AuthLayout", () => {
  it("wraps the page's principal content in exactly one main landmark", () => {
    render(
      <MemoryRouter>
        <AuthLayout title="Sign in" subtitle="Welcome back">
          <form aria-label="sign in form">
            <button type="submit">Continue</button>
          </form>
        </AuthLayout>
      </MemoryRouter>,
    );
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toContainElement(screen.getByRole("form", { name: /sign in form/i }));
    expect(mains[0]).toContainElement(screen.getByRole("heading", { name: /sign in/i }));
  });
});
