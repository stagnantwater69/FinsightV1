// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NotFound } from "./NotFound";

/**
 * The regression this pins is not "the 404 page looks right" — it is that an
 * unmatched path renders SOMETHING.
 *
 * `<Routes>` renders null when nothing matches, which made a missing route a
 * blank white page with no chrome, no message and no console error. That is
 * indistinguishable from a crashed bundle, and telling the two apart cost a
 * real debugging session. A test that only checked the copy would still pass
 * with the catch-all deleted, so the assertions below are about the path being
 * named and the page not being empty.
 */

// The auth context is mocked rather than provided: which onward link renders is
// the only thing NotFound reads from it, and standing up the real provider would
// pull in Supabase for a test about routing.
const authState = { profile: null as { id: number } | null };
vi.mock("../context/AuthContext", () => ({
  useAuth: () => authState,
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<p>dashboard</p>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NotFound", () => {
  it("renders something for a path no route matches", () => {
    const { container } = renderAt("/this-route-does-not-exist");
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByRole("heading", { name: /this page doesn't exist/i })).toBeInTheDocument();
  });

  it("names the unmatched path, so a broken link is reportable", () => {
    renderAt("/ai-chat-typo/deep/path");
    expect(screen.getByText("/ai-chat-typo/deep/path")).toBeInTheDocument();
  });

  it("does not send a signed-out visitor to a login form", () => {
    authState.profile = null;
    renderAt("/nope");
    // A wrong URL is not a reason to demand credentials; the way out is home.
    expect(screen.getByRole("link", { name: /go to home/i })).toHaveAttribute("href", "/");
  });

  it("offers a signed-in owner their dashboard instead", () => {
    authState.profile = { id: 1 };
    renderAt("/nope");
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toHaveAttribute("href", "/dashboard");
    authState.profile = null;
  });
});
