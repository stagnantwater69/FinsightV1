// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NoBusinessProfile } from "./NoBusinessProfile";

/**
 * WHERE THE GATE CARD IS STILL THE RIGHT ANSWER — AND WHERE IT IS NOT.
 *
 * Two defects, one component. First, thirteen pages answered "no business
 * selected" with `if (!selected) return null` — a white screen with no
 * heading, no explanation and no way forward. This card was the fix.
 *
 * Then the fix overshot: EVERY authenticated page returned it, so an owner who
 * chose "Skip for now" got the same card behind all seventeen doors and the
 * skip skipped to nothing. So the card retreated to the pages that WRITE a
 * record, where a form that cannot save really is worse than a card. The
 * read-only pages are enterable and sit in their own empty states instead —
 * see pages/NoProfileEmptyState.test.tsx for that half.
 *
 * The component's own two states are tested here, then a source sweep. The
 * sweep is the part that keeps the split honest: a render test can only check
 * the pages someone remembered to mount, while the defect is precisely the
 * page nobody remembered.
 */

const ctx = { error: null as string | null, refresh: vi.fn() };

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ctx,
}));

function mount() {
  return render(
    <MemoryRouter>
      <NoBusinessProfile />
    </MemoryRouter>,
  );
}

describe("NoBusinessProfile", () => {
  it("invites the owner to finish setup when they genuinely have no business", () => {
    ctx.error = null;
    mount();

    expect(screen.getByText("Finish setting up your business")).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue setup" })).toHaveAttribute(
      "href",
      "/onboarding",
    );
  });

  it("says the load failed — and does not invite a second business — on an error", () => {
    ctx.error = "Network Error";
    mount();

    expect(screen.getByText("Your businesses didn't load")).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Continue setup" })).not.toBeInTheDocument();
  });
});

/**
 * Read through Vite rather than `node:fs` — tsconfig.app.json compiles `src`
 * with `types: ["vite/client"]` and no node types, so a `node:fs` import here
 * would pass under vitest and then fail the production `tsc -b`. Same
 * approach as tapTargets.test.ts.
 */
/**
 * Comments stripped before any sweep runs.
 *
 * The pages that STOPPED gating explain why in a comment that quotes the line
 * they removed — `if (!selected) return <NoBusinessProfile />` — and a raw
 * text search cannot tell that quotation from the real thing. Removing block
 * and line comments first is what keeps the sweep looking at code.
 */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PAGES = Object.entries(
  import.meta.glob("../pages/**/*.tsx", { query: "?raw", import: "default", eager: true }),
)
  .map(([path, src]) => ({
    name: `pages/${path.replace(/^\.\.\/pages\//, "")}`,
    src: stripComments(src as string),
  }))
  .filter(({ name }) => !name.includes(".test."));

describe("no page renders nothing when there is no business selected", () => {
  it("has no `if (!selected) return null` left anywhere under pages/", () => {
    const offenders = PAGES.filter(({ src }) =>
      /if\s*\(\s*!selected\s*\)\s*(\{\s*)?return null/.test(src),
    ).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});

/**
 * The pages allowed to hand back the gate card instead of themselves.
 *
 * Every one of them SAVES something that has to belong to a business, so
 * without one the page could only offer a form that cannot submit. Adding a
 * page here is a real decision — it takes that page away from an owner who
 * skipped setup — so the list is written out rather than derived.
 *
 * AllBusinessProfiles is the exception that proves the rule: it renders the
 * card only on `loadError`, i.e. the "we couldn't load your businesses" branch,
 * never as a "you have none" gate. Its own empty state covers that.
 */
const WRITE_PAGES = [
  "pages/AddExpense.tsx",
  "pages/AddSalesRecord.tsx",
  "pages/ImportCsv.tsx",
  "pages/RecurringScheduleForm.tsx",
  "pages/ScanReceipt.tsx",
];

describe("only the pages that write a record are gated", () => {
  it("has no `if (!selected) return <NoBusinessProfile />` on a read-only page", () => {
    const offenders = PAGES.filter(
      ({ name, src }) =>
        !WRITE_PAGES.includes(name) &&
        /if\s*\(\s*!selected\s*\)\s*(\{\s*)?return\s*<NoBusinessProfile/.test(src),
    ).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("still gates every page that writes a record", () => {
    const ungated = WRITE_PAGES.filter((name) => {
      const page = PAGES.find((p) => p.name === name);
      // A renamed or deleted write page must fail here rather than silently
      // passing as "nothing to check".
      if (!page) return true;
      return !/if\s*\(\s*!selected\s*\)\s*(\{\s*)?return\s*<NoBusinessProfile/.test(page.src);
    });

    expect(ungated).toEqual([]);
  });
});
